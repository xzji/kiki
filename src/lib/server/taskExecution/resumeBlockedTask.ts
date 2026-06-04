import {
  getRuntimeJobByTaskInstanceId,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { requiresUserConfirmationToComplete } from "@/lib/server/domain/taskPolicy";
import {
  requeueBlockedGoalRuntimeJob,
  updateGoalRuntimeJobExecution,
} from "@/lib/server/services/goalRuntimeService";
import {
  ensureTaskWorkspace,
  writeJsonFileAtomic,
  writeTaskRunSnapshot,
} from "@/lib/server/workspace/conversationWorkspace";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { GoalServerProgress } from "@/types/goalTelemetry";
import type { InteractionRequirement, InteractionSubmission } from "@/types/kiki";
import type { ResultBlock, TaskResult } from "@/types/taskResult";

export type ResumeTaskRequestBody = {
  taskInstanceId: string;
  resumeToken: string;
  approved: boolean;
  feedback?: string;
  action?: string;
  fields?: Record<string, string>;
};

type ResumeTaskResult = {
  status: number;
  body: {
    reason?: string;
    resumed?: boolean;
    completed?: boolean;
    alreadyResumed?: boolean;
    progress?: GoalServerProgress | null;
    logs?: unknown[];
    trajectory?: ExecutionTrajectoryStep[];
  };
};

function nowIso() {
  return new Date().toISOString();
}

function createTrajectoryStep(input: {
  index: number;
  title: string;
  status: ExecutionTrajectoryStep["status"];
  thought?: string;
}): ExecutionTrajectoryStep {
  const now = nowIso();
  return {
    id: `resume-${Date.now()}-${input.index}-${Math.random().toString(36).slice(2, 8)}`,
    index: input.index,
    type: "approval",
    status: input.status,
    title: input.title,
    thought: input.thought,
    startedAt: now,
    endedAt: now,
  };
}

function resolveBlocker(blocker: ExecutionBlocker, input: Pick<ResumeTaskRequestBody, "approved" | "feedback">): ExecutionBlocker {
  return {
    ...blocker,
    status: "resolved",
    decision: input.approved ? "approved" : "rejected",
    feedback: input.feedback?.trim() || undefined,
    resolvedAt: nowIso(),
  };
}

function parseFeedbackFields(feedback: string) {
  const entries = new Map<string, string>();
  feedback
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const match = line.match(/^([^：:\n]{1,40})[:：]\s*(.+)$/);
      if (match?.[1] && match[2]) entries.set(match[1].trim(), match[2].trim());
    });
  return entries;
}

function mapToRecord(map: Map<string, string>) {
  return Object.fromEntries(map.entries());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function submittedValueFor(input: {
  label: string;
  feedback: string;
  feedbackFields: Map<string, string>;
  missingUserLabels: string[];
}) {
  const exact = input.feedbackFields.get(input.label);
  if (exact) return exact;
  if (input.missingUserLabels.length === 1 && input.missingUserLabels[0] === input.label && input.feedback) return input.feedback;
  return "";
}

function buildSubmittedReadiness(input: { structuredOutput: unknown; feedback: string; feedbackFields: Map<string, string> }) {
  if (!isRecord(input.structuredOutput) || !isRecord(input.structuredOutput.taskReadiness)) {
    return input.structuredOutput;
  }
  const readiness = input.structuredOutput.taskReadiness;
  if (!Array.isArray(readiness.items)) return input.structuredOutput;

  const missingUserLabels = readiness.items
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.source === "user" && item.status === "missing_user")
    .map((item) => (typeof item.label === "string" ? item.label : ""))
    .filter(Boolean);

  let updatedMissingCount = 0;
  const items = readiness.items.map((item) => {
    if (!isRecord(item) || typeof item.label !== "string") return item;
    const value = submittedValueFor({
      label: item.label,
      feedback: input.feedback,
      feedbackFields: input.feedbackFields,
      missingUserLabels,
    });
    if (!value) return item;
    updatedMissingCount += item.source === "user" && item.status === "missing_user" ? 1 : 0;
    return {
      ...item,
      status: "available",
      reason: `用户已提交：${value}`,
      value,
    };
  });
  const unresolvedMissingCount = Math.max(0, missingUserLabels.length - updatedMissingCount);
  const ready = unresolvedMissingCount === 0;

  return {
    ...input.structuredOutput,
    taskReadiness: {
      ...readiness,
      status: ready ? "ready" : "blocked",
      summary: ready
        ? "已收到用户补充信息，KiKi 正在继续执行。"
        : "已收到部分用户补充信息，仍有信息待补充。",
      items,
    },
  };
}

