import { createGeneratedInstance } from "@/lib/goalFactory";
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
      outcome: "blocked_config";
      taskInstanceId?: string;
      reason: string;
    };

function locateLatestTask(input: StartTaskAttemptInput) {
  const currentGoals = readGoalsSnapshot([input.goal]);
  const latestGoal = currentGoals.find((goal) => goal.id === input.goal.id) ?? input.goal;
  const latestSubGoal = latestGoal.subGoals.find((subGoal) => subGoal.id === input.subGoal.id) ?? input.subGoal;
  const latestTask = latestSubGoal.tasks.find((task) => task.id === input.task.id) ?? input.task;
  return { currentGoals, latestGoal, latestSubGoal, latestTask };
}

function latestInstanceForAttempt(input: {
  task: Task;
  instance?: TaskInstance;
  triggerSource: TriggerSource;
}) {
  if (input.instance) {
    return input.task.instances.find((candidate) => candidate.id === input.instance?.id) ?? input.instance;
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
  const { currentGoals, latestGoal, latestSubGoal, latestTask } = locateLatestTask(input);
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
  if (taskLevelOpenJob && taskLevelOpenJob.taskInstanceId !== instance.id) {
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

  const decision = resolveAdmitDecision({
    conversationId,
    goal: latestGoal,
    subGoal: latestSubGoal,
    task: latestTask,
  });

  const createdNewInstance = !latestTask.instances.some((candidate) => candidate.id === instance.id);

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
      goal: latestGoal,
      subGoal: latestSubGoal,
      task: latestTask,
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
    goal: latestGoal,
    subGoal: latestSubGoal,
    task: latestTask,
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
