import {
  createQueuedRuntimeJobInternal,
  updateRuntimeJobExecutionInternal,
} from "@/lib/server/repositories/runtimeJobsRepository";
import {
  findThreadById,
  ThreadRevisionMismatchError,
  updateThread,
} from "@/lib/server/repositories/threadsRepository";
import {
  markGoalInstanceStatusSnapshot,
  markGoalTaskNotificationDeliveredSnapshot,
  setTaskAutoRunDisabled,
  syncGoalInstanceFromProgress,
  upsertGoalTaskInstanceSnapshot,
} from "@/lib/server/runtime/goalStateSnapshot";
import {
  readGoalsSnapshotMeta,
  upsertGoalsSnapshot,
  type SnapshotWriteResult,
} from "@/lib/server/runtime/stateSnapshot";
import type { RuntimeJobPayload, RuntimeJobRecord } from "@/lib/server/repositories/runtimeJobsRepository";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type { Goal, SubGoal, Task, TaskInstance, TaskInstanceStatus } from "@/types/kiki";

export type GoalRuntimeEventSource = "scheduler" | "user" | "feedback" | "resume";

const GOALS_PROJECTION_MAX_RETRIES = 3;

export class GoalsProjectionConflictError extends Error {
  constructor(message = "goals snapshot 写入冲突，请重试") {
    super(message);
    this.name = "GoalsProjectionConflictError";
  }
}

export function requestThreadGovernanceTick(threadId: string, now = new Date()) {
  const thread = findThreadById(threadId);
  if (!thread || thread.status !== "active") return false;
  const nextTickAtMs = thread.nextTickAt ? new Date(thread.nextTickAt).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isFinite(nextTickAtMs) && nextTickAtMs <= now.getTime()) return false;
  try {
    updateThread(thread.id, { nextTickAt: now.toISOString() }, thread.revision);
    return true;
  } catch (error) {
    if (error instanceof ThreadRevisionMismatchError) return false;
    throw error;
  }
}

export function writeGoalsProjection(goals: Goal[], expectedRevision?: number): SnapshotWriteResult {
  return upsertGoalsSnapshot(goals, expectedRevision);
}

export function materializeGoalsProjection(goals: Goal[], expectedRevision?: number): SnapshotWriteResult {
  return writeGoalsProjection(goals, expectedRevision);
}

export function mutateGoalsProjection(
  mutator: (goals: Goal[]) => Goal[],
  input?: { maxRetries?: number; fallbackGoals?: Goal[] },
) {
  const maxRetries = input?.maxRetries ?? GOALS_PROJECTION_MAX_RETRIES;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const snapshot = readGoalsSnapshotMeta(input?.fallbackGoals ?? []);
    const nextGoals = mutator(snapshot.value);
    const result = writeGoalsProjection(nextGoals, snapshot.revision);
    if (result.ok) return nextGoals;
  }
  throw new GoalsProjectionConflictError();
}

export function persistTaskInstanceProjection(input: {
  goals: Goal[];
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
}) {
  return mutateGoalsProjection((goals) => upsertGoalTaskInstanceSnapshot(goals, {
    goal: input.goal,
    subGoal: input.subGoal,
    task: input.task,
    instance: input.instance,
  }), { fallbackGoals: input.goals });
}

export function disableTaskAutoRunProjection(input: {
  goals: Goal[];
  taskId: string;
}) {
  return mutateGoalsProjection((goals) => setTaskAutoRunDisabled(goals, input.taskId, true), {
    fallbackGoals: input.goals,
  });
}

export function syncTaskInstanceProgressProjection(input: {
  goals: Goal[];
  taskId: string;
  instanceId: string;
  progress: GoalServerProgress | null;
  logs?: GoalServerLogEntry[];
  trajectory?: ExecutionTrajectoryStep[];
}) {
  return mutateGoalsProjection((goals) => syncGoalInstanceFromProgress(goals, {
    taskId: input.taskId,
    instanceId: input.instanceId,
    progress: input.progress,
    logs: input.logs,
    trajectory: input.trajectory,
  }), { fallbackGoals: input.goals });
}

export function transitionTaskInstanceProjection(input: {
  goals: Goal[];
  taskId: string;
  instanceId: string;
  status: TaskInstanceStatus;
  reason?: string;
}) {
  return mutateGoalsProjection((goals) => markGoalInstanceStatusSnapshot(goals, {
    taskId: input.taskId,
    instanceId: input.instanceId,
    status: input.status,
    reason: input.reason,
  }), { fallbackGoals: input.goals });
}

export function markTaskNotificationDeliveredProjection(input: {
  goals: Goal[];
  taskId: string;
  instanceId: string;
  inboxItemId?: string;
  conversationMessageId?: string;
  notificationSequence?: number;
}) {
  return mutateGoalsProjection((goals) => markGoalTaskNotificationDeliveredSnapshot(goals, {
    taskId: input.taskId,
    instanceId: input.instanceId,
    inboxItemId: input.inboxItemId,
    conversationMessageId: input.conversationMessageId,
    notificationSequence: input.notificationSequence,
  }), { fallbackGoals: input.goals });
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
  const next = updateRuntimeJobExecutionInternal(jobId, updates);
  if (next && (updates.status === "completed" || updates.status === "failed")) {
    requestThreadGovernanceTick(next.payload.subGoal.id, new Date(next.updatedAt));
  }
  return next;
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
