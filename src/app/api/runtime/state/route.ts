import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createHash } from "crypto";

import {
  readRuntimeEnvironmentsSnapshotMeta,
  readScheduleEventsSnapshotMeta,
} from "@/lib/server/runtime/stateSnapshot";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readComposedGoalsSnapshotMeta } from "@/lib/server/runtime/instanceComposition";
import { withAuth } from "@/lib/server/http/withAuth";
import { createApiTimer, estimateJsonBytes } from "@/lib/server/http/timing";

export const runtime = "nodejs";

function etagFor(value: unknown) {
  return createHash("sha1").update(JSON.stringify(value)).digest("base64url");
}

function knownEtagsFromUrl(url: string) {
  const { searchParams } = new URL(url);
  const goals = searchParams.get("goalsEtag");
  const runtimeEnvironments = searchParams.get("runtimeEnvironmentsEtag");
  const scheduleEvents = searchParams.get("scheduleEventsEtag");
  if (!goals || !runtimeEnvironments || !scheduleEvents) return null;
  return { goals, runtimeEnvironments, scheduleEvents };
}

async function GETHandler(request: NextRequest) {
  const timer = createApiTimer("/api/runtime/state");
  const knownEtags = knownEtagsFromUrl(request.url);
  const snapshot = await timer.measure("db_ms", () => {
    const goals = readComposedGoalsSnapshotMeta([]);
    const runtimeEnvironments = readRuntimeEnvironmentsSnapshotMeta(INITIAL_RUNTIME_ENVIRONMENTS);
    const scheduleEvents = readScheduleEventsSnapshotMeta([]);
    return { goals, runtimeEnvironments, scheduleEvents };
  });
  const { goals, runtimeEnvironments, scheduleEvents } = snapshot;
  const etags = {
    goals: etagFor(goals.value),
    runtimeEnvironments: etagFor(runtimeEnvironments.value),
    scheduleEvents: etagFor(scheduleEvents.value),
  };
  const meta = {
    revisions: {
      goals: goals.revision,
      runtimeEnvironments: runtimeEnvironments.revision,
      scheduleEvents: scheduleEvents.revision,
    },
    etags,
    updatedAt: {
      goals: goals.updatedAt,
      runtimeEnvironments: runtimeEnvironments.updatedAt,
      scheduleEvents: scheduleEvents.updatedAt,
    },
  };
  if (
    knownEtags &&
    knownEtags.goals === etags.goals &&
    knownEtags.runtimeEnvironments === etags.runtimeEnvironments &&
    knownEtags.scheduleEvents === etags.scheduleEvents
  ) {
    const payload = {
      unchanged: true,
      meta,
    };
    timer.finish({
      responseBytes: estimateJsonBytes(payload),
      counts: {
        goal_count: goals.value.length,
        runtime_environment_count: runtimeEnvironments.value.length,
        schedule_event_count: scheduleEvents.value.length,
      },
    });
    return NextResponse.json(payload);
  }
  const payload = {
    goals: goals.value,
    runtimeEnvironments: runtimeEnvironments.value,
    scheduleEvents: scheduleEvents.value,
    meta,
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
