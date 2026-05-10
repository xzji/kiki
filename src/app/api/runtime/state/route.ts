import { NextResponse } from "next/server";

import {
  readGoalsSnapshot,
  readRuntimeEnvironmentsSnapshot,
  readScheduleEventsSnapshot,
} from "@/lib/server/runtime/stateSnapshot";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { initialGoals } from "@/mocks/goals";
import { initialScheduleEvents } from "@/mocks/schedule";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    goals: readGoalsSnapshot(initialGoals),
    runtimeEnvironments: readRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS),
    scheduleEvents: readScheduleEventsSnapshot(initialScheduleEvents),
  });
}
