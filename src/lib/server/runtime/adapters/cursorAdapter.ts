import { execFile } from "child_process";
import { promisify } from "util";

import { describeRuntimeToolPolicy, resolveRuntimeToolPolicy } from "@/lib/runtime/toolPolicy";
import {
  buildWorkspacePromptPayload,
  type RuntimeStreamEvent,
} from "@/lib/server/claude/transport";
import { createClaudeTrace } from "@/lib/server/claude/traceStore";
import { buildCursorEnv } from "@/lib/server/cursorEnv";
import { shouldProxyCliToMachine } from "@/lib/server/runtime/cliExecutionMode";
import { emitRuntimeFileEvents } from "@/lib/server/runtime/fileArtifactEmit";
import type {
  RuntimeAdapter,
  RuntimePromptJsonInput,
  RuntimePromptResult,
  RuntimeStreamOptions,
} from "@/lib/server/runtime/adapters/types";
import {
  buildCursorAcpArgs,
  CursorAcpConnection,
  type CursorAcpJsonRpcMessage,
} from "@/lib/server/runtime/adapters/cursorAcpClient";
import {
  createCursorAcpParseState,
  markCursorAcpPromptFinished,
  parseCursorAcpSessionUpdate,
} from "@/lib/server/runtime/adapters/cursorAcpParser";
import { resolveCursorAcpPermissionRequest } from "@/lib/server/runtime/adapters/cursorAcpPermission";
import { writeCursorCliOverlay } from "@/lib/server/runtime/adapters/cursorToolPolicy";
import { detachToolPermissionRequest } from "@/lib/server/toolPermission/toolPermissionBroker";
import { normalizeWorkingDirectory, resolveCliPath } from "@/lib/server/runtimePath";
import type { RuntimePermissionMode } from "@/types/runtime";

const execFileAsync = promisify(execFile);
const CURSOR_SILENCE_TIMEOUT_MS = 120_000;

export function buildCursorArgs() {
  return [...buildCursorAcpArgs()];
}

function resolveCursorToolPolicy(options: {
  filePolicy?: RuntimeStreamOptions["filePolicy"];
  permissionMode?: RuntimePermissionMode;
  channelPolicy?: RuntimeStreamOptions["channelPolicy"];
  workspacePolicy?: RuntimeStreamOptions["workspacePolicy"];
}) {
  const isTaskPrompt = options.workspacePolicy === "task" || options.channelPolicy?.mode === "task";
  return resolveRuntimeToolPolicy({
    filePolicy: options.filePolicy,
    permissionMode: options.permissionMode ?? "confirm",
    channelPolicy: options.channelPolicy ?? { mode: isTaskPrompt ? "task" : "conversation" },
  });
}

type CursorAcpPermissionContext = {
  permissionMode: RuntimePermissionMode;
  runtimeEnvId?: string;
  filePolicy?: RuntimeStreamOptions["filePolicy"];
  conversationId?: string;
  taskInstanceId?: string;
  taskId?: string;
  agentRunId?: string;
  assistantMessageId?: string;
  headless?: boolean;
  emitEvent: (event: RuntimeStreamEvent) => boolean;
  activePermissionRequestIds: Set<string>;
  aborted: () => boolean;
  clearSilenceTimer?: () => void;
  armSilenceTimer?: () => void;
  appendDiagnostic?: (message: string) => void;
};

async function respondToCursorAcpPermissionRequest(
  message: CursorAcpJsonRpcMessage,
  connection: CursorAcpConnection,
  context: CursorAcpPermissionContext,
) {
  if (typeof message.id !== "number") {
    context.appendDiagnostic?.("Cursor ACP session/request_permission 缺少 JSON-RPC id\n");
    connection.close("invalid_permission_request");
    return;
  }

  context.clearSilenceTimer?.();
  try {
    const outcome = await resolveCursorAcpPermissionRequest({
      message,
      permissionMode: context.permissionMode,
      runtimeEnvId: context.runtimeEnvId,
      filePolicy: context.filePolicy,
      conversationId: context.conversationId,
      taskInstanceId: context.taskInstanceId,
      taskId: context.taskId,
      agentRunId: context.agentRunId,
      assistantMessageId: context.assistantMessageId,
      headless: context.headless,
      emitEvent: context.emitEvent,
      onRequestCreated: (requestId) => context.activePermissionRequestIds.add(requestId),
      aborted: context.aborted,
    });
    connection.respond(message.id, { outcome });
  } finally {
    context.armSilenceTimer?.();
  }
}

