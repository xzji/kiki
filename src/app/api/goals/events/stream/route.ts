import { NextRequest } from "next/server";

import { getGoalEvents } from "@/lib/server/repositories/goalEventLogRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 2000;

function encodeSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const goalId = searchParams.get("goalId")?.trim();
  if (!goalId) {
    return new Response("goalId 不能为空", { status: 400 });
  }
  let cursor = Number(searchParams.get("fromId") ?? 0);
  if (!Number.isFinite(cursor)) cursor = 0;
  const encoder = new TextEncoder();
  let timer: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(encodeSse("ready", { cursor })));
      const tick = () => {
        try {
          const events = getGoalEvents({ goalId, fromId: cursor, limit: 100 });
          if (events.length) {
            cursor = events[events.length - 1].id;
            controller.enqueue(encoder.encode(encodeSse("events", { events, nextCursor: cursor })));
          } else {
            controller.enqueue(encoder.encode(encodeSse("heartbeat", { cursor })));
          }
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              encodeSse("error", {
                message: error instanceof Error ? error.message : "事件流读取失败",
              }),
            ),
          );
        }
      };
      timer = setInterval(tick, POLL_INTERVAL_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

