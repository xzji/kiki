import { NextRequest } from "next/server";

import { getConversationEvents } from "@/lib/server/repositories/conversationEventLogRepository";
import { createSseHeaders, writeSseComment, writeSseEvent } from "@/lib/server/sse";
import { bindUserContextTick } from "@/lib/server/sse/userContextTick";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 自适应轮询：流式进行中（持续有新事件）用短间隔让观察方近实时收敛；连续空闲若干次后回退到
// 长间隔，避免空闲会话增加无谓负载与 DB 压力。配合发送端 ~120ms 的持久化去抖合帧，
// 观察方能较平滑地分段呈现，消除原先固定 2s "哐一大段"的卡顿体感。
const ACTIVE_POLL_INTERVAL_MS = 400;
const IDLE_POLL_INTERVAL_MS = 5000;
const IDLE_TICKS_BEFORE_BACKOFF = 3;

async function GETHandler(request: NextRequest, context: { userId: string }) {
  const { userId } = context;
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId")?.trim() || undefined;
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
          const events = getConversationEvents({ conversationId, fromId: cursor, limit: 100 });
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
            message: error instanceof Error ? error.message : "会话事件流读取失败",
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
