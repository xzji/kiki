import WebSocket from "ws";

import { MACHINE_TUNNEL_WS_PATH, type MachineTunnelEnvelope } from "@/lib/server/tunnel/machineTunnelProtocol";
import type {
  DaemonHelloState,
  DaemonOutboundTransport,
  DaemonTransportCallbacks,
} from "@/lib/daemon/transport/types";
import type { DaemonLogDomain, DaemonLogLevel } from "@/lib/daemon/daemonLogger";

const WS_INBOUND_WATCHDOG_MS = 70_000;
const WS_MIN_RECONNECT_DELAY_MS = 1_000;
const WS_MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_PENDING_WS_OUTBOUND_ENVELOPES = 2_000;

function sendEnvelopeOverWs(ws: WebSocket, envelope: MachineTunnelEnvelope) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

function createBufferedWsOutbound(input: {
  getActiveWs: () => WebSocket | null;
  logEvent: (
    level: DaemonLogLevel,
    domain: DaemonLogDomain,
    message: string,
    fields?: Record<string, string | number | boolean | null | undefined>,
  ) => void;
}) {
  const pendingOutbound: MachineTunnelEnvelope[] = [];

  function enqueuePending(envelope: MachineTunnelEnvelope) {
    if (pendingOutbound.length >= MAX_PENDING_WS_OUTBOUND_ENVELOPES) {
      pendingOutbound.shift();
      input.logEvent("info", "stream", "WS pending outbound overflow, dropped oldest", {
        maxPending: MAX_PENDING_WS_OUTBOUND_ENVELOPES,
      });
    }
    pendingOutbound.push(envelope);
  }

  function sendOrQueue(envelope: MachineTunnelEnvelope) {
    const activeWs = input.getActiveWs();
    if (activeWs && sendEnvelopeOverWs(activeWs, envelope)) return;
    enqueuePending(envelope);
  }

  function flushPending() {
    const activeWs = input.getActiveWs();
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN || pendingOutbound.length === 0) return;
    let flushed = 0;
    while (pendingOutbound.length > 0) {
      const envelope = pendingOutbound[0];
      if (!sendEnvelopeOverWs(activeWs, envelope)) break;
      pendingOutbound.shift();
      flushed += 1;
    }
    if (flushed > 0) {
      input.logEvent("info", "stream", "WS flushed pending outbound", { flushed });
    }
  }

  async function flushPendingToTransport(transport: DaemonOutboundTransport) {
    if (pendingOutbound.length === 0) return;
    const pending = pendingOutbound.splice(0);
    let flushed = 0;
    for (const envelope of pending) {
      if (envelope.kind === "result") {
        await transport.sendResult(envelope.result);
        flushed += 1;
      } else if (envelope.kind === "stream") {
        await transport.sendStreamChunk(envelope.sessionId, envelope.event, envelope.seq ?? 0);
        flushed += 1;
      }
    }
    if (flushed > 0) {
      input.logEvent("info", "stream", "WS flushed pending outbound via HTTP fallback", { flushed });
    }
  }

  const transport: DaemonOutboundTransport = {
    async sendResult(result) {
      sendOrQueue({ kind: "result", result });
    },
    async sendStreamChunk(sessionId, event, seq) {
      sendOrQueue({ kind: "stream", sessionId, event, seq });
    },
  };

  return { transport, flushPending, flushPendingToTransport };
}

