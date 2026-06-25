import { NextRequest } from "next/server";

import { getConversationEvents } from "@/lib/server/repositories/conversationEventLogRepository";
import { getGoalEventsSince } from "@/lib/server/repositories/goalEventLogRepository";
import { createSseHeaders, writeSseComment, writeSseEvent } from "@/lib/server/sse";
import { bindUserContextTick } from "@/lib/server/sse/userContextTick";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVE_POLL_INTERVAL_MS = 2000;
const IDLE_POLL_INTERVAL_MS = 5000;
const IDLE_TICKS_BEFORE_BACKOFF = 3;
const TICK_LIMIT = 200;

function parseCursor(value: string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function GETHandler(request: NextRequest, context: { userId: string }) {
  const { userId } = context;
  const { searchParams } = new URL(request.url);
  let goalCursor = parseCursor(searchParams.get("goalCursor"));
  let conversationCursor = parseCursor(searchParams.get("conversationCursor"));
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;
  let idleTicks = 0;
  let cleanup: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanup = () => {
        if (disposed) return;
        disposed = true;
        if (timer) {
          clearTimeout(timer);
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
            idleTicks = 0;
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
            idleTicks = 0;
            writeSseEvent(controller, "conversation-events", {
              events: conversationEvents,
              nextCursor: conversationCursor,
            });
          }
          if (!goalEvents.length && !conversationEvents.length) {
            idleTicks += 1;
            writeSseComment(controller);
          }
        } catch (error) {
          writeSseEvent(controller, "error", {
            message: error instanceof Error ? error.message : "运行时事件流读取失败",
          });
        }
      };

      const boundTick = bindUserContextTick(userId, tick);
      const scheduleNext = () => {
        if (disposed) return;
        const interval =
          idleTicks >= IDLE_TICKS_BEFORE_BACKOFF ? IDLE_POLL_INTERVAL_MS : ACTIVE_POLL_INTERVAL_MS;
        timer = setTimeout(() => {
          boundTick();
          scheduleNext();
        }, interval);
      };
      boundTick();
      scheduleNext();

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
