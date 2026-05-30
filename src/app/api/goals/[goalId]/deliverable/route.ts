import { NextResponse } from "next/server";

import { getOrComposeGoalDeliverable } from "@/lib/server/services/goalDeliverableService";

export const runtime = "nodejs";

type Params = {
  params: { goalId: string };
};

function safeDecodeRouteParam(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const deliverable = getOrComposeGoalDeliverable(safeDecodeRouteParam(params.goalId));
    return NextResponse.json({ ok: true, deliverable });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "目标交付包生成失败" },
      { status: 404 },
    );
  }
}
