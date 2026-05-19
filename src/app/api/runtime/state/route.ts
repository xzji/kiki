import { NextResponse } from "next/server";

import {
  readGoalsSnapshotMeta,
  readRuntimeEnvironmentsSnapshotMeta,
  readScheduleEventsSnapshotMeta,
} from "@/lib/server/runtime/stateSnapshot";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";

export const runtime = "nodejs";

export async function GET() {
  const goals = readGoalsSnapshotMeta([]);
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
