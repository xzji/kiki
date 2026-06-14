import { NextResponse } from "next/server";

import {
  readRuntimeEnvironmentsSnapshotMeta,
  readScheduleEventsSnapshotMeta,
} from "@/lib/server/runtime/stateSnapshot";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readComposedGoalsSnapshotMeta } from "@/lib/server/runtime/instanceComposition";
import { withAuth } from "@/lib/server/http/withAuth";
import { createApiTimer, estimateJsonBytes } from "@/lib/server/http/timing";

export const runtime = "nodejs";

async function GETHandler() {
  const timer = createApiTimer("/api/runtime/state");
  const snapshot = await timer.measure("db_ms", () => {
    const goals = readComposedGoalsSnapshotMeta([]);
    const runtimeEnvironments = readRuntimeEnvironmentsSnapshotMeta(INITIAL_RUNTIME_ENVIRONMENTS);
    const scheduleEvents = readScheduleEventsSnapshotMeta([]);
    return { goals, runtimeEnvironments, scheduleEvents };
  });
  const { goals, runtimeEnvironments, scheduleEvents } = snapshot;
  const payload = {
    goals: goals.value,
    runtimeEnvironments: runtimeEnvironments.value,
    scheduleEvents: scheduleEvents.value,
    meta: {
      revisions: {
        goals: goals.revision,
        runtimeEnvironments: runtimeEnvironments.revision,
        scheduleEvents: scheduleEvents.revision,
      },
      updatedAt: {
        goals: goals.updatedAt,
        runtimeEnvironments: runtimeEnvironments.updatedAt,
        scheduleEvents: scheduleEvents.updatedAt,
      },
    },
  };
  const responseBytes = estimateJsonBytes(payload);
  timer.finish({
    responseBytes,
    counts: {
      goal_count: goals.value.length,
      runtime_environment_count: runtimeEnvironments.value.length,
      schedule_event_count: scheduleEvents.value.length,
    },
  });
  return NextResponse.json(payload);
}

export const GET = withAuth(GETHandler);