function submissionStatusText(submission: InteractionSubmission) {
  if (submission.type === "confirm") return submission.approved ? "已确认继续" : "已要求修改";
  if (submission.type === "answer") return "已提交答案";
  if (submission.type === "provide_context") return "已提交补充信息";
  if (submission.type === "perform_offline_action") return "已记录线下动作";
  return "已提交";
}

function submissionDetailText(submission: InteractionSubmission) {
  const fieldText = Object.entries(submission.fields ?? {})
    .map(([label, value]) => `${label}：${value}`)
    .join("；");
  return fieldText || submission.feedback || submission.action;
}

function buildSubmissionBlock(submission: InteractionSubmission): ResultBlock {
  return {
    kind: "key_value",
    entries: [
      { label: "提交状态", value: submissionStatusText(submission), emphasis: true },
      { label: "提交内容", value: submissionDetailText(submission) },
      { label: "提交时间", value: new Date(submission.submittedAt).toLocaleString("zh-CN") },
    ],
  };
}

function upsertSubmissionBlock(blocks: ResultBlock[], submission: InteractionSubmission) {
  const nextBlocks = blocks.filter((block) => {
    if (block.kind !== "key_value") return true;
    return !block.entries.some((entry) => entry.label === "提交状态");
  });
  return [buildSubmissionBlock(submission), ...nextBlocks];
}

function buildSubmittedTaskResult(input: {
  taskResult: unknown;
  taskId: string;
  instanceId: string;
  feedback: string;
  feedbackFields: Map<string, string>;
  submission: InteractionSubmission;
}) {
  const fallbackResult: TaskResult = {
    schemaVersion: 1,
    taskId: input.taskId,
    instanceId: input.instanceId,
    title: "已收到用户提交",
    status: "draft",
    blocks: [buildSubmissionBlock(input.submission)],
    meta: { producedAt: nowIso(), presentation: "summary_card", primaryFormat: "structured_blocks" },
  };
  if (!isRecord(input.taskResult) || !Array.isArray(input.taskResult.blocks)) return fallbackResult;
  const labels = Array.from(input.feedbackFields.keys());
  const hasSubmittedFields = labels.length > 0;
  const blocks = input.taskResult.blocks.flatMap((block) => {
    if (!isRecord(block)) return block;
    if (block.kind === "key_value" && Array.isArray(block.entries)) {
      return {
        ...block,
        entries: block.entries.map((entry) => {
          if (!isRecord(entry) || typeof entry.label !== "string") return entry;
          const value = input.feedbackFields.get(entry.label);
          if (!value) return entry;
          return {
            ...entry,
            value: `已提交：${value}`,
            emphasis: false,
          };
        }),
      };
    }
    if (block.kind === "list" && Array.isArray(block.items) && hasSubmittedFields) {
      const items = block.items.filter((item) => typeof item !== "string" || !labels.includes(item));
      return items.length ? { ...block, items } : [];
    }
    if (block.kind === "callout" && typeof block.text === "string" && /缺少|缺失|暂停/.test(block.text)) {
      return [];
    }
    return block;
  }) as ResultBlock[];

  return {
    ...(input.taskResult as TaskResult),
    title: `${submissionStatusText(input.submission)}，继续执行中`,
    status: "draft",
    blocks: upsertSubmissionBlock(blocks, input.submission),
    meta: {
      ...(isRecord(input.taskResult.meta) ? input.taskResult.meta : {}),
      producedAt: nowIso(),
    },
  } satisfies TaskResult;
}

