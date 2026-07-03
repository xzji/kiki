import { createHash, randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

process.env.KIKI_MACHINE_EXECUTOR = "true";

import { appendRuntimeDaemonLog } from "@/lib/daemon/daemonState";
import { createDaemonTrace, logDaemonEvent, logTraceEnabledWarning } from "@/lib/daemon/daemonLogger";
import { enterUserContext, runWithUserContext } from "@/lib/server/context/userContext";
import { runGoalTask } from "@/lib/server/goalTaskRunner";
import { getGoalTelemetryProgress, setGoalTelemetryObserver, updateGoalTelemetry } from "@/lib/server/goalTelemetry";
import { getKikiDefaultSkillsStatus, installKikiDefaultSkills } from "@/lib/server/kikiSkills/installService";
import { runGovernanceTickLocally } from "@/lib/server/governance/governanceTickLocalExecutor";
import { isGovernanceTickCommand, type GovernanceTickMachineCommand } from "@/lib/server/governance/governanceTickProtocol";
import { pickDirectoryWithOsascript } from "@/lib/server/runtime/selectWorkingDirectory";
import { discoverLocalRuntimes, validateRuntimeEnvironment } from "@/lib/server/runtimeEnvValidation";
import { provisionUserWorkspace } from "@/lib/server/services/userProvisioning";
import type { RuntimeJobPayload } from "@/lib/server/repositories/runtimeJobsRepository";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { ClaudeStreamEvent } from "@/lib/server/claude/transport";
import { normalizeClaudeJsonText } from "@/lib/server/claude/jsonRepair";
import { runRuntimePromptJson, runRuntimePromptText, streamRuntimePrompt } from "@/lib/server/runtime/runtimeTransport";
import { resolveLocalCliCwd } from "@/lib/server/runtime/resolveLocalCliCwd";
import {
  getPendingToolPermissionRequest,
  resolveToolPermissionDecision,
} from "@/lib/server/toolPermission/toolPermissionBroker";
import {
  addSessionToolPermissionRule,
  getSessionToolPermissionRules,
  getToolPermissionSessionKey,
  seedSessionToolPermissionRules,
} from "@/lib/server/toolPermission/sessionToolPermissionStore";
import { makeId } from "@/lib/utils";
import type {
  MachineCommand,
  MachineResult,
  RemoteDaemonServiceStatus,
  RemotePromptJsonPayload,
  RemoteStreamPromptPayload,
} from "@/lib/server/tunnel/tunnelHub";
import {
  createHttpPollingOutbound,
  runHttpPollingTransport,
} from "@/lib/daemon/transport/httpPollingTransport";
import { runWebSocketTransport } from "@/lib/daemon/transport/webSocketTransport";
import type { DaemonOutboundTransport } from "@/lib/daemon/transport/types";
import type { RuntimeEnvironmentCheckInput } from "@/types/runtime";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";

const DEVICE_ID_FILE = "daemon-device-id";

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export type RemoteDaemonServiceManager = {
  installService: () => Promise<RemoteDaemonServiceStatus>;
  uninstallService: () => Promise<RemoteDaemonServiceStatus>;
  serviceStatus: () => Promise<RemoteDaemonServiceStatus>;
};

type RunRemoteDaemonLoopInput = {
  serverUrl: string;
  apiKey: string;
  daemonVersion?: string;
  serviceManager?: RemoteDaemonServiceManager;
};

function normalizeBaseUrl(serverUrl: string) {
  return serverUrl.replace(/\/$/, "");
}

function daemonStateDirectory() {
  if (process.env.KIKI_DAEMON_HOME?.trim()) return process.env.KIKI_DAEMON_HOME.trim();
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "kiki-agent");
  }
  return path.join(os.homedir(), ".kiki");
}

function fallbackDeviceId() {
  return createHash("sha256")
    .update([os.hostname(), os.homedir(), process.platform, process.arch].join("|"))
    .digest("hex")
    .slice(0, 32);
}

function readOrCreateDeviceId() {
  try {
    const directory = daemonStateDirectory();
    const filePath = path.join(directory, DEVICE_ID_FILE);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf8").trim();
      if (existing) return existing;
    }
    const next = randomUUID();
    fs.writeFileSync(filePath, `${next}\n`, { mode: 0o600 });
    return next;
  } catch {
    return fallbackDeviceId();
  }
}

