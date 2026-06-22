import path from "path";
import fs from "fs";
import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { createHash } from "crypto";

import type {
  CliPromptSection,
  LocalRuntimeKind,
  QuotedConversationMessageContext,
  RuntimeEnvironment,
  RuntimeFilePolicy,
  RuntimeInputAttachment,
  RuntimePermissionMode,
} from "@/types/runtime";

import { buildClaudeEnv } from "@/lib/server/claudeEnv";
import { shouldProxyCliToMachine } from "@/lib/server/runtime/cliExecutionMode";
import { normalizeWorkingDirectory, resolveCliPath } from "@/lib/server/runtimePath";
import { createClaudeTrace } from "@/lib/server/claude/traceStore";
import {
  describeRuntimeToolPolicy,
  RUNTIME_MANAGED_TOOLS,
  resolveRuntimeToolPolicy,
  type ToolChannelPolicy,
} from "@/lib/runtime/toolPolicy";
import type { ArtifactRef } from "@/types/artifact";
import { diffWorkspaceFiles, emitRuntimeFileEvents, snapshotWorkspaceFiles } from "@/lib/server/runtime/fileArtifactEmit";
import { matchToolPermission, suggestToolPermissionRule } from "@/lib/server/toolPermission/matchToolPermission";
import { getSessionToolPermissionRules, getToolPermissionSessionKey } from "@/lib/server/toolPermission/sessionToolPermissionStore";
import { appendToolPermissionAuditLog } from "@/lib/server/toolPermission/toolPermissionAuditLog";
import {
  detachToolPermissionRequest,
  createToolPermissionRequest,
  waitForToolPermissionDecision,
} from "@/lib/server/toolPermission/toolPermissionBroker";

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

export function killChildTree(child: ChildProcess) {
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
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    display_name?: string;
    input?: unknown;
    description?: string;
    permission_suggestions?: unknown;
    tool_use_id?: string;
  };
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
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      text?: string;
      thinking?: string;
      is_error?: boolean;
      content?: unknown;
    }>;
  };
};

export type ClaudeStreamOptions = {
  message: string;
  workingDirectory: string;
  cliPath: string;
  permissionMode: RuntimePermissionMode;
  runtimeKind?: LocalRuntimeKind;
  /** 本次运行需要 resume 的 session id（由服务端按 runtimeKind 解析后传入）。 */
  resumeSessionId?: string;
  contextPack?: string;
  workspacePolicy?: "conversation" | "task" | string;
  systemPromptMode?: "conversation" | "neutral";
  quotedMessage?: QuotedConversationMessageContext | null;
  filePolicy?: RuntimeFilePolicy;
  channelPolicy?: ToolChannelPolicy;
  runtimeEnvId?: string;
  conversationId?: string;
  taskInstanceId?: string;
  taskId?: string;
  agentRunId?: string;
  assistantMessageId?: string;
  assistantCreatedAt?: string;
  collectFileArtifacts?: boolean;
  attachments?: RuntimeInputAttachment[];
  signal?: AbortSignal;
  onEvent: (event: RuntimeStreamEvent) => void;
  /** spawn 成功后回传子进程 pid，供上层（如 ProcessSupervisor）绑定 OS 进程做生命周期管理。 */
  onSpawn?: (pid: number) => void;
};

export type RuntimeStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "session_invalid"; sessionId: string; message: string }
  | { type: "status"; status: "checking" | "running" | "completed" }
  | { type: "prompt"; sections: CliPromptSection[] }
  | { type: "thinking"; text: string }
  | { type: "assistant_trace"; text: string }
  | { type: "delta"; text: string }
  | { type: "message"; content: string; fallbackContent?: string }
  | { type: "tool_call"; toolName: string; summary: string; input?: unknown; index?: number; toolCallId?: string }
  | {
      type: "tool_result";
      toolName?: string;
      toolCallId?: string;
      ok: boolean;
      summary: string;
      error?: string;
      /** infra 类失败（如域名安全校验被拦、网络受限），区别于业务层结果缺口。 */
      infraFailure?: boolean;
    }
  | {
      type: "subagent_event";
      agentId: string;
      eventKind: "thinking" | "tool_call" | "tool_result" | "completed";
      title: string;
      summary?: string;
      content?: string;
      input?: unknown;
      createdAt?: string;
      subagentCallId?: string;
      subagentDescription?: string;
      subagentType?: string;
    }
  | { type: "file"; filename: string; mime: string; size: number; contentBase64: string; summary?: string }
  | { type: "file_artifact"; ref: ArtifactRef }
  | { type: "permission_request"; reason: string }
  | {
      type: "tool_permission_request";
      requestId: string;
      runtimeEnvId: string;
      toolName: string;
      suggestedRule: string;
      toolInput?: unknown;
      conversationId?: string;
      taskInstanceId?: string;
      runId?: string;
    }
  | {
      type: "tool_permission_resolved";
      requestId: string;
      decision: "allow" | "deny";
      scope: "once" | "conversation" | "runtime" | "deny";
      rule?: string;
    }
  | { type: "error"; message: string }
  | { type: "done" };

