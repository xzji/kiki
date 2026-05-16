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
  baseRevision?: {
    goals?: number;
    runtimeEnvironments?: number;
    scheduleEvents?: number;
  };
};

function isValidArrayPayload(value: unknown) {
  return value === undefined || Array.isArray(value);
}

function isConflict(result: { ok: boolean; conflict?: boolean }) {
  return !result.ok && result.conflict;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Body;
  if (
    !isValidArrayPayload(body.goals) ||
    !isValidArrayPayload(body.runtimeEnvironments) ||
    !isValidArrayPayload(body.scheduleEvents)
  ) {
    return NextResponse.json({ ok: false, reason: "runtime state payload 必须是数组" }, { status: 400 });
  }

  const results = {
    goals: body.goals ? upsertGoalsSnapshot(body.goals, body.baseRevision?.goals) : null,
    runtimeEnvironments: body.runtimeEnvironments
      ? upsertRuntimeEnvironmentsSnapshot(body.runtimeEnvironments, body.baseRevision?.runtimeEnvironments)
      : null,
    scheduleEvents: body.scheduleEvents
      ? upsertScheduleEventsSnapshot(body.scheduleEvents, body.baseRevision?.scheduleEvents)
      : null,
  };

  const conflicts = Object.entries(results)
    .filter(([, result]) => result && isConflict(result))
    .map(([key]) => key);
  if (conflicts.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: "runtime state snapshot 已更新，拒绝过期客户端覆盖",
        conflicts,
        results,
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, results });
}
