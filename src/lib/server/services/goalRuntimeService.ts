import {
  createIdempotencyKey,
  normalizeInstanceId,
  normalizeTaskId,
} from "@/lib/opaqueIds";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import { appendGovernanceEvent } from "@/lib/server/repositories/governanceEventOutboxRepository";
import {
  markTaskNotificationDeliveredState,
  upsertTaskNotificationStateFromProgress,
} from "@/lib/server/repositories/taskNotificationStateRepository";
import {
  createQueuedRuntimeJobInternal,
  listRuntimeJobsByStatuses,
  updateRuntimeJobExecutionInternal,
} from "@/lib/server/repositories/runtimeJobsRepository";
import {
  findThreadById,
  ThreadRevisionMismatchError,
  updateThread,
} from "@/lib/server/repositories/threadsRepository";
import {
  markGoalInstanceStatusSnapshot,
  setTaskAutoRunDisabled,
  upsertGoalTaskInstanceSnapshot,
} from "@/lib/server/runtime/goalStateSnapshot";
import {
  readGoalsSnapshotMeta,
  upsertGoalsSnapshot,
  type SnapshotWriteResult,
} from "@/lib/server/runtime/stateSnapshot";
import type {
  RuntimeJobPayload,
  RuntimeJobRecord,
  RuntimeJobStatus,
} from "@/lib/server/repositories/runtimeJobsRepository";
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

function isTerminationReason(reason?: string) {
  return Boolean(reason && /终止|terminate/i.test(reason));
}

function runtimeJobStatusToTaskInstanceStatus(status: RuntimeJobStatus, reason?: string): TaskInstanceStatus {
  switch (status) {
    case "running":
      return "in_progress";
    case "awaiting_user":
      return "awaiting_user";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "cancelled":
      return isTerminationReason(reason) ? "terminated" : "paused";
    case "queued":
    default:
      return "pending";
  }
}

function findTaskInstance(goals: Goal[], taskId: string, instanceId: string) {
  const normalizedTaskId = normalizeTaskId(taskId);
  const normalizedInstanceId = normalizeInstanceId(instanceId);
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        if (normalizeTaskId(task.id) !== normalizedTaskId) continue;
        const instance = task.instances.find((entry) => normalizeInstanceId(entry.id) === normalizedInstanceId);
        if (instance) return { goal, task, instance };
      }
    }
  }
  return null;
}

function appendInstanceStatusChangedEvent(input: {
  job: RuntimeJobRecord;
  previousStatus?: TaskInstanceStatus;
  nextStatus: TaskInstanceStatus;
  reason?: string;
  createdAt?: string;
}) {
  const goalId = input.job.goalId ?? input.job.payload.goal.id;
  const taskId = input.job.taskId ?? input.job.payload.task.id;
  const instanceId = input.job.taskInstanceId ?? input.job.payload.instance.id;
  return appendGoalEventOnce({
    goalId,
    taskId,
    instanceId,
    kind: "instance.status_changed",
    producedBy: "worker",
    idempotencyKey: createIdempotencyKey(
      "instance.status_changed.runtime_job",
      input.job.id,
      input.previousStatus ?? "unknown",
      input.nextStatus,
      input.job.updatedAt,
    ),
    createdAt: input.createdAt ?? input.job.updatedAt,
    payload: {
      previousStatus: input.previousStatus,
      nextStatus: input.nextStatus,
      requestId: input.job.requestId,
      reason: input.reason ?? input.job.lastError,
    },
  });
}

export function wakeThreadGovernanceLoop(threadId: string, now = new Date()) {
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

export function requestThreadGovernanceTick(threadId: string, now = new Date()) {
  const thread = findThreadById(threadId);
  if (!thread || thread.status !== "active") return false;
  const nextTickAtMs = thread.nextTickAt ? new Date(thread.nextTickAt).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isFinite(nextTickAtMs) && nextTickAtMs <= now.getTime()) return false;
  appendGovernanceEvent({
    eventType: "thread_governance_tick_requested",
    source: "manual",
    topicId: thread.topicId,
    threadId: thread.id,
    idempotencyKey: createIdempotencyKey("thread_governance_tick.request", thread.id, now.toISOString()),
    createdAt: now.toISOString(),
    payload: {
      requestedAt: now.toISOString(),
      reason: "thread governance tick requested",
    },
  });
  return true;
}

