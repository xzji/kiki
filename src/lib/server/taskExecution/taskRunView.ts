import { getGoalTelemetryProgress, getTaskTelemetryLogs, getTaskTelemetryProgress } from "@/lib/server/goalTelemetry";
import {
  getRuntimeJobByTaskInstanceId,
  type RuntimeJobRecord,
} from "@/lib/server/repositories/runtimeJobsRepository";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";

export type TaskRunView = {
  progress: GoalServerProgress | null;
  logs: GoalServerLogEntry[];
  trajectory: ExecutionTrajectoryStep[];
  blocker: ExecutionBlocker | null;
  waitingReason?: string;
  isEmpty: boolean;
};

export type TaskRunResponse = Omit<TaskRunView, "isEmpty">;

function pickLatestProgress(candidates: Array<GoalServerProgress | null | undefined>) {
  return (
    candidates
      .filter((candidate): candidate is GoalServerProgress => Boolean(candidate))
      .sort((left, right) => +new Date(right.updatedAt) - +new Date(left.updatedAt))[0] ?? null
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function selectProgress(input: {
  runtimeJob: RuntimeJobRecord | null;
  requestId?: string;
  taskInstanceId?: string;
}) {
  const localProgress = [
    input.requestId ? getGoalTelemetryProgress(input.requestId) : null,
    input.taskInstanceId ? getTaskTelemetryProgress(input.taskInstanceId) : null,
  ];
  if (input.runtimeJob?.runtimeTransport === "cloud_control_plane" && input.runtimeJob.progress) {
    return input.runtimeJob.progress;
  }
  return pickLatestProgress([...localProgress, input.runtimeJob?.progress]);
}

function buildCancelledProgress(input: {
  runtimeJob: RuntimeJobRecord | null;
  requestId?: string;
}) {
  const { runtimeJob } = input;
  if (runtimeJob?.status !== "cancelled") return null;
  const now = new Date().toISOString();
  return {
    requestId: runtimeJob.requestId ?? input.requestId ?? `cancel-${runtimeJob.id}`,
    scope: "goal_task_execute",
    status: "cancelled",
    phase: "executing",
    message: "用户已手动停止任务执行。",
    startedAt: runtimeJob.startedAt ?? now,
    updatedAt: runtimeJob.updatedAt ?? now,
    finishedAt: runtimeJob.finishedAt ?? now,
    error: runtimeJob.lastError || "用户手动停止任务执行",
    goalId: runtimeJob.goalId,
    taskId: runtimeJob.taskId,
    taskInstanceId: runtimeJob.taskInstanceId,
    resultPayload: {
      errorCategory: "aborted",
      errorMessage: runtimeJob.lastError || "用户手动停止任务执行",
    },
  } satisfies GoalServerProgress;
}

function resolveLogs(input: {
  runtimeJob: RuntimeJobRecord | null;
  taskInstanceId?: string;
}) {
  if (input.runtimeJob?.runtimeTransport === "cloud_control_plane" && input.runtimeJob.logs.length > 0) {
    return input.runtimeJob.logs;
  }
  const telemetryLogs = input.taskInstanceId ? getTaskTelemetryLogs(input.taskInstanceId) : [];
  return telemetryLogs.length > 0 ? telemetryLogs : input.runtimeJob?.logs ?? [];
}

function resolveTrajectory(input: {
  runtimeJob: RuntimeJobRecord | null;
  progress: GoalServerProgress | null;
}) {
  const resultPayload = input.progress?.resultPayload;
  const progressTrajectory =
    resultPayload && Array.isArray(resultPayload["trajectory"])
      ? (resultPayload["trajectory"] as ExecutionTrajectoryStep[])
      : [];
  return progressTrajectory.length > 0 ? progressTrajectory : input.runtimeJob?.trajectory ?? [];
}

function buildWaitingReason(input: {
  runtimeJob: RuntimeJobRecord | null;
  progress: GoalServerProgress | null;
}) {
  const { runtimeJob, progress } = input;
  if (!runtimeJob) return undefined;
  if (runtimeJob.status === "queued") {
    if (runtimeJob.availableAt) {
      const availableAt = new Date(runtimeJob.availableAt);
      if (!Number.isNaN(availableAt.getTime()) && availableAt.getTime() > Date.now() + 1000) {
        return `任务已入队，等待到 ${formatDateTime(runtimeJob.availableAt)} 后进入下一次调度。`;
      }
    }
    return "任务已入队，正在等待后台 Worker 领取执行。可能是当前仍有前序任务在执行，或调度循环尚未轮到该任务。";
  }
  if (runtimeJob.status === "running") {
    const hasStartedTrajectory = runtimeJob.trajectory.length > 0 || Boolean(progress?.message);
    if (!hasStartedTrajectory) {
      return "后台 Worker 已领取任务，正在启动 Agent 并初始化执行环境。";
    }
  }
  return undefined;
}

export function buildTaskRunView(input: {
  taskInstanceId?: string;
  requestId?: string;
  runtimeJob?: RuntimeJobRecord | null;
}): TaskRunView {
  const runtimeJob =
    input.runtimeJob !== undefined
      ? input.runtimeJob
      : input.taskInstanceId
        ? getRuntimeJobByTaskInstanceId(input.taskInstanceId)
        : null;
  const progress = buildCancelledProgress({ runtimeJob, requestId: input.requestId }) ??
    selectProgress({
      runtimeJob,
      requestId: input.requestId,
      taskInstanceId: input.taskInstanceId,
    });
  const logs = resolveLogs({ runtimeJob, taskInstanceId: input.taskInstanceId });
  const trajectory = resolveTrajectory({ runtimeJob, progress });
  const waitingReason = buildWaitingReason({ runtimeJob, progress });
  return {
    progress,
    logs,
    trajectory,
    blocker: runtimeJob?.blocker ?? null,
    waitingReason,
    isEmpty: !runtimeJob && !progress && logs.length === 0,
  };
}

export function toTaskRunResponse(view: TaskRunView): TaskRunResponse {
  return {
    progress: view.progress,
    logs: view.logs,
    trajectory: view.trajectory,
    blocker: view.blocker,
    waitingReason: view.waitingReason,
  };
}