function buildInteractionSubmission(input: {
  blocker: ExecutionBlocker;
  body: ResumeTaskRequestBody;
  feedback: string;
  feedbackFields: Map<string, string>;
}): InteractionSubmission {
  const type = input.blocker.interactionRequirement.type;
  const approved = input.body.approved;
  const action =
    input.body.action?.trim() ||
    (type === "confirm"
      ? approved
        ? "确认继续"
        : "要求修改"
      : type === "answer"
        ? "提交答案"
        : type === "perform_offline_action"
          ? "记录线下动作"
          : "提交信息");
  return {
    type,
    status: type === "confirm" ? (approved ? "confirmed" : "rejected") : type === "perform_offline_action" ? "completed" : "submitted",
    action,
    approved,
    feedback: input.feedback,
    fields: {
      ...mapToRecord(input.feedbackFields),
      ...(input.body.fields ?? {}),
    },
    submittedAt: nowIso(),
  };
}

function nonInteractiveRequirement() {
  return {
    type: "none",
    timing: "not_required",
    reason: "",
    shouldNotifyUser: false,
  } satisfies InteractionRequirement;
}

function isInformationFeedbackOnlyBlocker(input: {
  task: NonNullable<ReturnType<typeof getRuntimeJobByTaskInstanceId>>["payload"]["task"];
  blocker: ExecutionBlocker;
  basePayload: unknown;
}) {
  const taskResult = isRecord(input.basePayload) && isRecord(input.basePayload.taskResult) ? input.basePayload.taskResult : undefined;
  return (
    input.task.expectedResult?.type === "information" &&
    input.blocker.interactionRequirement.type === "confirm" &&
    input.blocker.interactionRequirement.timing === "after_agent_output" &&
    taskResult?.status === "done" &&
    !requiresUserConfirmationToComplete(input.task, { includeUserCompletionOwner: true })
  );
}

function buildProgress(input: {
  job: NonNullable<ReturnType<typeof getRuntimeJobByTaskInstanceId>>;
  progress: GoalServerProgress | null;
  resultPayload: Record<string, unknown>;
  status: GoalServerProgress["status"];
  phase: GoalServerProgress["phase"];
  message: string;
}) {
  const now = nowIso();
  return {
    requestId: input.job.requestId ?? `resume-${input.job.taskInstanceId}`,
    scope: "goal_task_execute",
    status: input.status,
    phase: input.phase,
    message: input.message,
    startedAt: input.progress?.startedAt ?? input.job.startedAt ?? now,
    updatedAt: now,
    finishedAt: input.status === "completed" ? now : undefined,
    goalId: input.job.goalId,
    taskId: input.job.taskId,
    taskInstanceId: input.job.taskInstanceId,
    attemptCount: input.progress?.attemptCount,
    summary:
      typeof input.resultPayload.summary === "string"
        ? input.resultPayload.summary
        : input.progress?.summary,
    resultPayload: input.resultPayload,
  } satisfies GoalServerProgress;
}

function buildResumeContext(input: { approved: boolean; feedback: string }) {
  const lines = [
    `用户对上一次阻塞点的决定：${input.approved ? "确认继续" : "拒绝当前方案/要求修改"}`,
    `用户反馈：${input.feedback}`,
  ];
  if (input.approved) {
    lines.push(
      "用户已确认上一轮候选/草案，请不要再次要求用户确认同一内容。",
      "请基于已确认内容生成最终交付物，以完整 task_result.blocks 输出可直接展示给用户的最终方案卡片。",
    );
  } else {
    lines.push("请根据用户反馈修订上一轮候选/草案，并输出更新后的完整方案。");
  }
  return lines.join("\n");
}

