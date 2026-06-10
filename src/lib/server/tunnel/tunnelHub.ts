import {
  assertMachineFingerprint,
  authenticateMachineApiKey,
  getOnlineMachinesForUser,
  touchMachineHeartbeat,
  type AuthenticatedMachine,
} from "@/lib/server/services/machineService";
import type {
  ClaudeJsonToolPolicy,
  ClaudePromptJsonResult,
} from "@/lib/server/claude/transport";
import type { ToolChannelPolicy } from "@/lib/runtime/toolPolicy";
import type {
  QuotedConversationMessageContext,
  LocalRuntimeKind,
  RuntimeDiscoveryItem,
  RuntimeEnvironment,
  RuntimeEnvironmentCheckInput,
  RuntimeEnvironmentCheckResult,
  RuntimeFilePolicy,
  RuntimePermissionMode,
} from "@/types/runtime";
import type { KikiSkillsInstallPayload, KikiSkillsStatusPayload } from "@/lib/kikiSkills/types";

export type RemotePromptJsonPayload = {
  prompt: string;
  runtimeEnv: RuntimeEnvironment;
  cwd: string;
  conversationId?: string;
  permissionMode?: RuntimePermissionMode;
  toolPolicy?: ClaudeJsonToolPolicy;
  filePolicy?: RuntimeFilePolicy;
  channelPolicy?: ToolChannelPolicy;
  traceContext?: {
    requestId?: string;
    scope?: string;
    phase?: string;
    stepLabel?: string;
  };
};

export type RemoteStreamPromptPayload = {
  message: string;
  workingDirectory: string;
  cliPath: string;
  permissionMode: RuntimePermissionMode;
  runtimeKind?: LocalRuntimeKind;
  conversationId?: string;
  resumeSessionId?: string;
  contextPack?: string;
  workspacePolicy?: "conversation" | "task" | string;
  systemPromptMode?: "conversation" | "neutral";
  quotedMessage?: QuotedConversationMessageContext | null;
  filePolicy?: RuntimeFilePolicy;
  channelPolicy?: ToolChannelPolicy;
};

/**
 * 机器 Tunnel —— HTTP 长轮询实现。
 *
 * 早期版本用 WebSocket（Next 自定义 server + server.on("upgrade")），但在 Railway
 * 边缘代理下，HTTP 500 会串入已升级的 WS 流（表现为 RSV1/FIN/502，本地无法复现）。
 * 改为标准 HTTP 长轮询：daemon 轮询 /api/machine-tunnel/poll 取命令，执行后
 * POST /api/machine-tunnel/result 回传。在线判定统一用 DB 心跳（每次 poll 刷新）。
 */

/** 下发给本机 daemon 的命令 */
export type MachineCommand =
  | { type: "execute"; requestId: string; jobId: string; payload: Record<string, unknown> }
  | { type: "discover_runtimes"; requestId: string }
  | { type: "check_runtime"; requestId: string; payload: RuntimeEnvironmentCheckInput }
  | { type: "select_directory"; requestId: string }
  | { type: "skills_status"; requestId: string }
  | { type: "skills_install"; requestId: string }
  | { type: "run_prompt_json"; requestId: string; payload: RemotePromptJsonPayload }
  | { type: "run_prompt_text"; requestId: string; payload: RemotePromptJsonPayload }
  | { type: "stream_prompt"; sessionId: string; payload: RemoteStreamPromptPayload }
  | { type: "cancel"; requestId: string; jobId: string };

/** daemon 回传的命令结果 */
export type MachineResult =
  | { type: "execute"; jobId: string; ok: boolean; error?: string }
  | { type: "discover_runtimes"; requestId: string; ok: boolean; items?: RuntimeDiscoveryItem[]; workingDirectory?: string; error?: string }
  | { type: "check_runtime"; requestId: string; ok: boolean; result?: RuntimeEnvironmentCheckResult; error?: string }
  | { type: "select_directory"; requestId: string; ok: boolean; path?: string; canceled?: boolean; error?: string }
  | { type: "skills_status"; requestId: string; ok: boolean; result?: KikiSkillsStatusPayload; error?: string }
  | { type: "skills_install"; requestId: string; ok: boolean; result?: KikiSkillsInstallPayload; error?: string }
  | { type: "run_prompt_json"; requestId: string; ok: boolean; result?: ClaudePromptJsonResult; error?: string }
  | { type: "run_prompt_text"; requestId: string; ok: boolean; result?: ClaudePromptJsonResult; error?: string };

