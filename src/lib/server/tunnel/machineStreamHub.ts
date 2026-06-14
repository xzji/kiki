import type { ClaudeStreamEvent } from "@/lib/server/claude/transport";
import { runWithUserContext } from "@/lib/server/context/userContext";
import { getConversationMessage } from "@/lib/server/repositories/conversationMessagesRepository";
import { applyConversationCommand } from "@/lib/server/services/conversationCommandService";
import type { ConversationMessage } from "@/types/kiki";

type StreamWaiter = {
  resolve: (value: ClaudeStreamEvent | null) => void;
  timer: NodeJS.Timeout;
};

export type StreamSessionMetadata = {
  userId: string;
  conversationId?: string;
  assistantMessageId?: string;
  assistantCreatedAt?: string;
  runtimeKind?: string;
  startedAt: string;
};

type StreamSession = {
  queue: ClaudeStreamEvent[];
  waiters: StreamWaiter[];
  done: boolean;
  expectedSeq: number;
  buffer: Map<number, ClaudeStreamEvent>;
  gapTimer: NodeJS.Timeout | null;
  gapTimerMode: "normal" | "doneOnly" | null;
  cleanupTimer: NodeJS.Timeout | null;
  metadata?: StreamSessionMetadata;
  finalMessagePersisted: boolean;
};

const STREAM_STATE_KEY = Symbol.for("kiki.server.machineStream.state");
const STREAM_GAP_TIMEOUT_MS = 800;
const STREAM_DONE_GAP_TIMEOUT_MS = 3_000;
const STREAM_SESSION_CLEANUP_MS = 5 * 60 * 1000;
const STREAM_DETACHED_CLEANUP_MS = 60 * 60 * 1000;

function getSessions() {
  const globalRef = globalThis as typeof globalThis & {
    [STREAM_STATE_KEY]?: Map<string, StreamSession>;
  };
  if (!globalRef[STREAM_STATE_KEY]) {
    globalRef[STREAM_STATE_KEY] = new Map();
  }
  return globalRef[STREAM_STATE_KEY];
}

export function openStreamSession(sessionId: string, metadata?: StreamSessionMetadata) {
  getSessions().set(sessionId, {
    queue: [],
    waiters: [],
    done: false,
    expectedSeq: 0,
    buffer: new Map(),
    gapTimer: null,
    gapTimerMode: null,
    cleanupTimer: null,
    metadata,
    finalMessagePersisted: false,
  });
}

function clearCleanupTimer(session: StreamSession) {
  if (!session.cleanupTimer) return;
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = null;
}

function resolveAllWaiters(session: StreamSession, value: ClaudeStreamEvent | null) {
  for (const waiter of session.waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }
  session.waiters = [];
}

export function closeStreamSession(sessionId: string) {
  const sessions = getSessions();
  const session = sessions.get(sessionId);
  if (!session) return;
  clearGapTimer(session);
  clearCleanupTimer(session);
  session.done = true;
  session.buffer.clear();
  resolveAllWaiters(session, null);
  sessions.delete(sessionId);
}

export function detachStreamConsumer(sessionId: string) {
  const session = getSessions().get(sessionId);
  if (!session) return;
  resolveAllWaiters(session, null);
  if (!session.done && !session.cleanupTimer) {
    session.cleanupTimer = setTimeout(() => {
      closeStreamSession(sessionId);
    }, STREAM_DETACHED_CLEANUP_MS);
    session.cleanupTimer.unref?.();
  }
}

function scheduleStreamSessionCleanup(sessionId: string, session: StreamSession) {
  if (session.cleanupTimer) return;
  session.cleanupTimer = setTimeout(() => {
    closeStreamSession(sessionId);
  }, STREAM_SESSION_CLEANUP_MS);
  session.cleanupTimer.unref?.();
}

function clearGapTimer(session: StreamSession) {
  if (!session.gapTimer) return;
  clearTimeout(session.gapTimer);
  session.gapTimer = null;
  session.gapTimerMode = null;
}

function patchFinalMessage(message: ConversationMessage, content: string, status: "done" | "error", error?: string) {
  if ((message.kind === "text" || message.kind === "goal_plan_card") && message.cliProcess) {
    return {
      content,
      status,
      cliProcess: {
        ...message.cliProcess,
        status: status === "done" ? "completed" : "error",
        finishedAt: message.cliProcess.finishedAt ?? new Date().toISOString(),
        output: status === "done" ? content : message.cliProcess.output,
        error: status === "error" ? (error ?? message.cliProcess.error) : undefined,
      },
    } as Partial<ConversationMessage>;
  }
  return { content, status } as Partial<ConversationMessage>;
}