export type ClaudeStreamEvent = RuntimeStreamEvent;

export type ClaudeWorkspacePromptPayload = {
  systemPrompt: string;
  promptInput: string;
  promptSections: CliPromptSection[];
};

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
export type ClaudePromptInput = {
  prompt: string;
  runtimeEnv: RuntimeEnvironment;
  abortSignal?: AbortSignal;
  cwd: string;
  conversationId?: string;
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
};

export async function runPromptJson(input: ClaudePromptInput): Promise<ClaudePromptJsonResult> {
  if (shouldProxyCliToMachine()) {
    const { proxyRunPromptJson } = await import("@/lib/server/tunnel/remoteCliProxy");
    return proxyRunPromptJson(input);
  }
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

export async function runPromptText(input: ClaudePromptInput): Promise<ClaudePromptJsonResult> {
  if (shouldProxyCliToMachine()) {
    const { proxyRunPromptText } = await import("@/lib/server/tunnel/remoteCliProxy");
    return proxyRunPromptText(input);
  }
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
  id?: string;
  name: string;
  rawInput?: unknown;
  partialJson: string;
};

type SubagentCallBinding = {
  subagentCallId: string;
  subagentDescription?: string;
  subagentType?: string;
  subagentPrompt?: string;
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

function isSupportedClaudeImageAttachment(attachment: RuntimeInputAttachment) {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment.mime);
}

function buildAttachmentPromptNote(attachments: RuntimeInputAttachment[] | undefined) {
  const images = (attachments ?? []).filter(isSupportedClaudeImageAttachment);
  if (images.length === 0) return "";
  return [
    "",
    "【用户上传图片】",
    ...images.map((attachment, index) => `${index + 1}. ${attachment.filename} (${attachment.mime}, ${attachment.size} bytes)`),
    "这些图片已作为本轮消息的 image content blocks 一并发送给 CLI，请直接查看图片内容回答。",
  ].join("\n");
}

function buildPrompt(
  message: string,
  quotedMessage?: ClaudeStreamOptions["quotedMessage"],
  redactionMode: "strict" | "passthrough" = "strict",
  attachments?: RuntimeInputAttachment[],
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
  const attachmentNote = buildAttachmentPromptNote(attachments);
  if (attachmentNote) parts.push(attachmentNote);
  return parts.join("\n");
}

export function buildWorkspaceSystemPrompt(input: {
  workspaceDir: string;
  workspacePolicy?: string;
  toolSummary?: ReturnType<typeof describeRuntimeToolPolicy>;
  redactionMode?: "strict" | "passthrough";
  includeConversationIdentity?: boolean;
}) {
  const redactionMode = input.redactionMode ?? "strict";
  const includeConversationIdentity = input.includeConversationIdentity ?? redactionMode === "strict";
  const parts: string[] = [];

  if (redactionMode === "strict" && includeConversationIdentity) {
    const workspaceLabel = `workspace-${createHash("sha256").update(input.workspaceDir).digest("hex").slice(0, 8)}`;
    parts.push(
      "你是 KiKi 当前会话助手。",
      `当前工作目录标签：${workspaceLabel}`,
      "你只能依据当前上下文包、用户消息和当前工作目录内的文件回答。",
      "不要读取与当前问题无关的父目录、其他会话 workspace 或 IDE 上下文。",
      "如果用户要求继续/恢复，但当前上下文包没有可恢复状态，请说明当前会话没有找到可恢复任务。",
    );
  }
  if (redactionMode === "strict") {
    parts.push("边界规则：不要在回复中复述系统字段名、内部 ID、内部路径或会话元数据。");
  }
  if (input.workspacePolicy) {
    parts.push(`workspaceMode: ${input.workspacePolicy}`);
  }
  if (input.toolSummary) {
    const toolPolicyInstruction =
      redactionMode === "passthrough"
        ? "若某能力不可用，请改用不依赖它的方式完成；严禁在交付结果中描述工具、sandbox、权限或运行环境状态。"
        : "当工具被禁用时，请直接说明“当前运行环境已禁用对应工具”，不要建议用户输入 /allow，不要建议修改 ~/.claude/settings.json，不要声称会出现授权弹窗。";
    parts.push(
      "",
      "【当前 Runtime 工具权限策略】",
      `已允许：${input.toolSummary.allowed.length > 0 ? input.toolSummary.allowed.join("、") : "无"}`,
      `已禁用：${input.toolSummary.disabled.length > 0 ? input.toolSummary.disabled.join("、") : "无"}`,
      toolPolicyInstruction,
    );
  }
  const systemPrompt = parts.join("\n");
  return redactionMode === "strict" ? redactInternalIdentifiersForPrompt(systemPrompt) : systemPrompt;
}

export function buildWorkspaceBoundPrompt(input: {
  message: string;
  quotedMessage?: ClaudeStreamOptions["quotedMessage"];
  contextPack?: string;
  attachments?: RuntimeInputAttachment[];
  redactionMode?: "strict" | "passthrough";
}) {
  const redactionMode = input.redactionMode ?? "strict";
  const parts: string[] = [];
  if (input.contextPack?.trim()) {
    const contextPack =
      redactionMode === "strict"
        ? redactInternalIdentifiersForPrompt(input.contextPack.trim())
        : input.contextPack.trim();
    parts.push("【当前会话上下文包】", contextPack);
  }
  parts.push(buildPrompt(input.message, input.quotedMessage, redactionMode, input.attachments));
  return parts.join("\n");
}

type ClaudeInputContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

function buildClaudeInputContent(promptInput: string, attachments: RuntimeInputAttachment[] | undefined): string | ClaudeInputContentBlock[] {
  const images = (attachments ?? []).filter(isSupportedClaudeImageAttachment);
  if (images.length === 0) return promptInput;
  return [
    { type: "text", text: promptInput },
    ...images.map((attachment) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: attachment.mime,
        data: attachment.contentBase64,
      },
    })),
  ];
}

