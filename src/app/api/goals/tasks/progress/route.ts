import { NextRequest, NextResponse } from "next/server";

import { getGoalTelemetryProgress, getTaskTelemetryLogs, getTaskTelemetryProgress } from "@/lib/server/goalTelemetry";
import { getRuntimeJobByTaskInstanceId } from "@/lib/server/repositories/runtimeJobsRepository";
import type { GoalServerProgress } from "@/types/goalTelemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function latestProgress(candidates: Array<GoalServerProgress | null | undefined>) {
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

function buildWaitingReason(input: {
  runtimeJob: ReturnType<typeof getRuntimeJobByTaskInstanceId> | null;
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

export async function GET(request: NextRequest) {
  const requestId = request.nextUrl.searchParams.get("requestId")?.trim();
  const taskInstanceId = request.nextUrl.searchParams.get("taskInstanceId")?.trim();

  if (!requestId && !taskInstanceId) {
    return NextResponse.json({ reason: "requestId 或 taskInstanceId 不能为空" }, { status: 400 });
  }

  const runtimeJob = taskInstanceId ? getRuntimeJobByTaskInstanceId(taskInstanceId) : null;
  const progress = latestProgress([
    requestId ? getGoalTelemetryProgress(requestId) : null,
    taskInstanceId ? getTaskTelemetryProgress(taskInstanceId) : null,
    runtimeJob?.progress,
  ]);
  const telemetryLogs = taskInstanceId ? getTaskTelemetryLogs(taskInstanceId) : [];
  const logs = telemetryLogs.length > 0 ? telemetryLogs : runtimeJob?.logs ?? [];
  const progressTrajectory = Array.isArray(progress?.resultPayload?.trajectory)
    ? progress.resultPayload.trajectory
    : [];
  const trajectory = progressTrajectory.length > 0 ? progressTrajectory : runtimeJob?.trajectory ?? [];
  const waitingReason = buildWaitingReason({ runtimeJob, progress });
  if (!progress && (!logs || logs.length === 0)) {
    return NextResponse.json({ progress: null, logs: [], trajectory: [], waitingReason }, { status: 404 });
  }

  return NextResponse.json({
    progress,
    logs,
    trajectory,
    waitingReason,
  });
}
