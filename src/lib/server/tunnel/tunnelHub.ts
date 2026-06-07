import type { Server as HttpServer } from "http";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import {
  assertMachineFingerprint,
  authenticateMachineApiKey,
  touchMachineHeartbeat,
  type AuthenticatedMachine,
} from "@/lib/server/services/machineService";
import type { RuntimeDiscoveryItem, RuntimeEnvironmentCheckInput, RuntimeEnvironmentCheckResult } from "@/types/runtime";
import { parseTunnelMessage, serializeTunnelMessage } from "@/lib/server/tunnel/tunnelProtocol";
import { MACHINE_TUNNEL_WS_PATH, TUNNEL_PER_MESSAGE_DEFLATE } from "@/lib/server/tunnel/tunnelWsOptions";

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

type PendingTunnelRequest<T> = {
  machineId: string;
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ExecuteResultListener = (input: { jobId: string; ok: boolean; error?: string }) => void;
type MachineDisconnectListener = (machineId: string) => void;

type TunnelHubState = {
  connections: Map<string, MachineConnection>;
  pendingExecutes: Map<string, PendingExecute>;
  pendingDiscover: Map<string, PendingTunnelRequest<{ items: RuntimeDiscoveryItem[]; workingDirectory: string }>>;
  pendingCheckRuntime: Map<string, PendingTunnelRequest<RuntimeEnvironmentCheckResult>>;
  executeResultListener: ExecuteResultListener | null;
  machineDisconnectListener: MachineDisconnectListener | null;
};

// 生产入口 `tsx src/bin/kiki-production.ts` 与 Next 预构建的 API route bundle
// 是两份不同的模块实例，模块级 `const` 单例不共享。tunnel 的连接表必须挂到
// globalThis，保证同一进程内（WS 服务端 + API route）访问同一份状态，否则
// WebSocket 连到一份、discover/dispatch 读另一份空表，导致「在线但扫不到」。
const HUB_STATE_KEY = Symbol.for("kiki.server.tunnelHub.state");

function getState(): TunnelHubState {
  const globalRef = globalThis as typeof globalThis & {
    [HUB_STATE_KEY]?: TunnelHubState;
  };
  if (!globalRef[HUB_STATE_KEY]) {
    globalRef[HUB_STATE_KEY] = {
      connections: new Map(),
      pendingExecutes: new Map(),
      pendingDiscover: new Map(),
      pendingCheckRuntime: new Map(),
      executeResultListener: null,
      machineDisconnectListener: null,
    };
  }
  return globalRef[HUB_STATE_KEY];
}

function parseTunnelUpgradeUrl(requestUrl: string | undefined) {
  if (!requestUrl) return null;
  try {
    const url = new URL(requestUrl, "http://localhost");
    if (url.pathname !== MACHINE_TUNNEL_WS_PATH) return null;
    const apiKey = url.searchParams.get("api-key") ?? url.searchParams.get("apiKey");
    if (!apiKey) return null;
    return apiKey;
  } catch {
    return null;
  }
}

function rejectPendingForMachine(machineId: string, reason: string) {
  const state = getState();
  Array.from(state.pendingExecutes.entries()).forEach(([jobId, pending]) => {
    if (pending.machineId !== machineId) return;
    clearTimeout(pending.timer);
    state.pendingExecutes.delete(jobId);
    pending.reject(new Error(reason));
  });
  Array.from(state.pendingDiscover.entries()).forEach(([requestId, pending]) => {
    if (pending.machineId !== machineId) return;
    clearTimeout(pending.timer);
    state.pendingDiscover.delete(requestId);
    pending.reject(new Error(reason));
  });
  Array.from(state.pendingCheckRuntime.entries()).forEach(([requestId, pending]) => {
    if (pending.machineId !== machineId) return;
    clearTimeout(pending.timer);
    state.pendingCheckRuntime.delete(requestId);
    pending.reject(new Error(reason));
  });
}

function notifyExecuteResult(input: { jobId: string; ok: boolean; error?: string }) {
  getState().executeResultListener?.(input);
}

export function setTunnelExecuteResultListener(listener: ExecuteResultListener | null) {
  getState().executeResultListener = listener;
}

export function setMachineDisconnectListener(listener: MachineDisconnectListener | null) {
  getState().machineDisconnectListener = listener;
}

function handleMachineDisconnected(machineId: string) {
  rejectPendingForMachine(machineId, `machine ${machineId} 连接已断开`);
  getState().machineDisconnectListener?.(machineId);
}

export function getTunnelHub() {
  const state = getState();
  return {
    isMachineOnline(machineId: string) {
      const connection = state.connections.get(machineId);
      return Boolean(connection && connection.socket.readyState === connection.socket.OPEN);
    },
    getOnlineMachineIdsForUser(userId: string) {
      return Array.from(state.connections.values())
        .filter((entry) => entry.machine.userId === userId && entry.socket.readyState === entry.socket.OPEN)
        .map((entry) => entry.machine.machineId);
    },
    sendExecute(input: {
      machineId: string;
      jobId: string;
      requestId: string;
      payload: Record<string, unknown>;
    }) {
      const connection = state.connections.get(input.machineId);
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
    requestDiscoverRuntimes(input: { machineId: string; timeoutMs?: number }) {
      const connection = state.connections.get(input.machineId);
      if (!connection || connection.socket.readyState !== connection.socket.OPEN) {
        throw new Error(`machine ${input.machineId} 不在线`);
      }
      const requestId = `discover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = input.timeoutMs ?? 60_000;
      return new Promise<{ items: RuntimeDiscoveryItem[]; workingDirectory: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pendingDiscover.delete(requestId);
          reject(
            new Error(
              "本机扫描超时。请确认 daemon 已更新到最新版（npx @kiki_agent/daemon@latest），并保持在线。",
            ),
          );
        }, timeoutMs);
        state.pendingDiscover.set(requestId, {
          machineId: input.machineId,
          resolve,
          reject,
          timer,
        });
        connection.socket.send(serializeTunnelMessage({ type: "discover_runtimes", requestId }));
      });
    },
    requestCheckRuntime(input: {
      machineId: string;
      payload: RuntimeEnvironmentCheckInput;
      timeoutMs?: number;
    }) {
      const connection = state.connections.get(input.machineId);
      if (!connection || connection.socket.readyState !== connection.socket.OPEN) {
        throw new Error(`machine ${input.machineId} 不在线`);
      }
      const requestId = `check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = input.timeoutMs ?? 90_000;
      return new Promise<RuntimeEnvironmentCheckResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pendingCheckRuntime.delete(requestId);
          reject(new Error("本机 Runtime 检测超时，请确认 daemon 在线且为最新版"));
        }, timeoutMs);
        state.pendingCheckRuntime.set(requestId, {
          machineId: input.machineId,
          resolve,
          reject,
          timer,
        });
        connection.socket.send(
          serializeTunnelMessage({
            type: "check_runtime",
            requestId,
            payload: input.payload,
          }),
        );
      });
    },
    async dispatchExecute(input: {
      machineId: string;
      jobId: string;
      requestId: string;
      payload: Record<string, unknown>;
      timeoutMs?: number;
    }) {
      const connection = state.connections.get(input.machineId);
      if (!connection || connection.socket.readyState !== connection.socket.OPEN) {
        throw new Error(`machine ${input.machineId} 不在线`);
      }
      const timeoutMs = input.timeoutMs ?? 30 * 60_000;
      return new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pendingExecutes.delete(input.jobId);
          reject(new Error(`machine ${input.machineId} 执行超时`));
        }, timeoutMs);
        state.pendingExecutes.set(input.jobId, {
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
        getState().connections.delete(connection.machine.machineId);
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
    const state = getState();
    const pending = state.pendingExecutes.get(message.jobId);
    if (pending) {
      clearTimeout(pending.timer);
      state.pendingExecutes.delete(message.jobId);
      pending.resolve({ ok: message.ok, error: message.error });
    }
    notifyExecuteResult({
      jobId: message.jobId,
      ok: message.ok,
      error: message.error,
    });
    return;
  }
  if (message.type === "discover_runtimes_result") {
    const state = getState();
    const pending = state.pendingDiscover.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingDiscover.delete(message.requestId);
    if (!message.ok || !message.items) {
      pending.reject(new Error(message.error || "本机 Runtime 扫描失败"));
      return;
    }
    pending.resolve({
      items: message.items,
      workingDirectory: message.workingDirectory || "",
    });
    return;
  }
  if (message.type === "check_runtime_result") {
    const state = getState();
    const pending = state.pendingCheckRuntime.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingCheckRuntime.delete(message.requestId);
    if (!message.result) {
      pending.reject(new Error(message.error || "本机 Runtime 检测失败"));
      return;
    }
    pending.resolve(message.result);
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
    getState().connections.delete(machine.machineId);
    handleMachineDisconnected(machine.machineId);
  });
  socket.on("error", () => {
    getState().connections.delete(machine.machineId);
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
  const apiKey = parseTunnelUpgradeUrl(requestUrl);
  if (!apiKey) {
    socket.close(4401, "missing api-key");
    return;
  }
  const machine = authenticateMachineApiKey(apiKey);
  if (!machine) {
    socket.close(4401, "invalid api-key");
    return;
  }
  const state = getState();
  const existing = state.connections.get(machine.machineId);
  if (existing) {
    try {
      existing.socket.close(4000, "replaced");
    } catch {
      // ignore
    }
  }
  const connection: MachineConnection = { socket, machine };
  state.connections.set(machine.machineId, connection);
  touchMachineHeartbeat(machine.machineId);
  bindSocket(connection);
}

/** 本地开发：Tunnel 独立端口（:3001） */
export function startTunnelHub(port: number) {
  const wss = new WebSocketServer({ port, perMessageDeflate: TUNNEL_PER_MESSAGE_DEFLATE });
  wss.on("connection", (socket, request) => {
    acceptMachineConnection(socket, request.url);
  });
  return wss;
}

/** Railway 生产：Tunnel 与 Next 共用 HTTP 端口（WSS upgrade） */
export function attachTunnelHub(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: TUNNEL_PER_MESSAGE_DEFLATE });
  server.on("upgrade", (request, socket, head) => {
    if (!parseTunnelUpgradeUrl(request.url)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      acceptMachineConnection(ws, request.url);
    });
  });
  return wss;
}
