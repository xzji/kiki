import type { ClaudeStreamEvent } from "@/lib/server/claude/transport";

type StreamWaiter = {
  resolve: (value: ClaudeStreamEvent | null) => void;
  timer: NodeJS.Timeout;
};

type StreamSession = {
  queue: ClaudeStreamEvent[];
  waiters: StreamWaiter[];
  done: boolean;
};

const STREAM_STATE_KEY = Symbol.for("kiki.server.machineStream.state");

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
  getSessions().set(sessionId, { queue: [], waiters: [], done: false });
}

export function closeStreamSession(sessionId: string) {
  const sessions = getSessions();
  const session = sessions.get(sessionId);
  if (!session) return;
  session.done = true;
  for (const waiter of session.waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(null);
  }
  session.waiters = [];
  sessions.delete(sessionId);
}

export function pushStreamChunk(sessionId: string, event: ClaudeStreamEvent) {
  const session = getSessions().get(sessionId);
  if (!session || session.done) return;
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
