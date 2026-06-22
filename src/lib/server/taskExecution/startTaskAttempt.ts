import { createGeneratedInstance } from "@/lib/goalFactory";
import { normalizeGoalId, normalizeInstanceId, normalizeSubGoalId, normalizeTaskId } from "@/lib/opaqueIds";
import { composeGoalsWithRuntimeJobs } from "@/lib/server/runtime/instanceComposition";
import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import {
  disableTaskAutoRunProjection,
  enqueueGoalRuntimeJob,
  persistTaskInstanceProjection,
  updateGoalRuntimeJobExecution,
} from "@/lib/server/services/goalRuntimeService";
import { resolveAdmitDecision } from "@/lib/server/taskExecution/contextResolver";
import { readinessFromContext } from "@/lib/server/taskExecution/readinessAdapter";
import {
  createPreExecutionAwaitingProgress,
  createPreExecutionBlocker,
  createPreExecutionInteractionRequirement,
  createPreExecutionTaskResult,
} from "@/lib/server/taskExecution/preExecutionBlocker";
import {
  getLatestOpenRuntimeJobByTaskId,
  getRuntimeJobByTaskInstanceId,
  type RuntimeJobRecord,
} from "@/lib/server/repositories/runtimeJobsRepository";
import type { GoalServerProgress } from "@/types/goalTelemetry";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

type TriggerSource = "user" | "scheduler" | "feedback_rerun" | "resume_after_block";

type StartTaskAttemptInput = {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance?: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
  triggerSource: TriggerSource;
  requestId: string;
  conversationWorkspaceDir?: string;
  taskWorkspaceDir?: string;
  resumeContext?: string;
};

export type StartTaskAttemptResult =
  | {
      schemaVersion: 1;
      outcome: "queued";
      requestId: string;
      taskInstanceId: string;
      createdNewInstance: boolean;
    }
  | {
      schemaVersion: 1;
      outcome: "awaiting_user";
      requestId: string;
      taskInstanceId: string;
      createdNewInstance: boolean;
      reason: string;
      progress: GoalServerProgress;
      waitingReason: string;
    }
  | {
      schemaVersion: 1;
      outcome: "already_running";
      requestId?: string;
      taskInstanceId: string;
    }
  | {
      schemaVersion: 1;
      outcome: "already_completed";
      requestId?: string;
      taskInstanceId: string;
    }
  | {
      schemaVersion: 1;
      outcome: "blocked_config";
      taskInstanceId?: string;
      reason: string;
    };

function locateLatestTask(input: StartTaskAttemptInput) {
  // allow-raw-goals-snapshot: 启动写路径仍读取 raw projection 作为 mutation 基准；执行态准入必须走
  // composeGoalsWithRuntimeJobs，否则 raw 快照里的 pending/paused 会把已 completed 的上游依赖误判为未完成。
  const currentGoals = readGoalsSnapshot([input.goal]);
  const goalId = normalizeGoalId(input.goal.id);
  const subGoalId = normalizeSubGoalId(input.subGoal.id);
  const taskId = normalizeTaskId(input.task.id);
  const writeGoal = currentGoals.find((goal) => normalizeGoalId(goal.id) === goalId) ?? input.goal;
  const writeSubGoal = writeGoal.subGoals.find((subGoal) => normalizeSubGoalId(subGoal.id) === subGoalId) ?? input.subGoal;
  const writeTask = writeSubGoal.tasks.find((task) => normalizeTaskId(task.id) === taskId) ?? input.task;
  const composedGoals = composeGoalsWithRuntimeJobs(currentGoals);
  const latestGoal = composedGoals.find((goal) => normalizeGoalId(goal.id) === goalId) ?? input.goal;
  const latestSubGoal = latestGoal.subGoals.find((subGoal) => normalizeSubGoalId(subGoal.id) === subGoalId) ?? input.subGoal;
  const latestTask = latestSubGoal.tasks.find((task) => normalizeTaskId(task.id) === taskId) ?? input.task;
  return { currentGoals, writeGoal, writeSubGoal, writeTask, latestGoal, latestSubGoal, latestTask };
}

function latestInstanceForAttempt(input: {
  task: Task;
  instance?: TaskInstance;
  triggerSource: TriggerSource;
}) {
  if (input.instance) {
    const instanceId = normalizeInstanceId(input.instance.id);
    return input.task.instances.find((candidate) => normalizeInstanceId(candidate.id) === instanceId) ?? input.instance;
  }
  const now = new Date().toISOString();
  const next = createGeneratedInstance(input.task, now);
  return input.triggerSource === "scheduler"
    ? next
    : {
        ...next,
        intro: `用户手动发起执行“${input.task.title.replace(/^任务\d+：/, "")}”。`,
      };
}

