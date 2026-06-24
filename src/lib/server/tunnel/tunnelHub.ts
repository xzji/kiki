import {
  assertMachineFingerprint,
  authenticateMachineApiKey,
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
  RuntimeInputAttachment,
  RuntimePermissionMode,
} from "@/types/runtime";
import type { ToolPermissionDecision } from "@/lib/server/toolPermission/types";
import type { KikiSkillsInstallPayload, KikiSkillsStatusPayload } from "@/lib/kikiSkills/types";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type {
  GovernanceTickMachineCommand,
  GovernanceTickMachineResult,
  GovernanceTickOutcome,
} from "@/lib/server/governance/governanceTickProtocol";
import { isGovernanceTickMachineResult } from "@/lib/server/governance/governanceTickProtocol";

export type RemoteDaemonServiceKind = "launchd" | "systemd" | "unsupported";

export type RemoteDaemonServiceStatus = {
  platform: string;
  kind: RemoteDaemonServiceKind;
  installed: boolean;
  running: boolean;
  path: string;
  pid?: number | null;
  daemonVersion?: string | null;
};

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
  runtimeEnvId?: string;
  conversationId?: string;
  taskInstanceId?: string;
  taskId?: string;
  agentRunId?: string;
  assistantMessageId?: string;
  assistantCreatedAt?: string;
  resumeSessionId?: string;
  contextPack?: string;
  collectFileArtifacts?: boolean;
  workspacePolicy?: "conversation" | "task" | string;
  systemPromptMode?: "conversation" | "neutral";
  quotedMessage?: QuotedConversationMessageContext | null;
  attachments?: RuntimeInputAttachment[];
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
  | GovernanceTickMachineCommand
  | { type: "discover_runtimes"; requestId: string }
  | { type: "check_runtime"; requestId: string; payload: RuntimeEnvironmentCheckInput }
  | { type: "select_directory"; requestId: string }
  | { type: "skills_status"; requestId: string }
  | { type: "skills_install"; requestId: string }
  | { type: "daemon_service_status"; requestId: string }
  | { type: "daemon_service_autostart"; requestId: string; enabled: boolean }
  | { type: "run_prompt_json"; requestId: string; payload: RemotePromptJsonPayload }
  | { type: "run_prompt_text"; requestId: string; payload: RemotePromptJsonPayload }
  | { type: "stream_prompt"; sessionId: string; payload: RemoteStreamPromptPayload }
  | { type: "tool_permission_decision"; sessionId: string; decision: ToolPermissionDecision }
  | { type: "cancel"; requestId: string; jobId: string; reason?: string };

/** goal task 执行终态：本机执行完后回传，云端据此落 completed/failed/awaiting_user */
export type MachineExecuteStatus = "completed" | "failed" | "awaiting_user";

/** daemon 回传的命令结果 */
export type MachineResult =
  | {
      type: "execute";
      jobId: string;
      ok: boolean;
      error?: string;
      /** 结构化终态。缺省时回退按 ok 推断（completed/failed），兼容旧版 daemon。 */
      status?: MachineExecuteStatus;
      blocker?: unknown;
      trajectory?: unknown;
      result?: Record<string, unknown> | null;
    }
  | GovernanceTickMachineResult
  | {
      type: "execute_progress";
      jobId: string;
      progress?: GoalServerProgress;
      log?: GoalServerLogEntry;
      trajectory?: ExecutionTrajectoryStep[];
    }
  | { type: "discover_runtimes"; requestId: string; ok: boolean; items?: RuntimeDiscoveryItem[]; workingDirectory?: string; error?: string }
  | { type: "check_runtime"; requestId: string; ok: boolean; result?: RuntimeEnvironmentCheckResult; error?: string }
  | { type: "select_directory"; requestId: string; ok: boolean; path?: string; canceled?: boolean; error?: string }
  | { type: "skills_status"; requestId: string; ok: boolean; result?: KikiSkillsStatusPayload; error?: string }
  | { type: "skills_install"; requestId: string; ok: boolean; result?: KikiSkillsInstallPayload; error?: string }
  | { type: "daemon_service_status"; requestId: string; ok: boolean; result?: RemoteDaemonServiceStatus; error?: string }
  | { type: "daemon_service_autostart"; requestId: string; ok: boolean; result?: RemoteDaemonServiceStatus; error?: string }
  | { type: "run_prompt_json"; requestId: string; ok: boolean; result?: ClaudePromptJsonResult; error?: string }
  | { type: "run_prompt_text"; requestId: string; ok: boolean; result?: ClaudePromptJsonResult; error?: string };

