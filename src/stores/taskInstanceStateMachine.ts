"use client";

import type { GoalServerProgress } from "@/types/goalTelemetry";
import type {
  TaskExecutionPhase,
  TaskInstance,
  TaskInstanceExecutionState,
  TaskInstanceStatus,
  TaskRunErrorCategory,
} from "@/types/kiki";

type TransitionPatch = Pick<TaskInstance, "status"> & {
  execution: TaskInstanceExecutionState;
};

export type TaskInstanceTransition =
  | { type: "mark_status"; status: TaskInstanceStatus; now: string }
  | { type: "control"; action: "start" | "pause" | "resume"; now: string }
  | { type: "complete"; now: string }
  | { type: "run_started"; now: string }
  | { type: "run_failed"; requestId?: string; errorMessage?: string; now: string }
  | { type: "progress_synced"; progress: GoalServerProgress; waitingReason?: string; now: string }
  | { type: "retry_requested"; now: string }
  | { type: "stopped"; now: string };

type ExecutionOptions = {
  phase?: TaskExecutionPhase;
  startedAt?: string;
  finishedAt?: string;
  lastUpdatedAt?: string;
  waitingReason?: string;
  errorCategory?: TaskRunErrorCategory;
  errorMessage?: string;
  clearFinishedAt?: boolean;
  clearWaitingReason?: boolean;
  clearError?: boolean;
};

export function getTaskInstancePhase(status: TaskInstanceStatus): TaskExecutionPhase {
  if (status === "completed") return "completed";
  if (status === "awaiting_user") return "awaiting_user";
  if (status === "in_progress") return "running";
  if (status === "paused") return "paused";
  if (status === "error") return "failed";
  return "queued";
}

export function normalizeTaskInstanceExecution(instance: TaskInstance): TransitionPatch {
  const status = instance.execution?.status ?? instance.status;
  const phase = normalizePhase(status, instance.execution?.phase);
  return {
    status,
    execution: {
      ...instance.execution,
      phase,
      status,
      lastUpdatedAt: instance.execution?.lastUpdatedAt ?? instance.createdAt,
    },
  };
}

export function applyTaskInstanceTransition(
  instance: TaskInstance,
  transition: TaskInstanceTransition,
): TransitionPatch | null {
  switch (transition.type) {
    case "mark_status":
      return {
        status: transition.status,
        execution: buildExecution(instance, transition.status, {
          startedAt: instance.execution?.startedAt ?? instance.createdAt,
          finishedAt: transition.status === "completed" ? transition.now : instance.execution?.finishedAt,
          lastUpdatedAt: transition.now,
          errorCategory: transition.status === "error" ? "unknown" : instance.execution?.errorCategory,
          errorMessage: transition.status === "error" ? "任务执行失败" : instance.execution?.errorMessage,
        }),
      };
    case "control": {
      if (
        transition.action === "pause" &&
        instance.status !== "in_progress" &&
        instance.status !== "awaiting_user"
      ) {
        return null;
      }
      const status = transition.action === "pause" ? "paused" : "in_progress";
      return {
        status,
        execution: buildExecution(instance, status, {
          startedAt: instance.execution?.startedAt ?? transition.now,
          lastUpdatedAt: transition.now,
          clearFinishedAt: status === "in_progress",
          clearWaitingReason: status === "in_progress",
          clearError: status === "in_progress",
        }),
      };
    }
    case "complete":
      return {
        status: "completed",
        execution: buildExecution(instance, "completed", {
          startedAt: instance.execution?.startedAt ?? instance.createdAt,
          finishedAt: transition.now,
          lastUpdatedAt: transition.now,
          clearWaitingReason: true,
          clearError: true,
        }),
      };
    case "run_started":
      return {
        status: "in_progress",
        execution: buildExecution(instance, "in_progress", {
          startedAt: instance.execution?.startedAt ?? transition.now,
          lastUpdatedAt: transition.now,
          clearFinishedAt: true,
          clearWaitingReason: true,
          clearError: true,
        }),
      };
    case "run_failed":
      if (
        transition.requestId &&
        instance.runner?.requestId &&
        transition.requestId !== instance.runner.requestId
      ) {
        return null;
      }
      if (instance.status !== "in_progress" && instance.status !== "awaiting_user") {
        return null;
      }
      return {
        status: "error",
        execution: buildExecution(instance, "error", {
          startedAt: instance.execution?.startedAt ?? instance.createdAt,
          finishedAt: transition.now,
          lastUpdatedAt: transition.now,
          errorCategory: "unknown",
          errorMessage: transition.errorMessage ?? "任务执行失败",
          clearWaitingReason: true,
        }),
      };
    case "progress_synced":
      return buildProgressPatch(instance, transition);
    case "retry_requested":
      return {
        status: "pending",
        execution: buildExecution(instance, "pending", {
          phase: "retrying",
          startedAt: instance.execution?.startedAt,
          lastUpdatedAt: transition.now,
          clearFinishedAt: true,
          clearWaitingReason: true,
          clearError: true,
        }),
      };
    case "stopped":
      return {
        status: "paused",
        execution: buildExecution(instance, "paused", {
          phase: "cancelled",
          startedAt: instance.execution?.startedAt,
          finishedAt: transition.now,
          lastUpdatedAt: transition.now,
          clearWaitingReason: true,
        }),
      };
  }
}

