import { NextRequest, NextResponse } from "next/server";

import { getGoalTelemetryLogs } from "@/lib/server/goalTelemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limitParam = Number(request.nextUrl.searchParams.get("limit") || "120");
  const data = getGoalTelemetryLogs(Number.isFinite(limitParam) ? limitParam : 120);
  return NextResponse.json(data);
}