function isUserInterruptedMessage(message: ConversationMessage) {
  return message.content.includes("已中断");
}

function persistFinalStreamEvent(session: StreamSession, event: ClaudeStreamEvent) {
  const metadata = session.metadata;
  if (!metadata?.conversationId || !metadata.assistantMessageId) return;
  if (event.type !== "message" && event.type !== "error" && event.type !== "done") return;
  if (session.finalMessagePersisted && event.type !== "error") return;

  try {
    runWithUserContext(metadata.userId, () => {
      const current = getConversationMessage(metadata.conversationId!, metadata.assistantMessageId!);
      if (current && isUserInterruptedMessage(current.message)) return;
      if (event.type === "message") {
        const patch = current
          ? patchFinalMessage(current.message, event.content, "done")
          : ({ content: event.content, status: "done" } satisfies Partial<ConversationMessage>);
        if (current) {
          applyConversationCommand({
            command: {
              type: "update_message",
              conversationId: metadata.conversationId!,
              messageId: metadata.assistantMessageId!,
              patch,
            },
            idempotencyKey: `claude.stream.final.update:${metadata.conversationId}:${metadata.assistantMessageId}`,
            producedBy: "system",
          });
        } else {
          applyConversationCommand({
            command: {
              type: "append_message",
              conversationId: metadata.conversationId!,
              message: {
                id: metadata.assistantMessageId!,
                kind: "text",
                role: "kiki",
                content: event.content,
                createdAt: metadata.assistantCreatedAt ?? new Date().toISOString(),
                unread: true,
                status: "done",
                source: "kiki",
              },
            },
            idempotencyKey: `claude.stream.final.append:${metadata.conversationId}:${metadata.assistantMessageId}`,
            producedBy: "system",
          });
        }
        applyConversationCommand({
          command: { type: "set_status", conversationId: metadata.conversationId!, status: "idle" },
          idempotencyKey: `claude.stream.final.status:${metadata.conversationId}:${metadata.assistantMessageId}:idle`,
          producedBy: "system",
        });
        session.finalMessagePersisted = true;
        return;
      }

      if (event.type === "error") {
        const content = `（任务失败：${event.message}）`;
        const patch = current
          ? patchFinalMessage(current.message, current.message.content || content, "error", event.message)
          : ({ content, status: "error" } satisfies Partial<ConversationMessage>);
        if (current) {
          applyConversationCommand({
            command: {
              type: "update_message",
              conversationId: metadata.conversationId!,
              messageId: metadata.assistantMessageId!,
              patch,
            },
            idempotencyKey: `claude.stream.final.error:${metadata.conversationId}:${metadata.assistantMessageId}`,
            producedBy: "system",
          });
        } else {
          applyConversationCommand({
            command: {
              type: "append_message",
              conversationId: metadata.conversationId!,
              message: {
                id: metadata.assistantMessageId!,
                kind: "text",
                role: "kiki",
                content,
                createdAt: metadata.assistantCreatedAt ?? new Date().toISOString(),
                unread: true,
                status: "error",
                source: "kiki",
              },
            },
            idempotencyKey: `claude.stream.final.error.append:${metadata.conversationId}:${metadata.assistantMessageId}`,
            producedBy: "system",
          });
        }
        applyConversationCommand({
          command: { type: "set_status", conversationId: metadata.conversationId!, status: "error" },
          idempotencyKey: `claude.stream.final.status:${metadata.conversationId}:${metadata.assistantMessageId}:error`,
          producedBy: "system",
        });
        session.finalMessagePersisted = true;
        return;
      }

      if (event.type === "done" && current?.message.status === "streaming") {
        applyConversationCommand({
          command: {
            type: "update_message",
            conversationId: metadata.conversationId!,
            messageId: metadata.assistantMessageId!,
              patch: patchFinalMessage(current.message, current.message.content, "done"),
          },
          idempotencyKey: `claude.stream.final.done:${metadata.conversationId}:${metadata.assistantMessageId}`,
          producedBy: "system",
        });
        applyConversationCommand({
          command: { type: "set_status", conversationId: metadata.conversationId!, status: "idle" },
          idempotencyKey: `claude.stream.final.status:${metadata.conversationId}:${metadata.assistantMessageId}:done`,
          producedBy: "system",
        });
      }
    });
  } catch (error) {
    console.error("[machine-stream] persist final event failed", error);
  }
}

