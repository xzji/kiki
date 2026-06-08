import type { ClaudeStreamEvent } from "@/lib/server/claude/transport";

type StreamWaiter = {
  resolve: (value: ClaudeStreamEvent | null) => void;
  timer: NodeJS.Timeout;
};

type StreamSession = {
  queue: ClaudeStreamEvent[];
  waiters: StreamWaiter[];
  done: boolean;
  expectedSeq: number;
  buffer: Map<number, ClaudeStreamEvent>;
  gapTimer: NodeJS.Timeout | null;
  gapTimerMode: "normal" | "doneOnly" | null;
};

const STREAM_STATE_KEY = Symbol.for("kiki.server.machineStream.state");
const STREAM_GAP_TIMEOUT_MS = 800;
const STREAM_DONE_GAP_TIMEOUT_MS = 3_000;

function getSessions() {
  const globalRef = globalThis as typeof globalThis & {
    [STREAM_STATE_KEY]?: Map<string, StreamSession>;
  };
  if (!globalRef[STREAM_STATE_KEY]) {
    globalRef[STREAM_STATE_KEY] = new Map();
  }
  return globalRef[STREAM_STATE_KEY];
}

export function openStreamSession(sessionId: string) {
  getSessions().set(sessionId, {
    queue: [],
    waiters: [],
    done: false,
    expectedSeq: 0,
    buffer: new Map(),
    gapTimer: null,
    gapTimerMode: null,
  });
}

export function closeStreamSession(sessionId: string) {
  const sessions = getSessions();
  const session = sessions.get(sessionId);
  if (!session) return;
  clearGapTimer(session);
  session.done = true;
  session.buffer.clear();
  for (const waiter of session.waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(null);
  }
  session.waiters = [];
  sessions.delete(sessionId);
}

function clearGapTimer(session: StreamSession) {
  if (!session.gapTimer) return;
  clearTimeout(session.gapTimer);
  session.gapTimer = null;
  session.gapTimerMode = null;
}

function deliverInOrder(session: StreamSession, event: ClaudeStreamEvent) {
  if (event.type === "done") {
    session.done = true;
  }
  if (session.waiters.length > 0) {
    const waiter = session.waiters.shift()!;
    clearTimeout(waiter.timer);
    waiter.resolve(event);
    return;
  }
  session.queue.push(event);
}

function flushBuffered(session: StreamSession) {
  for (;;) {
    const event = session.buffer.get(session.expectedSeq);
    if (!event) break;
    session.buffer.delete(session.expectedSeq);
    deliverInOrder(session, event);
    session.expectedSeq += 1;
    if (session.done) {
      clearGapTimer(session);
      session.buffer.clear();
      return;
    }
  }
}

function armGapTimer(session: StreamSession) {
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
    flushBuffered(session);
    if (!session.done && session.buffer.size > 0) {
      armGapTimer(session);
    }
  }, timeoutMs);
}

export function pushStreamChunk(sessionId: string, event: ClaudeStreamEvent, seq?: number) {
  const session = getSessions().get(sessionId);
  if (!session || session.done) return;
  if (seq === undefined) {
    deliverInOrder(session, event);
    return;
  }
  if (seq < session.expectedSeq) return;
  if (seq === session.expectedSeq) {
    clearGapTimer(session);
    deliverInOrder(session, event);
    session.expectedSeq += 1;
    if (session.done) {
      session.buffer.clear();
      return;
    }
    flushBuffered(session);
    if (!session.done && session.buffer.size > 0) {
      armGapTimer(session);
    }
    return;
  }
  session.buffer.set(seq, event);
  if (session.gapTimerMode === "doneOnly" && event.type !== "done") {
    clearGapTimer(session);
  }
  armGapTimer(session);
}

function waitStreamEvent(sessionId: string, timeoutMs: number, signal?: AbortSignal) {
  const session = getSessions().get(sessionId);
  if (!session) return Promise.resolve(null);
  if (session.queue.length > 0) {
    return Promise.resolve(session.queue.shift()!);
  }
  if (session.done) return Promise.resolve(null);

  return new Promise<ClaudeStreamEvent | null>((resolve) => {
    const onAbort = () => resolve(null);
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      session.waiters = session.waiters.filter((item) => item.resolve !== resolve);
      signal?.removeEventListener("abort", onAbort);
      resolve(null);
    }, timeoutMs);
    session.waiters.push({
      resolve: (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      timer,
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
