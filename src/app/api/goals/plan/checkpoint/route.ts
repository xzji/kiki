import { NextRequest, NextResponse } from "next/server";

import { getGoalPlanningCheckpointStatus } from "@/lib/server/goalPlanning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const conversationId = request.nextUrl.searchParams.get("conversationId")?.trim();
  if (!conversationId) {
    return NextResponse.json({ available: false, reason: "conversationId 不能为空" }, { status: 400 });
  }

  const checkpoint = getGoalPlanningCheckpointStatus(conversationId);
  if (!checkpoint.available) {
    return NextResponse.json({
      available: false,
      checkpoint: checkpoint.discarded ? checkpoint : undefined,
    });
  }
  return NextResponse.json({ available: true, checkpoint });
}