export type { GovernanceTickOutcome };

type PendingTunnelRequest<T> = {
  machineId: string;
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type RequestMachineCommandType =
  | "discover_runtimes"
  | "check_runtime"
  | "select_directory"
  | "skills_status"
  | "skills_install"
  | "daemon_service_status"
  | "daemon_service_autostart"
  | "run_prompt_json"
  | "run_prompt_text";

type RequestMachineResult = Extract<MachineResult, { type: RequestMachineCommandType }>;

type RequestCommandResultMap = {
  discover_runtimes: { items: RuntimeDiscoveryItem[]; workingDirectory: string };
  check_runtime: RuntimeEnvironmentCheckResult;
  select_directory: { path: string } | { canceled: true };
  skills_status: KikiSkillsStatusPayload;
  skills_install: KikiSkillsInstallPayload;
  daemon_service_status: RemoteDaemonServiceStatus;
  daemon_service_autostart: RemoteDaemonServiceStatus;
  run_prompt_json: ClaudePromptJsonResult;
  run_prompt_text: ClaudePromptJsonResult;
};

type MachineCommandDescriptor<TType extends RequestMachineCommandType> = {
  requestIdPrefix: string;
  defaultTimeoutMs: number;
  timeoutMessage: string;
  parseResult: (result: Extract<RequestMachineResult, { type: TType }>) => RequestCommandResultMap[TType];
};

function defineMachineCommand<TType extends RequestMachineCommandType>(
  descriptor: MachineCommandDescriptor<TType>,
) {
  return descriptor;
}

export const MachineCommandRegistry = {
  discover_runtimes: defineMachineCommand({
    requestIdPrefix: "discover",
    defaultTimeoutMs: 60_000,
    timeoutMessage: "本机扫描超时。请确认 daemon 已全局安装并更新到最新版（npm i -g @kiki_agent/daemon@latest）且保持在线。",
    parseResult(result) {
      if (!result.ok || !result.items) throw new Error(result.error || "本机 Runtime 扫描失败");
      return { items: result.items, workingDirectory: result.workingDirectory || "" };
    },
  }),
  check_runtime: defineMachineCommand({
    requestIdPrefix: "check",
    defaultTimeoutMs: 90_000,
    timeoutMessage: "本机 Runtime 检测超时，请确认 daemon 在线且为最新版",
    parseResult(result) {
      if (!result.result) throw new Error(result.error || "本机 Runtime 检测失败");
      return result.result;
    },
  }),
  select_directory: defineMachineCommand({
    requestIdPrefix: "select-dir",
    defaultTimeoutMs: 6 * 60 * 1000,
    timeoutMessage: "本机目录选择超时。请确认 daemon 已更新到最新版并保持在线。",
    parseResult(result) {
      if (result.canceled) return { canceled: true };
      if (!result.ok || !result.path) throw new Error(result.error || "本机目录选择失败");
      return { path: result.path };
    },
  }),
  skills_status: defineMachineCommand({
    requestIdPrefix: "skills-status",
    defaultTimeoutMs: 60_000,
    timeoutMessage: "本机 KiKi 默认 skills 状态获取超时，请确认 daemon 已更新到最新版并保持在线",
    parseResult(result) {
      if (!result.ok || !result.result) throw new Error(result.error || "本机 KiKi 默认 skills 状态获取失败");
      return result.result;
    },
  }),
  skills_install: defineMachineCommand({
    requestIdPrefix: "skills-install",
    defaultTimeoutMs: 90_000,
    timeoutMessage: "本机 KiKi 默认 skills 安装超时，请确认 daemon 已更新到最新版并保持在线",
    parseResult(result) {
      if (!result.ok || !result.result) throw new Error(result.error || "本机 KiKi 默认 skills 安装失败");
      return result.result;
    },
  }),
  daemon_service_status: defineMachineCommand({
    requestIdPrefix: "daemon-service-status",
    defaultTimeoutMs: 15_000,
    timeoutMessage: "本机后台服务状态获取超时，请确认 daemon 已更新到最新版并保持在线",
    parseResult(result) {
      if (!result.ok || !result.result) throw new Error(result.error || "本机后台服务状态获取失败");
      return result.result;
    },
  }),
  daemon_service_autostart: defineMachineCommand({
    requestIdPrefix: "daemon-service-autostart",
    defaultTimeoutMs: 25_000,
    timeoutMessage: "本机后台服务设置超时，请确认 daemon 已更新到最新版并保持在线",
    parseResult(result) {
      if (!result.ok || !result.result) throw new Error(result.error || "本机后台服务设置失败");
      return result.result;
    },
  }),
  run_prompt_json: defineMachineCommand({
    requestIdPrefix: "json",
    defaultTimeoutMs: 10 * 60 * 1000,
    timeoutMessage: "本机 Claude JSON 调用超时，请确认 daemon 在线且为最新版",
    parseResult(result) {
      if (!result.ok || !result.result) throw new Error(result.error || "本机 Claude JSON 调用失败");
      return result.result;
    },
  }),
  run_prompt_text: defineMachineCommand({
    requestIdPrefix: "text",
    defaultTimeoutMs: 10 * 60 * 1000,
    timeoutMessage: "本机 Claude 文本调用超时，请确认 daemon 在线且为最新版",
    parseResult(result) {
      if (!result.ok || !result.result) throw new Error(result.error || "本机 Claude 文本调用失败");
      return result.result;
    },
  }),
} satisfies {
  [TType in RequestMachineCommandType]: MachineCommandDescriptor<TType>;
};

function isRequestMachineResult(result: MachineResult): result is RequestMachineResult {
  return result.type in MachineCommandRegistry && "requestId" in result;
}

function createMachineRequestId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type WaitingPoll = {
  resolve: (commands: MachineCommand[]) => void;
  timer: NodeJS.Timeout;
};

type ExecuteResultListener = (input: {
  jobId: string;
  ok: boolean;
  error?: string;
  status?: MachineExecuteStatus;
  blocker?: unknown;
  trajectory?: unknown;
  result?: Record<string, unknown> | null;
}) => void;
type ExecuteProgressListener = (input: {
  jobId: string;
  progress?: GoalServerProgress;
  log?: GoalServerLogEntry;
  trajectory?: ExecutionTrajectoryStep[];
}) => void;
type MachineResultContext = {
  userId?: string;
  machineId?: string;
};
type GovernanceTickResultListener = (result: GovernanceTickMachineResult, context?: MachineResultContext) => void;
type MachineDisconnectListener = (machineId: string) => void;
type MachineCommandSender = (command: MachineCommand) => boolean;
type MachineWsConnection = {
  userId: string;
  sender: MachineCommandSender;
};
type MachineHttpPollingPresence = {
  userId: string;
  timer: NodeJS.Timeout;
};

type TunnelHubState = {
  queues: Map<string, MachineCommand[]>;
  waiting: Map<string, WaitingPoll>;
  wsConnections: Map<string, MachineWsConnection>;
  wsPreferredMachines: Set<string>;
  httpPollingMachines: Map<string, MachineHttpPollingPresence>;
  pendingExecutes: Map<string, PendingTunnelRequest<{ ok: boolean; error?: string }>>;
  pendingRequests: Map<string, PendingTunnelRequest<unknown>>;
  executeResultListener: ExecuteResultListener | null;
  executeProgressListener: ExecuteProgressListener | null;
  governanceTickResultListener: GovernanceTickResultListener | null;
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
      wsConnections: new Map(),
      wsPreferredMachines: new Set(),
      httpPollingMachines: new Map(),
      pendingExecutes: new Map(),
      pendingRequests: new Map(),
      executeResultListener: null,
      executeProgressListener: null,
      governanceTickResultListener: null,
      machineDisconnectListener: null,
    };
  }
  if (!globalRef[HUB_STATE_KEY].pendingRequests) {
    globalRef[HUB_STATE_KEY].pendingRequests = new Map();
  }
  return globalRef[HUB_STATE_KEY];
}