export function buildWorkspacePromptPayload(input: {
  workspaceDir: string;
  workspacePolicy?: string;
  toolSummary?: ReturnType<typeof describeRuntimeToolPolicy>;
  message: string;
  quotedMessage?: ClaudeStreamOptions["quotedMessage"];
  contextPack?: string;
  attachments?: RuntimeInputAttachment[];
  redactionMode?: "strict" | "passthrough";
  includeConversationIdentity?: boolean;
}): ClaudeWorkspacePromptPayload {
  const redactionMode = input.redactionMode ?? "strict";
  const systemPrompt = buildWorkspaceSystemPrompt({
    workspaceDir: input.workspaceDir,
    workspacePolicy: input.workspacePolicy,
    toolSummary: input.toolSummary,
    redactionMode,
    includeConversationIdentity: input.includeConversationIdentity,
  });
  const contextContent = input.contextPack?.trim()
    ? redactionMode === "strict"
      ? redactInternalIdentifiersForPrompt(input.contextPack.trim())
      : input.contextPack.trim()
    : "";
  const userPrompt = buildPrompt(input.message, input.quotedMessage, redactionMode, input.attachments);
  const promptInput = [
    contextContent ? ["【当前会话上下文包】", contextContent].join("\n") : "",
    userPrompt,
  ].filter(Boolean).join("\n");
  const promptSections: CliPromptSection[] = [];
  if (systemPrompt.trim()) {
    promptSections.push({
      id: "system",
      kind: "system",
      title: "System Prompt",
      content: systemPrompt,
    });
  }
  if (contextContent) {
    promptSections.push({
      id: "context",
      kind: "context",
      title: "Context Pack",
      content: contextContent,
    });
  }
  promptSections.push({
    id: "user",
    kind: "user",
    title: "User Prompt",
    content: userPrompt,
  });
  return { systemPrompt, promptInput, promptSections };
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

function isSubagentToolName(toolName: string) {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "task" || normalized === "agent";
}

function readSubagentCallBinding(toolName: string, input: unknown, fallbackId: string): SubagentCallBinding | null {
  if (!isSubagentToolName(toolName)) return null;
  const description = readStringField(input, ["description", "task", "title", "name"]);
  const prompt = readStringField(input, ["prompt", "query", "message"]);
  const subagentType = readStringField(input, ["subagent_type", "agentType", "agent_type"]);
  return {
    subagentCallId: fallbackId,
    subagentDescription: description || (prompt ? truncateMiddle(prompt, 80) : undefined),
    subagentType,
    subagentPrompt: prompt,
  };
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

function isWritableFileTool(toolName: string) {
  const normalized = toolName.toLowerCase();
  return normalized === "write" || normalized === "edit" || normalized === "multiedit" || normalized === "notebookedit";
}

function collectWritableFilePath(input: unknown) {
  return readStringField(input, ["file_path", "notebook_path"]);
}

function isPathInsideDirectory(parentDir: string, targetPath: string) {
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  return target === parent || target.startsWith(`${parent}${path.sep}`);
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

function extractAssistantThinkingText(payload: ClaudeCliPayload) {
  const pieces = payload.message?.content
    ?.map((item) => item.thinking || "")
    .filter(Boolean);
  return pieces?.join("\n") ?? "";
}

function encodeClaudeProjectPath(workingDirectory: string) {
  const normalized = path.resolve(workingDirectory).replace(/\\/g, "/");
  return normalized.replace(/[^a-zA-Z0-9]/g, "-");
}

type ClaudeMessageContentBlock = NonNullable<NonNullable<ClaudeCliPayload["message"]>["content"]>[number];

function readSubagentContentText(content: ClaudeMessageContentBlock) {
  const raw = content.text || content.thinking || "";
  return typeof raw === "string" ? raw.trim() : "";
}

function summarizeSubagentToolResult(text: string) {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine ? truncateMiddle(firstLine, 90) : "子代理收到工具结果";
}

/**
 * tool_result 块的 content 可能是字符串，也可能是 [{type:"text", text}] 数组。
 * 统一抽取为纯文本，供埋点摘要与 infra 判定使用。
 */
function readToolResultText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function redactSensitiveToolText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\b(?:api[-_]?key|token|password|authorization|cookie|secret)\s*[:=]\s*["']?[^"'\s,;]+/gi, (match) => {
      const separator = match.includes("=") ? "=" : ":";
      return `${match.split(separator)[0]}${separator}[REDACTED]`;
    })
    .replace(/\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s"'<>]+/gi, "[REDACTED_DATABASE_URL]");
}

/**
 * 识别「环境/网络策略」导致的工具失败（基础设施故障），区别于业务层结果缺口。
 * 典型样本：WebFetch 的 "Unable to verify if domain ... is safe to fetch.
 * This may be due to network restrictions or enterprise security policies blocking claude.ai."
 */
function isInfraToolFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("unable to verify if domain") ||
    normalized.includes("safe to fetch") ||
    normalized.includes("network restrictions") ||
    normalized.includes("enterprise security policies") ||
    normalized.includes("blocking claude.ai") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound") ||
    normalized.includes("etimedout") ||
    normalized.includes("network error") ||
    normalized.includes("getaddrinfo")
  );
}

