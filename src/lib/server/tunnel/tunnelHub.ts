import type { Server as HttpServer } from "http";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import {
  assertMachineFingerprint,
  authenticateMachineApiKey,
  touchMachineHeartbeat,
  type AuthenticatedMachine,
} from "@/lib/server/services/machineService";
import { parseTunnelMessage, serializeTunnelMessage } from "@/lib/server/tunnel/tunnelProtocol";

type MachineConnection = {
  socket: WebSocket;
  machine: AuthenticatedMachine;
  fingerprint?: string;
};

type PendingExecute = {
  machineId: string;
  resolve: (result: { ok: boolean; error?: string }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ExecuteResultListener = (input: { jobId: string; ok: boolean; error?: string }) => void;
type MachineDisconnectListener = (machineId: string) => void;

const connections = new Map<string, MachineConnection>();
const pendingExecutes = new Map<string, PendingExecute>();
let executeResultListener: ExecuteResultListener | null = null;
let machineDisconnectListener: MachineDisconnectListener | null = null;

function extractApiKey(requestUrl: string | undefined) {
  if (!requestUrl) return null;
  try {
    const url = new URL(requestUrl, "http://localhost");
    return url.searchParams.get("api-key") ?? url.searchParams.get("apiKey");
  } catch {
    return null;
  }
}

function rejectPendingForMachine(machineId: string, reason: string) {
  Array.from(pendingExecutes.entries()).forEach(([jobId, pending]) => {
    if (pending.machineId !== machineId) return;
    clearTimeout(pending.timer);
    pendingExecutes.delete(jobId);
    pending.reject(new Error(reason));
  });
}

function notifyExecuteResult(input: { jobId: string; ok: boolean; error?: string }) {
  executeResultListener?.(input);
}

export function setTunnelExecuteResultListener(listener: ExecuteResultListener | null) {
  executeResultListener = listener;
}

export function setMachineDisconnectListener(listener: MachineDisconnectListener | null) {
  machineDisconnectListener = listener;
}

function handleMachineDisconnected(machineId: string) {
  rejectPendingForMachine(machineId, `machine ${machineId} 连接已断开`);
  machineDisconnectListener?.(machineId);
}

export function getTunnelHub() {
  return {
    isMachineOnline(machineId: string) {
      const connection = connections.get(machineId);
      return Boolean(connection && connection.socket.readyState === connection.socket.OPEN);
    },
    getOnlineMachineIdsForUser(userId: string) {
      return Array.from(connections.values())
        .filter((entry) => entry.machine.userId === userId && entry.socket.readyState === entry.socket.OPEN)
        .map((entry) => entry.machine.machineId);
    },
    sendExecute(input: {
      machineId: string;
      jobId: string;
      requestId: string;
      payload: Record<string, unknown>;
    }) {
      const connection = connections.get(input.machineId);
      if (!connection || connection.socket.readyState !== connection.socket.OPEN) {
        throw new Error(`machine ${input.machineId} 不在线`);
      }
      connection.socket.send(
        serializeTunnelMessage({
          type: "execute",
          jobId: input.jobId,
          requestId: input.requestId,
          payload: input.payload,
        }),
      );
    },
    async dispatchExecute(input: {
      machineId: string;
      jobId: string;
      requestId: string;
      payload: Record<string, unknown>;
      timeoutMs?: number;
    }) {
      const connection = connections.get(input.machineId);
      if (!connection || connection.socket.readyState !== connection.socket.OPEN) {
        throw new Error(`machine ${input.machineId} 不在线`);
      }
      const timeoutMs = input.timeoutMs ?? 30 * 60_000;
      return new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingExecutes.delete(input.jobId);
          reject(new Error(`machine ${input.machineId} 执行超时`));
        }, timeoutMs);
        pendingExecutes.set(input.jobId, {
          machineId: input.machineId,
          resolve,
          reject,
          timer,
        });
        connection.socket.send(
          serializeTunnelMessage({
            type: "execute",
            jobId: input.jobId,
            requestId: input.requestId,
            payload: input.payload,
          }),
        );
      });
    },
  };
}

function handleClientMessage(connection: MachineConnection, raw: string) {
  const message = parseTunnelMessage(raw);
  if (!message) return;
  if (message.type === "register") {
    if (message.fingerprint) {
      const fingerprintCheck = assertMachineFingerprint(connection.machine.machineId, message.fingerprint);
      if (!fingerprintCheck.ok) {
        connections.delete(connection.machine.machineId);
        connection.socket.close(4403, fingerprintCheck.reason);
        return;
      }
      connection.fingerprint = message.fingerprint;
    }
    touchMachineHeartbeat(connection.machine.machineId, connection.fingerprint);
    return;
  }
  if (message.type === "heartbeat") {
    touchMachineHeartbeat(connection.machine.machineId, connection.fingerprint);
    connection.socket.send(serializeTunnelMessage({ type: "pong", ts: new Date().toISOString() }));
    return;
  }
  if (message.type === "execute_result") {
    const pending = pendingExecutes.get(message.jobId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingExecutes.delete(message.jobId);
      pending.resolve({ ok: message.ok, error: message.error });
    }
    notifyExecuteResult({
      jobId: message.jobId,
      ok: message.ok,
      error: message.error,
    });
    return;
  }
  if (message.type === "event") {
    // P3b 后续：归一后写入 goal_event_log。MVP 先忽略。
    return;
  }
}

function bindSocket(connection: MachineConnection) {
  const { socket, machine } = connection;
  socket.on("message", (data) => {
    handleClientMessage(connection, String(data));
  });
  socket.on("close", () => {
    connections.delete(machine.machineId);
    handleMachineDisconnected(machine.machineId);
  });
  socket.on("error", () => {
    connections.delete(machine.machineId);
    handleMachineDisconnected(machine.machineId);
  });
  socket.send(
    serializeTunnelMessage({
      type: "registered",
      machineId: machine.machineId,
      userId: machine.userId,
    }),
  );
}

function acceptMachineConnection(socket: WebSocket, requestUrl: string | undefined) {
  const apiKey = extractApiKey(requestUrl);
  if (!apiKey) {
    socket.close(4401, "missing api-key");
    return;
  }
  const machine = authenticateMachineApiKey(apiKey);
  if (!machine) {
    socket.close(4401, "invalid api-key");
    return;
  }
  const existing = connections.get(machine.machineId);
  if (existing) {
    try {
      existing.socket.close(4000, "replaced");
    } catch {
      // ignore
    }
  }
  const connection: MachineConnection = { socket, machine };
  connections.set(machine.machineId, connection);
  touchMachineHeartbeat(machine.machineId);
  bindSocket(connection);
}

/** 本地开发：Tunnel 独立端口（:3001） */
export function startTunnelHub(port: number) {
  const wss = new WebSocketServer({ port });
  wss.on("connection", (socket, request) => {
    acceptMachineConnection(socket, request.url);
  });
  return wss;
}

/** Railway 生产：Tunnel 与 Next 共用 HTTP 端口（WSS upgrade） */
export function attachTunnelHub(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (!extractApiKey(request.url)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      acceptMachineConnection(ws, request.url);
    });
  });
  return wss;
}
