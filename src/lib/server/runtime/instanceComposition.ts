import { normalizeInstanceId } from "@/lib/opaqueIds";
import { getGoalEventsByInstanceIds } from "@/lib/server/repositories/goalEventLogRepository";
import {
  listRuntimeJobsByInstanceIds,
  type RuntimeJobRecord,
  type RuntimeJobStatus,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { listTaskNotificationStatesByInstanceIds } from "@/lib/server/repositories/taskNotificationStateRepository";
import { deriveTaskInstanceFromProgress } from "@/lib/server/runtime/goalStateSnapshot";
import { readGoalsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import { computeActiveExecutionDuration } from "@/lib/taskExecutionDuration";
import type { GoalEventRecord } from "@/types/goalEventLog";
import type { Goal, Task, TaskExecutionPhase, TaskInstance, TaskInstanceStatus } from "@/types/kiki";

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

function executionPhaseFromStatus(status: TaskInstanceStatus): TaskExecutionPhase {
  if (status === "completed") return "completed";
  if (status === "awaiting_user") return "awaiting_user";
  if (status === "in_progress") return "running";
  if (status === "error") return "failed";
  if (status === "paused") return "cancelled";
  if (status === "terminated") return "cancelled";
  return "queued";
}

function collectInstanceIds(goals: Goal[]) {
  const ids: string[] = [];
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        for (const instance of task.instances) {
          ids.push(instance.id);
        }
      }
    }
  }
  return ids;
}

