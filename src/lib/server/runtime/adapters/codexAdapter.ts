import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { describeRuntimeToolPolicy, resolveRuntimeToolPolicy } from "@/lib/runtime/toolPolicy";
import {
  buildWorkspacePromptPayload,
  killChildTree,
  type RuntimeStreamEvent,
} from "@/lib/server/claude/transport";
import { createClaudeTrace } from "@/lib/server/claude/traceStore";
import { shouldProxyCliToMachine } from "@/lib/server/runtime/cliExecutionMode";
import {
  diffWorkspaceFiles,
  emitRuntimeFileEvents,
  snapshotWorkspaceFiles,
} from "@/lib/server/runtime/fileArtifactEmit";
import type {
  RuntimeAdapter,
  RuntimePromptJsonInput,
  RuntimePromptResult,
  RuntimeStreamOptions,
} from "@/lib/server/runtime/adapters/types";
import { normalizeWorkingDirectory, resolveCliPath } from "@/lib/server/runtimePath";
import type { RuntimeInputAttachment, RuntimePermissionMode } from "@/types/runtime";

type CodexSandboxMode = "read-only" | "workspace-write";
type CodexJsonLine = Record<string, unknown>;

type CodexToolState = {
  toolName: string;
  input?: unknown;
  summary?: string;
};

type CodexParseState = {
  sessionId?: string;
  aggregatedText: string;
  finalMessage: string;
  lastError?: string;
  toolCalls: Map<string, CodexToolState>;
  pendingFilePaths: Set<string>;
};

type CodexArgsInput = {
  cwd: string;
  prompt: string;
  permissionMode: RuntimePermissionMode;
  resumeSessionId?: string;
  ephemeral?: boolean;
  imagePaths?: string[];
};