function appendTerminalTaskGovernanceEvent(input: {
  job: RuntimeJobRecord;
  status: "completed" | "failed";
}) {
  const eventType = input.status === "completed" ? "task_completed" : "task_failed";
  const source = input.status === "completed" ? "task_completed" : "task_failed";
  appendGovernanceEvent({
    eventType,
    source,
    topicId: input.job.goalId ?? input.job.payload.goal.id,
    threadId: input.job.payload.subGoal.id,
    taskId: input.job.taskId ?? input.job.payload.task.id,
    instanceId: input.job.taskInstanceId ?? input.job.payload.instance.id,
    idempotencyKey: createIdempotencyKey("governance.task_terminal", input.job.id, input.status),
    createdAt: input.job.updatedAt,
    payload: {
      runtimeJobId: input.job.id,
      requestId: input.job.requestId,
      status: input.status,
      reason: input.job.lastError,
    },
  });
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
  void input.taskId;
  void input.logs;
  void input.trajectory;
  return input.goals;
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

export function projectRuntimeJobStatusProjection(input: {
  job: RuntimeJobRecord;
  status?: RuntimeJobStatus;
  reason?: string;
  emitEvent?: boolean;
}) {
  const taskId = input.job.taskId ?? input.job.payload.task.id;
  const instanceId = input.job.taskInstanceId ?? input.job.payload.instance.id;
  const nextStatus = runtimeJobStatusToTaskInstanceStatus(input.status ?? input.job.status, input.reason ?? input.job.lastError);
  const currentGoals = readGoalsSnapshotMeta([]).value;
  const located = findTaskInstance(currentGoals, taskId, instanceId);
  const previousStatus = located?.instance.status;
  const shouldEmit = !located || previousStatus !== nextStatus;

  if (input.emitEvent !== false && shouldEmit) {
    appendInstanceStatusChangedEvent({
      job: input.job,
      previousStatus,
      nextStatus,
      reason: input.reason,
    });
  }

  return {
    projected: shouldEmit,
    previousStatus,
    nextStatus,
  };
}

export function reconcileRuntimeJobStatusProjections(input?: {
  statuses?: RuntimeJobStatus[];
  limit?: number;
}) {
  const jobs = listRuntimeJobsByStatuses({
    statuses: input?.statuses ?? ["queued", "running", "awaiting_user"],
    limit: input?.limit,
  });
  let projected = 0;
  for (const job of jobs) {
    const result = projectRuntimeJobStatusProjection({
      job,
      status: job.status,
      reason: "runtime job 状态对账",
    });
    if (result.projected) projected += 1;
  }
  return { checked: jobs.length, projected };
}

export function markTaskNotificationDeliveredProjection(input: {
  goals: Goal[];
  taskId: string;
  instanceId: string;
  inboxItemId?: string;
  conversationMessageId?: string;
  notificationSequence?: number;
}) {
  void input.goals;
  void input.taskId;
  markTaskNotificationDeliveredState({
    instanceId: input.instanceId,
    inboxItemId: input.inboxItemId,
    conversationMessageId: input.conversationMessageId,
    notificationSequence: input.notificationSequence,
  });
  return input.goals;
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
  if (next && updates.progress) {
    upsertTaskNotificationStateFromProgress({
      goalId: next.goalId,
      taskId: next.taskId,
      instance: next.payload.instance,
      progress: updates.progress,
    });
  }
  if (next && updates.status) {
    projectRuntimeJobStatusProjection({
      job: next,
      status: updates.status,
      reason: updates.lastError,
    });
  }
  if (next && (updates.status === "completed" || updates.status === "failed")) {
    appendTerminalTaskGovernanceEvent({
      job: next,
      status: updates.status,
    });
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
  return updateGoalRuntimeJobExecution(input.job.id, {
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
