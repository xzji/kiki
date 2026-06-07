import { NextResponse } from "next/server";

import {
  readRuntimeEnvironmentsSnapshotMeta,
  readScheduleEventsSnapshotMeta,
} from "@/lib/server/runtime/stateSnapshot";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readComposedGoalsSnapshotMeta } from "@/lib/server/runtime/instanceComposition";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

async function GETHandler() {
  const goals = readComposedGoalsSnapshotMeta([]);
  const runtimeEnvironments = readRuntimeEnvironmentsSnapshotMeta(INITIAL_RUNTIME_ENVIRONMENTS);
  const scheduleEvents = readScheduleEventsSnapshotMeta([]);
  return NextResponse.json({
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
  });
}

export const GET = withAuth(GETHandler);