type PendingTunnelRequest<T> = {
  machineId: string;
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type WaitingPoll = {
  resolve: (commands: MachineCommand[]) => void;
  timer: NodeJS.Timeout;
};

type ExecuteResultListener = (input: { jobId: string; ok: boolean; error?: string }) => void;
type MachineDisconnectListener = (machineId: string) => void;

type TunnelHubState = {
  queues: Map<string, MachineCommand[]>;
  waiting: Map<string, WaitingPoll>;
  pendingExecutes: Map<string, PendingTunnelRequest<{ ok: boolean; error?: string }>>;
  pendingDiscover: Map<string, PendingTunnelRequest<{ items: RuntimeDiscoveryItem[]; workingDirectory: string }>>;
  pendingCheckRuntime: Map<string, PendingTunnelRequest<RuntimeEnvironmentCheckResult>>;
  pendingSelectDirectory: Map<string, PendingTunnelRequest<{ path: string } | { canceled: true }>>;
  pendingSkillsStatus: Map<string, PendingTunnelRequest<KikiSkillsStatusPayload>>;
  pendingSkillsInstall: Map<string, PendingTunnelRequest<KikiSkillsInstallPayload>>;
  pendingRunPromptJson: Map<string, PendingTunnelRequest<ClaudePromptJsonResult>>;
  pendingRunPromptText: Map<string, PendingTunnelRequest<ClaudePromptJsonResult>>;
  executeResultListener: ExecuteResultListener | null;
  machineDisconnectListener: MachineDisconnectListener | null;
};

// 自定义 server 入口与 Next API route bundle 是两份模块实例，模块级 const 不共享。
// 状态挂到 globalThis，保证 poll/result 路由与编排器访问同一份队列。
const HUB_STATE_KEY = Symbol.for("kiki.server.machineTunnel.state");

function getState(): TunnelHubState {
  const globalRef = globalThis as typeof globalThis & { [HUB_STATE_KEY]?: TunnelHubState };
  if (!globalRef[HUB_STATE_KEY]) {
    globalRef[HUB_STATE_KEY] = {
      queues: new Map(),
      waiting: new Map(),
      pendingExecutes: new Map(),
      pendingDiscover: new Map(),
      pendingCheckRuntime: new Map(),
      pendingSelectDirectory: new Map(),
      pendingSkillsStatus: new Map(),
      pendingSkillsInstall: new Map(),
      pendingRunPromptJson: new Map(),
      pendingRunPromptText: new Map(),
      executeResultListener: null,
      machineDisconnectListener: null,
    };
  }
  return globalRef[HUB_STATE_KEY];
}

function isMachineOnlineDb(userId: string, machineId: string) {
  return getOnlineMachinesForUser(userId).some((machine) => machine.id === machineId);
}

function enqueueCommand(machineId: string, command: MachineCommand) {
  const state = getState();
  const waiting = state.waiting.get(machineId);
  if (waiting) {
    clearTimeout(waiting.timer);
    state.waiting.delete(machineId);
    waiting.resolve([command]);
    return;
  }
  const queue = state.queues.get(machineId) ?? [];
  queue.push(command);
  state.queues.set(machineId, queue);
}

/** 长轮询取命令：有则立即返回，否则挂起最多 timeoutMs，期间有命令入队即唤醒。 */
export function takeMachineCommands(machineId: string, timeoutMs: number): Promise<MachineCommand[]> {
  const state = getState();
  const queue = state.queues.get(machineId);
  if (queue && queue.length > 0) {
    state.queues.set(machineId, []);
    return Promise.resolve(queue);
  }
  // 同一机器只允许一个等待中的 poll，新 poll 顶替旧的（旧的返回空）。
  const existing = state.waiting.get(machineId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.resolve([]);
    state.waiting.delete(machineId);
  }
  return new Promise<MachineCommand[]>((resolve) => {
    const timer = setTimeout(() => {
      state.waiting.delete(machineId);
      resolve([]);
    }, timeoutMs);
    state.waiting.set(machineId, { resolve, timer });
  });
}

/** 处理 daemon 回传的命令结果 */
export function submitMachineResult(result: MachineResult) {
  const state = getState();
  if (result.type === "execute") {
    const pending = state.pendingExecutes.get(result.jobId);
    if (pending) {
      clearTimeout(pending.timer);
      state.pendingExecutes.delete(result.jobId);
      pending.resolve({ ok: result.ok, error: result.error });
    }
    state.executeResultListener?.({ jobId: result.jobId, ok: result.ok, error: result.error });
    return;
  }
  if (result.type === "discover_runtimes") {
    const pending = state.pendingDiscover.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingDiscover.delete(result.requestId);
    if (!result.ok || !result.items) {
      pending.reject(new Error(result.error || "本机 Runtime 扫描失败"));
      return;
    }
    pending.resolve({ items: result.items, workingDirectory: result.workingDirectory || "" });
    return;
  }
  if (result.type === "check_runtime") {
    const pending = state.pendingCheckRuntime.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingCheckRuntime.delete(result.requestId);
    if (!result.result) {
      pending.reject(new Error(result.error || "本机 Runtime 检测失败"));
      return;
    }
    pending.resolve(result.result);
    return;
  }
  if (result.type === "select_directory") {
    const pending = state.pendingSelectDirectory.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingSelectDirectory.delete(result.requestId);
    if (result.canceled) {
      pending.resolve({ canceled: true });
      return;
    }
    if (!result.ok || !result.path) {
      pending.reject(new Error(result.error || "本机目录选择失败"));
      return;
    }
    pending.resolve({ path: result.path });
    return;
  }
  if (result.type === "skills_status") {
    const pending = state.pendingSkillsStatus.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingSkillsStatus.delete(result.requestId);
    if (!result.ok || !result.result) {
      pending.reject(new Error(result.error || "本机 KiKi 默认 skills 状态获取失败"));
      return;
    }
    pending.resolve(result.result);
    return;
  }
  if (result.type === "skills_install") {
    const pending = state.pendingSkillsInstall.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingSkillsInstall.delete(result.requestId);
    if (!result.ok || !result.result) {
      pending.reject(new Error(result.error || "本机 KiKi 默认 skills 安装失败"));
      return;
    }
    pending.resolve(result.result);
    return;
  }
  if (result.type === "run_prompt_json") {
    const pending = state.pendingRunPromptJson.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingRunPromptJson.delete(result.requestId);
    if (!result.ok || !result.result) {
      pending.reject(new Error(result.error || "本机 Claude JSON 调用失败"));
      return;
    }
    pending.resolve(result.result);
    return;
  }
  if (result.type === "run_prompt_text") {
    const pending = state.pendingRunPromptText.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingRunPromptText.delete(result.requestId);
    if (!result.ok || !result.result) {
      pending.reject(new Error(result.error || "本机 Claude 文本调用失败"));
      return;
    }
    pending.resolve(result.result);
  }
}

/** poll 入口：鉴权 + 心跳 + 取命令。返回 null 表示鉴权失败。 */
export async function pollMachineCommands(input: {
  apiKey: string;
  fingerprint?: string;
  timeoutMs: number;
}): Promise<{ machine: AuthenticatedMachine; commands: MachineCommand[] } | { error: string } > {
  const machine = authenticateMachineApiKey(input.apiKey);
  if (!machine) return { error: "invalid api-key" };
  if (input.fingerprint) {
    const check = assertMachineFingerprint(machine.machineId, input.fingerprint);
    if (!check.ok) return { error: check.reason };
  }
  touchMachineHeartbeat(machine.machineId, input.fingerprint);
  const commands = await takeMachineCommands(machine.machineId, input.timeoutMs);
  return { machine, commands };
}

export function authenticateMachineForResult(apiKey: string) {
  return authenticateMachineApiKey(apiKey);
}

export function setTunnelExecuteResultListener(listener: ExecuteResultListener | null) {
  getState().executeResultListener = listener;
}

export function setMachineDisconnectListener(listener: MachineDisconnectListener | null) {
  getState().machineDisconnectListener = listener;
}

/** machine 离线时由编排器调用，重新入队其在途任务 */
export function notifyMachineOffline(machineId: string) {
  const state = getState();
  Array.from(state.pendingExecutes.entries()).forEach(([jobId, pending]) => {
    if (pending.machineId !== machineId) return;
    clearTimeout(pending.timer);
    state.pendingExecutes.delete(jobId);
    pending.reject(new Error(`machine ${machineId} 离线`));
  });
  state.queues.delete(machineId);
  state.machineDisconnectListener?.(machineId);
}

export function getTunnelHub() {
  const state = getState();
  return {
    isMachineOnline(machineId: string, userId: string) {
      return isMachineOnlineDb(userId, machineId);
    },
    getOnlineMachineIdsForUser(userId: string) {
      return getOnlineMachinesForUser(userId).map((machine) => machine.id);
    },
    sendExecute(input: { machineId: string; jobId: string; requestId: string; payload: Record<string, unknown> }) {
      enqueueCommand(input.machineId, {
        type: "execute",
        jobId: input.jobId,
        requestId: input.requestId,
        payload: input.payload,
      });
    },
    requestDiscoverRuntimes(input: { machineId: string; timeoutMs?: number }) {
      const requestId = `discover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = input.timeoutMs ?? 60_000;
      return new Promise<{ items: RuntimeDiscoveryItem[]; workingDirectory: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pendingDiscover.delete(requestId);
          reject(
            new Error("本机扫描超时。请确认 daemon 已更新到最新版（npx @kiki_agent/daemon@latest）并保持在线。"),
          );
        }, timeoutMs);
        state.pendingDiscover.set(requestId, { machineId: input.machineId, resolve, reject, timer });
        enqueueCommand(input.machineId, { type: "discover_runtimes", requestId });
      });
    },
    requestCheckRuntime(input: { machineId: string; payload: RuntimeEnvironmentCheckInput; timeoutMs?: number }) {
      const requestId = `check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = input.timeoutMs ?? 90_000;
      return new Promise<RuntimeEnvironmentCheckResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pendingCheckRuntime.delete(requestId);
          reject(new Error("本机 Runtime 检测超时，请确认 daemon 在线且为最新版"));
        }, timeoutMs);
        state.pendingCheckRuntime.set(requestId, { machineId: input.machineId, resolve, reject, timer });
        enqueueCommand(input.machineId, { type: "check_runtime", requestId, payload: input.payload });
      });
    },
    requestSelectDirectory(input: { machineId: string; timeoutMs?: number }) {
      const requestId = `select-dir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = input.timeoutMs ?? 6 * 60 * 1000;
      return new Promise<{ path: string } | { canceled: true }>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pendingSelectDirectory.delete(requestId);
          reject(new Error("本机目录选择超时。请确认 daemon 已更新到最新版并保持在线。"));
        }, timeoutMs);
        state.pendingSelectDirectory.set(requestId, { machineId: input.machineId, resolve, reject, timer });
        enqueueCommand(input.machineId, { type: "select_directory", requestId });
      });
    },
    requestKikiSkillsStatus(input: { machineId: string; timeoutMs?: number }) {
      const requestId = `skills-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = input.timeoutMs ?? 60_000;
      return new Promise<KikiSkillsStatusPayload>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pendingSkillsStatus.delete(requestId);
          reject(new Error("本机 KiKi 默认 skills 状态获取超时，请确认 daemon 已更新到最新版并保持在线"));
        }, timeoutMs);
        state.pendingSkillsStatus.set(requestId, { machineId: input.machineId, resolve, reject, timer });
        enqueueCommand(input.machineId, { type: "skills_status", requestId });
      });
    },
    requestInstallKikiSkills(input: { machineId: string; timeoutMs?: number }) {
      const requestId = `skills-install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = input.timeoutMs ?? 90_000;
      return new Promise<KikiSkillsInstallPayload>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pendingSkillsInstall.delete(requestId);
          reject(new Error("本机 KiKi 默认 skills 安装超时，请确认 daemon 已更新到最新版并保持在线"));
        }, timeoutMs);
        state.pendingSkillsInstall.set(requestId, { machineId: input.machineId, resolve, reject, timer });
        enqueueCommand(input.machineId, { type: "skills_install", requestId });
      });
    },
    requestRunPromptJson(input: { machineId: string; payload: RemotePromptJsonPayload; timeoutMs?: number }) {
      const requestId = `json-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;
      return new Promise<ClaudePromptJsonResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pendingRunPromptJson.delete(requestId);
          reject(new Error("本机 Claude JSON 调用超时，请确认 daemon 在线且为最新版"));
        }, timeoutMs);
        state.pendingRunPromptJson.set(requestId, { machineId: input.machineId, resolve, reject, timer });
        enqueueCommand(input.machineId, { type: "run_prompt_json", requestId, payload: input.payload });
      });
    },
    requestRunPromptText(input: { machineId: string; payload: RemotePromptJsonPayload; timeoutMs?: number }) {
      const requestId = `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;
      return new Promise<ClaudePromptJsonResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pendingRunPromptText.delete(requestId);
          reject(new Error("本机 Claude 文本调用超时，请确认 daemon 在线且为最新版"));
        }, timeoutMs);
        state.pendingRunPromptText.set(requestId, { machineId: input.machineId, resolve, reject, timer });
        enqueueCommand(input.machineId, { type: "run_prompt_text", requestId, payload: input.payload });
      });
    },
    sendStreamPrompt(input: { machineId: string; sessionId: string; payload: RemoteStreamPromptPayload }) {
      enqueueCommand(input.machineId, {
        type: "stream_prompt",
        sessionId: input.sessionId,
        payload: input.payload,
      });
    },
  };
}
