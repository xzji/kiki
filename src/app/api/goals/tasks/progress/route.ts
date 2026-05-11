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
  if (!progress && (!logs || logs.length === 0)) {
    return NextResponse.json({ progress: null, logs: [], trajectory: [] }, { status: 404 });
  }

  return NextResponse.json({
    progress,
    logs,
    trajectory,
  });
}