function indexJobsByInstanceId(jobs: RuntimeJobRecord[]) {
  const byInstanceId = new Map<string, RuntimeJobRecord>();
  for (const job of jobs) {
    const instanceId = job.taskInstanceId ?? job.payload.instance.id;
    const normalizedInstanceId = normalizeInstanceId(instanceId);
    const existing = byInstanceId.get(normalizedInstanceId);
    if (!existing || new Date(job.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
      byInstanceId.set(normalizedInstanceId, job);
    }
  }
  return byInstanceId;
}

function enrichInstanceExecutionDuration(input: {
  instance: TaskInstance;
  status: TaskInstanceStatus;
  durationEvents?: GoalEventRecord[];
  startedAt?: string;
  finishedAt?: string;
  lastUpdatedAt?: string;
}) {
  const executionStartedAt =
    input.startedAt ?? input.instance.execution?.startedAt ?? input.instance.createdAt;
  const activeExecution = computeActiveExecutionDuration({
    events: input.durationEvents ?? [],
    currentStatus: input.status,
    startedAt: executionStartedAt,
    finishedAt: input.finishedAt ?? input.instance.execution?.finishedAt,
    lastUpdatedAt: input.lastUpdatedAt ?? input.instance.execution?.lastUpdatedAt,
  });
  return {
    ...input.instance,
    status: input.status,
    execution: {
      ...input.instance.execution,
      phase: executionPhaseFromStatus(input.status),
      status: input.status,
      startedAt: executionStartedAt,
      activeDurationMs: activeExecution.activeDurationMs,
      activeSince: activeExecution.activeSince,
      finishedAt: input.finishedAt ?? input.instance.execution?.finishedAt,
      lastUpdatedAt: input.lastUpdatedAt ?? input.instance.execution?.lastUpdatedAt,
    },
  } satisfies TaskInstance;
}

function composeInstanceFromJob(input: {
  task: Task;
  instance: TaskInstance;
  job: RuntimeJobRecord;
  notification?: TaskInstance["notification"];
  durationEvents?: GoalEventRecord[];
}) {
  const projectedStatus = runtimeJobStatusToTaskInstanceStatus(input.job.status, input.job.lastError);
  const nextStatus =
    input.job.status === "cancelled" && input.instance.status === "terminated"
      ? "terminated"
      : projectedStatus;
  const resultProgress = input.job.result
    ? {
        requestId: input.job.requestId ?? `goal-task-${input.job.id}`,
        scope: "goal_task_execute" as const,
        status: input.job.status === "failed" ? "failed" as const : "completed" as const,
        phase: input.job.status === "failed" ? "error" as const : "completed" as const,
        message:
          typeof input.job.result.finalMessage === "string"
            ? input.job.result.finalMessage
            : input.job.status === "failed"
              ? input.job.lastError ?? "任务执行失败"
              : "任务执行完成",
        startedAt: input.job.startedAt ?? input.job.createdAt,
        updatedAt: input.job.updatedAt,
        finishedAt: input.job.finishedAt,
        error: input.job.status === "failed" ? input.job.lastError : undefined,
        goalId: input.job.goalId,
        taskId: input.job.taskId,
        taskInstanceId: input.job.taskInstanceId,
        resultPayload: input.job.result,
      }
    : null;
  const baseInstance: TaskInstance = {
    ...input.instance,
    notification: input.notification ?? input.instance.notification,
    runner: {
      ...input.instance.runner,
      requestId: input.job.requestId ?? input.instance.runner?.requestId,
      runtimeEnvId: input.job.runtimeEnvId ?? input.instance.runner?.runtimeEnvId,
      attemptCount: input.instance.runner?.attemptCount ?? 1,
      lastAttemptAt: input.job.startedAt ?? input.job.updatedAt,
    },
  };
  const progress = input.job.progress ?? resultProgress;
  const derived = progress
    ? deriveTaskInstanceFromProgress({
        task: input.task,
        instance: baseInstance,
        progress,
        logs: input.job.logs,
        trajectory: input.job.trajectory,
      })
    : baseInstance;
  const executionStartedAt = derived.execution?.startedAt ?? input.job.startedAt ?? input.instance.createdAt;
  const activeExecution = computeActiveExecutionDuration({
    events: input.durationEvents ?? [],
    currentStatus: nextStatus,
    startedAt: executionStartedAt,
    finishedAt: input.job.finishedAt ?? derived.execution?.finishedAt,
    lastUpdatedAt: input.job.updatedAt,
  });
  return {
    ...derived,
    status: nextStatus,
    execution: {
      ...derived.execution,
      phase: executionPhaseFromStatus(nextStatus),
      status: nextStatus,
      startedAt: executionStartedAt,
      activeDurationMs: activeExecution.activeDurationMs,
      activeSince: activeExecution.activeSince,
      finishedAt: input.job.finishedAt ?? derived.execution?.finishedAt,
      lastUpdatedAt: input.job.updatedAt,
      errorMessage: nextStatus === "error" ? input.job.lastError ?? derived.execution?.errorMessage : derived.execution?.errorMessage,
    },
    blocker: input.job.blocker ?? derived.blocker,
    trajectory: input.job.trajectory.length ? input.job.trajectory : derived.trajectory,
    notification: input.notification ?? derived.notification,
  } satisfies TaskInstance;
}

export function composeGoalsWithRuntimeJobs(goals: Goal[]) {
  const instanceIds = collectInstanceIds(goals);
  if (instanceIds.length === 0) return goals;
  const jobsByInstanceId = indexJobsByInstanceId(listRuntimeJobsByInstanceIds(instanceIds));
  const eventsByInstanceId = getGoalEventsByInstanceIds(instanceIds);
  const notificationsByInstanceId = new Map(
    listTaskNotificationStatesByInstanceIds(instanceIds).map((record) => [
      normalizeInstanceId(record.instanceId),
      record.notification,
    ]),
  );
  if (jobsByInstanceId.size === 0 && notificationsByInstanceId.size === 0 && eventsByInstanceId.size === 0) {
    return goals;
  }

  return goals.map((goal) => ({
    ...goal,
    subGoals: goal.subGoals.map((subGoal) => ({
      ...subGoal,
      tasks: subGoal.tasks.map((task) => ({
        ...task,
        instances: task.instances.map((instance) => {
          const instanceId = normalizeInstanceId(instance.id);
          const notification = notificationsByInstanceId.get(instanceId);
          const job = jobsByInstanceId.get(instanceId);
          const durationEvents = eventsByInstanceId.get(instanceId);
          if (!job) {
            const enriched = enrichInstanceExecutionDuration({
              instance: notification ? { ...instance, notification } : instance,
              status: instance.status,
              durationEvents,
            });
            return enriched;
          }
          return composeInstanceFromJob({
            task,
            instance,
            job,
            notification,
            durationEvents,
          });
        }),
      })),
    })),
  }));
}

export function readComposedGoalsSnapshot(fallback: Goal[]) {
  const meta = readGoalsSnapshotMeta(fallback);
  return composeGoalsWithRuntimeJobs(meta.value);
}

export function readComposedGoalsSnapshotMeta(fallback: Goal[]) {
  const meta = readGoalsSnapshotMeta(fallback);
  return {
    ...meta,
    value: composeGoalsWithRuntimeJobs(meta.value),
  };
}
