import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Server as HttpServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";

import { appendRuntimeDaemonLog } from "@/lib/daemon/daemonState";
import { runWithUserContext } from "@/lib/server/context/userContext";
import { pushStreamChunk } from "@/lib/server/tunnel/machineStreamHub";
import {
  assertMachineFingerprint,
  authenticateMachineApiKey,
  touchMachineHeartbeat,
} from "@/lib/server/services/machineService";
import {
  type MachineCommand,
  registerMachineWsConnection,
  submitMachineResult,
  unregisterMachineWsConnection,
} from "@/lib/server/tunnel/tunnelHub";
import {
  isMachineTunnelEnvelope,
  MACHINE_TUNNEL_WS_PATH,
  type MachineTunnelEnvelope,
} from "@/lib/server/tunnel/machineTunnelProtocol";
import { reconcileMachineTunnelHello } from "@/lib/server/scheduling/taskDispatcher";
import { reconcileGovernanceTickMachineHello } from "@/lib/server/governance/governanceTickDispatcher";

const HEARTBEAT_INTERVAL_MS = 25_000;
const INBOUND_WATCHDOG_MS = 70_000;

type WsConnection = {
  machineId: string;
  userId: string;
  ws: WebSocket;
  sendCommand: ReturnType<typeof createCommandSender>;
  heartbeatTimer: NodeJS.Timeout | null;
  watchdogTimer: NodeJS.Timeout | null;
  helloSeen: boolean;
};

const WS_SERVER_STATE_KEY = Symbol.for("kiki.server.machineTunnel.wsServer.state");

function getWsState() {
  const globalRef = globalThis as typeof globalThis & {
    [WS_SERVER_STATE_KEY]?: {
      initialized: WeakSet<HttpServer>;
      connections: Map<string, WsConnection>;
    };
  };
  if (!globalRef[WS_SERVER_STATE_KEY]) {
    globalRef[WS_SERVER_STATE_KEY] = {
      initialized: new WeakSet<HttpServer>(),
      connections: new Map(),
    };
  }
  return globalRef[WS_SERVER_STATE_KEY];
}

function firstHeader(request: IncomingMessage, name: string) {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0]?.trim();
  return value?.trim();
}

function destroyWithoutHttp(socket: Duplex) {
  try {
    socket.destroy();
  } catch {
    // noop
  }
}

function createCommandSender(ws: WebSocket) {
  return (command: MachineCommand) => {
    if (ws.readyState !== ws.OPEN) return false;
    return safeSend(ws, { kind: "command", command });
  };
}