const CODEX_SILENCE_TIMEOUT_MS = 120000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getPath(value: unknown, keys: string[]) {
  let current: unknown = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function readStringField(input: unknown, keys: string[]) {
  const record = asRecord(input);
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readDeepString(input: unknown, paths: string[][]) {
  for (const itemPath of paths) {
    const value = getPath(input, itemPath);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function truncateMiddle(value: string, max = 100) {
  if (value.length <= max) return value;
  const head = Math.ceil(max / 2) - 2;
  const tail = Math.floor(max / 2) - 1;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function readTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) {
    if (!Array.isArray(value)) return "";
    return value.map((item) => readTextContent(item)).join("");
  }
  const direct = readStringField(record, ["text", "content", "message", "delta"]);
  if (direct) return direct;
  const content = record.content;
  if (Array.isArray(content)) return content.map((item) => readTextContent(item)).join("");
  return "";
}

export function mapCodexSandbox(permissionMode: RuntimePermissionMode): CodexSandboxMode {
  return permissionMode === "execute" ? "workspace-write" : "read-only";
}

export function buildCodexEnv(source: Record<string, string | undefined> = process.env) {
  const keepPrefixes = [
    "CODEX_",
    "OPENAI_",
    "HTTPS_",
    "HTTP_",
    "NO_PROXY",
  ];
  const keepKeys = new Set([
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]);
  const env = {
    NODE_ENV: source.NODE_ENV || "development",
  } as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (keepKeys.has(key) || keepPrefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

export function buildCodexArgs(input: CodexArgsInput) {
  const sandbox = mapCodexSandbox(input.permissionMode);
  // `codex exec resume` 只接受 --json/--skip-git-repo-check/-c/--image/--ephemeral 等参数，
  // 不接受 --sandbox/--color/--cd（实测会报 "unexpected argument '--sandbox'"）。
  // 因此 resume 分支用 -c sandbox_mode 传 sandbox，新会话分支才用 --sandbox/--cd/--color。
  if (input.resumeSessionId) {
    const args = [
      "exec",
      "resume",
      input.resumeSessionId,
      "--json",
      "--skip-git-repo-check",
      "-c",
      `sandbox_mode="${sandbox}"`,
      "-c",
      "approval_policy=\"never\"",
    ];
    if (input.ephemeral) args.push("--ephemeral");
    for (const imagePath of input.imagePaths ?? []) {
      args.push("--image", imagePath);
    }
    args.push(input.prompt);
    return args;
  }
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--cd",
    input.cwd,
    "--skip-git-repo-check",
    "--sandbox",
    sandbox,
    "-c",
    "approval_policy=\"never\"",
  ];
  if (input.ephemeral) args.push("--ephemeral");
  for (const imagePath of input.imagePaths ?? []) {
    args.push("--image", imagePath);
  }
  args.push(input.prompt);
  return args;
}

function summarizeCommand(input: unknown) {
  const command = readStringField(input, ["command", "cmd", "description", "summary"]) ||
    readDeepString(input, [["command", "command"], ["exec", "command"], ["input", "command"]]);
  return command ? `执行命令 ${truncateMiddle(command)}` : "执行终端命令";
}

function collectWritablePath(input: unknown) {
  return readStringField(input, ["path", "file_path", "file", "target_file"]) ||
    readDeepString(input, [["input", "path"], ["input", "file_path"], ["output", "path"]]);
}

function extractSessionId(line: CodexJsonLine) {
  return readStringField(line, ["thread_id", "threadId", "session_id", "sessionId", "id"]) ||
    readDeepString(line, [
      ["thread", "id"],
      ["thread", "thread_id"],
      ["session", "id"],
      ["item", "thread_id"],
    ]);
}

function extractErrorMessage(line: CodexJsonLine) {
  return readStringField(line, ["message", "error", "error_message", "errorMessage", "reason"]) ||
    readDeepString(line, [
      ["error", "message"],
      ["turn", "error", "message"],
      ["item", "error", "message"],
    ]);
}

type CodexEnvelope = {
  phase: "started" | "updated" | "completed" | "other";
  kind: string;
  payload: CodexJsonLine;
  raw: CodexJsonLine;
};

/**
 * Codex exec --json 把内容包在 thread/turn/item 信封里：
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 * 这里把 item.* 信封拆开，用 item.type 作为实际事件类型，phase 表示生命周期；
 * 顶层事件（thread.started / turn.* / 顶层 error）则原样返回。
 */
function unwrapCodexLine(line: CodexJsonLine): CodexEnvelope {
  const type = typeof line.type === "string" ? line.type : "";
  const item = asRecord(line.item);
  if (type.startsWith("item.") && item) {
    const phase =
      type === "item.completed"
        ? "completed"
        : type === "item.started"
          ? "started"
          : type === "item.updated"
            ? "updated"
            : "other";
    return { phase, kind: typeof item.type === "string" ? item.type : "", payload: item as CodexJsonLine, raw: line };
  }
  return { phase: "other", kind: type, payload: line, raw: line };
}

function extractAgentText(payload: CodexJsonLine) {
  return readStringField(payload, ["text", "content", "message"]) ||
    readTextContent(payload.message) ||
    readTextContent(payload.content) ||
    "";
}

function extractToolCallId(payload: CodexJsonLine) {
  return readStringField(payload, ["call_id", "callId", "tool_call_id", "toolCallId", "id"]) ||
    readDeepString(payload, [["item", "id"], ["item", "call_id"], ["command_execution", "id"]]) ||
    `tool-${Math.random().toString(36).slice(2, 10)}`;
}

function extractToolInput(payload: CodexJsonLine) {
  // 返回结构化记录，便于 summarizeCommand 从 command/cmd 等字段提取命令文本。
  const nested = asRecord(payload.input) ?? asRecord(payload.action);
  return nested ?? payload;
}

/**
 * 累积/最终化 agent 文本：增量 phase 计算 delta 并下发；最终 phase 记录 finalMessage，
 * 由 finishSuccess 统一发 message 事件，避免 delta 与 message 重复展示。
 */
function handleCodexAgentText(
  state: CodexParseState,
  text: string,
  isFinal: boolean,
  emitEvent?: (event: RuntimeStreamEvent) => boolean,
) {
  if (!text) return true;
  if (text.startsWith(state.aggregatedText)) {
    const delta = text.slice(state.aggregatedText.length);
    state.aggregatedText = text;
    if (isFinal) state.finalMessage = text;
    if (delta && !isFinal && emitEvent) return emitEvent({ type: "delta", text: delta }) !== false;
    return true;
  }
  state.aggregatedText = text;
  if (isFinal) {
    state.finalMessage = text;
    return true;
  }
  return emitEvent?.({ type: "delta", text }) !== false;
}

export function createCodexParseState(): CodexParseState {
  return {
    aggregatedText: "",
    finalMessage: "",
    toolCalls: new Map(),
    pendingFilePaths: new Set(),
  };
}

export function consumeCodexJsonLine(
  rawLine: string,
  state: CodexParseState,
  emitEvent?: (event: RuntimeStreamEvent) => boolean,
) {
  const lineText = rawLine.trim();
  if (!lineText) return true;
  let line: CodexJsonLine;
  try {
    line = JSON.parse(lineText) as CodexJsonLine;
  } catch {
    return true;
  }

  const { phase, kind, payload } = unwrapCodexLine(line);

  // 顶层会话事件：thread.started 携带 thread_id。
  if (/^thread\.started$/i.test(kind) || /(^|[^a-z])session([^a-z]|$)/i.test(kind)) {
    const sessionId = extractSessionId(payload) ?? extractSessionId(line);
    if (sessionId && sessionId !== state.sessionId) {
      state.sessionId = sessionId;
      if (emitEvent?.({ type: "session", sessionId }) === false) return false;
    }
    return true;
  }

  // 顶层 turn.started：标记运行中。
  if (/^turn\.started$/i.test(kind)) {
    return emitEvent?.({ type: "status", status: "running" }) !== false;
  }

  // 顶层 turn.failed：本轮致命错误，下发 error 事件。
  if (/^turn\.failed$/i.test(kind)) {
    state.lastError = extractErrorMessage(payload) || extractErrorMessage(line) || "Codex CLI 返回错误";
    return emitEvent?.({ type: "error", message: state.lastError }) !== false;
  }

  // 顶层 error（如 "Reconnecting... 2/5" 重试提示）属于瞬时噪声：只记录，不下发 error 事件，
  // 真正失败由 turn.failed 或非零退出码兜底，避免把重连提示渲染成用户可见错误。
  if (phase === "other" && /^error$/i.test(kind)) {
    const message = extractErrorMessage(payload) || extractErrorMessage(line);
    if (message) state.lastError = message;
    return true;
  }

  // item.* 信封：按 item.type 分发。
  if (/command_execution|tool_call|mcp_tool_call|exec_command/i.test(kind)) {
    const toolCallId = extractToolCallId(payload);
    const input = extractToolInput(payload);
    const toolName = readStringField(payload, ["tool_name", "toolName", "name"]) || "shell";
    if (phase === "started" || phase === "other") {
      const summary = summarizeCommand(input);
      state.toolCalls.set(toolCallId, { toolName, input, summary });
      return emitEvent?.({ type: "tool_call", toolName, summary, input, toolCallId }) !== false;
    }
    // completed / updated：作为结果下发。
    const stateItem = state.toolCalls.get(toolCallId);
    const status = readStringField(payload, ["status", "result"]);
    const exitCode = payload.exit_code;
    const ok =
      payload.is_error !== true &&
      payload.error === undefined &&
      payload.ok !== false &&
      (typeof exitCode !== "number" || exitCode === 0) &&
      !/fail|error/i.test(status ?? "");
    const filePath = ok ? collectWritablePath(input) : undefined;
    if (filePath) state.pendingFilePaths.add(filePath);
    return emitEvent?.({
      type: "tool_result",
      toolName: stateItem?.toolName ?? toolName,
      toolCallId,
      ok,
      summary: ok ? "命令执行完成" : "命令执行失败",
      error: ok ? undefined : extractErrorMessage(payload),
    }) !== false;
  }

  // item.* 内的 error item（如 stream 回退提示）：记录但不致命。
  if (/^error$/i.test(kind)) {
    const message = extractErrorMessage(payload);
    if (message) state.lastError = message;
    return true;
  }

  // 增量 agent 文本。
  if (/agent_message_delta|message_delta|output_text_delta|delta/i.test(kind) && phase !== "completed") {
    const delta =
      readStringField(payload, ["delta", "text", "content"]) ||
      readDeepString(payload, [["delta", "text"], ["message", "delta"]]) ||
      "";
    return handleCodexAgentText(state, state.aggregatedText + delta, false, emitEvent);
  }

  // agent_message（reasoning 等不计入最终回复）。
  if (/agent_message|assistant_message/i.test(kind) && !/reasoning|user/i.test(kind)) {
    const text = extractAgentText(payload);
    return handleCodexAgentText(state, text, phase === "completed", emitEvent);
  }

  return true;
}

export function extractCodexFinalMessage(output: string) {
  const state = createCodexParseState();
  for (const line of output.split("\n")) {
    consumeCodexJsonLine(line, state);
  }
  return state.finalMessage.trim() || state.aggregatedText.trim() || output.trim();
}

function looksLikeInvalidSession(message: string) {
  return /session|thread/i.test(message) && /not found|invalid|unknown|missing|no .*found/i.test(message);
}

function isSupportedCodexImageAttachment(attachment: RuntimeInputAttachment) {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment.mime);
}

function imageExtension(mime: string) {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".png";
  }
}

export function buildCodexAttachmentPromptNote(attachments: RuntimeInputAttachment[] | undefined) {
  const items = attachments ?? [];
  if (items.length === 0) return "";
  const images = items.filter(isSupportedCodexImageAttachment);
  const others = items.filter((item) => !isSupportedCodexImageAttachment(item));
  return [
    "",
    "【用户上传附件】",
    ...images.map((item, index) => `${index + 1}. ${item.filename} (${item.mime}) 已通过 Codex --image 传入，请直接查看图片内容。`),
    ...others.map((item, index) => `${images.length + index + 1}. ${item.filename} (${item.mime}, ${item.size} bytes) 暂不支持二进制直传，只能依据文件名和用户描述回答。`),
  ].join("\n");
}

async function writeImageAttachmentsToTempFiles(attachments: RuntimeInputAttachment[] | undefined) {
  const images = (attachments ?? []).filter(isSupportedCodexImageAttachment);
  if (images.length === 0) return { imagePaths: [] as string[], cleanup: async () => undefined };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiki-codex-images-"));
  const imagePaths: string[] = [];
  await Promise.all(images.map(async (attachment, index) => {
    const safeName = attachment.filename.replace(/[^a-zA-Z0-9._-]/g, "_") || `image-${index}`;
    const filePath = path.join(tempDir, `${index}-${safeName}${path.extname(safeName) ? "" : imageExtension(attachment.mime)}`);
    await fs.writeFile(filePath, Buffer.from(attachment.contentBase64, "base64"));
    imagePaths.push(filePath);
  }));
  return {
    imagePaths,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function runCodexPrompt(
  input: RuntimePromptJsonInput,
  mode: "json" | "text",
  options: { ephemeral?: boolean } = {},
): Promise<RuntimePromptResult> {
  if (shouldProxyCliToMachine()) {
    const { proxyRunPromptJson, proxyRunPromptText } = await import("@/lib/server/tunnel/remoteCliProxy");
    return mode === "json" ? proxyRunPromptJson(input) : proxyRunPromptText(input);
  }
  const cwd = normalizeWorkingDirectory(input.cwd);
  const cliPath = await resolveCliPath(input.runtimeEnv.cliPath);
  const startedAt = Date.now();
  const permissionMode = input.permissionMode ?? input.runtimeEnv.permissionMode;
  const args = buildCodexArgs({ cwd, prompt: input.prompt, permissionMode, ephemeral: options.ephemeral });
  const trace = createClaudeTrace({
    cwd,
    cliPath,
    args,
    permissionMode,
    requestId: input.traceContext?.requestId,
    scope: input.traceContext?.scope ?? `codex_${mode}`,
    phase: input.traceContext?.phase,
    stepLabel: input.traceContext?.stepLabel,
  });
  trace?.writePrompt(input.prompt);

  return new Promise<RuntimePromptResult>((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: buildCodexEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let output = "";
    let stderr = "";
    let aborted = false;

    const abort = () => {
      aborted = true;
      killChildTree(child);
      trace?.finish("aborted", input.abortMessage ?? "Codex CLI 调用已中断");
      reject(new DOMException(input.abortMessage ?? "Codex CLI 调用已中断", "AbortError"));
    };

    if (input.abortSignal?.aborted) {
      abort();
      return;
    }
    input.abortSignal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      trace?.appendStdout(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      trace?.appendStderr(text);
    });
    child.on("error", (error) => {
      input.abortSignal?.removeEventListener("abort", abort);
      trace?.finish("failed", error.message);
      reject(error);
    });
    child.on("close", (code) => {
      input.abortSignal?.removeEventListener("abort", abort);
      if (aborted) return;
      const exitCode = code ?? 0;
      const finalMessage = extractCodexFinalMessage(output);
      if (exitCode !== 0) {
        const message = finalMessage || stderr.trim() || input.failureMessage || "Codex CLI 调用失败";
        trace?.finish("failed", message);
        reject(new Error(message));
        return;
      }
      if (finalMessage) trace?.writeOutput(finalMessage);
      trace?.finish("completed");
      resolve({ raw: finalMessage, exitCode, stderr: stderr.trim(), elapsedMs: Date.now() - startedAt });
    });
  });
}

export const codexAdapter: RuntimeAdapter = {
  kind: "codex",
  meta: {
    label: "Codex CLI",
    command: "codex",
    versionArgs: ["--version"],
    installHint: "安装 Codex CLI 后确保 `codex` 命令在 PATH 中可用。",
    uiAccent: "bg-[#EEF6FF] text-[#2563EB]",
    uiIcon: "Code2",
  },
  capabilities: {
    sessionResume: true,
    permissionModes: true,
    toolSelection: "none",
    fileArtifacts: true,
  },
  async streamPrompt(options: RuntimeStreamOptions) {
    if (shouldProxyCliToMachine()) {
      const { proxyStreamPrompt } = await import("@/lib/server/tunnel/remoteCliProxy");
      return proxyStreamPrompt({ ...options, runtimeKind: "codex" });
    }

    const cwd = normalizeWorkingDirectory(options.workingDirectory);
    const resolvedToolPolicy = resolveRuntimeToolPolicy({
      filePolicy: options.filePolicy,
      permissionMode: options.permissionMode,
      channelPolicy: options.channelPolicy ?? { mode: options.workspacePolicy === "task" ? "task" : "conversation" },
    });
    const isTaskPrompt = options.workspacePolicy === "task" || options.channelPolicy?.mode === "task";
    const shouldCollectFileArtifacts = options.collectFileArtifacts ?? true;
    const workspaceSnapshot = shouldCollectFileArtifacts && !isTaskPrompt ? snapshotWorkspaceFiles(cwd) : null;
    const redactionMode = isTaskPrompt ? "passthrough" : "strict";
    const effectiveWorkspacePolicy = options.workspacePolicy ?? (isTaskPrompt ? "task" : undefined);
    const includeConversationIdentity = !isTaskPrompt && options.systemPromptMode === "conversation";
    const promptPayload = buildWorkspacePromptPayload({
      workspaceDir: cwd,
      workspacePolicy: effectiveWorkspacePolicy,
      toolSummary: describeRuntimeToolPolicy(resolvedToolPolicy),
      message: options.message,
      quotedMessage: options.quotedMessage,
      contextPack: options.contextPack,
      redactionMode,
      includeConversationIdentity,
    });
    const attachmentNote = buildCodexAttachmentPromptNote(options.attachments);
    const promptInput = `${promptPayload.systemPrompt ? `${promptPayload.systemPrompt}\n\n` : ""}${promptPayload.promptInput}${attachmentNote}`;
    const promptSections = attachmentNote
      ? [...promptPayload.promptSections, { id: "attachments", kind: "context" as const, title: "Attachments", content: attachmentNote.trim() }]
      : promptPayload.promptSections;
    const cliPath = await resolveCliPath(options.cliPath);
    const tempImages = await writeImageAttachmentsToTempFiles(options.attachments);

    options.onEvent({ type: "status", status: "checking" });
    const args = buildCodexArgs({
      cwd,
      prompt: promptInput,
      permissionMode: options.permissionMode,
      resumeSessionId: options.resumeSessionId,
      imagePaths: tempImages.imagePaths,
    });
    const trace = createClaudeTrace({
      cwd,
      cliPath,
      args,
      permissionMode: options.permissionMode,
      toolPolicy: resolvedToolPolicy,
      resumeSessionId: options.resumeSessionId,
      scope: "conversation_chat",
      stepLabel: "Codex 会话流式回复",
    });
    trace?.writePrompt(promptInput);
    options.onEvent({ type: "prompt", sections: promptSections });

    await new Promise<void>((resolve, reject) => {
      const child = spawn(cliPath, args, {
        cwd,
        env: buildCodexEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      if (typeof child.pid === "number") options.onSpawn?.(child.pid);

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let callbackError: unknown = null;
      let emittedFatalError = false;
      let settled = false;
      let terminalResultReceived = false;
      const state = createCodexParseState();
      let silenceTimer: NodeJS.Timeout | null = null;

      const clearSilenceTimer = () => {
        if (silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }
      };
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        clearSilenceTimer();
        resolve();
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearSilenceTimer();
        reject(error);
      };
      const emitEvent = (event: RuntimeStreamEvent) => {
        if (callbackError || settled) return false;
        try {
          options.onEvent(event);
          return true;
        } catch (error) {
          callbackError = error;
          emittedFatalError = true;
          killChildTree(child);
          rejectOnce(error);
          return false;
        }
      };
      const finishSuccess = () => {
        const changedFiles = workspaceSnapshot ? diffWorkspaceFiles(cwd, workspaceSnapshot) : [];
        for (const filePath of changedFiles) state.pendingFilePaths.add(filePath);
        if (options.collectFileArtifacts !== false) {
          if (!emitRuntimeFileEvents({
            cwd,
            filePaths: state.pendingFilePaths,
            emitEvent,
            appendDiagnostic: (message) => trace?.appendStderr(message),
          })) return false;
        }
        const content = state.finalMessage.trim() || state.aggregatedText.trim();
        trace?.writeOutput(content);
        if (!emitEvent({ type: "message", content })) return false;
        if (!emitEvent({ type: "status", status: "completed" })) return false;
        return true;
      };
      const failFatal = (message: string) => {
        if (settled || emittedFatalError) return;
        emittedFatalError = true;
        killChildTree(child);
        trace?.finish("failed", message);
        emitEvent({ type: "error", message });
        emitEvent({ type: "done" });
        resolveOnce();
      };
      const armSilenceTimer = () => {
        if (settled) return;
        clearSilenceTimer();
        silenceTimer = setTimeout(() => {
          failFatal(state.lastError ? `Codex CLI 长时间无响应：${state.lastError}` : "Codex CLI 长时间无响应。");
        }, CODEX_SILENCE_TIMEOUT_MS);
      };
      const abort = () => {
        clearSilenceTimer();
        if (terminalResultReceived) return;
        emittedFatalError = true;
        killChildTree(child);
        trace?.finish("aborted", "Codex CLI 流式调用已中断");
        if (emitEvent({ type: "done" })) resolveOnce();
      };
      const consumeLine = (line: string) => {
        const ok = consumeCodexJsonLine(line, state, emitEvent);
        if (!ok) return false;
        try {
          if (line.trim()) trace?.appendParsedEvent(JSON.parse(line) as Record<string, unknown>);
        } catch {
          trace?.appendStderr(`Codex JSON 行解析失败：${line}\n`);
        }
        return true;
      };

      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      armSilenceTimer();

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdoutBuffer += text;
        trace?.appendStdout(text);
        armSilenceTimer();
        let lineBreakIndex = stdoutBuffer.indexOf("\n");
        while (lineBreakIndex !== -1) {
          const line = stdoutBuffer.slice(0, lineBreakIndex);
          stdoutBuffer = stdoutBuffer.slice(lineBreakIndex + 1);
          if (!consumeLine(line)) return;
          lineBreakIndex = stdoutBuffer.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrBuffer += text;
        trace?.appendStderr(text);
        armSilenceTimer();
      });
      child.on("error", (error) => {
        options.signal?.removeEventListener("abort", abort);
        clearSilenceTimer();
        emittedFatalError = true;
        trace?.finish("failed", error.message);
        rejectOnce(error);
      });
      child.on("close", (code) => {
        options.signal?.removeEventListener("abort", abort);
        clearSilenceTimer();
        if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
        if (callbackError || settled) return;
        terminalResultReceived = true;
        const exitCode = code ?? 0;
        const message = state.lastError || stderrBuffer.trim();
        if (exitCode !== 0) {
          emittedFatalError = true;
          if (options.resumeSessionId && looksLikeInvalidSession(message)) {
            emitEvent({ type: "session_invalid", sessionId: options.resumeSessionId, message });
          } else {
            emitEvent({ type: "error", message: message || "Codex CLI 流式调用失败" });
          }
          trace?.finish("failed", message || "Codex CLI 流式调用失败");
        } else if (!emittedFatalError) {
          const content = state.finalMessage.trim() || state.aggregatedText.trim();
          // 退出码为 0 但本轮已记录错误且无任何文本：按失败处理，避免下发空的成功消息。
          if (!content && state.lastError) {
            emitEvent({ type: "error", message: state.lastError });
            trace?.finish("failed", state.lastError);
          } else {
            finishSuccess();
            trace?.finish("completed");
          }
        }
        emitEvent({ type: "done" });
        resolveOnce();
      });
    }).finally(async () => {
      await tempImages.cleanup();
    });
  },
  runPromptJson: (input) => runCodexPrompt(input, "json"),
  runPromptText: (input) => runCodexPrompt(input, "text"),
  async healthCheck(input) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const result = await runCodexPrompt(
        {
          prompt: "请只回复 ok",
          runtimeEnv: {
            id: "health-check",
            type: "local",
            runtimeKind: "codex",
            name: "Codex CLI",
            workingDirectory: input.workingDirectory,
            cliPath: input.cliPath,
            permissionMode: "readonly",
            filePolicy: input.filePolicy,
          },
          cwd: input.workingDirectory,
          permissionMode: "readonly",
          filePolicy: input.filePolicy,
          channelPolicy: { mode: "readonly_json" },
          abortSignal: controller.signal,
          abortMessage: "Codex CLI 可用性检测超时",
          failureMessage: "Codex CLI 可用性检测失败",
        },
        "json",
        { ephemeral: true },
      );
      return { authenticated: Boolean(result.raw.trim()), result: result.raw.trim() };
    } finally {
      clearTimeout(timeout);
    }
  },
};
