import { createIdempotencyKey, createOpaqueId } from "@/lib/opaqueIds";
import { createGeneratedInstance } from "@/lib/goalFactory";
import { mergeTaskPatch, type TaskPatch } from "@/lib/server/governance/taskPatchMerge";
import type { GovernanceIntent, TaskRef } from "@/lib/server/governance/governanceIntent";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import {
  getRuntimeJobByTaskInstanceId,
  type RuntimeJobStatus,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { composeGoalsWithRuntimeJobs } from "@/lib/server/runtime/instanceComposition";
import { markGoalInstanceRunStarted, upsertGoalTaskInstanceSnapshot } from "@/lib/server/runtime/goalStateSnapshot";
import { readGoalsSnapshot, readGoalsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import { applyGoalCommand } from "@/lib/server/services/goalCommandService";
import { updateGoalRuntimeJobExecution, writeGoalsProjection } from "@/lib/server/services/goalRuntimeService";
import { startTaskAttempt } from "@/lib/server/taskExecution/startTaskAttempt";
import { ensureConversationWorkspace, ensureTaskWorkspace } from "@/lib/server/workspace/conversationWorkspace";
import { buildTaskQuoteContent } from "@/lib/taskFeedback";
import { normalizeExecutionKind } from "@/types/kiki";
import type { Goal, Task, TaskInstance, TaskInstanceStatus } from "@/types/kiki";
import type { QuotedConversationMessageContext, RuntimeEnvironment } from "@/types/runtime";

export type GovernanceApplyResult = {
  intent: GovernanceIntent;
  assistantMessage: string;
  goals?: Goal[];
  revision?: number;
  taskInstanceId?: string;
  taskCardMessage?: {
    content?: string;
    taskRef: Required<TaskRef>;
    taskSnapshot?: {
      task: Task;
      instance: TaskInstance;
    };
  };
};

function nowIso() {
  return new Date().toISOString();
}

function createRequestId(prefix = "goal-task") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function findTaskRef(goals: Goal[], taskRef: TaskRef) {
  const goal = goals.find((item) => item.id === taskRef.goalId);
  const subGoal = goal?.subGoals.find((item) => item.id === taskRef.subGoalId);
  const task = subGoal?.tasks.find((item) => item.id === taskRef.taskId);
  const instance = taskRef.instanceId ? task?.instances.find((item) => item.id === taskRef.instanceId) : undefined;
  if (!goal || !subGoal || !task) return null;
  return { goal, subGoal, task, instance };
}

function latestInstance(task: Task, predicate: (instance: TaskInstance) => boolean) {
  return [...task.instances]
    .filter(predicate)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
}

function toCommand(status: TaskInstanceStatus) {
  if (status === "paused") return "pause";
  if (status === "in_progress") return "resume";
  if (status === "error") return "cancel";
  return "transition";
}

function toRuntimeJobStatus(status: TaskInstanceStatus): RuntimeJobStatus {
  if (status === "in_progress") return "running";
  if (status === "awaiting_user") return "awaiting_user";
  if (status === "completed") return "completed";
  if (status === "error") return "failed";
  if (status === "paused") return "cancelled";
  return "queued";
}

function transitionInstanceFromGovernance(input: {
  goal: Goal;
  task: Task;
  instance: TaskInstance;
  nextStatus: TaskInstanceStatus;
  reason: string;
  idempotencyKey: string;
}) {
  const statusEvent = appendGoalEventOnce({
    goalId: input.goal.id,
    taskId: input.task.id,
    instanceId: input.instance.id,
    kind: "instance.status_changed",
    producedBy: "api",
    idempotencyKey: input.idempotencyKey,
    payload: {
      previousStatus: input.instance.status,
      nextStatus: input.nextStatus,
      reason: input.reason,
    },
  });
  if (!statusEvent) throw new Error("状态变更事件写入失败");
  appendGoalEventOnce({
    goalId: input.goal.id,
    taskId: input.task.id,
    instanceId: input.instance.id,
    kind: "instance.user_command",
    producedBy: "api",
    idempotencyKey: createIdempotencyKey("instance.user_command", input.idempotencyKey),
    payload: {
      command: toCommand(input.nextStatus),
      reason: input.reason,
    },
  });
  const job = getRuntimeJobByTaskInstanceId(input.instance.id);
  if (job) {
    updateGoalRuntimeJobExecution(job.id, {
      status: toRuntimeJobStatus(input.nextStatus),
      lastError: input.reason,
      finishedAt:
        input.nextStatus === "completed" || input.nextStatus === "error" || input.nextStatus === "paused"
          ? new Date().toISOString()
          : undefined,
      leaseOwner: input.nextStatus === "in_progress" ? job.leaseOwner : undefined,
      leaseExpiresAt: input.nextStatus === "in_progress" ? job.leaseExpiresAt : undefined,
    });
  }
}

function buildTaskInputFromPatch(patch: TaskPatch) {
  const description = patch.description?.trim() || patch.objective?.trim() || patch.title?.trim() || "由会话创建的任务";
  const expectedResult = patch.expectedResult
    ? {
        type: patch.expectedResult.type ?? ("deliverable" as const),
        description: patch.expectedResult.description ?? patch.expectedOutcome ?? patch.deliverable ?? description,
        format: patch.expectedResult.format ?? ("markdown" as const),
        ...patch.expectedResult,
      }
    : undefined;
  return {
    title: patch.title?.trim() || "未命名任务",
    description,
    expectedOutcome: patch.expectedOutcome?.trim() || patch.deliverable?.trim() || description,
    expectedResult,
    taskType: patch.taskType ?? (patch.triggerRule || patch.cadence || patch.triggerCondition ? "repeat" as const : "one_shot" as const),
    triggerRule: patch.triggerRule?.trim() || patch.cadence?.trim() || patch.triggerCondition?.trim() || "立即触发",
    executionKind: normalizeExecutionKind(undefined),
  };
}

function buildRevisionContext(input: {
  task: Task;
  sourceInstance: TaskInstance;
  userMessage: string;
  revisionHint: string;
  quotedMessage?: QuotedConversationMessageContext | null;
}) {
  return [
    "【会话治理触发的修订重跑】",
    `原实例：${input.sourceInstance.id}`,
    `原任务：${input.task.title}`,
    "",
    input.quotedMessage ? `用户发送时引用内容：\n[${input.quotedMessage.roleLabel}] ${input.quotedMessage.content}\n` : "",
    "用户要求：",
    input.userMessage,
    "",
    "修订要求：",
    input.revisionHint,
    "",
    "原结果摘要：",
    buildTaskQuoteContent(input.task, input.sourceInstance),
    "",
    "执行要求：请基于原任务要求和用户反馈重新产出完整可验收结果。可以复用原结果中仍正确的部分，但必须优先修正用户指出的问题。",
  ].join("\n");
}

function buildQueuedProgress(input: {
  requestId: string;
  goal: Goal;
  task: Task;
  instance: TaskInstance;
  message: string;
}) {
  const now = nowIso();
  return {
    requestId: input.requestId,
    scope: "goal_task_execute" as const,
    status: "running" as const,
    phase: "executing" as const,
    message: input.message,
    startedAt: now,
    updatedAt: now,
    goalId: input.goal.id,
    taskId: input.task.id,
    taskInstanceId: input.instance.id,
    attemptCount: 1,
    summary: input.message,
    resultPayload: {
      finalMessage: input.message,
      structuredOutput: input.instance.result?.structuredOutput ?? null,
    },
  };
}

async function applyRerun(input: {
  conversationId: string;
  taskRef: TaskRef;
  runtimeEnv: RuntimeEnvironment;
  userMessage: string;
  revisionHint: string;
  quotedMessage?: QuotedConversationMessageContext | null;
}): Promise<GovernanceApplyResult> {
  if (!input.taskRef.instanceId) {
    throw new Error("重跑当前结果需要 instanceId");
  }
  const rawGoals = readGoalsSnapshot([]);
  const composedGoals = composeGoalsWithRuntimeJobs(rawGoals);
  const located = findTaskRef(composedGoals, input.taskRef);
  if (!located?.instance) throw new Error("未找到要重跑的任务结果");
  const createdAt = nowIso();
  const baseInstance = createGeneratedInstance(located.task, createdAt);
  const nextInstance: TaskInstance = {
    ...baseInstance,
    id: createOpaqueId("inst"),
    dateLabel: `${baseInstance.dateLabel} 修订 ${new Date(createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
    intro: `根据你的要求重新执行“${located.task.title.replace(/^任务\d+：/, "")}”。`,
    result: {
      structuredOutput: {
        revisionRequest: {
          sourceInstanceId: located.instance.id,
          userFeedback: input.userMessage,
          revisionInstruction: input.revisionHint,
          createdAt,
        },
      },
    },
  };
  const requestId = `goal-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspace = ensureConversationWorkspace(input.conversationId);
  const taskWorkspaceDir = ensureTaskWorkspace({
    conversationId: input.conversationId,
    taskId: located.task.id,
    instanceId: nextInstance.id,
  });
  const taskWithInstance: Task = {
    ...located.task,
    instances: [nextInstance, ...located.task.instances],
  };
  const goalsWithInstance = upsertGoalTaskInstanceSnapshot(rawGoals, {
    goal: located.goal,
    subGoal: located.subGoal,
    task: taskWithInstance,
    instance: nextInstance,
  });
  const startedGoals = markGoalInstanceRunStarted(goalsWithInstance, {
    taskId: located.task.id,
    instanceId: nextInstance.id,
    requestId,
    runtimeEnvId: input.runtimeEnv.id,
    permissionMode: input.runtimeEnv.permissionMode,
    workingDirectory: taskWorkspaceDir,
  });
  writeGoalsProjection(startedGoals);
  const queuedTask = { ...located.task, instances: [nextInstance, ...located.task.instances] };
  const progress = buildQueuedProgress({
    requestId,
    goal: located.goal,
    task: queuedTask,
    instance: nextInstance,
    message: "已收到要求，正在重新执行任务。",
  });
  const attempt = startTaskAttempt({
    goal: located.goal,
    subGoal: located.subGoal,
    task: queuedTask,
    instance: nextInstance,
    runtimeEnv: input.runtimeEnv,
    triggerSource: "feedback_rerun",
    requestId,
    conversationWorkspaceDir: workspace.workspaceDir,
    taskWorkspaceDir,
    resumeContext: buildRevisionContext({
      task: located.task,
      sourceInstance: located.instance,
      userMessage: input.userMessage,
      revisionHint: input.revisionHint,
      quotedMessage: input.quotedMessage,
    }),
  });
  if (attempt.outcome === "queued") {
    updateGoalRuntimeJobExecution(`job-${nextInstance.id}`, {
      requestId,
      status: "queued",
      progress,
      logs: [],
      blocker: null,
      result: progress.resultPayload,
      lastError: undefined,
      finishedAt: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
  }
  return {
    intent: "rerun_current",
    assistantMessage: attempt.outcome === "queued" ? "已按你的要求重新执行任务。" : "已创建重跑任务，但当前执行未进入队列。",
    taskInstanceId: nextInstance.id,
    taskCardMessage: {
      content: `已根据你的要求重新执行「${located.task.title.replace(/^任务\d+：/, "")}」。`,
      taskRef: {
        goalId: located.goal.id,
        subGoalId: located.subGoal.id,
        taskId: located.task.id,
        instanceId: nextInstance.id,
      },
      taskSnapshot: {
        task: queuedTask,
        instance: nextInstance,
      },
    },
  };
}

function taskSnapshotForInstance(task: Task, instance: TaskInstance): Task {
  return {
    ...task,
    instances: task.instances.some((candidate) => candidate.id === instance.id)
      ? task.instances.map((candidate) => (candidate.id === instance.id ? instance : candidate))
      : [instance, ...task.instances],
  };
}

async function applyDispatch(input: {
  taskRef: TaskRef;
  runtimeEnv: RuntimeEnvironment;
}): Promise<GovernanceApplyResult> {
  const goals = composeGoalsWithRuntimeJobs(readGoalsSnapshot([]));
  const located = findTaskRef(goals, input.taskRef);
  if (!located) throw new Error("未找到要执行的任务");
  const requestId = createRequestId();
  const attempt = startTaskAttempt({
    goal: located.goal,
    subGoal: located.subGoal,
    task: located.task,
    instance: located.instance,
    runtimeEnv: input.runtimeEnv,
    triggerSource: "user",
    requestId,
  });
  if (attempt.outcome === "blocked_config") {
    throw new Error(attempt.reason);
  }
  const snapshot = composeGoalsWithRuntimeJobs(readGoalsSnapshot([]));
  const nextLocated = findTaskRef(snapshot, {
    ...input.taskRef,
    instanceId: attempt.taskInstanceId,
  });
  const instance = nextLocated?.instance ?? located.instance;
  const task = nextLocated?.task ?? located.task;
  return {
    intent: "dispatch_task",
    assistantMessage:
      attempt.outcome === "awaiting_user"
        ? "已开始执行任务，但需要先补充必要信息。"
        : attempt.outcome === "already_running"
          ? "该任务已经在执行中。"
          : "已开始执行该任务。",
    taskInstanceId: attempt.taskInstanceId,
    taskCardMessage: instance
      ? {
          content: `已开始执行「${task.title.replace(/^任务\d+：/, "")}」。`,
          taskRef: {
            goalId: located.goal.id,
            subGoalId: located.subGoal.id,
            taskId: task.id,
            instanceId: instance.id,
          },
          taskSnapshot: {
            task: taskSnapshotForInstance(task, instance),
            instance,
          },
        }
      : undefined,
  };
}

async function applyPauseOrResume(input: {
  taskRef: TaskRef;
  runtimeEnv?: RuntimeEnvironment;
  userMessage: string;
  idempotencyKey: string;
}): Promise<GovernanceApplyResult> {
  const goals = composeGoalsWithRuntimeJobs(readGoalsSnapshot([]));
  const located = findTaskRef(goals, input.taskRef);
  if (!located) throw new Error("未找到目标任务");
  const message = input.userMessage.toLowerCase();
  const explicitResume = /恢复|继续|resume|continue/.test(message);
  const explicitPause = /暂停|停止|停掉|pause|stop/.test(message);
  const target =
    located.instance ??
    (explicitResume
      ? latestInstance(located.task, (instance) => instance.status === "paused")
      : latestInstance(located.task, (instance) => instance.status === "in_progress" || instance.status === "awaiting_user"));
  if (!target) {
    throw new Error(explicitResume ? "未找到可恢复的暂停实例。" : "未找到可暂停的执行中实例。");
  }
  const shouldResume = explicitResume || (!explicitPause && target.status === "paused");
  if (shouldResume) {
    if (!input.runtimeEnv) throw new Error("恢复任务需要 Runtime 环境");
    const attempt = startTaskAttempt({
      goal: located.goal,
      subGoal: located.subGoal,
      task: located.task,
      instance: target,
      runtimeEnv: input.runtimeEnv,
      triggerSource: "user",
      requestId: createRequestId(),
    });
    if (attempt.outcome === "blocked_config") throw new Error(attempt.reason);
    return {
      intent: "pause_task",
      assistantMessage: attempt.outcome === "already_running" ? "该任务已经在执行中。" : "已恢复该任务执行。",
      taskInstanceId: attempt.taskInstanceId,
    };
  }
  if (target.status !== "in_progress" && target.status !== "awaiting_user") {
    throw new Error("当前任务实例不在执行中，无法暂停。");
  }
  transitionInstanceFromGovernance({
    goal: located.goal,
    task: located.task,
    instance: target,
    nextStatus: "paused",
    reason: "用户通过会话暂停任务执行",
    idempotencyKey: input.idempotencyKey,
  });
  const meta = readGoalsSnapshotMeta([]);
  return {
    intent: "pause_task",
    assistantMessage: "已暂停该任务执行。",
    goals: composeGoalsWithRuntimeJobs(meta.value),
    revision: meta.revision,
    taskInstanceId: target.id,
  };
}

export async function applyGovernanceCommand(input: {
  conversationId: string;
  intent: GovernanceIntent;
  taskRef: TaskRef;
  patch?: TaskPatch;
  revisionHint?: string;
  userMessage: string;
  runtimeEnv?: RuntimeEnvironment;
  quotedMessage?: QuotedConversationMessageContext | null;
  idempotencyKey: string;
}): Promise<GovernanceApplyResult> {
  if (input.intent === "dispatch_task") {
    if (!input.runtimeEnv) throw new Error("执行任务需要 Runtime 环境");
    return applyDispatch({ taskRef: input.taskRef, runtimeEnv: input.runtimeEnv });
  }
  if (input.intent === "pause_task") {
    return applyPauseOrResume({
      taskRef: input.taskRef,
      runtimeEnv: input.runtimeEnv,
      userMessage: input.userMessage,
      idempotencyKey: input.idempotencyKey,
    });
  }
  if (input.intent === "rerun_current") {
    if (!input.runtimeEnv) throw new Error("重跑任务需要 Runtime 环境");
    return applyRerun({
      conversationId: input.conversationId,
      taskRef: input.taskRef,
      runtimeEnv: input.runtimeEnv,
      userMessage: input.userMessage,
      revisionHint: input.revisionHint || input.userMessage,
      quotedMessage: input.quotedMessage,
    });
  }
  const goals = readGoalsSnapshot([]);
  const located = findTaskRef(goals, input.taskRef);
  if (!located) throw new Error("未找到目标任务");
  if (input.intent === "cancel_task") {
    const result = applyGoalCommand({
      command: {
        type: "delete_task",
        goalId: located.goal.id,
        taskId: located.task.id,
      },
      idempotencyKey: input.idempotencyKey,
    });
    return { intent: input.intent, assistantMessage: "已删除该任务。", goals: result.goals, revision: result.revision };
  }
  if (input.intent === "create_task") {
    if (!input.patch) throw new Error("新建任务缺少任务内容");
    const result = applyGoalCommand({
      command: {
        type: "create_task",
        goalId: located.goal.id,
        subGoalId: located.subGoal.id,
        task: buildTaskInputFromPatch(input.patch),
      },
      idempotencyKey: input.idempotencyKey,
    });
    return { intent: input.intent, assistantMessage: "已创建新任务。", goals: result.goals, revision: result.revision };
  }
  if (input.intent === "amend_task" || input.intent === "update_task") {
    if (!input.patch) throw new Error("修改任务缺少补丁内容");
    const result = applyGoalCommand({
      command: {
        type: "update_task",
        goalId: located.goal.id,
        taskId: located.task.id,
        task: mergeTaskPatch(located.task, input.patch),
      },
      idempotencyKey: input.idempotencyKey,
    });
    if (input.intent === "amend_task") {
      appendGoalEventOnce({
        goalId: located.goal.id,
        taskId: located.task.id,
        kind: "task.definition_amended",
        producedBy: "api",
        idempotencyKey: `${input.idempotencyKey}:definition_amended`,
        payload: {
          source: "conversation_governance",
          message: input.userMessage,
          patch: input.patch,
        },
      });
    }
    return {
      intent: input.intent,
      assistantMessage: input.intent === "amend_task" ? "已更新任务标准，后续执行将按新要求进行。" : "已更新任务。",
      goals: result.goals,
      revision: result.revision,
    };
  }
  return { intent: input.intent, assistantMessage: "这条消息不需要修改任务状态。" };
}