function buildProgressPatch(
  instance: TaskInstance,
  transition: Extract<TaskInstanceTransition, { type: "progress_synced" }>,
): TransitionPatch | null {
  const { progress, waitingReason, now } = transition;
  if (
    progress.requestId &&
    instance.runner?.requestId &&
    progress.requestId !== instance.runner.requestId
  ) {
    return null;
  }
  if (instance.status !== "in_progress" && instance.status !== "awaiting_user") {
    return null;
  }

  const status: TaskInstanceStatus =
    progress.status === "completed"
      ? progress.resultPayload?.awaitingUser
        ? "awaiting_user"
        : "completed"
      : progress.status === "cancelled"
        ? "paused"
      : progress.status === "failed"
        ? "error"
        : "in_progress";

  return {
    status,
    execution: buildExecution(instance, status, {
      startedAt: instance.execution?.startedAt ?? progress.startedAt ?? instance.createdAt,
      finishedAt: progress.finishedAt,
      lastUpdatedAt: progress.updatedAt ?? now,
      waitingReason: status === "in_progress" ? waitingReason : undefined,
      clearFinishedAt: status === "in_progress" || status === "awaiting_user",
      clearWaitingReason: status !== "in_progress",
      errorCategory:
        status === "error"
          ? ((progress.resultPayload?.errorCategory as TaskRunErrorCategory | undefined) ?? "unknown")
          : undefined,
      errorMessage: status === "error" ? progress.error : undefined,
      clearError: status !== "error",
    }),
  };
}

function buildExecution(
  instance: TaskInstance,
  status: TaskInstanceStatus,
  options: ExecutionOptions,
): TaskInstanceExecutionState {
  const previous = instance.execution;
  return {
    ...previous,
    phase: options.phase ?? getTaskInstancePhase(status),
    status,
    startedAt: options.startedAt ?? previous?.startedAt,
    finishedAt: options.clearFinishedAt ? undefined : options.finishedAt ?? previous?.finishedAt,
    lastUpdatedAt: options.lastUpdatedAt ?? previous?.lastUpdatedAt,
    waitingReason: options.clearWaitingReason ? undefined : options.waitingReason ?? previous?.waitingReason,
    errorCategory: options.clearError ? undefined : options.errorCategory ?? previous?.errorCategory,
    errorMessage: options.clearError ? undefined : options.errorMessage ?? previous?.errorMessage,
  };
}

function normalizePhase(status: TaskInstanceStatus, phase?: TaskExecutionPhase): TaskExecutionPhase {
  if (status === "pending" && phase === "retrying") return phase;
  if (status === "paused" && phase === "cancelled") return phase;
  return getTaskInstancePhase(status);
}
