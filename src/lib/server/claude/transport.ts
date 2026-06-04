import { spawn, type ChildProcess } from "child_process";
import { createHash } from "crypto";

import type {
  QuotedConversationMessageContext,
  RuntimeEnvironment,
  RuntimeFilePolicy,
  RuntimePermissionMode,
} from "@/types/runtime";

import { buildClaudeEnv } from "@/lib/server/claudeEnv";
import { normalizeWorkingDirectory, resolveCliPath } from "@/lib/server/runtimePath";
import { createClaudeTrace } from "@/lib/server/claude/traceStore";
import {
  describeRuntimeToolPolicy,
  resolveRuntimeToolPolicy,
  type ToolChannelPolicy,
} from "@/lib/runtime/toolPolicy";

/**
 * 强制回收 Claude CLI 子进程及其衍生的整个进程组。
 *
 * 背景：spawn 时使用 `detached: true`，子进程成为独立进程组组长，
 * 因此可以通过 `process.kill(-pid, signal)` 一次性回收其所有孙进程，
 * 避免出现「父进程被 SIGTERM 杀掉、孙进程仍残留」的孤儿 CLI。
 *
 * 升级策略：先发 SIGTERM 优雅终止；若 KILL_ESCALATION_MS 内进程仍未退出，
 * 再发 SIGKILL 强杀，确保「abort 一定能杀干净」。
 */
const KILL_ESCALATION_MS = 5 * 1000;

function killChildTree(child: ChildProcess) {
  const pid = child.pid;
  // spawn 失败时 pid 为 undefined，直接返回，避免 process.kill(-undefined) 抛 TypeError。
  if (typeof pid !== "number") return;

  const killGroup = (signal: NodeJS.Signals) => {
    try {
      // 负 pid = 向整个进程组发送信号（依赖 detached: true）。
      process.kill(-pid, signal);
    } catch {
      // 进程组可能已不存在（ESRCH）或权限问题，退化为直接杀进程本身。
      try {
        child.kill(signal);
      } catch {
        // 进程已退出，忽略。
      }
    }
  };

  killGroup("SIGTERM");

  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      killGroup("SIGKILL");
    }
  }, KILL_ESCALATION_MS);
  // 不阻塞进程退出。
  escalation.unref?.();
  // 进程一旦退出即清理升级定时器。
  child.once("exit", () => clearTimeout(escalation));
}


export type ClaudeCliPayload = {
  type?: string;
  subtype?: string;
  status?: string;
  session_id?: string;
  result?: string;
  api_error_status?: string;
  errors?: string[];
  permission_denials?: Array<{
    tool_name?: string;
    tool_use_id?: string;
    tool_input?: unknown;
  }>;
  event?: {
    type?: string;
    index?: number;
    delta?: {
      type?: string;
      text?: string;
      partial_json?: string;
    };
    content_block?: {
      type?: string;
      id?: string;
      name?: string;
      input?: unknown;
    };
  };
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
    }>;
  };
};

export type ClaudeStreamOptions = {
  message: string;
  workingDirectory: string;
  cliPath: string;
  permissionMode: RuntimePermissionMode;
  claudeSessionId?: string;
  contextPack?: string;
  workspacePolicy?: "conversation" | "task" | string;
  quotedMessage?: QuotedConversationMessageContext | null;
  filePolicy?: RuntimeFilePolicy;
  channelPolicy?: ToolChannelPolicy;
  signal?: AbortSignal;
  onEvent: (event: ClaudeStreamEvent) => void;
  /** spawn 成功后回传子进程 pid，供上层（如 ExecutionSupervisor）绑定 OS 进程做生命周期管理。 */
  onSpawn?: (pid: number) => void;
};

export type ClaudeStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "session_invalid"; sessionId: string; message: string }
  | { type: "status"; status: "checking" | "running" | "completed" }
  | { type: "delta"; text: string }
  | { type: "message"; content: string; fallbackContent?: string }
  | { type: "tool_call"; toolName: string; summary: string; input?: unknown; index?: number }
  | { type: "permission_request"; reason: string }
  | { type: "error"; message: string }
  | { type: "done" };