function cancelActiveCursorPermissionRequests(activePermissionRequestIds: Set<string>) {
  for (const requestId of Array.from(activePermissionRequestIds)) {
    detachToolPermissionRequest(requestId, "local_process_lost");
  }
  activePermissionRequestIds.clear();
}

type CursorAcpRunContext = {
  cliPath: string;
  cwd: string;
  permissionMode: RuntimePermissionMode;
  promptText: string;
  resumeSessionId?: string;
  runtimeEnvId?: string;
  filePolicy?: RuntimeStreamOptions["filePolicy"];
  headless?: boolean;
  traceContext?: RuntimePromptJsonInput["traceContext"];
  abortSignal?: AbortSignal;
  abortMessage?: string;
  failureMessage?: string;
  onSpawn?: (pid: number) => void;
  onStderr?: (chunk: string) => void;
  onParsedNotification?: (message: CursorAcpJsonRpcMessage) => void;
  consumeEvents?: (events: RuntimeStreamEvent[]) => boolean;
};

async function runCursorAcpPrompt(input: CursorAcpRunContext): Promise<{ text: string; sessionId?: string }> {
  const args = buildCursorArgs();
  const trace = createClaudeTrace({
    cwd: input.cwd,
    cliPath: input.cliPath,
    args,
    permissionMode: input.permissionMode,
    resumeSessionId: input.resumeSessionId,
    requestId: input.traceContext?.requestId,
    scope: input.traceContext?.scope ?? "cursor_acp",
    phase: input.traceContext?.phase,
    stepLabel: input.traceContext?.stepLabel,
  });
  trace?.writePrompt(input.promptText);

  let settled = false;
  let aborted = false;
  let callbackError: unknown = null;
  let activeSessionId: string | undefined;
  const parseState = createCursorAcpParseState();
  const pendingFilePaths = new Set<string>();
  const permissionChain: Promise<void>[] = [];
  const activePermissionRequestIds = new Set<string>();

  const connection = CursorAcpConnection.connect({
    cliPath: input.cliPath,
    cwd: input.cwd,
    signal: input.abortSignal,
    onStderr: (chunk) => {
      trace?.appendStderr(chunk);
      input.onStderr?.(chunk);
    },
    onNotification: async (message) => {
      input.onParsedNotification?.(message);
      trace?.appendParsedEvent(message);

      if (message.method === "session/request_permission") {
        const permissionTask = respondToCursorAcpPermissionRequest(message, connection, {
          permissionMode: input.permissionMode,
          runtimeEnvId: input.runtimeEnvId,
          filePolicy: input.filePolicy,
          headless: input.headless,
          emitEvent: () => true,
          activePermissionRequestIds,
          aborted: () => aborted || settled,
          appendDiagnostic: (diagnostic) => trace?.appendStderr(diagnostic),
        });
        permissionChain.push(permissionTask);
        await permissionTask;
        return;
      }

      if (message.method !== "session/update") return;
      const params = (message.params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
      const update = params.update;
      if (!update) return;
      activeSessionId = params.sessionId ?? activeSessionId;
      const events = parseCursorAcpSessionUpdate({
        sessionId: params.sessionId,
        update,
        state: parseState,
      });
      for (const event of events) {
        if (event.type === "tool_call" && event.input && typeof event.input === "object") {
          const inputRecord = event.input as Record<string, unknown>;
          const filePath =
            typeof inputRecord.path === "string"
              ? inputRecord.path
              : typeof inputRecord.file_path === "string"
                ? inputRecord.file_path
                : undefined;
          if (filePath) pendingFilePaths.add(filePath);
        }
        if (input.consumeEvents && !input.consumeEvents([event])) {
          callbackError = new Error("Cursor ACP 事件消费失败");
          connection.close("emitter_closed");
        }
      }
    },
  });

  if (typeof connection.process.pid === "number") {
    input.onSpawn?.(connection.process.pid);
  }

  const abort = () => {
    if (settled || aborted) return;
    aborted = true;
    cancelActiveCursorPermissionRequests(activePermissionRequestIds);
    if (activeSessionId) {
      void connection.cancel(activeSessionId);
    }
    connection.close(input.abortMessage ?? "Cursor ACP 调用已中断");
    trace?.finish("aborted", input.abortMessage ?? "Cursor ACP 调用已中断");
  };

  if (input.abortSignal?.aborted) {
    abort();
    throw new DOMException(input.abortMessage ?? "Cursor ACP 调用已中断", "AbortError");
  }
  input.abortSignal?.addEventListener("abort", abort, { once: true });

  try {
    await connection.bootstrap();
    const sessionId = await connection.openSession({
      cwd: input.cwd,
      resumeSessionId: input.resumeSessionId,
    });
    activeSessionId = sessionId;
    if (!parseState.sessionEmitted) {
      parseState.sessionEmitted = true;
      input.consumeEvents?.([{ type: "session", sessionId }]);
    }
    await connection.setMode(sessionId, input.permissionMode);
    const promptResult = await connection.prompt(sessionId, input.promptText);
    markCursorAcpPromptFinished(parseState, promptResult.stopReason);
    await connection.waitForNotifications();
    await Promise.all(permissionChain);
    settled = true;
    trace?.writeOutput(parseState.aggregatedText);
    trace?.finish("completed");
    return { text: parseState.aggregatedText.trim(), sessionId };
  } catch (error) {
    settled = true;
    if (aborted) {
      throw new DOMException(input.abortMessage ?? "Cursor ACP 调用已中断", "AbortError");
    }
    const message = error instanceof Error ? error.message : input.failureMessage || "Cursor ACP 调用失败";
    trace?.finish("failed", message);
    throw callbackError ?? new Error(message);
  } finally {
    input.abortSignal?.removeEventListener("abort", abort);
    cancelActiveCursorPermissionRequests(activePermissionRequestIds);
    connection.close();
    void pendingFilePaths;
  }
}

async function runCursorPrompt(input: RuntimePromptJsonInput, _outputFormat: "json" | "text"): Promise<RuntimePromptResult> {
  if (shouldProxyCliToMachine()) {
    const { proxyRunPromptJson, proxyRunPromptText } = await import("@/lib/server/tunnel/remoteCliProxy");
    return _outputFormat === "json" ? proxyRunPromptJson(input) : proxyRunPromptText(input);
  }

  const cwd = normalizeWorkingDirectory(input.cwd);
  const cliPath = await resolveCliPath(input.runtimeEnv.cliPath || "cursor");
  const permissionMode = input.permissionMode ?? input.runtimeEnv.permissionMode;
  const resolvedToolPolicy = resolveRuntimeToolPolicy({
    filePolicy: input.filePolicy ?? input.runtimeEnv.filePolicy,
    permissionMode,
    channelPolicy: input.channelPolicy ?? { mode: "readonly_json" },
  });
  await writeCursorCliOverlay({ workingDirectory: cwd, permissionMode, resolvedToolPolicy });

  const startedAt = Date.now();
  const { text } = await runCursorAcpPrompt({
    cliPath,
    cwd,
    permissionMode,
    promptText: input.prompt,
    runtimeEnvId: input.runtimeEnv.id,
    filePolicy: input.filePolicy ?? input.runtimeEnv.filePolicy,
    headless: true,
    traceContext: input.traceContext,
    abortSignal: input.abortSignal,
    abortMessage: input.abortMessage,
    failureMessage: input.failureMessage,
  });

  if (!text.trim()) {
    throw new Error(input.failureMessage || "Cursor ACP 未返回有效结果");
  }
  return { raw: text, exitCode: 0, stderr: "", elapsedMs: Date.now() - startedAt };
}

export const cursorAdapter: RuntimeAdapter = {
  kind: "cursor",
  meta: {
    label: "Cursor CLI",
    command: "cursor",
    versionArgs: ["agent", "--version"],
    installHint: "安装 Cursor 并确保 `cursor agent acp` 可用；运行 `cursor agent login` 完成登录。",
    uiAccent: "bg-[#EEF2FF] text-[#3730A3]",
    uiIcon: "MousePointer2",
  },
  capabilities: {
    sessionResume: true,
    permissionModes: true,
    toolSelection: "both",
    fileArtifacts: true,
  },
  async streamPrompt(options: RuntimeStreamOptions) {
    if (shouldProxyCliToMachine()) {
      const { proxyStreamPrompt } = await import("@/lib/server/tunnel/remoteCliProxy");
      return proxyStreamPrompt({ ...options, runtimeKind: "cursor" });
    }

    const cwd = normalizeWorkingDirectory(options.workingDirectory);
    const resolvedToolPolicy = resolveCursorToolPolicy(options);
    const permissionMode = options.permissionMode;
    await writeCursorCliOverlay({ workingDirectory: cwd, permissionMode, resolvedToolPolicy });

    const isTaskPrompt = options.workspacePolicy === "task" || options.channelPolicy?.mode === "task";
    const redactionMode = isTaskPrompt ? "passthrough" : "strict";
    const effectiveWorkspacePolicy = options.workspacePolicy ?? (isTaskPrompt ? "task" : undefined);
    const includeConversationIdentity = !isTaskPrompt && options.systemPromptMode === "conversation";
    const toolSummary = describeRuntimeToolPolicy(resolvedToolPolicy);
    const promptPayload = buildWorkspacePromptPayload({
      workspaceDir: cwd,
      workspacePolicy: effectiveWorkspacePolicy,
      toolSummary,
      message: options.message,
      quotedMessage: options.quotedMessage,
      contextPack: options.contextPack,
      redactionMode,
      includeConversationIdentity,
    });
    const { systemPrompt, promptInput, promptSections } = promptPayload;
    const stdinPayload = `${systemPrompt ? `${systemPrompt}\n\n` : ""}${promptInput}`;

    const cliPath = await resolveCliPath(options.cliPath || "cursor");
    options.onEvent({ type: "status", status: "checking" });
    const args = buildCursorArgs();
    const trace = createClaudeTrace({
      cwd,
      cliPath,
      args,
      permissionMode,
      toolPolicy: resolvedToolPolicy,
      resumeSessionId: options.resumeSessionId,
      scope: "conversation_chat",
      stepLabel: "Cursor ACP 会话流式回复",
    });
    trace?.writePrompt(stdinPayload);
    options.onEvent({ type: "prompt", sections: promptSections });

    let settled = false;
    let aborted = false;
    let callbackError: unknown = null;
    let emittedFatalError = false;
    let activeSessionId: string | undefined;
    const parseState = createCursorAcpParseState();
    const pendingFilePaths = new Set<string>();
    const permissionChain: Promise<void>[] = [];
    const activePermissionRequestIds = new Set<string>();
    let silenceTimer: NodeJS.Timeout | null = null;

    const clearSilenceTimer = () => {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
    };

    let connection: CursorAcpConnection | null = null;
    const emitEvent = (event: RuntimeStreamEvent) => {
      if (callbackError || settled) return false;
      try {
        options.onEvent(event);
        return true;
      } catch (error) {
        callbackError = error;
        emittedFatalError = true;
        connection?.close("emitter_closed");
        return false;
      }
    };

    const failFatal = (message: string) => {
      if (settled || emittedFatalError) return;
      emittedFatalError = true;
      connection?.close(message);
      trace?.finish("failed", message);
      emitEvent({ type: "error", message });
      emitEvent({ type: "done" });
      settled = true;
      clearSilenceTimer();
    };

    const armSilenceTimer = () => {
      if (settled) return;
      clearSilenceTimer();
      silenceTimer = setTimeout(() => {
        failFatal(
          parseState.lastModelError
            ? `Cursor ACP 长时间无响应：${parseState.lastModelError}`
            : "Cursor ACP 长时间无响应，可能是网络或认证问题。",
        );
      }, CURSOR_SILENCE_TIMEOUT_MS);
    };

    const permissionContext: CursorAcpPermissionContext = {
      permissionMode,
      runtimeEnvId: options.runtimeEnvId,
      filePolicy: options.filePolicy,
      conversationId: options.conversationId,
      taskInstanceId: options.taskInstanceId,
      taskId: options.taskId,
      agentRunId: options.agentRunId,
      assistantMessageId: options.assistantMessageId,
      headless: false,
      emitEvent,
      activePermissionRequestIds,
      aborted: () => aborted || settled,
      clearSilenceTimer,
      armSilenceTimer,
      appendDiagnostic: (message) => trace?.appendStderr(message),
    };

    const finishSuccess = (content: string) => {
      if (options.collectFileArtifacts !== false) {
        if (
          !emitRuntimeFileEvents({
            cwd,
            filePaths: pendingFilePaths,
            emitEvent,
            appendDiagnostic: (message) => trace?.appendStderr(message),
          })
        ) {
          return;
        }
      }
      if (!emitEvent({ type: "message", content: content.trim() || parseState.aggregatedText.trim() })) return;
      trace?.writeOutput(content.trim() || parseState.aggregatedText.trim());
      emitEvent({ type: "status", status: "completed" });
    };

    connection = CursorAcpConnection.connect({
      cliPath,
      cwd,
      signal: options.signal,
      onStderr: (chunk) => {
        trace?.appendStderr(chunk);
        armSilenceTimer();
      },
      onNotification: async (message) => {
        trace?.appendParsedEvent(message);
        if (message.method !== "session/request_permission") {
          armSilenceTimer();
        }

        if (message.method === "session/request_permission") {
          if (!connection) return;
          const permissionTask = respondToCursorAcpPermissionRequest(message, connection, permissionContext);
          permissionChain.push(permissionTask);
          await permissionTask;
          return;
        }

        if (message.method !== "session/update") return;
        const params = (message.params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
        const update = params.update;
        if (!update) return;
        activeSessionId = params.sessionId ?? activeSessionId;
        const events = parseCursorAcpSessionUpdate({
          sessionId: params.sessionId,
          update,
          state: parseState,
        });
        for (const event of events) {
          if (event.type === "tool_call" && event.input && typeof event.input === "object") {
            const inputRecord = event.input as Record<string, unknown>;
            const filePath =
              typeof inputRecord.path === "string"
                ? inputRecord.path
                : typeof inputRecord.file_path === "string"
                  ? inputRecord.file_path
                  : undefined;
            if (filePath) pendingFilePaths.add(filePath);
          }
          if (!emitEvent(event)) return;
        }
      },
    });

    if (typeof connection.process.pid === "number") {
      options.onSpawn?.(connection.process.pid);
    }

    const abort = () => {
      if (settled || aborted) return;
      aborted = true;
      cancelActiveCursorPermissionRequests(activePermissionRequestIds);
      if (activeSessionId) {
        void connection?.cancel(activeSessionId);
      }
      connection?.close("Cursor ACP 流式调用已中断");
      trace?.finish("aborted", "Cursor ACP 流式调用已中断");
      emitEvent({ type: "done" });
      settled = true;
      clearSilenceTimer();
    };

    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    armSilenceTimer();

    try {
      options.onEvent({ type: "status", status: "running" });
      await connection.bootstrap();
      let sessionId: string;
      try {
        sessionId = await connection.openSession({
          cwd,
          resumeSessionId: options.resumeSessionId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Cursor ACP 会话恢复失败";
        if (options.resumeSessionId) {
          emitEvent({ type: "session_invalid", sessionId: options.resumeSessionId, message });
        } else {
          emitEvent({ type: "error", message });
        }
        trace?.finish("failed", message);
        emitEvent({ type: "done" });
        settled = true;
        return;
      }
      activeSessionId = sessionId;
      if (!parseState.sessionEmitted) {
        parseState.sessionEmitted = true;
        emitEvent({ type: "session", sessionId });
      }
      await connection.setMode(sessionId, permissionMode);
      const promptResult = await connection.prompt(sessionId, stdinPayload);
      markCursorAcpPromptFinished(parseState, promptResult.stopReason);
      await connection.waitForNotifications();
      await Promise.all(permissionChain);

      if (callbackError) {
        throw callbackError;
      }
      if (aborted) return;

      if (parseState.lastModelError && !parseState.aggregatedText.trim()) {
        failFatal(parseState.lastModelError);
        return;
      }
      finishSuccess(parseState.aggregatedText);
      trace?.finish("completed");
    } catch (error) {
      if (aborted) return;
      const message = error instanceof Error ? error.message : "Cursor ACP 流式调用失败";
      if (options.resumeSessionId && /session|not found|invalid|load/i.test(message)) {
        emitEvent({ type: "session_invalid", sessionId: options.resumeSessionId, message });
      } else if (!emittedFatalError) {
        emitEvent({ type: "error", message });
      }
      trace?.finish("failed", message);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      cancelActiveCursorPermissionRequests(activePermissionRequestIds);
      clearSilenceTimer();
      connection?.close();
      if (!settled) {
        emitEvent({ type: "done" });
        settled = true;
      }
    }
  },
  runPromptJson: (input) => runCursorPrompt(input, "json"),
  runPromptText: (input) => runCursorPrompt(input, "text"),
  async healthCheck(input) {
    const cliPath = await resolveCliPath(input.cliPath || "cursor");
    try {
      const { stdout, stderr } = await execFileAsync(cliPath, ["agent", "status"], {
        timeout: 15000,
        maxBuffer: 256 * 1024,
        env: buildCursorEnv(),
      });
      const combined = `${stdout}\n${stderr}`.trim();
      const authenticated = /logged in/i.test(combined);
      return { authenticated, result: combined };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cursor CLI 可用性检测失败";
      return { authenticated: false, result: message };
    }
  },
};
