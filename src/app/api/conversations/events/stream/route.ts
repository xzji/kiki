import { NextRequest } from "next/server";

import { getConversationEvents } from "@/lib/server/repositories/conversationEventLogRepository";
import { createSseHeaders, writeSseEvent } from "@/lib/server/sse";
import { bindUserContextTick } from "@/lib/server/sse/userContextTick";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 2000;

async function GETHandler(request: NextRequest, context: { userId: string }) {
  const { userId } = context;
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId")?.trim() || undefined;
  let cursor = Number(searchParams.get("fromId") ?? 0);
  if (!Number.isFinite(cursor)) cursor = 0;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;
  let cleanup: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanup = () => {
        if (disposed) return;
        disposed = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        try {
          controller.close();
        } catch {
          // ignore double-close
        }
      };
      writeSseEvent(controller, "ready", { cursor });
      const tick = () => {
        if (disposed) return;
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
      const boundTick = bindUserContextTick(userId, tick);
      boundTick();
      timer = setInterval(boundTick, POLL_INTERVAL_MS);
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: createSseHeaders(),
  });
}

export const GET = withAuth(GETHandler);