export type ClaudePromptJsonResult = {
  raw: string;
  exitCode: number;
  stderr: string;
  elapsedMs: number;
};

export type ClaudeJsonToolPolicy =
  | {
      mode: "deny_all";
    }
  | {
      mode: "readonly_only";
      allow?: string[];
    };

const JSON_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Task",
];

export function buildJsonToolArgs(policy: ClaudeJsonToolPolicy = { mode: "deny_all" }) {
  if (policy.mode === "readonly_only") {
    const allowedTools = policy.allow && policy.allow.length > 0 ? policy.allow : ["Read", "Glob", "Grep"];
    return ["--allowedTools", allowedTools.join(",")];
  }
  return ["--disallowedTools", JSON_DISALLOWED_TOOLS.join(",")];
}

export function buildTextToolArgs(policy: ClaudeJsonToolPolicy = { mode: "deny_all" }) {
  return buildJsonToolArgs(policy);
}

function buildToolArgs(policy: { allowedTools: string[]; disallowedTools: string[] }) {
  const args: string[] = [];
  if (policy.allowedTools.length > 0) {
    args.push("--allowedTools", policy.allowedTools.join(","));
  }
  if (policy.disallowedTools.length > 0) {
    args.push("--disallowedTools", policy.disallowedTools.join(","));
  }
  return args;
}

/**
 * JSON calls must return their business payload through stdout result.result.
 * They never need write-capable tools; work that needs tools should use streamPrompt.
 */