function isOpenJob(job: RuntimeJobRecord | null) {
  return Boolean(job && (job.status === "queued" || job.status === "running" || job.status === "awaiting_user"));
}

/**
 * 终态护栏判定：该实例对应的 runtime job 是否已 completed。
 *
 * 权威来源是 runtime_jobs（不是 goals 投影）——线上诊断发现投影里实例可能仍是
 * pending/progress=0（投影滞后），而 job 早已 completed。pause-all/resume-all 与
 * 调度器都不该把这种"已完成"的一次性任务重新拉起。
 */
function isCompletedJob(job: RuntimeJobRecord | null) {
  return job?.status === "completed";
}

function persistInstanceSnapshot(input: {
  goals: Goal[];
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
}) {
  return persistTaskInstanceProjection({
    goals: input.goals,
    goal: input.goal,
    subGoal: input.subGoal,
    task: input.task,
    instance: input.instance,
  });
}

function disableAutoRunIfNeeded(goals: Goal[], triggerSource: TriggerSource, taskId: string) {
  if (triggerSource !== "scheduler") return;
  disableTaskAutoRunProjection({ goals, taskId });
}

function runtimeJobEventSource(triggerSource: TriggerSource) {
  if (triggerSource === "feedback_rerun") return "feedback";
  if (triggerSource === "resume_after_block") return "resume";
  return triggerSource;
}

function enqueueRuntimeJob(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
  triggerSource: TriggerSource;
  requestId: string;
  conversationWorkspaceDir?: string;
  taskWorkspaceDir?: string;
  resumeContext?: string;
}) {
  return enqueueGoalRuntimeJob(
    {
      goal: input.goal,
      subGoal: input.subGoal,
      task: input.task,
      instance: input.instance,
      runtimeEnv: input.runtimeEnv,
      conversationWorkspaceDir: input.conversationWorkspaceDir,
      taskWorkspaceDir: input.taskWorkspaceDir,
      resumeContext: input.resumeContext,
    },
    { requestId: input.requestId, eventSource: runtimeJobEventSource(input.triggerSource) },
  );
}

function isMissingUserInputOnly(decision: ReturnType<typeof resolveAdmitDecision>) {
  return (
    decision.readiness.blockers.length > 0 &&
    decision.readiness.blockers.every((blocker) => blocker.kind === "missing_user_input")
  );
}

