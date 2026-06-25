import { NextRequest } from "next/server";

import { getGoalEvents } from "@/lib/server/repositories/goalEventLogRepository";
import { createSseHeaders, writeSseComment, writeSseEvent } from "@/lib/server/sse";
import { bindUserContextTick } from "@/lib/server/sse/userContextTick";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVE_POLL_INTERVAL_MS = 2000;
const IDLE_POLL_INTERVAL_MS = 5000;
const IDLE_TICKS_BEFORE_BACKOFF = 3;

async function GETHandler(request: NextRequest, context: { userId: string }) {
  const { userId } = context;
  const { searchParams } = new URL(request.url);
  const goalId = searchParams.get("goalId")?.trim();
  if (!goalId) {
    return new Response("goalId 不能为空", { status: 400 });
  }
  let cursor = Number(searchParams.get("fromId") ?? 0);
  if (!Number.isFinite(cursor)) cursor = 0;
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
      writeSseEvent(controller, "ready", { cursor });
      const tick = () => {
        if (disposed) return;
        try {
          const events = getGoalEvents({ goalId, fromId: cursor, limit: 100 });
          if (events.length) {
            cursor = events[events.length - 1].id;
            idleTicks = 0;
            writeSseEvent(controller, "events", { events, nextCursor: cursor });
          } else {
            idleTicks += 1;
            writeSseComment(controller);
          }
        } catch (error) {
          writeSseEvent(controller, "error", {
            message: error instanceof Error ? error.message : "事件流读取失败",
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