export async function runPromptJson(input: {
  prompt: string;
  runtimeEnv: RuntimeEnvironment;
  abortSignal?: AbortSignal;
  cwd: string;
  permissionMode?: RuntimePermissionMode;
  abortMessage?: string;
  failureMessage?: string;
  traceContext?: {
    requestId?: string;
    scope?: string;
    phase?: string;
    stepLabel?: string;
  };
  toolPolicy?: ClaudeJsonToolPolicy;
  filePolicy?: RuntimeFilePolicy;
  channelPolicy?: ToolChannelPolicy;
}): Promise<ClaudePromptJsonResult> {
  const cwd = normalizeWorkingDirectory(input.cwd);
  const cliPath = await resolveCliPath(input.runtimeEnv.cliPath);
  const startedAt = Date.now();
  const resolvedToolPolicy = resolveRuntimeToolPolicy({
    filePolicy: input.filePolicy ?? input.runtimeEnv.filePolicy,
    permissionMode: input.permissionMode ?? input.runtimeEnv.permissionMode,
    channelPolicy: input.channelPolicy ?? {
      mode: "readonly_json",
      ...(input.toolPolicy?.mode === "readonly_only" ? { allow: input.toolPolicy.allow } : {}),
    },
  });
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    mapPermissionMode(input.permissionMode ?? input.runtimeEnv.permissionMode),
    ...buildToolArgs(resolvedToolPolicy),
  ];
  const trace = createClaudeTrace({
    cwd,
    cliPath,
    args,
    permissionMode: input.permissionMode ?? input.runtimeEnv.permissionMode,
    toolPolicy: resolvedToolPolicy,
    requestId: input.traceContext?.requestId,
    scope: input.traceContext?.scope ?? "claude_json",
    phase: input.traceContext?.phase,
    stepLabel: input.traceContext?.stepLabel,
  });
  trace?.writePrompt(input.prompt);

  return new Promise<ClaudePromptJsonResult>((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: buildClaudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    child.stdin.write(input.prompt);
    child.stdin.end();

    let output = "";
    let errorOutput = "";
    let aborted = false;

    const abort = () => {
      aborted = true;
      killChildTree(child);
      trace?.finish("aborted", input.abortMessage ?? "Claude CLI 调用已中断");
      reject(new DOMException(input.abortMessage ?? "Claude CLI 调用已中断", "AbortError"));
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
      errorOutput += text;
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
      if (exitCode !== 0) {
        trace?.finish("failed", errorOutput.trim() || input.failureMessage || "Claude CLI JSON 调用失败");
        reject(new Error(errorOutput.trim() || input.failureMessage || "Claude CLI JSON 调用失败"));
        return;
      }
      const parsedOutput = extractClaudeOutputText(output);
      if (parsedOutput) trace?.writeOutput(parsedOutput);
      trace?.finish("completed");
      resolve({
        raw: output,
        exitCode,
        stderr: errorOutput.trim(),
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

export async function runPromptText(input: {
  prompt: string;
  runtimeEnv: RuntimeEnvironment;
  abortSignal?: AbortSignal;
  cwd: string;
  permissionMode?: RuntimePermissionMode;
  abortMessage?: string;
  failureMessage?: string;
  traceContext?: {
    requestId?: string;
    scope?: string;
    phase?: string;
    stepLabel?: string;
  };
  toolPolicy?: ClaudeJsonToolPolicy;
  filePolicy?: RuntimeFilePolicy;
  channelPolicy?: ToolChannelPolicy;
}): Promise<ClaudePromptJsonResult> {
  const cwd = normalizeWorkingDirectory(input.cwd);
  const cliPath = await resolveCliPath(input.runtimeEnv.cliPath);
  const startedAt = Date.now();
  const resolvedToolPolicy = resolveRuntimeToolPolicy({
    filePolicy: input.filePolicy ?? input.runtimeEnv.filePolicy,
    permissionMode: input.permissionMode ?? input.runtimeEnv.permissionMode,
    channelPolicy: input.channelPolicy ?? {
      mode: "readonly_json",
      ...(input.toolPolicy?.mode === "readonly_only" ? { allow: input.toolPolicy.allow } : {}),
    },
  });
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    mapPermissionMode(input.permissionMode ?? input.runtimeEnv.permissionMode),
    ...buildToolArgs(resolvedToolPolicy),
  ];
  const trace = createClaudeTrace({
    cwd,
    cliPath,
    args,
    permissionMode: input.permissionMode ?? input.runtimeEnv.permissionMode,
    toolPolicy: resolvedToolPolicy,
    requestId: input.traceContext?.requestId,
    scope: input.traceContext?.scope ?? "claude_text",
    phase: input.traceContext?.phase,
    stepLabel: input.traceContext?.stepLabel,
  });
  trace?.writePrompt(input.prompt);

  return new Promise<ClaudePromptJsonResult>((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: buildClaudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    child.stdin.write(input.prompt);
    child.stdin.end();

    let output = "";
    let errorOutput = "";
    let aborted = false;

    const abort = () => {
      aborted = true;
      killChildTree(child);
      trace?.finish("aborted", input.abortMessage ?? "Claude CLI 文本调用已中断");
      reject(new DOMException(input.abortMessage ?? "Claude CLI 文本调用已中断", "AbortError"));
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
      errorOutput += text;
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
      if (exitCode !== 0) {
        trace?.finish("failed", errorOutput.trim() || input.failureMessage || "Claude CLI 文本调用失败");
        reject(new Error(errorOutput.trim() || input.failureMessage || "Claude CLI 文本调用失败"));
        return;
      }
      const parsedOutput = extractClaudeOutputText(output);
      if (parsedOutput) trace?.writeOutput(parsedOutput);
      trace?.finish("completed");
      resolve({
        raw: parsedOutput || output,
        exitCode,
        stderr: errorOutput.trim(),
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

type ToolUseBlockState = {
  name: string;
  rawInput?: unknown;
  partialJson: string;
};

function mapPermissionMode(permissionMode: RuntimePermissionMode) {
  switch (permissionMode) {
    case "execute":
      return "acceptEdits";
    default:
      return "default";
  }
}

function redactInternalIdentifiersForPrompt(value: string) {
  return value.replace(/\b(?:conv|goal|sub|task|inst)-[A-Za-z0-9_-]+\b/g, "<redacted-id>");
}

function buildPrompt(
  message: string,
  quotedMessage?: ClaudeStreamOptions["quotedMessage"],
  redactionMode: "strict" | "passthrough" = "strict",
) {
  const parts: string[] = [];
  if (quotedMessage) {
    const quotedContent =
      redactionMode === "strict"
        ? redactInternalIdentifiersForPrompt(quotedMessage.content)
        : quotedMessage.content;
    parts.push(
      `以下是当前用户引用的上下文，请优先参考：`,
      `[${quotedMessage.roleLabel}] ${quotedContent}`,
      "",
    );
  }
  parts.push(`当前用户消息：`, redactionMode === "strict" ? redactInternalIdentifiersForPrompt(message) : message);
  return parts.join("\n");
}

export function buildWorkspaceBoundPrompt(input: {
  message: string;
  quotedMessage?: ClaudeStreamOptions["quotedMessage"];
  contextPack?: string;
  workspaceDir: string;
  workspacePolicy?: string;
  toolSummary?: ReturnType<typeof describeRuntimeToolPolicy>;
  redactionMode?: "strict" | "passthrough";
}) {
  const redactionMode = input.redactionMode ?? "strict";
  const workspaceLabel =
    redactionMode === "strict"
      ? `isolated-session-${createHash("sha256").update(input.workspaceDir).digest("hex").slice(0, 8)}`
      : input.workspaceDir;
  const parts: string[] = [
    "你是 KiKi 当前会话助手，不是代码仓库开发助手。",
    `当前工作目录是隔离 workspace：${workspaceLabel}`,
    "你只能依据当前上下文包、用户消息和当前工作目录内的文件回答。",
    "不得读取父目录、项目源码目录、其他会话 workspace 或 IDE 上下文。",
    "如果用户要求继续/恢复，但当前上下文包没有可恢复状态，请说明当前会话没有找到可恢复任务。",
  ];
  if (redactionMode === "strict") {
    parts.push("边界规则：不要在回复中复述系统字段名、内部 ID、内部路径或会话元数据。");
  }
  if (input.workspacePolicy) {
    parts.push(`workspaceMode: ${input.workspacePolicy}`);
  }
  if (input.toolSummary) {
    parts.push(
      "",
      "【当前 Runtime 工具权限策略】",
      `已允许：${input.toolSummary.allowed.length > 0 ? input.toolSummary.allowed.join("、") : "无"}`,
      `已禁用：${input.toolSummary.disabled.length > 0 ? input.toolSummary.disabled.join("、") : "无"}`,
      "当工具被禁用时，请直接说明“当前运行环境已禁用对应工具”，不要建议用户输入 /allow，不要建议修改 ~/.claude/settings.json，不要声称会出现授权弹窗。",
    );
  }
  if (input.contextPack?.trim()) {
    const contextPack =
      redactionMode === "strict"
        ? redactInternalIdentifiersForPrompt(input.contextPack.trim())
        : input.contextPack.trim();
    parts.push("", "【当前会话上下文包】", contextPack);
  }
  parts.push("", buildPrompt(input.message, input.quotedMessage, redactionMode));
  return parts.join("\n");
}

export type ClaudeSessionDecision =
  | { kind: "set"; sessionId: string }
  | { kind: "duplicate-init"; ignored: string }
  | { kind: "ignore" };

export function classifySessionFromInitPayload(
  payload: ClaudeCliPayload,
  currentSessionId: string | undefined,
): ClaudeSessionDecision {
  if (payload.type !== "system" || payload.subtype !== "init" || !payload.session_id) {
    return { kind: "ignore" };
  }
  if (!currentSessionId) {
    return { kind: "set", sessionId: payload.session_id };
  }
  if (payload.session_id === currentSessionId) {
    return { kind: "ignore" };
  }
  return { kind: "duplicate-init", ignored: payload.session_id };
}

export type ClaudeResultErrorDecision =
  | { kind: "session_invalid"; sessionId: string; message: string }
  | { kind: "error"; message: string };

export function classifyResultError(
  payload: ClaudeCliPayload,
  resumeSessionId: string | undefined,
): ClaudeResultErrorDecision {
  const message =
    payload.result ||
    payload.errors?.join("\n") ||
    payload.api_error_status ||
    "Claude 返回了错误结果";
  if (resumeSessionId && /No conversation found with session ID/i.test(message)) {
    return {
      kind: "session_invalid",
      sessionId: resumeSessionId,
      message,
    };
  }
  return { kind: "error", message };
}

function truncateMiddle(value: string, max = 80) {
  if (value.length <= max) return value;
  const head = Math.ceil(max / 2) - 2;
  const tail = Math.floor(max / 2) - 1;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function asRecord(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
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

function parseToolInput(rawInput: unknown, partialJson: string) {
  const hasRawInput =
    rawInput !== undefined &&
    (!Array.isArray(rawInput) || rawInput.length > 0) &&
    (typeof rawInput !== "object" || rawInput === null || Object.keys(rawInput as Record<string, unknown>).length > 0);
  if (hasRawInput) return rawInput;
  if (!partialJson.trim()) return rawInput;
  try {
    return JSON.parse(partialJson) as unknown;
  } catch {
    return rawInput;
  }
}

function extractClaudeOutputText(raw: string) {
  try {
    const parsed = JSON.parse(raw.trim()) as ClaudeCliPayload;
    if (typeof parsed.result === "string") return parsed.result;
    const content = parsed.message?.content?.map((item) => item.text || item.thinking || "").join("");
    return content?.trim() || "";
  } catch {
    return raw.trim();
  }
}

function extractAssistantTraceText(payload: ClaudeCliPayload) {
  const pieces = payload.message?.content
    ?.map((item) => item.thinking || item.text || "")
    .filter(Boolean);
  return pieces?.join("\n") ?? "";
}

function summarizeToolCall(toolName: string, input: unknown) {
  const normalized = toolName.toLowerCase();
  const filePath = readStringField(input, ["file_path", "path", "target_file", "file", "cwd"]);
  const query = readStringField(input, ["query", "information_request", "pattern", "description", "command", "url"]);

  if (normalized.includes("read")) {
    return filePath ? `读取文件 ${truncateMiddle(filePath)}` : "读取文件内容";
  }
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) {
    return filePath ? `编辑文件 ${truncateMiddle(filePath)}` : "编辑代码文件";
  }
  if (normalized.includes("grep")) {
    return query ? `搜索代码内容：${truncateMiddle(query, 60)}` : "搜索代码内容";
  }
  if (normalized.includes("glob") || normalized === "ls" || normalized.includes("searchcodebase")) {
    return query
      ? `查找项目内容：${truncateMiddle(query, 60)}`
      : filePath
        ? `浏览目录 ${truncateMiddle(filePath)}`
        : "查找项目内容";
  }
  if (normalized.includes("websearch")) {
    return query ? `搜索网页：${truncateMiddle(query, 60)}` : "搜索网页信息";
  }
  if (normalized.includes("webfetch")) {
    return query ? `浏览网页 ${truncateMiddle(query, 72)}` : "抓取网页内容";
  }
  if (normalized.includes("runcommand") || normalized.includes("bash")) {
    return query ? `执行命令：${truncateMiddle(query, 72)}` : "执行终端命令";
  }
  if (normalized === "task") {
    return query ? `调用子代理：${truncateMiddle(query, 60)}` : "调用子代理";
  }

  return query ? `调用 ${toolName}：${truncateMiddle(query, 60)}` : `调用 ${toolName}`;
}

export async function streamPrompt(options: ClaudeStreamOptions) {
  const cwd = normalizeWorkingDirectory(options.workingDirectory);
  const cliPath = await resolveCliPath(options.cliPath);

  options.onEvent({ type: "status", status: "checking" });

  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    mapPermissionMode(options.permissionMode),
  ];
  if (options.claudeSessionId) {
    args.push("--resume", options.claudeSessionId);
  }
  const resolvedToolPolicy = resolveRuntimeToolPolicy({
    filePolicy: options.filePolicy,
    permissionMode: options.permissionMode,
    channelPolicy: options.channelPolicy ?? { mode: options.workspacePolicy === "task" ? "task" : "conversation" },
  });
  // Claude CLI 的 --allowedTools 在 Commander.js 中被定义为 variadic（<tools...>），
  // 使用逗号分隔形式，并通过 stdin 传 prompt，规避参数吞食问题。
  args.push(...buildToolArgs(resolvedToolPolicy));
  const promptInput = buildWorkspaceBoundPrompt({
    message: options.message,
    quotedMessage: options.quotedMessage,
    contextPack: options.contextPack,
    workspaceDir: cwd,
    workspacePolicy: options.workspacePolicy,
    toolSummary: describeRuntimeToolPolicy(resolvedToolPolicy),
    redactionMode: options.workspacePolicy === "task" ? "passthrough" : "strict",
  });
  const trace = createClaudeTrace({
    cwd,
    cliPath,
    args,
    permissionMode: options.permissionMode,
    toolPolicy: resolvedToolPolicy,
    claudeSessionId: options.claudeSessionId,
    scope: "conversation_chat",
    stepLabel: "Claude 会话流式回复",
  });
  trace?.writePrompt(promptInput);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: buildClaudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    if (typeof child.pid === "number") {
      options.onSpawn?.(child.pid);
    }

    // 通过 stdin 传入 prompt，彻底规避 --allowedTools 的 variadic 参数吞食问题。
    child.stdin.write(promptInput);
    child.stdin.end();

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let emittedFatalError = false;
    let aborted = false;
    let terminalResultReceived = false;
    let aggregatedAssistantText = "";
    let callbackError: unknown = null;
    let settled = false;
    let canonicalSessionId = options.claudeSessionId;
    const toolUseBlocks = new Map<number, ToolUseBlockState>();

    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const emitEvent = (event: ClaudeStreamEvent) => {
      if (callbackError) return false;
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

    const abort = () => {
      if (terminalResultReceived) return;
      aborted = true;
      emittedFatalError = true;
      killChildTree(child);
      trace?.finish("aborted", "Claude CLI 流式调用已中断");
      if (emitEvent({ type: "done" })) {
        resolveOnce();
      }
    };

    if (options.signal?.aborted) {
      abort();
      return;
    }

    options.signal?.addEventListener("abort", abort, { once: true });

    const consumeLine = (line: string) => {
      if (callbackError) return;
      if (!line.trim()) return;

      let payload: ClaudeCliPayload;
      try {
        payload = JSON.parse(line) as ClaudeCliPayload;
      } catch {
        // Ignore non-JSON lines; Claude stream-json may emit incidental text in some environments.
        return;
      }
      trace?.appendParsedEvent(payload);

      const sessionDecision = classifySessionFromInitPayload(payload, canonicalSessionId);
      if (sessionDecision.kind === "set") {
        canonicalSessionId = sessionDecision.sessionId;
        if (!emitEvent({ type: "session", sessionId: sessionDecision.sessionId })) return;
      }

      if (payload.type === "system" && payload.subtype === "status") {
        const status = payload.status === "requesting" ? "running" : "checking";
        emitEvent({ type: "status", status });
        return;
      }

      if (payload.type === "stream_event") {
        const eventType = payload.event?.type;
        const eventIndex = typeof payload.event?.index === "number" ? payload.event.index : -1;
        if (eventType === "content_block_start" && payload.event?.content_block?.type === "tool_use" && eventIndex >= 0) {
          toolUseBlocks.set(eventIndex, {
            name: payload.event.content_block.name || "Tool",
            rawInput: payload.event.content_block.input,
            partialJson: "",
          });
          return;
        }
        if (eventType === "content_block_delta") {
          if (payload.event?.delta?.type === "input_json_delta" && eventIndex >= 0) {
            const currentTool = toolUseBlocks.get(eventIndex);
            if (currentTool) {
              currentTool.partialJson += payload.event.delta.partial_json || "";
            }
            return;
          }
          const text = payload.event?.delta?.text;
          if (typeof text === "string" && text.length > 0) {
            aggregatedAssistantText += text;
            emitEvent({ type: "delta", text });
          }
          return;
        }
        if (eventType === "content_block_stop" && eventIndex >= 0) {
          const currentTool = toolUseBlocks.get(eventIndex);
          if (currentTool) {
            const parsedInput = parseToolInput(currentTool.rawInput, currentTool.partialJson);
            emitEvent({
              type: "tool_call",
              toolName: currentTool.name,
              summary: summarizeToolCall(currentTool.name, parsedInput),
              input: parsedInput,
              index: eventIndex,
            });
            toolUseBlocks.delete(eventIndex);
          }
        }
        return;
      }

      if (payload.type === "assistant") {
        // Assistant messages can include intermediate reasoning/process text.
        // Only the terminal result.result is allowed to become the final protocol output.
        const thinking = extractAssistantTraceText(payload);
        if (thinking) aggregatedAssistantText += thinking;
        if (thinking) trace?.appendThinking(`${thinking}\n`);
        return;
      }

      if (payload.type === "result") {
        terminalResultReceived = true;
        if (payload.permission_denials?.length) {
          emittedFatalError = true;
          const tools = Array.from(
            new Set(payload.permission_denials.map((item) => item.tool_name).filter(Boolean)),
          ).join("、");
          const message = tools
            ? `当前运行环境未允许 ${tools}。请在设置里的「工具权限策略」中开启后重试。`
            : "当前运行环境未允许本次工具调用。请在设置里的「工具权限策略」中开启后重试。";
          if (!emitEvent({ type: "permission_request", reason: message })) return;
          emitEvent({ type: "error", message });
          return;
        }
        if (payload.subtype === "success") {
          if (typeof payload.result !== "string" || !payload.result.trim()) {
            emittedFatalError = true;
            emitEvent({
              type: "error",
              message: "Claude CLI 成功结束，但没有返回 result.result，无法提取最终任务结果。",
            });
            return;
          }
          if (!emitEvent({ type: "message", content: payload.result, fallbackContent: aggregatedAssistantText.trim() || undefined })) return;
          trace?.writeOutput(payload.result);
          emitEvent({ type: "status", status: "completed" });
        } else {
          emittedFatalError = true;
          const decision = classifyResultError(payload, options.claudeSessionId);
          if (decision.kind === "session_invalid") {
            emitEvent({
              type: "session_invalid",
              sessionId: decision.sessionId,
              message: decision.message,
            });
          } else {
            emitEvent({
              type: "error",
              message: decision.message,
            });
          }
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutBuffer += text;
      trace?.appendStdout(text);
      let lineBreakIndex = stdoutBuffer.indexOf("\n");
      while (lineBreakIndex !== -1) {
        const line = stdoutBuffer.slice(0, lineBreakIndex);
        stdoutBuffer = stdoutBuffer.slice(lineBreakIndex + 1);
        consumeLine(line);
        lineBreakIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuffer += text;
      trace?.appendStderr(text);
    });

    child.on("error", (error) => {
      emittedFatalError = true;
      trace?.finish("failed", error.message || "Claude CLI 启动失败");
      if (!emitEvent({
        type: "error",
        message: error.message || "Claude CLI 启动失败",
      })) return;
      if (emitEvent({ type: "done" })) {
        resolveOnce();
      }
    });

    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (callbackError) return;
      if (aborted) return;
      if (stdoutBuffer.trim()) {
        consumeLine(stdoutBuffer.trim());
      }
      if (callbackError) return;

      if (code !== 0 && !emittedFatalError) {
        trace?.finish("failed", stderrBuffer.trim() || "Claude CLI 异常退出");
        if (!emitEvent({
          type: "error",
          message: stderrBuffer.trim() || "Claude CLI 异常退出",
        })) return;
      }

      if (emittedFatalError) {
        trace?.finish("failed", stderrBuffer.trim() || "Claude CLI 流式调用失败");
      } else {
        trace?.finish("completed");
      }
      if (emitEvent({ type: "done" })) {
        resolveOnce();
      }
    });
  });
}