function osFingerprint() {
  return `device:${process.platform}-${process.arch}:${readOrCreateDeviceId()}`;
}

function safeJsonBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

const GOVERNANCE_RAW_LOG_LIMIT = 1200;

function publishRuntimeSessionProgress(input: {
  requestId: string;
  payload: RuntimeJobPayload;
  sessionId: string | null;
}) {
  const nextPayload = { ...(getGoalTelemetryProgress(input.requestId)?.resultPayload ?? {}) };
  delete nextPayload.runtimeSessionId;
  delete nextPayload.runtimeSessionInvalid;
  updateGoalTelemetry({
    requestId: input.requestId,
    scope: "goal_task_execute",
    phase: "executing",
    message: input.sessionId ? "Claude 会话已记录，可用于断点续跑" : "Claude 会话已失效，已清除断点续跑会话",
    goalId: input.payload.goal.id,
    taskId: input.payload.task.id,
    taskInstanceId: input.payload.instance.id,
    resultPayload: input.sessionId
      ? { ...nextPayload, runtimeSessionId: input.sessionId }
      : { ...nextPayload, runtimeSessionInvalid: true },
  });
}

function clipGovernanceRaw(value: string | undefined) {
  if (!value) return "";
  return value.length > GOVERNANCE_RAW_LOG_LIMIT ? `${value.slice(0, GOVERNANCE_RAW_LOG_LIMIT)}...` : value;
}

function commandPayloadKeys(command: MachineCommand) {
  const payload = "payload" in command ? command.payload : null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  return Object.keys(payload).join(",");
}

function commandLogFields(command: MachineCommand) {
  return {
    type: command.type,
    requestId: "requestId" in command ? command.requestId : undefined,
    sessionId: "sessionId" in command ? command.sessionId : undefined,
    jobId: "jobId" in command ? command.jobId : undefined,
    bytes: safeJsonBytes(command),
  };
}

function resultLogFields(result: MachineResult) {
  const maybe = result as MachineResult & {
    requestId?: string;
    sessionId?: string;
    jobId?: string;
    ok?: boolean;
    status?: string;
    error?: string;
    trajectory?: unknown[];
  };
  return {
    type: result.type,
    requestId: maybe.requestId,
    sessionId: maybe.sessionId,
    jobId: maybe.jobId,
    ok: maybe.ok,
    status: maybe.status,
    error: maybe.error,
    trajectorySteps: Array.isArray(maybe.trajectory) ? maybe.trajectory.length : undefined,
  };
}

async function executeRemoteJob(input: {
  jobId: string;
  requestId: string;
  payload: RuntimeJobPayload;
  initialTrajectory: ExecutionTrajectoryStep[];
  signal: AbortSignal;
}) {
  seedSessionToolPermissionRules({
    conversationId: input.payload.goal.conversationId,
    taskInstanceId: input.payload.instance.id,
    runtimeEnvId: input.payload.runtimeEnv.id,
    rules: input.payload.toolPermissionSessionRules,
  });
  return runGoalTask({
    requestId: input.requestId,
    goal: input.payload.goal,
    subGoal: input.payload.subGoal,
    task: input.payload.task,
    instance: input.payload.instance,
    runtimeEnv: input.payload.runtimeEnv,
    resumeContext: input.payload.resumeContext,
    resumeSessionId: input.payload.resumeSessionId,
    initialTrajectory: input.initialTrajectory,
    signal: input.signal,
    onSessionId: (sessionId) =>
      publishRuntimeSessionProgress({
        requestId: input.requestId,
        payload: input.payload,
        sessionId,
      }),
  });
}

function persistLiveToolPermissionDecision(decision: {
  requestId: string;
  decision: "allow" | "deny";
  scope: "once" | "conversation" | "runtime" | "deny";
  rule?: string;
}) {
  if (decision.decision !== "allow") return false;
  if (!decision.rule || (decision.scope !== "conversation" && decision.scope !== "runtime")) return false;
  const request = getPendingToolPermissionRequest(decision.requestId);
  if (!request) return false;
  const key = getToolPermissionSessionKey({
    conversationId: request.conversationId,
    taskInstanceId: request.taskInstanceId,
    runtimeEnvId: request.runtimeEnvId,
  });
  const beforeCount = getSessionToolPermissionRules(key).length;
  addSessionToolPermissionRule(key, {
    id: makeId("tool-rule"),
    pattern: decision.rule,
    label: decision.rule,
    source: "user",
    createdAt: new Date().toISOString(),
  });
  return getSessionToolPermissionRules(key).length > beforeCount;
}

