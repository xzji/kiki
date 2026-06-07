import { NextRequest, NextResponse } from "next/server";

import { getGoalTelemetryProgress } from "@/lib/server/goalTelemetry";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(request: NextRequest) {
  const requestId = request.nextUrl.searchParams.get("requestId")?.trim();
  if (!requestId) {
    return NextResponse.json({ reason: "requestId 不能为空" }, { status: 400 });
  }

  const progress = getGoalTelemetryProgress(requestId);
  if (!progress) {
    return NextResponse.json({ progress: null }, { status: 404 });
  }

  return NextResponse.json({ progress });
}

export const GET = withAuth(GETHandler);
