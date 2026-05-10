import { NextRequest, NextResponse } from "next/server";

import { upsertGoalsSnapshot, upsertRuntimeEnvironmentsSnapshot, upsertScheduleEventsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import type { Goal } from "@/types/kiki";
import type { AgentEvent } from "@/types/schedule";
import type { RuntimeEnvironment } from "@/types/runtime";

export const runtime = "nodejs";

type Body = {
  goals?: Goal[];
  runtimeEnvironments?: RuntimeEnvironment[];
  scheduleEvents?: AgentEvent[];
};

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Body;
  if (body.goals) upsertGoalsSnapshot(body.goals);
  if (body.runtimeEnvironments) upsertRuntimeEnvironmentsSnapshot(body.runtimeEnvironments);
  if (body.scheduleEvents) upsertScheduleEventsSnapshot(body.scheduleEvents);
  return NextResponse.json({ ok: true });
}
