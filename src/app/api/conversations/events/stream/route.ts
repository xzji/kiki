import { NextRequest } from "next/server";

import { getConversationEvents } from "@/lib/server/repositories/conversationEventLogRepository";
import { createSseHeaders, writeSseEvent } from "@/lib/server/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 2000;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId")?.trim() || undefined;
  let cursor = Number(searchParams.get("fromId") ?? 0);
  if (!Number.isFinite(cursor)) cursor = 0;
  let timer: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      writeSseEvent(controller, "ready", { cursor });
      const tick = () => {
        try {
          const events = getConversationEvents({ conversationId, fromId: cursor, limit: 100 });
          if (events.length) {
            cursor = events[events.length - 1].id;
            writeSseEvent(controller, "events", { events, nextCursor: cursor });
          } else {
            writeSseEvent(controller, "heartbeat", { cursor });
          }
        } catch (error) {
          writeSseEvent(controller, "error", {
            message: error instanceof Error ? error.message : "会话事件流读取失败",
          });
        }
      };
      tick();
      timer = setInterval(tick, POLL_INTERVAL_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: createSseHeaders(),
  });
}
