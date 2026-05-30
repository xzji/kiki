import { NextRequest } from "next/server";

import { getConversationEvents } from "@/lib/server/repositories/conversationEventLogRepository";
import { getGoalEventsSince } from "@/lib/server/repositories/goalEventLogRepository";
import { createSseHeaders, writeSseEvent } from "@/lib/server/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 2000;
const TICK_LIMIT = 200;

function parseCursor(value: string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  let goalCursor = parseCursor(searchParams.get("goalCursor"));
  let conversationCursor = parseCursor(searchParams.get("conversationCursor"));
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

      writeSseEvent(controller, "ready", { goalCursor, conversationCursor });

      const tick = () => {
        if (disposed) return;
        try {
          const goalEvents = getGoalEventsSince({ fromId: goalCursor, limit: TICK_LIMIT });
          if (goalEvents.length) {
            goalCursor = goalEvents[goalEvents.length - 1].id;
            writeSseEvent(controller, "goal-events", {
              events: goalEvents,
              nextCursor: goalCursor,
            });
          }
          const conversationEvents = getConversationEvents({
            fromId: conversationCursor,
            limit: TICK_LIMIT,
          });
          if (conversationEvents.length) {
            conversationCursor = conversationEvents[conversationEvents.length - 1].id;
            writeSseEvent(controller, "conversation-events", {
              events: conversationEvents,
              nextCursor: conversationCursor,
            });
          }
          if (!goalEvents.length && !conversationEvents.length) {
            writeSseEvent(controller, "heartbeat", { ts: Date.now() });
          }
        } catch (error) {
          writeSseEvent(controller, "error", {
            message: error instanceof Error ? error.message : "运行时事件流读取失败",
          });
        }
      };

      timer = setInterval(tick, POLL_INTERVAL_MS);
      tick();

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