function deliverInOrder(sessionId: string, session: StreamSession, event: ClaudeStreamEvent) {
  if (!session.done) clearCleanupTimer(session);
  persistFinalStreamEvent(session, event);
  if (event.type === "done") {
    session.done = true;
    scheduleStreamSessionCleanup(sessionId, session);
  }
  if (session.waiters.length > 0) {
    const waiter = session.waiters.shift()!;
    clearTimeout(waiter.timer);
    waiter.resolve(event);
    return;
  }
  session.queue.push(event);
}

function flushBuffered(sessionId: string, session: StreamSession) {
  for (;;) {
    const event = session.buffer.get(session.expectedSeq);
    if (!event) break;
    session.buffer.delete(session.expectedSeq);
    deliverInOrder(sessionId, session, event);
    session.expectedSeq += 1;
    if (session.done) {
      clearGapTimer(session);
      session.buffer.clear();
      return;
    }
  }
}

function armGapTimer(sessionId: string, session: StreamSession) {
  if (session.done || session.gapTimer || session.buffer.size === 0) return;
  const nextSeq = Math.min(...Array.from(session.buffer.keys()));
  const nextEvent = session.buffer.get(nextSeq);
  const timeoutMs = nextEvent?.type === "done" ? STREAM_DONE_GAP_TIMEOUT_MS : STREAM_GAP_TIMEOUT_MS;
  session.gapTimerMode = nextEvent?.type === "done" ? "doneOnly" : "normal";
  session.gapTimer = setTimeout(() => {
    session.gapTimer = null;
    session.gapTimerMode = null;
    if (session.done || session.buffer.size === 0) return;
    const nextBufferedSeq = Math.min(...Array.from(session.buffer.keys()));
    if (Number.isFinite(nextBufferedSeq) && nextBufferedSeq > session.expectedSeq) {
      session.expectedSeq = nextBufferedSeq;
    }
    flushBuffered(sessionId, session);
    if (!session.done && session.buffer.size > 0) {
      armGapTimer(sessionId, session);
    }
  }, timeoutMs);
}

export function pushStreamChunk(sessionId: string, event: ClaudeStreamEvent, seq?: number) {
  const session = getSessions().get(sessionId);
  if (!session || session.done) {
    if (event.type === "message" || event.type === "error" || event.type === "done") {
      console.warn("[machine-stream] chunk ignored without active session", {
        sessionId,
        eventType: event.type,
        seq,
      });
    }
    return;
  }
  if (seq === undefined) {
    deliverInOrder(sessionId, session, event);
    return;
  }
  if (seq < session.expectedSeq) return;
  if (seq === session.expectedSeq) {
    clearGapTimer(session);
    deliverInOrder(sessionId, session, event);
    session.expectedSeq += 1;
    if (session.done) {
      session.buffer.clear();
      return;
    }
    flushBuffered(sessionId, session);
    if (!session.done && session.buffer.size > 0) {
      armGapTimer(sessionId, session);
    }
    return;
  }
  session.buffer.set(seq, event);
  if (session.gapTimerMode === "doneOnly" && event.type !== "done") {
    clearGapTimer(session);
  }
  armGapTimer(sessionId, session);
}

function waitStreamEvent(sessionId: string, timeoutMs: number, signal?: AbortSignal) {
  const session = getSessions().get(sessionId);
  if (!session) return Promise.resolve(null);
  if (session.queue.length > 0) {
    return Promise.resolve(session.queue.shift()!);
  }
  if (session.done) return Promise.resolve(null);

  return new Promise<ClaudeStreamEvent | null>((resolve) => {
    const state: {
      timer?: NodeJS.Timeout;
      wrappedResolve?: (value: ClaudeStreamEvent | null) => void;
    } = {};
    const onAbort = () => {
      session.waiters = session.waiters.filter((item) => item.resolve !== state.wrappedResolve);
      if (state.timer) clearTimeout(state.timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(null);
    };
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    state.timer = setTimeout(() => {
      session.waiters = session.waiters.filter((item) => item.resolve !== state.wrappedResolve);
      signal?.removeEventListener("abort", onAbort);
      resolve(null);
    }, timeoutMs);
    state.wrappedResolve = (value: ClaudeStreamEvent | null) => {
      if (state.timer) clearTimeout(state.timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    session.waiters.push({
      resolve: state.wrappedResolve,
      timer: state.timer,
    });
  });
}

export async function consumeStreamSession(
  sessionId: string,
  onEvent: (event: ClaudeStreamEvent) => void,
  signal?: AbortSignal,
) {
  for (;;) {
    const next = await waitStreamEvent(sessionId, 10 * 60 * 1000, signal);
    if (!next) break;
    onEvent(next);
    if (next.type === "done") break;
  }
}
