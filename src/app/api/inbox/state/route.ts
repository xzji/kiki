import { NextResponse } from "next/server";

import {
  listInboxItemsFromDeliveredEvents,
  listInboxItemStates,
} from "@/lib/server/repositories/inboxItemStateRepository";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler() {
  return NextResponse.json({
    ok: true,
    states: listInboxItemStates(),
    items: listInboxItemsFromDeliveredEvents(),
  });
}

export const GET = withAuth(GETHandler);