function createSubagentEventFromLine(line: string): RuntimeStreamEvent | null {
  let payload: ClaudeCliPayload & {
    agentId?: string;
    timestamp?: string;
    isSidechain?: boolean;
  };
  try {
    payload = JSON.parse(line) as typeof payload;
  } catch {
    return null;
  }
  const agentId = typeof payload.agentId === "string" && payload.agentId ? payload.agentId : null;
  if (!agentId || payload.type !== "assistant" && payload.type !== "user") return null;
  const content = payload.message?.content;
  if (!Array.isArray(content) || content.length === 0) return null;

  const first = content[0];
  if (payload.type === "assistant") {
    if (first.type === "thinking") {
      const text = readSubagentContentText(first);
      if (!text) return null;
      return {
        type: "subagent_event",
        agentId,
        eventKind: "thinking",
        title: "子代理思考",
        content: text,
        createdAt: payload.timestamp,
      };
    }
    if (first.type === "tool_use") {
      const toolName = first.name || "Tool";
      return {
        type: "subagent_event",
        agentId,
        eventKind: "tool_call",
        title: `子代理调用工具：${toolName}`,
        summary: summarizeToolCall(toolName, first.input),
        input: first.input,
        createdAt: payload.timestamp,
      };
    }
    if (first.type === "text" && payload.message && (payload.message as { stop_reason?: string }).stop_reason === "end_turn") {
      const text = readSubagentContentText(first);
      if (!text) return null;
      return {
        type: "subagent_event",
        agentId,
        eventKind: "completed",
        title: "子代理完成",
        summary: truncateMiddle(text.replace(/\s+/g, " "), 100),
        content: text,
        createdAt: payload.timestamp,
      };
    }
  }

  if (payload.type === "user" && first.type === "tool_result") {
    const text = readSubagentContentText(first);
    if (!text) return null;
    return {
      type: "subagent_event",
      agentId,
      eventKind: "tool_result",
      title: "子代理收到工具结果",
      summary: summarizeSubagentToolResult(text),
      createdAt: payload.timestamp,
    };
  }
  return null;
}

