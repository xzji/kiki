import { normalizeInstanceId } from "@/lib/opaqueIds";
import {
  listRuntimeJobsByInstanceIds,
  type RuntimeJobRecord,
  type RuntimeJobStatus,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { listTaskNotificationStatesByInstanceIds } from "@/lib/server/repositories/taskNotificationStateRepository";
import { deriveTaskInstanceFromProgress } from "@/lib/server/runtime/goalStateSnapshot";
import { readGoalsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import type { Goal, Task, TaskExecutionPhase, TaskInstance, TaskInstanceStatus } from "@/types/kiki";

function runtimeJobStatusToTaskInstanceStatus(status: RuntimeJobStatus): TaskInstanceStatus {
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
      return "paused";
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

function composeInstanceFromJob(input: {
  task: Task;
  instance: TaskInstance;
  job: RuntimeJobRecord;
  notification?: TaskInstance["notification"];
}) {
  const nextStatus = runtimeJobStatusToTaskInstanceStatus(input.job.status);
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
  const derived = input.job.progress
    ? deriveTaskInstanceFromProgress({
        task: input.task,
        instance: baseInstance,
        progress: input.job.progress,
        logs: input.job.logs,
        trajectory: input.job.trajectory,
      })
    : baseInstance;
  return {
    ...derived,
    status: nextStatus,
    execution: {
      ...derived.execution,
      phase: executionPhaseFromStatus(nextStatus),
      status: nextStatus,
      startedAt: derived.execution?.startedAt ?? input.job.startedAt ?? input.instance.createdAt,
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
  const notificationsByInstanceId = new Map(
    listTaskNotificationStatesByInstanceIds(instanceIds).map((record) => [
      normalizeInstanceId(record.instanceId),
      record.notification,
    ]),
  );
  if (jobsByInstanceId.size === 0 && notificationsByInstanceId.size === 0) return goals;

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
          if (!job) {
            return notification ? { ...instance, notification } : instance;
          }
          return composeInstanceFromJob({ task, instance, job, notification });
        }),
      })),
    })),
  }));
}

export function readComposedGoalsSnapshotMeta(fallback: Goal[]) {
  const meta = readGoalsSnapshotMeta(fallback);
  return {
    ...meta,
    value: composeGoalsWithRuntimeJobs(meta.value),
  };
}