export async function runWebSocketTransport(input: {
  base: string;
  apiKey: string;
  fingerprint: string;
  daemonVersion: string;
  callbacks: DaemonTransportCallbacks;
  getHelloState: () => DaemonHelloState;
  setOutboundTransport: (transport: DaemonOutboundTransport) => void;
  transportMode: string;
}): Promise<"fallback"> {
  const wsUrl = `${input.base.replace(/^http/, "ws")}${MACHINE_TUNNEL_WS_PATH}`;
  let reconnectDelay = WS_MIN_RECONNECT_DELAY_MS;
  let consecutiveFailures = 0;
  let activeWs: WebSocket | null = null;
  const bufferedOutbound = createBufferedWsOutbound({
    getActiveWs: () => activeWs,
    logEvent: input.callbacks.logEvent,
  });
  input.setOutboundTransport(bufferedOutbound.transport);

  for (;;) {
    let ws: WebSocket | null = null;
    let openedAt = 0;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let heartbeatSeen = false;

    const clearWatchdog = () => {
      if (!watchdogTimer) return;
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    };
    const resetWatchdog = () => {
      clearWatchdog();
      watchdogTimer = setTimeout(() => {
        input.callbacks.logEvent("info", "conn", "WS inbound watchdog timeout", {
          watchdogMs: WS_INBOUND_WATCHDOG_MS,
        });
        ws?.terminate();
      }, WS_INBOUND_WATCHDOG_MS);
    };

    input.setOutboundTransport(bufferedOutbound.transport);
    input.callbacks.logEvent("info", "conn", "WS tunnel connecting", { wsUrl });

    await new Promise<void>((resolve) => {
      const currentWs = new WebSocket(wsUrl, {
        perMessageDeflate: false,
        headers: {
          "x-machine-api-key": input.apiKey,
          "x-machine-fingerprint": input.fingerprint,
        },
      });
      ws = currentWs;

      currentWs.on("open", () => {
        if (ws !== currentWs) return;
        openedAt = Date.now();
        activeWs = currentWs;
        input.callbacks.logEvent("info", "conn", "WS tunnel connected", {
          daemonVersion: input.daemonVersion,
          fingerprint: input.fingerprint,
        });
        resetWatchdog();
        input.setOutboundTransport(bufferedOutbound.transport);
        const helloState = input.getHelloState();
        sendEnvelopeOverWs(currentWs, {
          kind: "hello",
          daemonVersion: input.daemonVersion,
          fingerprint: input.fingerprint,
          capabilities: [
            "execute",
            "discover_runtimes",
            "check_runtime",
            "select_directory",
            "skills",
            "daemon_service",
            "run_prompt",
            "stream_prompt",
            "topic_governance_tick",
            "thread_governance_tick",
          ],
          runningJobIds: helloState.runningJobIds,
          runningGovernanceJobIds: helloState.runningGovernanceJobIds,
          activeStreamSessionIds: helloState.activeStreamSessionIds,
        });
        bufferedOutbound.flushPending();
      });

      currentWs.on("message", (data) => {
        if (ws !== currentWs) return;
        resetWatchdog();
        let envelope: MachineTunnelEnvelope;
        try {
          envelope = JSON.parse(data.toString()) as MachineTunnelEnvelope;
        } catch {
          input.callbacks.logEvent("info", "err", "WS invalid json ignored");
          return;
        }
        if (!envelope || typeof envelope.kind !== "string") {
          input.callbacks.logEvent("info", "err", "WS unknown message ignored");
          return;
        }
        if (envelope.kind === "hello_ack") {
          input.callbacks.onBindUser(envelope.userId);
          return;
        }
        if (envelope.kind === "ping") {
          if (!heartbeatSeen) {
            heartbeatSeen = true;
            input.callbacks.logEvent("info", "hb", "WS heartbeat established");
          }
          sendEnvelopeOverWs(currentWs, { kind: "pong", nonce: envelope.nonce });
          return;
        }
        if (envelope.kind === "pong") {
          input.callbacks.logEvent("debug", "hb", "WS pong received");
          return;
        }
        if (envelope.kind === "command") {
          void input.callbacks.onCommand(envelope.command);
          return;
        }
        input.callbacks.logEvent("info", "err", "WS unsupported envelope ignored", { kind: envelope.kind });
      });

      currentWs.on("close", (code, reason) => {
        if (ws !== currentWs) return;
        clearWatchdog();
        if (activeWs === currentWs) activeWs = null;
        input.setOutboundTransport(bufferedOutbound.transport);
        input.callbacks.logEvent("info", "conn", "WS tunnel closed", {
          code,
          reason: reason.toString("utf8") || "none",
          lifetimeMs: openedAt ? Date.now() - openedAt : 0,
        });
        resolve();
      });

      currentWs.on("error", (error) => {
        if (ws !== currentWs) return;
        input.callbacks.logEvent("info", "err", "WS tunnel error", { error: error.message });
      });
    });

    const lifetimeMs = openedAt ? Date.now() - openedAt : 0;
    if (lifetimeMs < 5_000) {
      consecutiveFailures += 1;
      input.callbacks.logEvent("info", "conn", "WS quick disconnect", {
        lifetimeMs,
        consecutiveFailures,
      });
    } else {
      consecutiveFailures = 0;
      reconnectDelay = WS_MIN_RECONNECT_DELAY_MS;
    }
    input.callbacks.logEvent("debug", "conn", "WS reconnect scheduled", { reconnectDelayMs: reconnectDelay });
    await input.callbacks.sleep(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, WS_MAX_RECONNECT_DELAY_MS);
  }
}
