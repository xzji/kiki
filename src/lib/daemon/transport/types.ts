import type { ClaudeStreamEvent } from "@/lib/server/claude/transport";
import type { MachineCommand, MachineResult } from "@/lib/server/tunnel/tunnelHub";

export type DaemonOutboundTransport = {
  sendResult: (result: MachineResult) => Promise<void>;
  sendStreamChunk: (sessionId: string, event: ClaudeStreamEvent, seq: number) => Promise<void>;
};

export type DaemonTransportCallbacks = {
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  onCommand: (command: MachineCommand) => Promise<void> | void;
  onBindUser: (userId: string) => void;
};

export type DaemonHelloState = {
  runningJobIds: string[];
  activeStreamSessionIds: string[];
};

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs / 1000}s）`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
