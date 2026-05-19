import { NextRequest, NextResponse } from "next/server";

import { createOpaqueId } from "@/lib/opaqueIds";
import { createGeneratedInstance } from "@/lib/goalFactory";
import { markGoalInstanceRunStarted, upsertGoalTaskInstanceSnapshot } from "@/lib/server/runtime/goalStateSnapshot";
import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { updateGoalRuntimeJobExecution, writeGoalsProjection } from "@/lib/server/services/goalRuntimeService";
import { startTaskAttempt } from "@/lib/server/taskExecution/startTaskAttempt";
import { judgeTaskFeedback } from "@/lib/server/taskFeedbackJudge";
import { ensureConversationWorkspace, ensureTaskWorkspace } from "@/lib/server/workspace/conversationWorkspace";
import { buildTaskQuoteContent, getFeedbackHistory, withFeedbackRecord } from "@/lib/taskFeedback";
import type { TaskFeedbackRecord } from "@/lib/taskFeedback";
import type { Goal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRef = {
  goalId: string;
  subGoalId: string;
  taskId: string;
  instanceId: string;
};

type RequestBody = {
  conversationId: string;
  message: string;
  sourceMessageId?: string;
  feedbackId?: string;
  taskRef: TaskRef;
  runtimeEnv?: RuntimeEnvironment;
};

function nowIso() {
  return new Date().toISOString();
}

function findTaskRef(goals: Goal[], taskRef: TaskRef) {
  const goal = goals.find((item) => item.id === taskRef.goalId);
  const subGoal = goal?.subGoals.find((item) => item.id === taskRef.subGoalId);
  const task = subGoal?.tasks.find((item) => item.id === taskRef.taskId);
  const instance = task?.instances.find((item) => item.id === taskRef.instanceId);
  if (!goal || !subGoal || !task || !instance) return null;
  return { goal, subGoal, task, instance };
}

function replaceTaskInstance(goals: Goal[], taskId: string, instance: TaskInstance) {
  return goals.map((goal) => ({
    ...goal,
    subGoals: goal.subGoals.map((subGoal) => ({
      ...subGoal,
      tasks: subGoal.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              instances: task.instances.map((item) => item.id === instance.id ? instance : item),
            }
          : task,
      ),
    })),
  }));
}

function updateFeedbackRecord(goals: Goal[], taskId: string, instanceId: string, record: TaskFeedbackRecord) {
  const found = goals
    .flatMap((goal) => goal.subGoals.flatMap((subGoal) => subGoal.tasks))
    .find((task) => task.id === taskId)
    ?.instances.find((instance) => instance.id === instanceId);
  if (!found) return goals;
  return replaceTaskInstance(goals, taskId, withFeedbackRecord(found, record));
}

function findExistingFeedback(instance: TaskInstance, sourceMessageId?: string, feedbackId?: string) {
  return getFeedbackHistory(instance).find((item) => {
    if (feedbackId && item.id === feedbackId) return true;
    if (sourceMessageId && item.sourceMessageId === sourceMessageId) return true;
    return false;
  });
}

function findActiveFeedbackRerun(task: Task, sourceInstanceId: string) {
  return task.instances.find((instance) => {
    const revisionRequest = instance.result?.structuredOutput?.revisionRequest as
      | { sourceInstanceId?: string }
      | undefined;
    return (
      revisionRequest?.sourceInstanceId === sourceInstanceId &&
      (instance.status === "pending" || instance.status === "in_progress" || instance.status === "awaiting_user")
    );
  });
}