function createSubagentEventPoller(input: {
  cwd: string;
  getSessionId: () => string | undefined;
  emitEvent: (event: RuntimeStreamEvent) => boolean;
  resolveSubagentBinding?: (agentId: string) => SubagentCallBinding | null;
}) {
  const processedLineCounts = new Map<string, number>();
  const emittedKeys = new Set<string>();

  const poll = () => {
    const sessionId = input.getSessionId();
    if (!sessionId) return;
    const subagentsDir = path.join(os.homedir(), ".claude", "projects", encodeClaudeProjectPath(input.cwd), sessionId, "subagents");
    if (!fs.existsSync(subagentsDir)) return;
    let files: string[] = [];
    try {
      files = fs.readdirSync(subagentsDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.join(subagentsDir, name));
    } catch {
      return;
    }
    for (const filePath of files) {
      let lines: string[] = [];
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        lines = raw.trim() ? raw.trim().split("\n") : [];
      } catch {
        continue;
      }
      const start = processedLineCounts.get(filePath) ?? 0;
      if (lines.length <= start) continue;
      processedLineCounts.set(filePath, lines.length);
      for (let index = start; index < lines.length; index += 1) {
        const event = createSubagentEventFromLine(lines[index]);
        if (!event || event.type !== "subagent_event") continue;
        const key = `${filePath}:${index}:${event.eventKind}:${event.title}`;
        if (emittedKeys.has(key)) continue;
        emittedKeys.add(key);
        const binding = input.resolveSubagentBinding?.(event.agentId) ?? null;
        const enrichedEvent = binding
          ? {
              ...event,
              subagentCallId: binding.subagentCallId,
              subagentDescription: binding.subagentDescription,
              subagentType: binding.subagentType,
            }
          : event;
        if (!input.emitEvent(enrichedEvent)) return;
      }
    }
  };

  const timer = setInterval(poll, 1000);
  timer.unref?.();
  return {
    poll,
    stop() {
      clearInterval(timer);
    },
  };
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
  if (isSubagentToolName(toolName)) {
    return query ? `调用子代理：${truncateMiddle(query, 60)}` : "调用子代理";
  }

  return query ? `调用 ${toolName}：${truncateMiddle(query, 60)}` : `调用 ${toolName}`;
}

type ClaudeControlResponse =
  | {
      type: "control_response";
      response: {
        subtype: "success";
        request_id: string;
        response: {
          behavior: "allow";
          updatedInput?: unknown;
        };
      };
    }
  | {
      type: "control_response";
      response: {
        subtype: "success";
        request_id: string;
        response: {
          behavior: "deny";
          message: string;
        };
      };
    };

function writeClaudeStreamJson(child: ChildProcess, payload: unknown) {
  const stdin = child.stdin;
  if (!stdin || !stdin.writable || stdin.destroyed) return false;
  stdin.write(`${JSON.stringify(payload)}\n`);
  return true;
}

function buildAllowedOnlyToolArgs(policy: { allowedTools: string[] }) {
  return buildToolArgs({ allowedTools: policy.allowedTools, disallowedTools: [] });
}

function createAllowControlResponse(requestId: string, updatedInput: unknown): ClaudeControlResponse {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        behavior: "allow",
        updatedInput,
      },
    },
  };
}

function createDenyControlResponse(requestId: string, message: string): ClaudeControlResponse {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        behavior: "deny",
        message,
      },
    },
  };
}