export function startTaskAttempt(input: StartTaskAttemptInput): StartTaskAttemptResult {
  const { currentGoals, writeGoal, writeSubGoal, writeTask, latestGoal, latestSubGoal, latestTask } = locateLatestTask(input);
  const conversationId = latestGoal.conversationId;
  if (!conversationId) {
    throw new Error("任务缺少 conversationId，无法创建隔离 workspace");
  }
  const instance = latestInstanceForAttempt({
    task: latestTask,
    instance: input.instance,
    triggerSource: input.triggerSource,
  });
  const taskLevelOpenJob = getLatestOpenRuntimeJobByTaskId(latestTask.id);
  if (
    taskLevelOpenJob &&
    (!taskLevelOpenJob.taskInstanceId || normalizeInstanceId(taskLevelOpenJob.taskInstanceId) !== normalizeInstanceId(instance.id))
  ) {
    if (taskLevelOpenJob.status === "awaiting_user" && taskLevelOpenJob.progress) {
      return {
        schemaVersion: 1,
        outcome: "awaiting_user",
        requestId: taskLevelOpenJob.requestId ?? input.requestId,
        taskInstanceId: taskLevelOpenJob.taskInstanceId ?? instance.id,
        createdNewInstance: false,
        reason:
          (taskLevelOpenJob.result?.awaitingReason as string | undefined) ||
          (taskLevelOpenJob.progress.resultPayload?.awaitingReason as string | undefined) ||
          "等待用户补充信息。",
        progress: taskLevelOpenJob.progress,
        waitingReason:
          (taskLevelOpenJob.result?.awaitingReason as string | undefined) ||
          (taskLevelOpenJob.progress.resultPayload?.awaitingReason as string | undefined) ||
          "等待用户补充信息。",
      };
    }
    return {
      schemaVersion: 1,
      outcome: "already_running",
      requestId: taskLevelOpenJob.requestId,
      taskInstanceId: taskLevelOpenJob.taskInstanceId ?? instance.id,
    };
  }
  const existing = getRuntimeJobByTaskInstanceId(instance.id);
  if (isOpenJob(existing)) {
    if (existing?.status === "awaiting_user" && existing.progress) {
      return {
        schemaVersion: 1,
        outcome: "awaiting_user",
        requestId: existing.requestId ?? input.requestId,
        taskInstanceId: instance.id,
        createdNewInstance: false,
        reason:
          (existing.result?.awaitingReason as string | undefined) ||
          (existing.progress.resultPayload?.awaitingReason as string | undefined) ||
          "等待用户补充信息。",
        progress: existing.progress,
        waitingReason:
          (existing.result?.awaitingReason as string | undefined) ||
          (existing.progress.resultPayload?.awaitingReason as string | undefined) ||
          "等待用户补充信息。",
      };
    }
    return {
      schemaVersion: 1,
      outcome: "already_running",
      requestId: existing?.requestId,
      taskInstanceId: instance.id,
    };
  }

  // 终态护栏：目标实例的 job 已 completed 时直接空操作，不重建 blocker / 不重新 admit。
  // feedback_rerun 始终传入全新实例（此时该实例尚无 job），天然豁免；
  // 命中的是 resume-all / 调度器 / 手动重发把"同一个已完成实例"再拉起的场景——
  // 线上 bug 正是 pause-all→resume-all 把已完成的一次性任务又拉起重新追问。
  if (isCompletedJob(existing)) {
    return {
      schemaVersion: 1,
      outcome: "already_completed",
      requestId: existing?.requestId,
      taskInstanceId: instance.id,
    };
  }

  const decision = resolveAdmitDecision({
    conversationId,
    goal: latestGoal,
    subGoal: latestSubGoal,
    task: latestTask,
    resumeContext: input.resumeContext,
  });

  const instanceId = normalizeInstanceId(instance.id);
  const createdNewInstance = !latestTask.instances.some((candidate) => normalizeInstanceId(candidate.id) === instanceId);

  if (decision.readiness.state !== "ready") {
    const blockingKinds = new Set(decision.readiness.blockers.map((blocker) => blocker.kind));
    if (blockingKinds.has("cycle") || blockingKinds.has("config")) {
      disableAutoRunIfNeeded(currentGoals, input.triggerSource, latestTask.id);
      return {
        schemaVersion: 1,
        outcome: "blocked_config",
        taskInstanceId: instance.id,
        reason: decision.readiness.summary,
      };
    }
    if (!isMissingUserInputOnly(decision)) {
      return {
        schemaVersion: 1,
        outcome: "blocked_config",
        taskInstanceId: instance.id,
        reason: decision.readiness.summary,
      };
    }
    const readiness = readinessFromContext(decision);
    const interactionRequirement = createPreExecutionInteractionRequirement(readiness);
    const blocker = createPreExecutionBlocker({
      executionId: input.requestId,
      taskId: latestTask.id,
      instanceId: instance.id,
      interactionRequirement,
    });
    const taskResult = createPreExecutionTaskResult({
      task: latestTask,
      instance,
      readiness,
      interactionRequirement,
    });
    const progress = createPreExecutionAwaitingProgress({
      requestId: input.requestId,
      goalId: latestGoal.id,
      task: latestTask,
      instance,
      readiness,
      interactionRequirement,
      blocker,
      taskResult,
      trajectory: [],
    });

    persistInstanceSnapshot({
      goals: currentGoals,
      goal: writeGoal,
      subGoal: writeSubGoal,
      task: writeTask,
      instance,
    });

    enqueueRuntimeJob({
      goal: latestGoal,
      subGoal: latestSubGoal,
      task: latestTask,
      instance,
      runtimeEnv: input.runtimeEnv,
      triggerSource: input.triggerSource,
      requestId: input.requestId,
      conversationWorkspaceDir: input.conversationWorkspaceDir,
      taskWorkspaceDir: input.taskWorkspaceDir,
      resumeContext: input.resumeContext,
    });
    updateGoalRuntimeJobExecution(`job-${instance.id}`, {
      status: "awaiting_user",
      progress,
      logs: [],
      trajectory: [],
      blocker,
      result:
        progress.resultPayload && typeof progress.resultPayload === "object"
          ? progress.resultPayload
          : null,
      finishedAt: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
    });

    return {
      schemaVersion: 1,
      outcome: "awaiting_user",
      requestId: input.requestId,
      taskInstanceId: instance.id,
      createdNewInstance,
      reason: interactionRequirement.reason,
      progress,
      waitingReason: interactionRequirement.reason,
    };
  }

  persistInstanceSnapshot({
    goals: currentGoals,
    goal: writeGoal,
    subGoal: writeSubGoal,
    task: writeTask,
    instance,
  });

  enqueueRuntimeJob({
    goal: latestGoal,
    subGoal: latestSubGoal,
    task: latestTask,
    instance,
    runtimeEnv: input.runtimeEnv,
    triggerSource: input.triggerSource,
    requestId: input.requestId,
    conversationWorkspaceDir: input.conversationWorkspaceDir,
    taskWorkspaceDir: input.taskWorkspaceDir,
    resumeContext: input.resumeContext,
  });

  return {
    schemaVersion: 1,
    outcome: "queued",
    requestId: input.requestId,
    taskInstanceId: instance.id,
    createdNewInstance,
  };
}
