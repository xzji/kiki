import { NextResponse } from "next/server";

import {
  listInboxItemsFromDeliveredEvents,
  listInboxItemStates,
} from "@/lib/server/repositories/inboxItemStateRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    states: listInboxItemStates(),
    items: listInboxItemsFromDeliveredEvents(),
  });
}