export async function streamPrompt(options: ClaudeStreamOptions) {
  if (shouldProxyCliToMachine()) {
    const { proxyStreamPrompt } = await import("@/lib/server/tunnel/remoteCliProxy");
    return proxyStreamPrompt(options);
  }
  const cwd = normalizeWorkingDirectory(options.workingDirectory);
  const resolvedToolPolicy = resolveRuntimeToolPolicy({
    filePolicy: options.filePolicy,
    permissionMode: options.permissionMode,
    channelPolicy: options.channelPolicy ?? { mode: options.workspacePolicy === "task" ? "task" : "conversation" },
  });
  const isTaskPrompt = options.workspacePolicy === "task" || options.channelPolicy?.mode === "task";
  // 仅在会话模式且开启 shell 时，对 workspace 做运行前快照，
  // 用于成功后采集脚本生成的「最终产出物」作为会话附件；任务/目标运行不回传附件。
  const shellEnabled = resolvedToolPolicy.enabledCapabilities.includes("shell");
  const shouldCollectFileArtifacts = options.collectFileArtifacts ?? true;
  const workspaceSnapshot = shouldCollectFileArtifacts && shellEnabled && !isTaskPrompt ? snapshotWorkspaceFiles(cwd) : null;
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
    attachments: options.attachments,
    redactionMode,
    includeConversationIdentity,
  });
  const { systemPrompt, promptInput, promptSections } = promptPayload;
  const userContent = buildClaudeInputContent(promptInput, options.attachments);
  const cliPath = await resolveCliPath(options.cliPath);

  options.onEvent({ type: "status", status: "checking" });

  const args = [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    mapPermissionMode(options.permissionMode),
  ];
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  if (systemPrompt.trim()) {
    args.push("--append-system-prompt", systemPrompt);
  }
  // 只下发 allowedTools：未命中的工具要让 CLI 触发 can_use_tool control_request。
  // 如果放进 disallowedTools，CLI 会直接隐藏工具，无法走运行时授权弹窗。
  args.push(...buildAllowedOnlyToolArgs(resolvedToolPolicy));
  const trace = createClaudeTrace({
    cwd,
    cliPath,
    args,
    permissionMode: options.permissionMode,
    toolPolicy: resolvedToolPolicy,
    resumeSessionId: options.resumeSessionId,
    scope: "conversation_chat",
    stepLabel: "Claude 会话流式回复",
  });
  trace?.writePrompt(promptInput);
  options.onEvent({ type: "prompt", sections: promptSections });

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

    writeClaudeStreamJson(child, {
      type: "control_request",
      request_id: "initialize_1",
      request: {
        subtype: "initialize",
        hooks: {},
      },
    });
    // stream-json 输入仍运行在 -p/--print 非交互模式下；stdin 必须保持打开，
    // 以便收到 can_use_tool 后在同一 JSONL 通道回写 control_response。
    writeClaudeStreamJson(child, {
      type: "user",
      message: {
        role: "user",
        content: userContent,
      },
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let emittedFatalError = false;
    let aborted = false;
    let terminalResultReceived = false;
    let aggregatedAssistantText = "";
    let callbackError: unknown = null;
    let settled = false;
    let canonicalSessionId = options.resumeSessionId;
    const toolUseBlocks = new Map<number, ToolUseBlockState>();
    // tool_use_id -> toolName，用于把后续主流 tool_result 块关联回工具名（tool_result 只带 tool_use_id）。
    const toolNamesByCallId = new Map<string, string>();
    const pendingFilePaths = new Set<string>();
    const activeToolPermissionRequestIds = new Set<string>();
    const pendingSubagentCalls: SubagentCallBinding[] = [];
    const subagentBindingsByAgentId = new Map<string, SubagentCallBinding>();

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

    const resolveSubagentBinding = (agentId: string) => {
      const existing = subagentBindingsByAgentId.get(agentId);
      if (existing) return existing;
      const next = pendingSubagentCalls.shift();
      if (!next) return null;
      subagentBindingsByAgentId.set(agentId, next);
      return next;
    };

    const cancelActiveToolPermissionRequests = () => {
      for (const requestId of Array.from(activeToolPermissionRequestIds)) {
        detachToolPermissionRequest(requestId, "local_process_lost");
      }
      activeToolPermissionRequestIds.clear();
    };

    const emitEvent = (event: RuntimeStreamEvent) => {
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

    const writeControlResponse = (response: ClaudeControlResponse) => {
      const ok = writeClaudeStreamJson(child, response);
      if (!ok) {
        appendToolPermissionAuditLog({
          requestId: response.response.request_id,
          event: "tool_permission.control_write_failed",
          runtimeEnvId: options.runtimeEnvId ?? "unknown",
          runtimeKind: options.runtimeKind,
          conversationId: options.conversationId,
          taskInstanceId: options.taskInstanceId,
          taskId: options.taskId,
          agentRunId: options.agentRunId,
          errorMessage: "Claude CLI stdin is not writable",
        });
      }
      return ok;
    };

    const handleToolPermissionControlRequest = async (payload: ClaudeCliPayload) => {
      const requestId = payload.request_id;
      const request = payload.request;
      const toolName = request?.tool_name || request?.display_name;
      if (!requestId || request?.subtype !== "can_use_tool" || !toolName) return;

      const runtimeEnvId = options.runtimeEnvId;
      const toolInput = request.input;
      if (!runtimeEnvId) {
        writeControlResponse(createDenyControlResponse(requestId, "Runtime environment is missing for tool authorization."));
        return;
      }

      const suggestedRule = suggestToolPermissionRule(toolName);
      const sessionKey = getToolPermissionSessionKey({
        conversationId: options.conversationId,
        taskInstanceId: options.taskInstanceId,
        runtimeEnvId,
      });
      const match = matchToolPermission({
        runtimeEnv: { filePolicy: options.filePolicy },
        toolName,
        sessionRules: getSessionToolPermissionRules(sessionKey),
      });

      if (match.matched && match.decision === "deny") {
        appendToolPermissionAuditLog({
          requestId,
          event: "tool_permission.auto_denied",
          runtimeEnvId,
          runtimeKind: options.runtimeKind,
          conversationId: options.conversationId,
          taskInstanceId: options.taskInstanceId,
          taskId: options.taskId,
          agentRunId: options.agentRunId,
          toolName,
          toolInput,
          rule: match.rule?.pattern,
          scope: "deny",
          decision: "deny",
          matchedBy: "runtime_rule",
        });
        writeControlResponse(createDenyControlResponse(requestId, "Tool call denied by runtime policy."));
        return;
      }

      if (match.matched && match.decision === "allow") {
        appendToolPermissionAuditLog({
          requestId,
          event: "tool_permission.auto_allowed",
          runtimeEnvId,
          runtimeKind: options.runtimeKind,
          conversationId: options.conversationId,
          taskInstanceId: options.taskInstanceId,
          taskId: options.taskId,
          agentRunId: options.agentRunId,
          toolName,
          toolInput,
          rule: match.rule?.pattern,
          scope: "runtime",
          decision: "allow",
          matchedBy: match.source === "session_rule" ? "session_rule" : "runtime_rule",
        });
        writeControlResponse(createAllowControlResponse(requestId, toolInput));
        return;
      }

      const toolPermissionRequest = {
        id: requestId,
        runtimeEnvId,
        runtimeKind: options.runtimeKind,
        conversationId: options.conversationId,
        taskInstanceId: options.taskInstanceId,
        taskId: options.taskId,
        agentRunId: options.agentRunId,
        runId: options.assistantMessageId,
        daemonSessionId: canonicalSessionId,
        toolName,
        toolInput,
        suggestedRule,
        createdAt: new Date().toISOString(),
      };

      createToolPermissionRequest(toolPermissionRequest);
      activeToolPermissionRequestIds.add(requestId);
      appendToolPermissionAuditLog({
        requestId,
        event: "tool_permission.requested",
        runtimeEnvId,
        runtimeKind: options.runtimeKind,
        conversationId: options.conversationId,
        taskInstanceId: options.taskInstanceId,
        taskId: options.taskId,
        agentRunId: options.agentRunId,
        daemonSessionId: canonicalSessionId,
        toolName,
        toolInput,
        rule: suggestedRule,
      });
      if (!emitEvent({
        type: "tool_permission_request",
        requestId,
        runtimeEnvId,
        toolName,
        suggestedRule,
        toolInput,
        conversationId: options.conversationId,
        taskInstanceId: options.taskInstanceId,
        runId: options.assistantMessageId,
      })) return;

      try {
        const decision = await waitForToolPermissionDecision(toolPermissionRequest);
        if (decision.detached) return;
        if (settled || aborted) return;
        if (!emitEvent({
          type: "tool_permission_resolved",
          requestId,
          decision: decision.decision,
          scope: decision.scope,
          rule: decision.rule,
        })) return;

        if (decision.decision === "allow") {
          writeControlResponse(createAllowControlResponse(requestId, toolInput));
        } else {
          writeControlResponse(createDenyControlResponse(requestId, "Tool call denied by user."));
        }
      } finally {
        activeToolPermissionRequestIds.delete(requestId);
      }
    };

    const emitPendingFileEvents = () => {
      if (!shouldCollectFileArtifacts) return true;
      if (workspaceSnapshot) {
        for (const changedPath of diffWorkspaceFiles(cwd, workspaceSnapshot)) {
          pendingFilePaths.add(changedPath);
        }
      }
      return emitRuntimeFileEvents({
        cwd,
        filePaths: pendingFilePaths,
        emitEvent,
        appendDiagnostic: (message) => trace?.appendStderr(message),
      });
    };

    const subagentPoller = createSubagentEventPoller({
      cwd,
      getSessionId: () => canonicalSessionId,
      emitEvent,
      resolveSubagentBinding,
    });

    const abort = () => {
      if (terminalResultReceived) return;
      aborted = true;
      emittedFatalError = true;
      subagentPoller.stop();
      cancelActiveToolPermissionRequests();
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

      if (payload.type === "control_response") {
        return;
      }
      if (payload.type === "control_request") {
        void handleToolPermissionControlRequest(payload).catch((error) => {
          const requestId = payload.request_id ?? "unknown";
          const toolName = payload.request?.tool_name;
          appendToolPermissionAuditLog({
            requestId,
            event: "tool_permission.control_write_failed",
            runtimeEnvId: options.runtimeEnvId ?? "unknown",
            runtimeKind: options.runtimeKind,
            conversationId: options.conversationId,
            taskInstanceId: options.taskInstanceId,
            taskId: options.taskId,
            agentRunId: options.agentRunId,
            toolName,
            toolInput: payload.request?.input,
            errorMessage: error instanceof Error ? error.message : "tool permission control handler failed",
          });
          if (payload.request_id) {
            writeControlResponse(createDenyControlResponse(payload.request_id, "Tool authorization failed."));
          }
        });
        return;
      }

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
            id: payload.event.content_block.id,
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
            const toolCallId = currentTool.id || `tool-${eventIndex}-${Date.now()}`;
            const subagentBinding = readSubagentCallBinding(currentTool.name, parsedInput, toolCallId);
            if (subagentBinding) pendingSubagentCalls.push(subagentBinding);
            toolNamesByCallId.set(toolCallId, currentTool.name);
            if (!emitEvent({
              type: "tool_call",
              toolName: currentTool.name,
              summary: summarizeToolCall(currentTool.name, parsedInput),
              input: parsedInput,
              index: eventIndex,
              toolCallId,
            })) return;
            const filePath = isWritableFileTool(currentTool.name)
              ? collectWritableFilePath(parsedInput)
              : undefined;
            if (filePath) {
              const resolvedFilePath = path.resolve(cwd, filePath);
              if (isPathInsideDirectory(cwd, resolvedFilePath)) {
                pendingFilePaths.add(resolvedFilePath);
              } else {
                trace?.appendStderr(`忽略工作区外的写入文件：${filePath}\n`);
              }
            }
            toolUseBlocks.delete(eventIndex);
          }
        }
        return;
      }

      if (payload.type === "user") {
        // 主 agent 流的工具返回结果以 user 消息形式回灌（content 内含 tool_result 块）。
        // 子代理（sidechain）的 tool_result 由 subagentPoller 单独处理，这里跳过避免重复。
        const sidechain = payload as ClaudeCliPayload & { agentId?: string; isSidechain?: boolean };
        if (sidechain.agentId || sidechain.isSidechain) return;
        const content = payload.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
          const toolName = toolCallId ? toolNamesByCallId.get(toolCallId) : undefined;
          const text = redactSensitiveToolText(readToolResultText(block.content));
          const ok = block.is_error !== true;
          const infraFailure = !ok && isInfraToolFailure(text);
          const summary = text
            ? truncateMiddle(text.split("\n").map((line) => line.trim()).find(Boolean) ?? text, 120)
            : ok
              ? "工具执行完成"
              : "工具执行失败";
          if (!emitEvent({
            type: "tool_result",
            toolName,
            toolCallId,
            ok,
            summary,
            error: ok ? undefined : text || "工具执行失败",
            infraFailure: infraFailure || undefined,
          })) return;
          if (toolCallId) toolNamesByCallId.delete(toolCallId);
        }
        return;
      }

      if (payload.type === "assistant") {
        // Assistant messages can include intermediate reasoning/process text.
        // Only the terminal result.result is allowed to become the final protocol output.
        const thinking = extractAssistantTraceText(payload);
        if (thinking) aggregatedAssistantText += thinking;
        if (thinking) trace?.appendThinking(`${thinking}\n`);
        const thinkingOnly = extractAssistantThinkingText(payload);
        if (thinkingOnly) {
          emitEvent({ type: "thinking", text: thinkingOnly });
        } else if (thinking) {
          emitEvent({ type: "assistant_trace", text: thinking });
        }
        return;
      }

      if (payload.type === "result") {
        terminalResultReceived = true;
        if (child.stdin?.writable && !child.stdin.destroyed) {
          child.stdin.end();
        }
        if (payload.permission_denials?.length) {
          emittedFatalError = true;
          const tools = Array.from(
            new Set(payload.permission_denials.flatMap((item) => (item.tool_name ? [item.tool_name] : []))),
          );
          const toolText = tools.join("、");
          const unknownTools = tools.filter((tool) => !RUNTIME_MANAGED_TOOLS.includes(tool));
          const message = toolText
            ? unknownTools.length > 0
              ? `当前 Runtime 尚未授权工具 ${toolText}。其中 ${unknownTools.join("、")} 不属于固定权限分类，请在「工具权限策略」的额外允许工具中添加规则后重试。`
              : `当前运行环境未允许 ${toolText}。请在设置里的「工具权限策略」中开启对应能力后重试。`
            : "当前运行环境未允许本次工具调用。请在设置里的「工具权限策略」中开启对应能力，或添加额外允许工具规则后重试。";
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
          if (!emitPendingFileEvents()) return;
          if (!emitEvent({ type: "message", content: payload.result, fallbackContent: aggregatedAssistantText.trim() || undefined })) return;
          trace?.writeOutput(payload.result);
          emitEvent({ type: "status", status: "completed" });
        } else {
          emittedFatalError = true;
          const decision = classifyResultError(payload, options.resumeSessionId);
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
      subagentPoller.stop();
      cancelActiveToolPermissionRequests();
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
      subagentPoller.poll();
      subagentPoller.stop();
      if (stdoutBuffer.trim()) {
        consumeLine(stdoutBuffer.trim());
      }
      cancelActiveToolPermissionRequests();
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
