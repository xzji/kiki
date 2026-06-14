import { NextResponse } from "next/server";

import {
  listInboxItemsFromDeliveredEventsWithStats,
  listInboxItemStates,
} from "@/lib/server/repositories/inboxItemStateRepository";
import { withAuth } from "@/lib/server/http/withAuth";
import { createApiTimer, estimateJsonBytes } from "@/lib/server/http/timing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler() {
  const timer = createApiTimer("/api/inbox/state");
  const { states, deliveredEvents } = await timer.measure("db_ms", () => ({
    states: listInboxItemStates(),
    deliveredEvents: listInboxItemsFromDeliveredEventsWithStats(),
  }));
  const payload = {
    ok: true,
    states,
    items: deliveredEvents.items,
  };
  const responseBytes = estimateJsonBytes(payload);
  timer.finish({
    responseBytes,
    counts: {
      state_count: states.length,
      delivered_event_scan_count: deliveredEvents.deliveredEventScanCount,
      goal_count: deliveredEvents.goalCount,
      item_count: deliveredEvents.items.length,
    },
  });
  return NextResponse.json(payload);
}

export const GET = withAuth(GETHandler);