export async function handleGovernanceTickDaemonCommand(input: {
  command: GovernanceTickMachineCommand;
  invoke: LlmInvoke;
  sendResult: (result: MachineResult) => Promise<void>;
  now?: Date;
}) {
  const result = await runGovernanceTickLocally({
    command: input.command,
    invoke: input.invoke,
    now: input.now,
  });
  console.info("[governance_daemon]", "local tick finished", {
    governanceJobId: input.command.governanceJobId,
    targetKind: input.command.targetKind,
    ok: result.ok,
    outcomeOk: result.outcome?.targetKind === "topic" ? result.outcome.ok : result.outcome?.result.ok,
    error:
      result.error ??
      (result.outcome?.targetKind === "topic"
        ? result.outcome.error
        : result.outcome?.result.ok === false
          ? result.outcome.result.error.kind
          : undefined),
  });
  await input.sendResult(result);
  console.info("[governance_daemon]", "result sent", {
    governanceJobId: input.command.governanceJobId,
    targetKind: input.command.targetKind,
    ok: result.ok,
  });
  return result;
}

export async function runRemoteDaemonLoop(input: RunRemoteDaemonLoopInput) {
  const base = normalizeBaseUrl(input.serverUrl);
  const fingerprint = osFingerprint();
  const daemonVersion = input.daemonVersion ?? "dev";
  logTraceEnabledWarning();
  logDaemonEvent("info", "life", "remote daemon started", {
    daemonVersion,
    transport: process.env.KIKI_DAEMON_TRANSPORT ?? "auto",
    fingerprint,
  });

  let boundUserId: string | null = null;
  const runningJobs = new Set<string>();
  const runningGovernanceJobs = new Set<string>();
  const requestIdToRunningJob = new Map<string, string>();
  const runningJobControllers = new Map<string, AbortController>();
  const commandStartedAtByRequestId = new Map<string, number>();
  const commandStartedAtByJobId = new Map<string, number>();
  // 进行中的流式会话数（stream_prompt 不进 runningJobs，需单独计数，避免交接退出打断实时流）。
  const activeStreamSessionIds = new Set<string>();
  // 方案 A：前台进程在网页开启 24h、后台服务接管后置位，由主循环择机优雅退出。
  let shouldExitAfterHandoff = false;

  let outboundTransport: DaemonOutboundTransport = createHttpPollingOutbound({
    base,
    apiKey: input.apiKey,
    logEvent: logDaemonEvent,
  });

  function setOutboundTransport(transport: DaemonOutboundTransport) {
    outboundTransport = transport;
  }

  async function sendResult(result: MachineResult) {
    await outboundTransport.sendResult(result);
    const fields = resultLogFields(result);
    const requestStartedAt = fields.requestId ? commandStartedAtByRequestId.get(fields.requestId) : undefined;
    const jobStartedAt = fields.jobId ? commandStartedAtByJobId.get(fields.jobId) : undefined;
    const startedAt = requestStartedAt ?? jobStartedAt;
    logDaemonEvent("info", result.type === "execute_progress" ? "exec" : "cmd", "done", {
      ...fields,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    });
    if (result.type !== "execute_progress") {
      if (fields.requestId) commandStartedAtByRequestId.delete(fields.requestId);
      if (fields.jobId) commandStartedAtByJobId.delete(fields.jobId);
    }
  }

  function sendExecuteProgress(result: Extract<MachineResult, { type: "execute_progress" }>) {
    void sendResult(result).catch((error) => {
      logDaemonEvent("info", "err", "execute progress send failed", {
        jobId: result.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  setGoalTelemetryObserver({
    onProgress(progress) {
      const jobId = requestIdToRunningJob.get(progress.requestId);
      if (!jobId) return;
      sendExecuteProgress({ type: "execute_progress", jobId, progress });
    },
    onLog(log) {
      if (!log.requestId) return;
      const jobId = requestIdToRunningJob.get(log.requestId);
      if (!jobId) return;
      sendExecuteProgress({ type: "execute_progress", jobId, log });
    },
  });

  async function sendStreamChunk(sessionId: string, event: ClaudeStreamEvent, seq: number) {
    if (event.type === "done" || event.type === "error") {
      logDaemonEvent(event.type === "error" ? "info" : "debug", event.type === "error" ? "err" : "stream", "stream chunk send", {
        sessionId,
        seq,
        eventType: event.type,
        error: event.type === "error" ? event.message : undefined,
      });
    }
    await outboundTransport.sendStreamChunk(sessionId, event, seq);
  }

  async function runPromptOnMachine(payload: RemotePromptJsonPayload, mode: "json" | "text") {
    const cwd = resolveLocalCliCwd({
      cwd: payload.cwd,
      fallbackWorkingDirectory: payload.runtimeEnv.workingDirectory,
      conversationId: payload.conversationId,
    });
    const runner = mode === "json" ? runRuntimePromptJson : runRuntimePromptText;
    const trace = createDaemonTrace({
      type: mode === "json" ? "run_prompt_json" : "run_prompt_text",
      requestId: payload.traceContext?.requestId,
      metadata: { conversationId: payload.conversationId, cwd },
    });
    trace?.writePrompt(payload.prompt);
    try {
      const result = await runner({
        prompt: payload.prompt,
        runtimeEnv: payload.runtimeEnv,
        cwd,
        conversationId: payload.conversationId,
        permissionMode: payload.permissionMode,
        toolPolicy: payload.toolPolicy,
        filePolicy: payload.filePolicy,
        channelPolicy: payload.channelPolicy,
        traceContext: payload.traceContext,
      });
      trace?.writeOutput(result);
      trace?.finish("completed");
      return result;
    } catch (error) {
      trace?.finish("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  function buildGovernanceLlmInvoke(command: GovernanceTickMachineCommand): LlmInvoke {
    return async ({ prompt }) => {
      if (!command.llm) {
        throw new Error("governance tick command missing llm runtime payload");
      }
      const result = await runPromptOnMachine(
        {
          ...command.llm,
          prompt,
          traceContext: {
            requestId: command.requestId,
            scope: "governance_tick",
            phase: command.targetKind,
          },
        },
        "json",
      );
      let parsed: Record<string, unknown> | undefined;
      let parseError: string | undefined;
      let parsedShape: "object" | "array" | "primitive" | "invalid_json" = "invalid_json";
      const normalizedRaw = normalizeClaudeJsonText(result.raw);
      try {
        const value = JSON.parse(normalizedRaw) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsed = value as Record<string, unknown>;
          parsedShape = "object";
        } else if (Array.isArray(value)) {
          parsedShape = "array";
        } else {
          parsedShape = "primitive";
        }
      } catch (error) {
        parsed = undefined;
        parseError = error instanceof Error ? error.message : String(error);
      }
      // 记录 runtime 返回的原貌，覆盖“模型连合法决策 JSON 都没返回”导致下游 validation_error 的场景。
      console.info("[governance_invoke]", "machine prompt result", {
        governanceJobId: command.governanceJobId,
        targetKind: command.targetKind,
        exitCode: result.exitCode,
        elapsedMs: result.elapsedMs,
        rawBytes: Buffer.byteLength(result.raw ?? "", "utf8"),
        normalizedBytes: Buffer.byteLength(normalizedRaw ?? "", "utf8"),
        parsedShape,
        parsedKeys: parsed ? Object.keys(parsed) : undefined,
        parseError,
        rawSnippet: clipGovernanceRaw(result.raw),
        normalizedSnippet: clipGovernanceRaw(normalizedRaw),
      });
      return {
        rawText: normalizedRaw,
        parsed,
        meta: { exitCode: result.exitCode, elapsedMs: result.elapsedMs },
      };
    };
  }

  function bindUser(userId: string) {
    if (boundUserId === userId) return;
    boundUserId = userId;
    provisionUserWorkspace(userId);
    enterUserContext(userId);
    logDaemonEvent("info", "life", "machine bound user", { userId });
  }

  type DaemonCommandHandler = (command: MachineCommand, startedAt: number) => Promise<void> | void;

  async function handleGovernanceCommand(command: MachineCommand) {
    if (!isGovernanceTickCommand(command)) return;
    if (runningGovernanceJobs.has(command.governanceJobId)) return;
    runningGovernanceJobs.add(command.governanceJobId);
    logDaemonEvent("info", "cmd", "governance tick start", {
      requestId: command.requestId,
      governanceJobId: command.governanceJobId,
      targetKind: command.targetKind,
    });
    void (async () => {
      try {
        await handleGovernanceTickDaemonCommand({
          command,
          invoke: buildGovernanceLlmInvoke(command),
          sendResult,
        });
      } finally {
        runningGovernanceJobs.delete(command.governanceJobId);
      }
    })();
  }

  const commandHandlers: Partial<Record<MachineCommand["type"], DaemonCommandHandler>> = {
    async discover_runtimes(command) {
      if (command.type !== "discover_runtimes") return;
      try {
        const result = await discoverLocalRuntimes();
        await sendResult({
          type: "discover_runtimes",
          requestId: command.requestId,
          ok: true,
          items: result.items,
          workingDirectory: os.homedir(),
        });
      } catch (error) {
        await sendResult({
          type: "discover_runtimes",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "扫描失败",
        });
      }
    },
    async check_runtime(command) {
      if (command.type !== "check_runtime") return;
      try {
        const result = await validateRuntimeEnvironment(command.payload as RuntimeEnvironmentCheckInput);
        await sendResult({ type: "check_runtime", requestId: command.requestId, ok: result.ok, result });
      } catch (error) {
        await sendResult({
          type: "check_runtime",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "检测失败",
        });
      }
    },
    async select_directory(command) {
      if (command.type !== "select_directory") return;
      try {
        const picked = await pickDirectoryWithOsascript();
        if ("canceled" in picked) {
          await sendResult({ type: "select_directory", requestId: command.requestId, ok: true, canceled: true });
          return;
        }
        await sendResult({ type: "select_directory", requestId: command.requestId, ok: true, path: picked.path });
      } catch (error) {
        await sendResult({
          type: "select_directory",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "目录选择失败",
        });
      }
    },
    async skills_status(command) {
      if (command.type !== "skills_status") return;
      try {
        const result = getKikiDefaultSkillsStatus();
        await sendResult({ type: "skills_status", requestId: command.requestId, ok: true, result });
      } catch (error) {
        await sendResult({
          type: "skills_status",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "KiKi 默认 skills 状态获取失败",
        });
      }
    },
    async skills_install(command) {
      if (command.type !== "skills_install") return;
      try {
        const result = installKikiDefaultSkills();
        await sendResult({ type: "skills_install", requestId: command.requestId, ok: true, result });
      } catch (error) {
        await sendResult({
          type: "skills_install",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "KiKi 默认 skills 安装失败",
        });
      }
    },
    async daemon_service_status(command) {
      if (command.type !== "daemon_service_status") return;
      try {
        if (!input.serviceManager) throw new Error("当前 daemon 不支持后台服务状态查询，请更新 @kiki_agent/daemon");
        const result = await input.serviceManager.serviceStatus();
        await sendResult({ type: "daemon_service_status", requestId: command.requestId, ok: true, result });
      } catch (error) {
        await sendResult({
          type: "daemon_service_status",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "后台服务状态获取失败",
        });
      }
    },
    async daemon_service_autostart(command) {
      if (command.type !== "daemon_service_autostart") return;
      try {
        if (!input.serviceManager) throw new Error("当前 daemon 不支持后台服务设置，请更新 @kiki_agent/daemon");
        if (command.enabled) {
          await input.serviceManager.installService();
        } else {
          await input.serviceManager.uninstallService();
        }
        const result = await input.serviceManager.serviceStatus();
        await sendResult({ type: "daemon_service_autostart", requestId: command.requestId, ok: true, result });
        const isManaged = process.env.KIKI_DAEMON_MANAGED === "1";
        if (command.enabled && !isManaged && result.running) shouldExitAfterHandoff = true;
      } catch (error) {
        await sendResult({
          type: "daemon_service_autostart",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "后台服务设置失败",
        });
      }
    },
    async run_prompt_json(command) {
      if (command.type !== "run_prompt_json") return;
      try {
        const result = await runPromptOnMachine(command.payload, "json");
        await sendResult({ type: "run_prompt_json", requestId: command.requestId, ok: true, result });
      } catch (error) {
        await sendResult({
          type: "run_prompt_json",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "JSON 调用失败",
        });
      }
    },
    async run_prompt_text(command) {
      if (command.type !== "run_prompt_text") return;
      try {
        const result = await runPromptOnMachine(command.payload, "text");
        await sendResult({ type: "run_prompt_text", requestId: command.requestId, ok: true, result });
      } catch (error) {
        await sendResult({
          type: "run_prompt_text",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "文本调用失败",
        });
      }
    },
    tool_permission_decision(command) {
      if (command.type !== "tool_permission_decision") return;
      const persistedSessionRule = persistLiveToolPermissionDecision(command.decision);
      const resolved = resolveToolPermissionDecision(command.decision);
      logDaemonEvent(resolved ? "info" : "debug", "stream", "tool permission decision", {
        sessionId: command.sessionId,
        requestId: command.decision.requestId,
        decision: command.decision.decision,
        scope: command.decision.scope,
        resolved,
        persistedSessionRule,
      });
    },
    stream_prompt(command, startedAt) {
      if (command.type !== "stream_prompt") return;
      activeStreamSessionIds.add(command.sessionId);
      logDaemonEvent("info", "stream", "start", {
        sessionId: command.sessionId,
        bytes: safeJsonBytes(command.payload),
      });
      void (async () => {
        const payload = command.payload as RemoteStreamPromptPayload;
        let seq = 0;
        const trace = createDaemonTrace({
          type: "stream_prompt",
          sessionId: command.sessionId,
          metadata: { conversationId: payload.conversationId, runtimeKind: payload.runtimeKind },
        });
        trace?.writePrompt(payload.message);
        const cwd = resolveLocalCliCwd({
          cwd: payload.workingDirectory,
          fallbackWorkingDirectory: payload.workingDirectory,
          conversationId: payload.workspacePolicy === "conversation" ? undefined : payload.conversationId,
        });
        try {
          seedSessionToolPermissionRules({
            conversationId: payload.conversationId,
            taskInstanceId: payload.taskInstanceId,
            runtimeEnvId: payload.runtimeEnvId,
            rules: payload.toolPermissionSessionRules,
          });
          await streamRuntimePrompt({
            message: payload.message,
            workingDirectory: cwd,
            cliPath: payload.cliPath,
            permissionMode: payload.permissionMode,
            runtimeKind: payload.runtimeKind,
            runtimeEnvId: payload.runtimeEnvId,
            resumeSessionId: payload.resumeSessionId,
            contextPack: payload.contextPack,
            collectFileArtifacts: payload.collectFileArtifacts,
            workspacePolicy: payload.workspacePolicy,
            systemPromptMode: payload.systemPromptMode,
            quotedMessage: payload.quotedMessage,
            attachments: payload.attachments,
            filePolicy: payload.filePolicy,
            channelPolicy: payload.channelPolicy,
            conversationId: payload.conversationId,
            taskInstanceId: payload.taskInstanceId,
            taskId: payload.taskId,
            agentRunId: payload.agentRunId,
            assistantMessageId: payload.assistantMessageId,
            assistantCreatedAt: payload.assistantCreatedAt,
            onEvent: (event) => {
              trace?.appendStreamEvent({ seq, event });
              void sendStreamChunk(command.sessionId, event, seq++);
            },
          });
          trace?.finish("completed");
        } catch (error) {
          trace?.finish("failed", error instanceof Error ? error.message : String(error));
          await sendStreamChunk(
            command.sessionId,
            { type: "error", message: error instanceof Error ? error.message : "流式调用失败" },
            seq++,
          );
          await sendStreamChunk(command.sessionId, { type: "done" }, seq++);
        } finally {
          activeStreamSessionIds.delete(command.sessionId);
          logDaemonEvent("info", "stream", "done", {
            sessionId: command.sessionId,
            durationMs: Date.now() - startedAt,
            chunks: seq,
          });
        }
      })();
    },
    topic_governance_tick: handleGovernanceCommand,
    thread_governance_tick: handleGovernanceCommand,
    execute(command, startedAt) {
      if (command.type !== "execute") return;
      if (runningJobs.has(command.jobId)) {
        const existingController = runningJobControllers.get(command.jobId);
        const hasLiveController = Boolean(existingController) && !existingController!.signal.aborted;
        if (hasLiveController) {
          // 真正在执行中的重复下发：daemon 已通过 hello 上报该 job running，云端不应重复启动。
          // 不重跑（避免同一 job 并发双跑），但记录日志以便观测云端为何重复派发。
          logDaemonEvent("info", "exec", "duplicate execute ignored: job already running", {
            requestId: command.requestId,
            jobId: command.jobId,
          });
          return;
        }
        // 僵尸残留：runningJobs 仍持有该 jobId，但 controller 缺失或已 abort，说明上一轮执行的
        // 收尾（finally）未运行（执行链挂死或被中止后未清理）。清掉残留再按新命令重跑，
        // 否则该 jobId 会永久占用 hello 上报的 running 名额，撑满并发预算导致后续任务无法派发。
        logDaemonEvent("info", "exec", "reclaiming stale running job before re-execute", {
          requestId: command.requestId,
          jobId: command.jobId,
        });
        runningJobs.delete(command.jobId);
        runningJobControllers.delete(command.jobId);
      }
      const abortController = new AbortController();
      runningJobs.add(command.jobId);
      runningJobControllers.set(command.jobId, abortController);
      requestIdToRunningJob.set(command.requestId, command.jobId);
      logDaemonEvent("info", "exec", "start", {
        requestId: command.requestId,
        jobId: command.jobId,
        bytes: safeJsonBytes(command.payload),
      });
      void (async () => {
        const trace = createDaemonTrace({ type: "execute", requestId: command.requestId, jobId: command.jobId });
        try {
          const raw = command.payload as Partial<RuntimeJobPayload> & { trajectory?: ExecutionTrajectoryStep[] };
          trace?.writePayload(raw);
          if (!raw.goal || !raw.subGoal || !raw.task || !raw.instance || !raw.runtimeEnv) {
            throw new Error("execute payload 不完整");
          }
          if (!boundUserId) throw new Error("machine 尚未绑定用户");
          const payload: RuntimeJobPayload = {
            goal: raw.goal,
            subGoal: raw.subGoal,
            task: raw.task,
            instance: raw.instance,
            runtimeEnv: raw.runtimeEnv,
            resumeContext: raw.resumeContext,
            resumeSessionId: raw.resumeSessionId,
            executionMachineId: raw.executionMachineId,
            toolPermissionSessionRules: raw.toolPermissionSessionRules,
          };
          const initialTrajectory = Array.isArray(raw.trajectory) ? raw.trajectory : [];
          const outcome = await runWithUserContext(boundUserId, () =>
            executeRemoteJob({
              jobId: command.jobId,
              requestId: command.requestId,
              payload,
              initialTrajectory,
              signal: abortController.signal,
            }),
          );
          logDaemonEvent("info", "exec", "done", {
            requestId: command.requestId,
            jobId: command.jobId,
            status: outcome.status,
            hasBlocker: Boolean(outcome.blocker),
            trajectorySteps: outcome.trajectory?.length ?? 0,
            durationMs: Date.now() - startedAt,
          });
          trace?.writeOutput(outcome);
          trace?.finish("completed");
          await sendResult({
            type: "execute",
            jobId: command.jobId,
            ok: outcome.status !== "failed",
            error: outcome.status === "failed" ? outcome.error : undefined,
            status: outcome.status,
            blocker: outcome.blocker ?? undefined,
            trajectory: outcome.trajectory,
            result: outcome.result ?? undefined,
          });
        } catch (error) {
          const aborted = abortController.signal.aborted;
          const message = aborted ? "用户终止任务执行" : error instanceof Error ? error.message : "执行失败";
          trace?.finish("failed", message);
          logDaemonEvent("info", aborted ? "exec" : "err", aborted ? "execute cancelled" : "execute failed", {
            requestId: command.requestId,
            jobId: command.jobId,
            durationMs: Date.now() - startedAt,
            error: message,
          });
          await sendResult({
            type: "execute",
            jobId: command.jobId,
            ok: false,
            status: "failed",
            error: message,
          });
        } finally {
          // 仅当本次执行的 controller 仍是当前登记的那个时才清理，避免被 reclaim 重跑后
          // 旧的挂死 promise 迟到 settle 时误删新一轮执行的 runningJobs / controller 状态。
          if (runningJobControllers.get(command.jobId) === abortController) {
            runningJobs.delete(command.jobId);
            runningJobControllers.delete(command.jobId);
            if (requestIdToRunningJob.get(command.requestId) === command.jobId) {
              requestIdToRunningJob.delete(command.requestId);
            }
          }
        }
      })();
    },
    cancel(command) {
      if (command.type !== "cancel") return;
      const abortController = runningJobControllers.get(command.jobId);
      const running = runningJobs.has(command.jobId);
      if (!abortController || abortController.signal.aborted) {
        // 僵尸兜底：jobId 仍在 runningJobs（撑占 hello 上报的 running 名额），但 controller
        // 缺失或已 abort，无法再 abort 出一个 failed 终态。直接清理本地残留并回执 cancelled，
        // 让云端解除 in-flight、释放并发预算，避免后续任务永久无法派发。
        if (running) {
          logDaemonEvent("info", "exec", "cancel reclaiming stale running job", {
            requestId: command.requestId,
            jobId: command.jobId,
            reason: command.reason,
          });
          runningJobs.delete(command.jobId);
          runningJobControllers.delete(command.jobId);
          void sendResult({
            type: "execute",
            jobId: command.jobId,
            ok: false,
            status: "failed",
            error: command.reason ?? "任务已取消",
          });
          return;
        }
        logDaemonEvent("info", "cmd", "cancel ignored", {
          requestId: command.requestId,
          jobId: command.jobId,
          running,
          reason: command.reason,
        });
        return;
      }
      logDaemonEvent("info", "cmd", "cancel received", {
        requestId: command.requestId,
        jobId: command.jobId,
        running,
        reason: command.reason,
      });
      abortController.abort();
    },
  };

  async function handleCommand(command: MachineCommand) {
    const startedAt = Date.now();
    if ("requestId" in command) commandStartedAtByRequestId.set(command.requestId, startedAt);
    if ("jobId" in command) commandStartedAtByJobId.set(command.jobId, startedAt);
    logDaemonEvent("info", "cmd", "recv", commandLogFields(command));
    logDaemonEvent("debug", "cmd", "payload keys", { ...commandLogFields(command), keys: commandPayloadKeys(command) });
    const handler = commandHandlers[command.type];
    if (handler) {
      await handler(command, startedAt);
      return;
    }
    logDaemonEvent("info", "cmd", "ignored unsupported command", { type: command.type });
  }

  const callbacks = {
    log: appendRuntimeDaemonLog,
    logEvent: logDaemonEvent,
    sleep,
    // WS 模式下命令由 ws "message" 事件回调触发：bindUser(hello_ack) 里的 enterWith 只对
    // 当次回调的延续生效，不会传播到后续 command 回调（二者是 socket 的兄弟异步操作）。
    // 必须在此用 runWithUserContext 显式包裹，使 handleCommand 同步创建的 stream_prompt /
    // run_prompt_* 异步链继承用户上下文，否则 getCurrentUserId() 会抛「缺少用户上下文」，
    // 导致流式对话静默失败、前端收不到任何回复。
    onCommand: (command: MachineCommand) =>
      boundUserId
        ? runWithUserContext(boundUserId, () => handleCommand(command))
        : handleCommand(command),
    onBindUser: bindUser,
  };
  const transportMode = process.env.KIKI_DAEMON_TRANSPORT ?? "auto";
  if (transportMode !== "polling") {
    await runWebSocketTransport({
      base,
      apiKey: input.apiKey,
      fingerprint,
      daemonVersion,
      callbacks,
      getHelloState: () => ({
        runningJobIds: Array.from(runningJobs),
        runningGovernanceJobIds: Array.from(runningGovernanceJobs),
        activeStreamSessionIds: Array.from(activeStreamSessionIds),
      }),
      setOutboundTransport,
      transportMode,
    });
    if (transportMode === "ws") return;
    setOutboundTransport(createHttpPollingOutbound({ base, apiKey: input.apiKey, logEvent: logDaemonEvent }));
    logDaemonEvent("info", "conn", "HTTP polling fallback started", { reason: "ws_fallback" });
  }

  await runHttpPollingTransport({
    base,
    apiKey: input.apiKey,
    fingerprint,
    daemonVersion,
    callbacks,
    shouldExitAfterHandoff: () => shouldExitAfterHandoff,
    getPendingHandoffCount: () => runningJobs.size + runningGovernanceJobs.size + activeStreamSessionIds.size,
    getHelloState: () => ({
      runningJobIds: Array.from(runningJobs),
      runningGovernanceJobIds: Array.from(runningGovernanceJobs),
      activeStreamSessionIds: Array.from(activeStreamSessionIds),
    }),
  });

}
