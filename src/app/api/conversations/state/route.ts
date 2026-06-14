import { NextRequest, NextResponse } from "next/server";

import { readConversationState } from "@/lib/server/services/conversationCommandService";
import { withAuth } from "@/lib/server/http/withAuth";
import { createApiTimer, estimateJsonBytes } from "@/lib/server/http/timing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(request: NextRequest) {
  const timer = createApiTimer("/api/conversations/state");
  const { searchParams } = new URL(request.url);
  const includeMessages = searchParams.get("includeMessages") === "1";
  const state = await timer.measure("db_ms", () => readConversationState({ includeMessages }));
  const payload = { ok: true, ...state };
  const responseBytes = estimateJsonBytes(payload);
  timer.finish({
    responseBytes,
    counts: {
      conversation_count: state.meta.conversationCount,
      total_message_count: state.meta.totalMessageCount,
      total_unread_count: state.meta.totalUnreadCount,
      latest_event_id: state.latestEventId,
    },
  });
  return NextResponse.json(payload);
}

export const GET = withAuth(GETHandler);