function isMachineHttpPollingOnline(machineId: string) {
  return getState().httpPollingMachines.has(machineId);
}

function getHttpPollingMachineIdsForUser(userId: string) {
  return Array.from(getState().httpPollingMachines.entries())
    .filter(([, presence]) => presence.userId === userId)
    .map(([machineId]) => machineId);
}

function registerMachineHttpPolling(machineId: string, userId: string, timeoutMs: number) {
  const state = getState();
  const existing = state.httpPollingMachines.get(machineId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const current = state.httpPollingMachines.get(machineId);
    if (current?.timer === timer) state.httpPollingMachines.delete(machineId);
  }, timeoutMs + 5_000);
  state.httpPollingMachines.set(machineId, { userId, timer });
}

function enqueueCommand(machineId: string, command: MachineCommand) {
  const state = getState();
  const wsConnection = state.wsConnections.get(machineId);
  if (wsConnection?.sender(command)) return;

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

function requestMachineCommand<TType extends RequestMachineCommandType>(input: {
  state: TunnelHubState;
  machineId: string;
  type: TType;
  timeoutMs?: number;
  buildCommand: (requestId: string) => Extract<MachineCommand, { type: TType }>;
}): Promise<RequestCommandResultMap[TType]> {
  const descriptor = MachineCommandRegistry[input.type];
  const requestId = createMachineRequestId(descriptor.requestIdPrefix);
  const timeoutMs = input.timeoutMs ?? descriptor.defaultTimeoutMs;
  return new Promise<RequestCommandResultMap[TType]>((resolve, reject) => {
    const timer = setTimeout(() => {
      input.state.pendingRequests.delete(requestId);
      reject(new Error(descriptor.timeoutMessage));
    }, timeoutMs);
    input.state.pendingRequests.set(requestId, {
      machineId: input.machineId,
      resolve: (value: unknown) => resolve(value as RequestCommandResultMap[TType]),
      reject,
      timer,
    });
    enqueueCommand(input.machineId, input.buildCommand(requestId));
  });
}

export function registerMachineWsConnection(input: { machineId: string; userId: string; sender: MachineCommandSender }) {
  const state = getState();
  const httpPolling = state.httpPollingMachines.get(input.machineId);
  if (httpPolling) {
    clearTimeout(httpPolling.timer);
    state.httpPollingMachines.delete(input.machineId);
  }
  state.wsPreferredMachines.add(input.machineId);
  state.wsConnections.set(input.machineId, { userId: input.userId, sender: input.sender });
  const queued = state.queues.get(input.machineId) ?? [];
  if (queued.length === 0) return;
  state.queues.delete(input.machineId);
  for (let index = 0; index < queued.length; index += 1) {
    if (input.sender(queued[index])) continue;
    state.queues.set(input.machineId, queued.slice(index));
    break;
  }
}

export function unregisterMachineWsConnection(machineId: string, sender?: MachineCommandSender) {
  const state = getState();
  if (sender && state.wsConnections.get(machineId)?.sender !== sender) return;
  state.wsConnections.delete(machineId);
}

export function isMachineWsOnline(machineId: string) {
  return getState().wsConnections.has(machineId);
}

export function getWsOnlineMachineIdsForUser(userId: string) {
  return Array.from(getState().wsConnections.entries())
    .filter(([, connection]) => connection.userId === userId)
    .map(([machineId]) => machineId);
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
export function submitMachineResult(result: MachineResult, context?: MachineResultContext) {
  const state = getState();
  if (result.type === "execute") {
    const pending = state.pendingExecutes.get(result.jobId);
    if (pending) {
      clearTimeout(pending.timer);
      state.pendingExecutes.delete(result.jobId);
      pending.resolve({ ok: result.ok, error: result.error });
    }
    state.executeResultListener?.({
      jobId: result.jobId,
      ok: result.ok,
      error: result.error,
      status: result.status,
      blocker: result.blocker,
      trajectory: result.trajectory,
      result: result.result,
    });
    return;
  }
  if (result.type === "execute_progress") {
    state.executeProgressListener?.({
      jobId: result.jobId,
      progress: result.progress,
      log: result.log,
      trajectory: result.trajectory,
    });
    return;
  }
  if (isGovernanceTickMachineResult(result)) {
    state.governanceTickResultListener?.(result, context);
    return;
  }
  if (isRequestMachineResult(result)) {
    const pending = state.pendingRequests.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingRequests.delete(result.requestId);
    try {
      const descriptor = MachineCommandRegistry[result.type] as MachineCommandDescriptor<typeof result.type>;
      pending.resolve(descriptor.parseResult(result as never));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
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
  registerMachineHttpPolling(machine.machineId, machine.userId, input.timeoutMs);
  const commands = await takeMachineCommands(machine.machineId, input.timeoutMs);
  return { machine, commands };
}

export function authenticateMachineForResult(apiKey: string) {
  return authenticateMachineApiKey(apiKey);
}

export function setTunnelExecuteResultListener(listener: ExecuteResultListener | null) {
  getState().executeResultListener = listener;
}

export function setTunnelExecuteProgressListener(listener: ExecuteProgressListener | null) {
  getState().executeProgressListener = listener;
}

export function setTunnelGovernanceTickResultListener(listener: GovernanceTickResultListener | null) {
  getState().governanceTickResultListener = listener;
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
  Array.from(state.pendingRequests.entries()).forEach(([requestId, pending]) => {
    if (pending.machineId !== machineId) return;
    clearTimeout(pending.timer);
    state.pendingRequests.delete(requestId);
    pending.reject(new Error(`machine ${machineId} 离线`));
  });
  state.queues.delete(machineId);
  state.machineDisconnectListener?.(machineId);
}

export function getTunnelHub() {
  const state = getState();
  return {
    isMachineOnline(machineId: string, userId: string) {
      void userId;
      if (isMachineWsOnline(machineId) || isMachineHttpPollingOnline(machineId)) return true;
      return false;
    },
    getOnlineMachineIdsForUser(userId: string) {
      return Array.from(
        new Set([
          ...getWsOnlineMachineIdsForUser(userId),
          ...getHttpPollingMachineIdsForUser(userId),
        ]),
      );
    },
    sendExecute(input: { machineId: string; jobId: string; requestId: string; payload: Record<string, unknown> }) {
      enqueueCommand(input.machineId, {
        type: "execute",
        jobId: input.jobId,
        requestId: input.requestId,
        payload: input.payload,
      });
    },
    sendCancel(input: { machineId: string; jobId: string; requestId: string; reason?: string }) {
      enqueueCommand(input.machineId, {
        type: "cancel",
        jobId: input.jobId,
        requestId: input.requestId,
        reason: input.reason,
      });
    },
    sendGovernanceTick(input: { machineId: string; command: GovernanceTickMachineCommand }) {
      enqueueCommand(input.machineId, input.command);
    },
    requestDiscoverRuntimes(input: { machineId: string; timeoutMs?: number }) {
      return requestMachineCommand({
        state,
        machineId: input.machineId,
        type: "discover_runtimes",
        timeoutMs: input.timeoutMs,
        buildCommand: (requestId) => ({ type: "discover_runtimes", requestId }),
      });
    },
    requestCheckRuntime(input: { machineId: string; payload: RuntimeEnvironmentCheckInput; timeoutMs?: number }) {
      return requestMachineCommand({
        state,
        machineId: input.machineId,
        type: "check_runtime",
        timeoutMs: input.timeoutMs,
        buildCommand: (requestId) => ({ type: "check_runtime", requestId, payload: input.payload }),
      });
    },
    requestSelectDirectory(input: { machineId: string; timeoutMs?: number }) {
      return requestMachineCommand({
        state,
        machineId: input.machineId,
        type: "select_directory",
        timeoutMs: input.timeoutMs,
        buildCommand: (requestId) => ({ type: "select_directory", requestId }),
      });
    },
    requestKikiSkillsStatus(input: { machineId: string; timeoutMs?: number }) {
      return requestMachineCommand({
        state,
        machineId: input.machineId,
        type: "skills_status",
        timeoutMs: input.timeoutMs,
        buildCommand: (requestId) => ({ type: "skills_status", requestId }),
      });
    },
    requestInstallKikiSkills(input: { machineId: string; timeoutMs?: number }) {
      return requestMachineCommand({
        state,
        machineId: input.machineId,
        type: "skills_install",
        timeoutMs: input.timeoutMs,
        buildCommand: (requestId) => ({ type: "skills_install", requestId }),
      });
    },
    requestDaemonServiceStatus(input: { machineId: string; timeoutMs?: number }) {
      return requestMachineCommand({
        state,
        machineId: input.machineId,
        type: "daemon_service_status",
        timeoutMs: input.timeoutMs,
        buildCommand: (requestId) => ({ type: "daemon_service_status", requestId }),
      });
    },
    requestDaemonServiceAutostart(input: { machineId: string; enabled: boolean; timeoutMs?: number }) {
      return requestMachineCommand({
        state,
        machineId: input.machineId,
        type: "daemon_service_autostart",
        timeoutMs: input.timeoutMs,
        buildCommand: (requestId) => ({
          type: "daemon_service_autostart",
          requestId,
          enabled: input.enabled,
        }),
      });
    },
    requestRunPromptJson(input: { machineId: string; payload: RemotePromptJsonPayload; timeoutMs?: number }) {
      return requestMachineCommand({
        state,
        machineId: input.machineId,
        type: "run_prompt_json",
        timeoutMs: input.timeoutMs,
        buildCommand: (requestId) => ({ type: "run_prompt_json", requestId, payload: input.payload }),
      });
    },
    requestRunPromptText(input: { machineId: string; payload: RemotePromptJsonPayload; timeoutMs?: number }) {
      return requestMachineCommand({
        state,
        machineId: input.machineId,
        type: "run_prompt_text",
        timeoutMs: input.timeoutMs,
        buildCommand: (requestId) => ({ type: "run_prompt_text", requestId, payload: input.payload }),
      });
    },
    sendStreamPrompt(input: { machineId: string; sessionId: string; payload: RemoteStreamPromptPayload }) {
      enqueueCommand(input.machineId, {
        type: "stream_prompt",
        sessionId: input.sessionId,
        payload: input.payload,
      });
    },
    sendToolPermissionDecision(input: { machineId: string; sessionId: string; decision: ToolPermissionDecision }) {
      enqueueCommand(input.machineId, {
        type: "tool_permission_decision",
        sessionId: input.sessionId,
        decision: input.decision,
      });
    },
  };
}
