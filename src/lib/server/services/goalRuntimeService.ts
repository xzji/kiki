import {
  createQueuedRuntimeJobInternal,
  updateRuntimeJobExecutionInternal,
} from "@/lib/server/repositories/runtimeJobsRepository";
import {
  markGoalInstanceStatusSnapshot,
  markGoalTaskNotificationDeliveredSnapshot,
  setTaskAutoRunDisabled,
  syncGoalInstanceFromProgress,
  upsertGoalTaskInstanceSnapshot,
} from "@/lib/server/runtime/goalStateSnapshot";
import { upsertGoalsSnapshot, type SnapshotWriteResult } from "@/lib/server/runtime/stateSnapshot";
import type { RuntimeJobPayload, RuntimeJobRecord } from "@/lib/server/repositories/runtimeJobsRepository";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type { Goal, SubGoal, Task, TaskInstance, TaskInstanceStatus } from "@/types/kiki";

export type GoalRuntimeEventSource = "scheduler" | "user" | "feedback" | "resume";

export function writeGoalsProjection(goals: Goal[], expectedRevision?: number): SnapshotWriteResult {
  return upsertGoalsSnapshot(goals, expectedRevision);
}

export function materializeGoalsProjection(goals: Goal[], expectedRevision?: number): SnapshotWriteResult {
  return writeGoalsProjection(goals, expectedRevision);
}

export function persistTaskInstanceProjection(input: {
  goals: Goal[];
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
}) {
  const nextGoals = upsertGoalTaskInstanceSnapshot(input.goals, {
    goal: input.goal,
    subGoal: input.subGoal,
    task: input.task,
    instance: input.instance,
  });
  writeGoalsProjection(nextGoals);
  return nextGoals;
}

export function disableTaskAutoRunProjection(input: {
  goals: Goal[];
  taskId: string;
}) {
  const nextGoals = setTaskAutoRunDisabled(input.goals, input.taskId, true);
  writeGoalsProjection(nextGoals);
  return nextGoals;
}

export function syncTaskInstanceProgressProjection(input: {
  goals: Goal[];
  taskId: string;
  instanceId: string;
  progress: GoalServerProgress | null;
  logs?: GoalServerLogEntry[];
  trajectory?: ExecutionTrajectoryStep[];
}) {
  const nextGoals = syncGoalInstanceFromProgress(input.goals, {
    taskId: input.taskId,
    instanceId: input.instanceId,
    progress: input.progress,
    logs: input.logs,
    trajectory: input.trajectory,
  });
  writeGoalsProjection(nextGoals);
  return nextGoals;
}

export function transitionTaskInstanceProjection(input: {
  goals: Goal[];
  taskId: string;
  instanceId: string;
  status: TaskInstanceStatus;
  reason?: string;
}) {
  const nextGoals = markGoalInstanceStatusSnapshot(input.goals, {
    taskId: input.taskId,
    instanceId: input.instanceId,
    status: input.status,
    reason: input.reason,
  });
  writeGoalsProjection(nextGoals);
  return nextGoals;
}

export function markTaskNotificationDeliveredProjection(input: {
  goals: Goal[];
  taskId: string;
  instanceId: string;
  inboxItemId?: string;
  conversationMessageId?: string;
  notificationSequence?: number;
}) {
  const nextGoals = markGoalTaskNotificationDeliveredSnapshot(input.goals, {
    taskId: input.taskId,
    instanceId: input.instanceId,
    inboxItemId: input.inboxItemId,
    conversationMessageId: input.conversationMessageId,
    notificationSequence: input.notificationSequence,
  });
  writeGoalsProjection(nextGoals);
  return nextGoals;
}

export function enqueueGoalRuntimeJob(
  payload: RuntimeJobPayload,
  input?: { requestId?: string; eventSource?: GoalRuntimeEventSource },
): RuntimeJobRecord {
  return createQueuedRuntimeJobInternal(payload, input);
}

export function updateGoalRuntimeJobExecution(
  jobId: string,
  updates: Parameters<typeof updateRuntimeJobExecutionInternal>[1],
) {
  return updateRuntimeJobExecutionInternal(jobId, updates);
}

export function requeueBlockedGoalRuntimeJob(input: {
  job: RuntimeJobRecord;
  taskWorkspaceDir?: string;
  resumeContext: string;
  progress: GoalServerProgress;
  trajectory: ExecutionTrajectoryStep[];
  result: Record<string, unknown>;
}) {
  return updateRuntimeJobExecutionInternal(input.job.id, {
    status: "queued",
    payload: {
      ...input.job.payload,
      taskWorkspaceDir: input.taskWorkspaceDir,
      resumeContext: input.resumeContext,
    },
    progress: input.progress,
    trajectory: input.trajectory,
    blocker: null,
    result: input.result,
    finishedAt: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
  });
}
