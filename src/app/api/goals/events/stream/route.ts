import { NextRequest } from "next/server";

import { getGoalEvents } from "@/lib/server/repositories/goalEventLogRepository";
import { createSseHeaders, writeSseEvent } from "@/lib/server/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 2000;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const goalId = searchParams.get("goalId")?.trim();
  if (!goalId) {
    return new Response("goalId 不能为空", { status: 400 });
  }
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
          const events = getGoalEvents({ goalId, fromId: cursor, limit: 100 });
          if (events.length) {
            cursor = events[events.length - 1].id;
            writeSseEvent(controller, "events", { events, nextCursor: cursor });
          } else {
            writeSseEvent(controller, "heartbeat", { cursor });
          }
        } catch (error) {
          writeSseEvent(controller, "error", {
            message: error instanceof Error ? error.message : "事件流读取失败",
          });
        }
      };
      timer = setInterval(tick, POLL_INTERVAL_MS);
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
