import { NextRequest, NextResponse } from "next/server";

import { getGoalEvents, getLatestGoalEventId } from "@/lib/server/repositories/goalEventLogRepository";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

async function GETHandler(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const goalId = searchParams.get("goalId")?.trim();
  if (!goalId) {
    return NextResponse.json({ reason: "goalId 不能为空" }, { status: 400 });
  }
  const fromId = Number(searchParams.get("fromId") ?? 0);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 200), 1), 500);
  const events = getGoalEvents({
    goalId,
    fromId: Number.isFinite(fromId) ? fromId : 0,
    limit,
  });
  const nextCursor = events.length ? events[events.length - 1].id : getLatestGoalEventId(goalId);
  return NextResponse.json({
    events,
    nextCursor,
  });
}

export const GET = withAuth(GETHandler);