export async function resumeBlockedTask(body: ResumeTaskRequestBody): Promise<ResumeTaskResult> {
  if (!body.taskInstanceId || !body.resumeToken) {
    return { status: 400, body: { reason: "taskInstanceId 和 resumeToken 不能为空" } };
  }

  const job = getRuntimeJobByTaskInstanceId(body.taskInstanceId);
  if (!job) {
    return { status: 404, body: { reason: "当前任务没有等待恢复的阻塞点" } };
  }
  if (!job.blocker) {
    if (job.status === "queued" || job.status === "running") {
      return {
        status: 200,
        body: {
          resumed: true,
          completed: false,
          alreadyResumed: true,
          progress: job.progress,
          logs: job.logs,
          trajectory: job.trajectory,
        },
      };
    }
    return { status: 404, body: { reason: "当前任务没有等待恢复的阻塞点" } };
  }
  if (job.blocker.status === "resolved") {
    return {
      status: 200,
      body: {
        resumed: true,
        completed: job.status === "completed",
        alreadyResumed: true,
        progress: job.progress,
        logs: job.logs,
        trajectory: job.trajectory,
      },
    };
  }
  if (job.blocker.resumeToken !== body.resumeToken) {
    return { status: 409, body: { reason: "恢复令牌不匹配，请刷新后重试" } };
  }

  const resolvedBlocker = resolveBlocker(job.blocker, body);
  const conversationId = job.conversationId ?? job.payload.goal.conversationId;
  const taskWorkspaceDir =
    job.payload.taskWorkspaceDir ??
    (conversationId
      ? ensureTaskWorkspace({
          conversationId,
          taskId: job.payload.task.id,
          instanceId: job.payload.instance.id,
        })
      : undefined);
  if (taskWorkspaceDir) {
    writeJsonFileAtomic(`${taskWorkspaceDir}/resume-input.json`, {
      submittedAt: nowIso(),
      approved: body.approved,
      action: body.action,
      feedback: body.feedback,
      fields: body.fields,
      resumeToken: body.resumeToken,
    });
  }
  const nextTrajectory = [
    ...job.trajectory,
    createTrajectoryStep({
      index: job.trajectory.length,
      status: "running",
      title: body.approved ? "已提交补充信息，KiKi 继续执行中" : "已提交修改意见，KiKi 继续执行中",
      thought: body.feedback?.trim() || job.blocker.interactionRequirement.reason,
    }),
  ];
  const basePayload = job.result ?? job.progress?.resultPayload ?? {};

  if (isInformationFeedbackOnlyBlocker({ task: job.payload.task, blocker: job.blocker, basePayload })) {
    const feedback = body.feedback?.trim() || (body.approved ? "用户已确认当前报告。" : "用户提出了反馈。");
    const feedbackFields = parseFeedbackFields(feedback);
    Object.entries(body.fields ?? {}).forEach(([label, value]) => feedbackFields.set(label, value));
    const interactionSubmission = buildInteractionSubmission({
      blocker: job.blocker,
      body,
      feedback,
      feedbackFields,
    });
    const structuredOutput = {
      ...(isRecord(basePayload) && isRecord(basePayload.structuredOutput) ? basePayload.structuredOutput : {}),
      interactionSubmission,
      followUpFeedback: {
        feedback,
        fields: mapToRecord(feedbackFields),
      },
    };
    const resultPayload = {
      ...basePayload,
      awaitingUser: false,
      awaitingReason: undefined,
      blocker: resolvedBlocker,
      trajectory: nextTrajectory,
      interactionRequirement: nonInteractiveRequirement(),
      interactionSubmission,
      structuredOutput,
    };
    const nextProgress = buildProgress({
      job,
      progress: job.progress,
      resultPayload,
      status: "completed",
      phase: "completed",
      message: "已记录用户反馈，任务保持完成",
    });
    if (conversationId) {
      writeTaskRunSnapshot({
        conversationId,
        taskId: job.payload.task.id,
        instanceId: job.payload.instance.id,
        progress: nextProgress,
        trajectory: nextTrajectory,
        result: resultPayload,
      });
    }
    updateGoalRuntimeJobExecution(job.id, {
      status: "completed",
      progress: nextProgress,
      trajectory: nextTrajectory,
      blocker: resolvedBlocker,
      result: resultPayload,
      finishedAt: nowIso(),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
    return {
      status: 200,
      body: { resumed: true, completed: true, progress: nextProgress, logs: job.logs, trajectory: nextTrajectory },
    };
  }

  if (body.approved && job.blocker.resumeStrategy === "complete_on_approve") {
    const feedback = body.feedback?.trim() || "用户已确认，可以继续。";
    const feedbackFields = parseFeedbackFields(feedback);
    Object.entries(body.fields ?? {}).forEach(([label, value]) => feedbackFields.set(label, value));
    const interactionSubmission = buildInteractionSubmission({
      blocker: job.blocker,
      body,
      feedback,
      feedbackFields,
    });
    const structuredOutput = {
      ...(isRecord(basePayload) && isRecord(basePayload.structuredOutput) ? basePayload.structuredOutput : {}),
      interactionSubmission,
    };
    const taskResult = buildSubmittedTaskResult({
      taskResult: isRecord(basePayload) ? basePayload.taskResult : undefined,
      taskId: job.payload.task.id,
      instanceId: job.payload.instance.id,
      feedback,
      feedbackFields,
      submission: interactionSubmission,
    });
    const resultPayload = {
      ...basePayload,
      awaitingUser: false,
      awaitingReason: undefined,
      blocker: resolvedBlocker,
      trajectory: nextTrajectory,
      interactionRequirement: nonInteractiveRequirement(),
      interactionSubmission,
      structuredOutput,
      taskResult,
    };
    const nextProgress = buildProgress({
      job,
      progress: job.progress,
      resultPayload,
      status: "completed",
      phase: "completed",
      message: "用户已确认，任务已完成",
    });
    if (conversationId) {
      writeTaskRunSnapshot({
        conversationId,
        taskId: job.payload.task.id,
        instanceId: job.payload.instance.id,
        progress: nextProgress,
        trajectory: nextTrajectory,
        result: resultPayload,
      });
    }
    updateGoalRuntimeJobExecution(job.id, {
      status: "completed",
      progress: nextProgress,
      trajectory: nextTrajectory,
      blocker: resolvedBlocker,
      result: resultPayload,
      finishedAt: nowIso(),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
    return {
      status: 200,
      body: { resumed: true, completed: true, progress: nextProgress, logs: job.logs, trajectory: nextTrajectory },
    };
  }

  const feedback = body.feedback?.trim() || (body.approved ? "用户已确认，请继续执行。" : "用户未确认当前方案，请根据反馈修改后继续执行。");
  const feedbackFields = parseFeedbackFields(feedback);
  Object.entries(body.fields ?? {}).forEach(([label, value]) => feedbackFields.set(label, value));
  const interactionSubmission = buildInteractionSubmission({
    blocker: job.blocker,
    body,
    feedback,
    feedbackFields,
  });
  const structuredOutput = buildSubmittedReadiness({
    structuredOutput: isRecord(basePayload) ? basePayload.structuredOutput : undefined,
    feedback,
    feedbackFields,
  });
  const structuredOutputWithSubmission = {
    ...(isRecord(structuredOutput) ? structuredOutput : {}),
    interactionSubmission,
  };
  const taskResult = buildSubmittedTaskResult({
    taskResult: isRecord(basePayload) ? basePayload.taskResult : undefined,
    taskId: job.payload.task.id,
    instanceId: job.payload.instance.id,
    feedback,
    feedbackFields,
    submission: interactionSubmission,
  });
  const resultPayload = {
    ...basePayload,
    awaitingUser: false,
    awaitingReason: undefined,
    blocker: resolvedBlocker,
    trajectory: nextTrajectory,
    interactionRequirement: nonInteractiveRequirement(),
    interactionSubmission,
    structuredOutput: structuredOutputWithSubmission,
    taskResult,
  };
  const nextProgress = buildProgress({
    job,
    progress: job.progress,
    resultPayload,
    status: "running",
    phase: "executing",
    message: body.approved ? "已收到用户确认，等待 Agent 生成最终方案" : "已收到用户反馈，等待 Agent 继续执行",
  });
  if (conversationId) {
    writeTaskRunSnapshot({
      conversationId,
      taskId: job.payload.task.id,
      instanceId: job.payload.instance.id,
      progress: nextProgress,
      trajectory: nextTrajectory,
      result: resultPayload,
    });
  }
  requeueBlockedGoalRuntimeJob({
    job,
    taskWorkspaceDir,
    resumeContext: buildResumeContext({ approved: body.approved, feedback }),
    progress: nextProgress,
    trajectory: nextTrajectory,
    result: resultPayload,
  });

  return {
    status: 200,
    body: { resumed: true, completed: false, progress: nextProgress, logs: job.logs, trajectory: nextTrajectory },
  };
}