function safeSend(ws: WebSocket, envelope: MachineTunnelEnvelope) {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

function clearConnectionTimers(connection: WsConnection) {
  if (connection.heartbeatTimer) {
    clearInterval(connection.heartbeatTimer);
    connection.heartbeatTimer = null;
  }
  if (connection.watchdogTimer) {
    clearTimeout(connection.watchdogTimer);
    connection.watchdogTimer = null;
  }
}

function resetWatchdog(connection: WsConnection) {
  if (connection.watchdogTimer) clearTimeout(connection.watchdogTimer);
  connection.watchdogTimer = setTimeout(() => {
    appendRuntimeDaemonLog(`machine ${connection.machineId} WS 入站超时，强制断开重连`);
    connection.ws.terminate();
  }, INBOUND_WATCHDOG_MS);
}

function closeExistingConnection(machineId: string) {
  const existing = getWsState().connections.get(machineId);
  if (!existing) return;
  appendRuntimeDaemonLog(`machine ${machineId} 建立新 WS 连接，顶替旧连接`);
  clearConnectionTimers(existing);
  try {
    existing.ws.close(4409, "machine connection replaced");
  } catch {
    existing.ws.terminate();
  }
}

function handleEnvelope(connection: WsConnection, envelope: MachineTunnelEnvelope) {
  resetWatchdog(connection);
  touchMachineHeartbeat(connection.machineId);

  if (envelope.kind === "pong") return;

  if (envelope.kind === "hello") {
    connection.helloSeen = true;
    touchMachineHeartbeat(connection.machineId, envelope.fingerprint);
    safeSend(connection.ws, {
      kind: "hello_ack",
      machineId: connection.machineId,
      userId: connection.userId,
    });
    runWithUserContext(connection.userId, () => reconcileMachineTunnelHello({
      machineId: connection.machineId,
      userId: connection.userId,
      runningJobIds: envelope.runningJobIds,
    }));
    runWithUserContext(connection.userId, () => reconcileGovernanceTickMachineHello({
      machineId: connection.machineId,
      userId: connection.userId,
      runningGovernanceJobIds: envelope.runningGovernanceJobIds ?? [],
    }));
    appendRuntimeDaemonLog(
      `machine ${connection.machineId} WS hello：daemon=${envelope.daemonVersion} running=${envelope.runningJobIds.length} governanceRunning=${envelope.runningGovernanceJobIds?.length ?? 0} streams=${envelope.activeStreamSessionIds.length}`,
    );
    return;
  }

  if (envelope.kind === "result") {
    submitMachineResult(envelope.result, {
      userId: connection.userId,
      machineId: connection.machineId,
    });
    return;
  }

  if (envelope.kind === "stream") {
    pushStreamChunk(envelope.sessionId, envelope.event, envelope.seq);
    return;
  }

  if (envelope.kind === "ping") {
    safeSend(connection.ws, { kind: "pong", nonce: envelope.nonce });
  }
}

export function initializeMachineTunnelWsServer(server: HttpServer) {
  const state = getWsState();
  if (state.initialized.has(server)) return;
  state.initialized.add(server);

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== MACHINE_TUNNEL_WS_PATH) return;

    const apiKey = firstHeader(request, "x-machine-api-key");
    const fingerprint = firstHeader(request, "x-machine-fingerprint");
    if (!apiKey) {
      destroyWithoutHttp(socket);
      return;
    }
    const machine = authenticateMachineApiKey(apiKey);
    if (!machine) {
      destroyWithoutHttp(socket);
      return;
    }
    if (fingerprint) {
      const check = assertMachineFingerprint(machine.machineId, fingerprint);
      if (!check.ok) {
        destroyWithoutHttp(socket);
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      closeExistingConnection(machine.machineId);

      const connection: WsConnection = {
        machineId: machine.machineId,
        userId: machine.userId,
        ws,
        sendCommand: createCommandSender(ws),
        heartbeatTimer: null,
        watchdogTimer: null,
        helloSeen: false,
      };

      state.connections.set(machine.machineId, connection);
      registerMachineWsConnection({
        machineId: machine.machineId,
        userId: machine.userId,
        sender: connection.sendCommand,
      });
      touchMachineHeartbeat(machine.machineId, fingerprint);
      resetWatchdog(connection);
      connection.heartbeatTimer = setInterval(() => {
        if (ws.readyState !== ws.OPEN) return;
        safeSend(ws, { kind: "ping", nonce: String(Date.now()) });
      }, HEARTBEAT_INTERVAL_MS);

      ws.on("message", (data) => {
        if (state.connections.get(machine.machineId)?.ws !== ws) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          appendRuntimeDaemonLog(`machine ${machine.machineId} WS 收到 invalid_json，已忽略`);
          resetWatchdog(connection);
          return;
        }
        if (!isMachineTunnelEnvelope(parsed)) {
          appendRuntimeDaemonLog(`machine ${machine.machineId} WS 收到未知消息，已忽略`);
          resetWatchdog(connection);
          return;
        }
        try {
          handleEnvelope(connection, parsed);
        } catch (error) {
          appendRuntimeDaemonLog(`machine ${machine.machineId} WS 消息处理失败：${error instanceof Error ? error.message : String(error)}`);
          ws.close(1011, "internal error");
        }
      });

      ws.on("close", () => {
        if (state.connections.get(machine.machineId)?.ws !== ws) return;
        clearConnectionTimers(connection);
        state.connections.delete(machine.machineId);
        unregisterMachineWsConnection(machine.machineId, connection.sendCommand);
        appendRuntimeDaemonLog(
          `machine ${machine.machineId} WS 已断开，等待心跳过期或重连 hello 对账后再重入队在途任务`,
        );
      });

      ws.on("error", (error) => {
        appendRuntimeDaemonLog(`machine ${machine.machineId} WS 错误：${error.message}`);
      });
    });
  });

  appendRuntimeDaemonLog(`机器 Tunnel WS 端点已挂载：${MACHINE_TUNNEL_WS_PATH}`);
}