function buildRevisionContext(input: {
  task: Task;
  sourceInstance: TaskInstance;
  userMessage: string;
  revisionContext: string;
}) {
  return [
    "【用户反馈驱动的修订重跑】",
    `原实例：${input.sourceInstance.id}`,
    `原任务：${input.task.title}`,
    "",
    "用户反馈：",
    input.userMessage,
    "",
    "修订要求：",
    input.revisionContext,
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

export async function POST(request: NextRequest) {
  const body = (await request.json()) as RequestBody;
  if (!body.conversationId || !body.taskRef || !body.message?.trim()) {
    return NextResponse.json({ reason: "反馈参数不完整" }, { status: 400 });
  }

  const goals = readGoalsSnapshot([]);
  const located = findTaskRef(goals, body.taskRef);
  if (!located) {
    return NextResponse.json({ reason: "未找到被引用的任务结果" }, { status: 404 });
  }
  if (located.goal.conversationId && located.goal.conversationId !== body.conversationId) {
    return NextResponse.json({ reason: "被引用任务不属于当前会话" }, { status: 403 });
  }
  if (!located.instance.result?.taskResult && located.instance.status !== "completed") {
    return NextResponse.json({
      decision: "clarify",
      assistantMessage: "这条任务结果还没有完成，建议等它完成后再引用结果反馈。",
    });
  }

  const existingFeedback = findExistingFeedback(located.instance, body.sourceMessageId, body.feedbackId);
  if (existingFeedback) {
    return NextResponse.json({
      decision: existingFeedback.decision,
      assistantMessage: existingFeedback.assistantMessage,
      taskInstanceId: existingFeedback.rerunInstanceId,
    });
  }

  const activeRerun = findActiveFeedbackRerun(located.task, located.instance.id);
  if (activeRerun) {
    return NextResponse.json({
      decision: "rerun",
      assistantMessage: "我已经在按这条任务结果的反馈进行修订执行，先继续跟进当前修订任务。",
      taskInstanceId: activeRerun.id,
      taskCardMessage: {
        taskRef: {
          goalId: located.goal.id,
          subGoalId: located.subGoal.id,
          taskId: located.task.id,
          instanceId: activeRerun.id,
        },
        taskSnapshot: {
          task: located.task,
          instance: activeRerun,
        },
      },
    });
  }

  if (!body.runtimeEnv || body.runtimeEnv.type !== "local" || body.runtimeEnv.health?.status !== "online") {
    const record: TaskFeedbackRecord = {
      id: body.feedbackId || `feedback-${Date.now()}`,
      sourceMessageId: body.sourceMessageId,
      userMessage: body.message,
      decision: "clarify",
      assistantMessage: "我已收到你对任务结果的反馈。当前本地 Runtime 未连接，暂时不能自动重做；连接 Runtime 后可以再次引用这条结果让我按反馈修订。",
      createdAt: nowIso(),
    };
    writeGoalsProjection(updateFeedbackRecord(goals, located.task.id, located.instance.id, record));
    return NextResponse.json({ decision: record.decision, assistantMessage: record.assistantMessage });
  }

  const workspace = ensureConversationWorkspace(body.conversationId);
  const judge = await judgeTaskFeedback({
    goal: located.goal,
    subGoal: located.subGoal,
    task: located.task,
    instance: located.instance,
    userMessage: body.message,
    runtimeEnv: body.runtimeEnv,
    workingDirectory: workspace.workspaceDir,
  });

  if (judge.decision !== "rerun") {
    const record: TaskFeedbackRecord = {
      id: body.feedbackId || `feedback-${Date.now()}`,
      sourceMessageId: body.sourceMessageId,
      userMessage: body.message,
      decision: judge.decision,
      assistantMessage: judge.assistantMessage,
      revisionContext: judge.revisionContext,
      createdAt: nowIso(),
    };
    writeGoalsProjection(updateFeedbackRecord(goals, located.task.id, located.instance.id, record));
    return NextResponse.json({
      decision: judge.decision,
      assistantMessage: judge.assistantMessage,
      reason: judge.reason,
    });
  }

  const createdAt = nowIso();
  const baseInstance = createGeneratedInstance(located.task, createdAt);
  const revisionContext = buildRevisionContext({
    task: located.task,
    sourceInstance: located.instance,
    userMessage: body.message,
    revisionContext: judge.revisionContext ?? "",
  });
  const nextInstance: TaskInstance = {
    ...baseInstance,
    dateLabel: `${baseInstance.dateLabel} 修订 ${new Date(createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
    intro: `根据你的反馈重新执行“${located.task.title.replace(/^任务\d+：/, "")}”。`,
    result: {
      structuredOutput: {
        revisionRequest: {
          sourceInstanceId: located.instance.id,
          userFeedback: body.message,
          revisionInstruction: judge.revisionContext,
          createdAt,
        },
      },
    },
  };
  nextInstance.id = createOpaqueId("inst");
  const requestId = `goal-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taskWorkspaceDir = ensureTaskWorkspace({
    conversationId: body.conversationId,
    taskId: located.task.id,
    instanceId: nextInstance.id,
  });
  const taskWithInstance: Task = {
    ...located.task,
    instances: [nextInstance, ...located.task.instances],
  };
  const goalsWithInstance = upsertGoalTaskInstanceSnapshot(goals, {
    goal: located.goal,
    subGoal: located.subGoal,
    task: taskWithInstance,
    instance: nextInstance,
  });
  const startedGoals = markGoalInstanceRunStarted(goalsWithInstance, {
    taskId: located.task.id,
    instanceId: nextInstance.id,
    requestId,
    runtimeEnvId: body.runtimeEnv.id,
    permissionMode: body.runtimeEnv.permissionMode,
    workingDirectory: taskWorkspaceDir,
  });
  const record: TaskFeedbackRecord = {
    id: body.feedbackId || `feedback-${Date.now()}`,
    sourceMessageId: body.sourceMessageId,
    userMessage: body.message,
    decision: "rerun",
    assistantMessage: judge.assistantMessage,
    revisionContext: judge.revisionContext,
    createdAt,
    rerunInstanceId: nextInstance.id,
  };
  const goalsWithFeedback = updateFeedbackRecord(startedGoals, located.task.id, located.instance.id, record);
  writeGoalsProjection(goalsWithFeedback);
  const latest = findTaskRef(goalsWithFeedback, {
    ...body.taskRef,
    instanceId: nextInstance.id,
  });
  const queuedInstance = latest?.instance ?? nextInstance;
  const queuedTask = latest?.task ?? taskWithInstance;
  const progress = buildQueuedProgress({
    requestId,
    goal: located.goal,
    task: queuedTask,
    instance: queuedInstance,
    message: "已收到反馈，正在按反馈重新执行任务。",
  });
  const attempt = startTaskAttempt({
    goal: located.goal,
    subGoal: located.subGoal,
    task: queuedTask,
    instance: queuedInstance,
    runtimeEnv: body.runtimeEnv,
    triggerSource: "feedback_rerun",
    requestId,
    conversationWorkspaceDir: workspace.workspaceDir,
    taskWorkspaceDir,
    resumeContext: revisionContext,
  });
  if (attempt.outcome !== "queued") {
    return NextResponse.json({
      decision: attempt.outcome === "awaiting_user" ? "rerun" : "clarify",
      assistantMessage:
        attempt.outcome === "awaiting_user"
          ? "已收到反馈，但重跑任务需要先补充关键信息。"
          : attempt.outcome === "already_running"
            ? "我已经在按这条任务结果的反馈进行修订执行，先继续跟进当前修订任务。"
            : attempt.reason,
      reason: "reason" in attempt ? attempt.reason : undefined,
      progress: "progress" in attempt ? attempt.progress : undefined,
      taskInstanceId: attempt.taskInstanceId,
    });
  }
  updateGoalRuntimeJobExecution(`job-${queuedInstance.id}`, {
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
  return NextResponse.json({
    decision: "rerun",
    assistantMessage: judge.assistantMessage,
    reason: judge.reason,
    progress,
    logs: [],
    trajectory: [],
    taskInstanceId: queuedInstance.id,
    taskCardMessage: {
      content: `已根据你的反馈重新执行「${located.task.title.replace(/^任务\d+：/, "")}」。`,
      taskRef: {
        goalId: located.goal.id,
        subGoalId: located.subGoal.id,
        taskId: located.task.id,
        instanceId: queuedInstance.id,
      },
      taskSnapshot: {
        task: queuedTask,
        instance: queuedInstance,
      },
    },
  });
}
