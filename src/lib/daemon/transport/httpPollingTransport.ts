import type { ClaudeStreamEvent } from "@/lib/server/claude/transport";
import type { MachineCommand, MachineResult } from "@/lib/server/tunnel/tunnelHub";
import type { DaemonLogDomain, DaemonLogLevel } from "@/lib/daemon/daemonLogger";
import { fetchWithTimeout, type DaemonHelloState, type DaemonOutboundTransport, type DaemonTransportCallbacks } from "@/lib/daemon/transport/types";

const POLL_PATH = "/api/machine-tunnel/poll";
const RESULT_PATH = "/api/machine-tunnel/result";
const STREAM_CHUNK_PATH = "/api/machine-tunnel/stream-chunk";
const RECONNECT_DELAY_MS = 5_000;
const POLL_FETCH_TIMEOUT_MS = 40_000;
const RESULT_FETCH_TIMEOUT_MS = 30_000;
const AUTH_FAILURE_BACKOFF_MS = 60_000;
const AUTH_FAILURE_WARN_THRESHOLD = 3;
const AUTH_FAILURE_REMINDER_EVERY = 30;

async function readPollFailureReason(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { reason?: string };
    return typeof data.reason === "string" && data.reason ? data.reason : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function createHttpPollingOutbound(input: {
  base: string;
  apiKey: string;
  logEvent: (
    level: DaemonLogLevel,
    domain: DaemonLogDomain,
    message: string,
    fields?: Record<string, string | number | boolean | null | undefined>,
  ) => void;
}): DaemonOutboundTransport {
  const resultUrl = `${input.base}${RESULT_PATH}`;
  const streamChunkUrl = `${input.base}${STREAM_CHUNK_PATH}`;

  async function sendResult(result: MachineResult) {
    try {
      await fetchWithTimeout(
        resultUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-machine-api-key": input.apiKey },
          body: JSON.stringify(result),
        },
        RESULT_FETCH_TIMEOUT_MS,
      );
    } catch (error) {
      input.logEvent("info", "err", "HTTP result send failed", {
        type: result.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function sendStreamChunk(sessionId: string, event: ClaudeStreamEvent, seq: number) {
    const body = JSON.stringify({ sessionId, event, seq });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          streamChunkUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-machine-api-key": input.apiKey },
            body,
          },
          RESULT_FETCH_TIMEOUT_MS,
        );
        if (response.ok) return;
        if (attempt === 1) {
          input.logEvent("info", "err", "HTTP stream chunk send failed", {
            sessionId,
            seq,
            status: response.status,
          });
        }
      } catch (error) {
        if (attempt === 1) {
          input.logEvent("info", "err", "HTTP stream chunk send failed", {
            sessionId,
            seq,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  return { sendResult, sendStreamChunk };
}

export async function runHttpPollingTransport(input: {
  base: string;
  apiKey: string;
  fingerprint: string;
  daemonVersion: string;
  callbacks: DaemonTransportCallbacks;
  shouldExitAfterHandoff: () => boolean;
  getPendingHandoffCount: () => number;
  getHelloState: () => DaemonHelloState;
}): Promise<never> {
  const pollUrl = `${input.base}${POLL_PATH}`;
  input.callbacks.logEvent("info", "conn", "HTTP polling started", {
    pollUrl,
    daemonVersion: input.daemonVersion,
    fingerprint: input.fingerprint,
  });

  let consecutiveAuthFailures = 0;
  let handoffWaitLogged = false;

  for (;;) {
    try {
      const response = await fetchWithTimeout(
        pollUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-machine-api-key": input.apiKey },
          body: JSON.stringify({
            fingerprint: input.fingerprint,
            daemonVersion: input.daemonVersion,
            runningGovernanceJobIds: input.getHelloState().runningGovernanceJobIds,
          }),
        },
        POLL_FETCH_TIMEOUT_MS,
      );
      if (response.status === 401) {
        consecutiveAuthFailures += 1;
        const reason = await readPollFailureReason(response);
        const shouldWarn =
          consecutiveAuthFailures === AUTH_FAILURE_WARN_THRESHOLD ||
          (consecutiveAuthFailures > AUTH_FAILURE_WARN_THRESHOLD &&
            (consecutiveAuthFailures - AUTH_FAILURE_WARN_THRESHOLD) % AUTH_FAILURE_REMINDER_EVERY === 0);
        if (shouldWarn) {
          input.callbacks.logEvent("info", "err", "HTTP polling auth still failing", {
            reason,
            fingerprint: input.fingerprint,
            failures: consecutiveAuthFailures,
          });
        } else if (consecutiveAuthFailures < AUTH_FAILURE_WARN_THRESHOLD) {
          input.callbacks.logEvent("info", "err", "HTTP polling auth failed", {
            reason,
            backoffMs: AUTH_FAILURE_BACKOFF_MS,
            failures: consecutiveAuthFailures,
          });
        }
        await input.callbacks.sleep(AUTH_FAILURE_BACKOFF_MS);
        continue;
      }
      if (!response.ok) {
        consecutiveAuthFailures = 0;
        input.callbacks.logEvent("info", "conn", "HTTP polling non-ok response", {
          status: response.status,
          retryAfterMs: RECONNECT_DELAY_MS,
        });
        await input.callbacks.sleep(RECONNECT_DELAY_MS);
        continue;
      }
      if (consecutiveAuthFailures > 0) {
        input.callbacks.logEvent("info", "conn", "HTTP polling auth recovered", {
          previousFailures: consecutiveAuthFailures,
        });
        consecutiveAuthFailures = 0;
      }

      const data = (await response.json()) as {
        ok: boolean;
        userId?: string;
        commands?: MachineCommand[];
      };
      if (data.userId) input.callbacks.onBindUser(data.userId);
      for (const command of data.commands ?? []) {
        await input.callbacks.onCommand(command);
      }

      if (input.shouldExitAfterHandoff()) {
        const pending = input.getPendingHandoffCount();
        if (pending > 0) {
          if (!handoffWaitLogged) {
            input.callbacks.logEvent("info", "life", "handoff waiting for active work", { pending });
            handoffWaitLogged = true;
          }
        } else {
          input.callbacks.logEvent("info", "life", "handoff complete, exiting foreground daemon");
          await input.callbacks.sleep(200);
          process.exit(0);
        }
      }
    } catch (error) {
      input.callbacks.logEvent("info", "conn", "HTTP polling failed", {
        error: error instanceof Error ? error.message : String(error),
        retryAfterMs: RECONNECT_DELAY_MS,
      });
      await input.callbacks.sleep(RECONNECT_DELAY_MS);
    }
  }
}
