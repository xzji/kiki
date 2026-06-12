import WebSocket from "ws";

import { MACHINE_TUNNEL_WS_PATH, type MachineTunnelEnvelope } from "@/lib/server/tunnel/machineTunnelProtocol";
import type {
  DaemonHelloState,
  DaemonOutboundTransport,
  DaemonTransportCallbacks,
} from "@/lib/daemon/transport/types";

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
  log: (message: string) => void;
}) {
  const pendingOutbound: MachineTunnelEnvelope[] = [];

  function enqueuePending(envelope: MachineTunnelEnvelope) {
    if (pendingOutbound.length >= MAX_PENDING_WS_OUTBOUND_ENVELOPES) {
      pendingOutbound.shift();
      input.log(`WS 待补发队列超过 ${MAX_PENDING_WS_OUTBOUND_ENVELOPES}，已丢弃最旧分片`);
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
      input.log(`WS 已补发 ${flushed} 条断线期间结果/流式分片`);
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
      input.log(`WS 降级前已通过 HTTP 补发 ${flushed} 条结果/流式分片`);
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
    log: input.callbacks.log,
  });
  input.setOutboundTransport(bufferedOutbound.transport);

  for (;;) {
    let ws: WebSocket | null = null;
    let openedAt = 0;
    let watchdogTimer: NodeJS.Timeout | null = null;

    const clearWatchdog = () => {
      if (!watchdogTimer) return;
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    };
    const resetWatchdog = () => {
      clearWatchdog();
      watchdogTimer = setTimeout(() => {
        input.callbacks.log(`WS ${WS_INBOUND_WATCHDOG_MS / 1000}s 无入站消息，强制重连…`);
        ws?.terminate();
      }, WS_INBOUND_WATCHDOG_MS);
    };

    input.setOutboundTransport(bufferedOutbound.transport);
    input.callbacks.log(`尝试建立 WS tunnel：${wsUrl}`);

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
        input.callbacks.log("WS tunnel 已连接");
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
          ],
          runningJobIds: helloState.runningJobIds,
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
          input.callbacks.log("WS 收到 invalid_json，已忽略");
          return;
        }
        if (!envelope || typeof envelope.kind !== "string") {
          input.callbacks.log("WS 收到未知消息，已忽略");
          return;
        }
        if (envelope.kind === "hello_ack") {
          input.callbacks.onBindUser(envelope.userId);
          return;
        }
        if (envelope.kind === "ping") {
          sendEnvelopeOverWs(currentWs, { kind: "pong", nonce: envelope.nonce });
          return;
        }
        if (envelope.kind === "pong") return;
        if (envelope.kind === "command") {
          void input.callbacks.onCommand(envelope.command);
          return;
        }
        input.callbacks.log(`WS 收到不适用于 daemon 的消息：${envelope.kind}`);
      });

      currentWs.on("close", (code, reason) => {
        if (ws !== currentWs) return;
        clearWatchdog();
        if (activeWs === currentWs) activeWs = null;
        input.setOutboundTransport(bufferedOutbound.transport);
        input.callbacks.log(`WS tunnel 断开（code=${code}, reason=${reason.toString("utf8") || "none"}）`);
        resolve();
      });

      currentWs.on("error", (error) => {
        if (ws !== currentWs) return;
        input.callbacks.log(`WS tunnel 错误：${error.message}`);
      });
    });

    const lifetimeMs = openedAt ? Date.now() - openedAt : 0;
    if (lifetimeMs < 5_000) {
      consecutiveFailures += 1;
      input.callbacks.log(`WS 快速断连（${lifetimeMs}ms），连续失败 ${consecutiveFailures} 次`);
    } else {
      consecutiveFailures = 0;
      reconnectDelay = WS_MIN_RECONNECT_DELAY_MS;
    }
    input.callbacks.log(`WS 将在 ${reconnectDelay / 1000}s 后重连…`);
    await input.callbacks.sleep(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, WS_MAX_RECONNECT_DELAY_MS);
  }
}
