import { NextRequest, NextResponse } from "next/server";

import { getGoalTelemetryProgress, getTaskTelemetryLogs, getTaskTelemetryProgress } from "@/lib/server/goalTelemetry";
import { getRuntimeJobByTaskInstanceId } from "@/lib/server/repositories/runtimeJobsRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = request.nextUrl.searchParams.get("requestId")?.trim();
  const taskInstanceId = request.nextUrl.searchParams.get("taskInstanceId")?.trim();

  if (!requestId && !taskInstanceId) {
    return NextResponse.json({ reason: "requestId 或 taskInstanceId 不能为空" }, { status: 400 });
  }

  const runtimeJob = taskInstanceId ? getRuntimeJobByTaskInstanceId(taskInstanceId) : null;
  const progress =
    (requestId ? getGoalTelemetryProgress(requestId) : getTaskTelemetryProgress(taskInstanceId!)) ??
    runtimeJob?.progress ??
    null;
  const telemetryLogs = taskInstanceId ? getTaskTelemetryLogs(taskInstanceId) : [];
  const logs = telemetryLogs.length > 0 ? telemetryLogs : runtimeJob?.logs ?? [];
  if (!progress && (!logs || logs.length === 0)) {
    return NextResponse.json({ progress: null, logs: [] }, { status: 404 });
  }

  return NextResponse.json({
    progress,
    logs,
  });
}
