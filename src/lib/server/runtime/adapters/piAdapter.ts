import { spawn } from "child_process";

import { describeRuntimeToolPolicy, resolveRuntimeToolPolicy } from "@/lib/runtime/toolPolicy";
import {
  buildWorkspacePromptPayload,
  killChildTree,
  type RuntimeStreamEvent,
} from "@/lib/server/claude/transport";
import { createClaudeTrace } from "@/lib/server/claude/traceStore";
import { buildPiEnv } from "@/lib/server/piEnv";
import { shouldProxyCliToMachine } from "@/lib/server/runtime/cliExecutionMode";
import { emitRuntimeFileEvents } from "@/lib/server/runtime/fileArtifactEmit";
import type {
  RuntimeAdapter,
  RuntimePromptJsonInput,
  RuntimePromptResult,
  RuntimeStreamOptions,
} from "@/lib/server/runtime/adapters/types";
import { normalizeWorkingDirectory, resolveCliPath } from "@/lib/server/runtimePath";
import type { RuntimeToolCapability } from "@/types/runtime";

type PiJsonLine = Record<string, unknown>;

type PiToolState = {
  toolName: string;
  args?: unknown;
};

const PI_TOOL_MAP: Partial<Record<RuntimeToolCapability, string[]>> = {
  fileRead: ["read", "grep", "find", "ls"],
  fileWrite: ["write", "edit"],
  shell: ["bash"],
};
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

function truncateMiddle(value: string, max = 80) {
  if (value.length <= max) return value;
  const head = Math.ceil(max / 2) - 2;
  const tail = Math.floor(max / 2) - 1;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function summarizeToolCall(toolName: string, input: unknown) {
  const normalized = toolName.toLowerCase();
  const filePath = readStringField(input, ["file_path", "path", "target_file", "file", "cwd"]);
  const query = readStringField(input, ["query", "pattern", "description", "command", "url"]);
  if (["read", "grep", "find", "ls"].includes(normalized)) {
    return filePath ? `读取文件 ${truncateMiddle(filePath)}` : "读取文件内容";
  }
  if (["write", "edit"].includes(normalized)) {
    return filePath ? `编辑文件 ${truncateMiddle(filePath)}` : "编辑代码文件";
  }
  if (normalized === "bash") {
    return query ? `执行命令 ${truncateMiddle(query)}` : "执行终端命令";
  }
  return query || filePath || toolName;
}

function collectWritableFilePath(toolName: string, input: unknown) {
  const normalized = toolName.toLowerCase();
  if (normalized !== "write" && normalized !== "edit") return undefined;
  return readStringField(input, ["file_path", "path", "target_file", "file"]);
}

function extractTextDelta(line: PiJsonLine) {
  const event = asRecord(line.assistantMessageEvent) ?? asRecord(line.messageEvent) ?? asRecord(line.event);
  if (!event) return "";
  const delta = event.delta;
  if (typeof delta === "string") return delta;
  if (typeof event.text === "string") return event.text;
  return "";
}

function isThinkingDelta(line: PiJsonLine) {
  const event = asRecord(line.assistantMessageEvent) ?? asRecord(line.messageEvent) ?? asRecord(line.event);
  const type = typeof event?.type === "string" ? event.type.toLowerCase() : "";
  return type.includes("thinking") || type.includes("reasoning");
}

function extractAssistantTextFromLine(line: PiJsonLine) {
  const message = asRecord(line.message) ?? asRecord(line.assistantMessage);
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const record = asRecord(item);
        return typeof record?.text === "string" ? record.text : "";
      })
      .join("");
  }
  return "";
}

function extractAgentEndText(line: PiJsonLine) {
  const messages = line.messages;
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = extractAssistantTextFromLine({ message: messages[index] });
    if (text.trim()) return text.trim();
  }
  return "";
}

export function buildPiToolArgs(enabledCapabilities: RuntimeToolCapability[]) {
  const tools = new Set<string>();
  for (const capability of enabledCapabilities) {
    for (const tool of PI_TOOL_MAP[capability] ?? []) tools.add(tool);
  }
  if (tools.size === 0) return ["-nt"];
  return ["--tools", Array.from(tools).sort().join(",")];
}

function buildPiArgs(input: {
  systemPrompt?: string;
  sessionId?: string;
  enabledCapabilities: RuntimeToolCapability[];
}) {
  const args = ["-p", "--mode", "json", "--no-context-files"];
  if (input.systemPrompt?.trim()) {
    args.push("--append-system-prompt", input.systemPrompt);
  }
  if (input.sessionId) {
    args.push("--session", input.sessionId);
  }
  args.push(...buildPiToolArgs(input.enabledCapabilities));
  return args;
}

async function runPiPrompt(input: RuntimePromptJsonInput, mode: "json" | "text"): Promise<RuntimePromptResult> {
  if (shouldProxyCliToMachine()) {
    const { proxyRunPromptJson, proxyRunPromptText } = await import("@/lib/server/tunnel/remoteCliProxy");
    return mode === "json" ? proxyRunPromptJson(input) : proxyRunPromptText(input);
  }
  const cwd = normalizeWorkingDirectory(input.cwd);
  const cliPath = await resolveCliPath(input.runtimeEnv.cliPath, { packageName: PI_PACKAGE_NAME });
  const startedAt = Date.now();
  const resolvedToolPolicy = resolveRuntimeToolPolicy({
    filePolicy: input.filePolicy ?? input.runtimeEnv.filePolicy,
    permissionMode: input.permissionMode ?? input.runtimeEnv.permissionMode,
    channelPolicy: input.channelPolicy ?? {
      mode: "readonly_json",
      ...(input.toolPolicy?.mode === "readonly_only" ? { allow: input.toolPolicy.allow } : {}),
    },
  });
  const args = buildPiArgs({ enabledCapabilities: resolvedToolPolicy.enabledCapabilities });
  const trace = createClaudeTrace({
    cwd,
    cliPath,
    args,
    permissionMode: input.permissionMode ?? input.runtimeEnv.permissionMode,
    toolPolicy: resolvedToolPolicy,
    requestId: input.traceContext?.requestId,
    scope: input.traceContext?.scope ?? "pi_json",
    phase: input.traceContext?.phase,
    stepLabel: input.traceContext?.stepLabel,
  });
  trace?.writePrompt(input.prompt);

  return new Promise<RuntimePromptResult>((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: buildPiEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    child.stdin.write(input.prompt);
    child.stdin.end();

    let output = "";
    let stdoutBuffer = "";
    let stderr = "";
    let lastAssistantText = "";
    let aborted = false;

    const abort = () => {
      aborted = true;
      killChildTree(child);
      trace?.finish("aborted", input.abortMessage ?? "Pi CLI 调用已中断");
      reject(new DOMException(input.abortMessage ?? "Pi CLI 调用已中断", "AbortError"));
    };

    if (input.abortSignal?.aborted) {
      abort();
      return;
    }
    input.abortSignal?.addEventListener("abort", abort, { once: true });

    const consumeLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;
      output += `${rawLine}\n`;
      try {
        const parsed = JSON.parse(line) as PiJsonLine;
        trace?.appendParsedEvent(parsed);
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (type === "message_update") {
          const delta = extractTextDelta(parsed);
          if (delta) lastAssistantText += delta;
        }
        if (type === "message_end") {
          const text = extractAssistantTextFromLine(parsed);
          if (text.trim()) lastAssistantText = text.trim();
        }
        if (type === "agent_end") {
          const text = extractAgentEndText(parsed);
          if (text) lastAssistantText = text;
        }
      } catch {
        // Keep raw stdout in output; Pi may emit incidental non-JSON lines.
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
      if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        trace?.finish("failed", stderr.trim() || input.failureMessage || "Pi CLI 调用失败");
        reject(new Error(stderr.trim() || input.failureMessage || "Pi CLI 调用失败"));
        return;
      }
      const raw = lastAssistantText.trim() || output.trim();
      if (raw) trace?.writeOutput(raw);
      trace?.finish("completed");
      resolve({ raw, exitCode, stderr: stderr.trim(), elapsedMs: Date.now() - startedAt });
    });
  });
}

export const piAdapter: RuntimeAdapter = {
  kind: "pi",
  meta: {
    label: "Pi CLI",
    command: "pi",
    packageName: PI_PACKAGE_NAME,
    versionArgs: ["--version"],
    installHint: "安装 @earendil-works/pi-coding-agent 后确保 `pi` 命令在 PATH 中可用。",
    uiAccent: "bg-[#FFF1F2] text-[#BE123C]",
    uiIcon: "Atom",
  },
  capabilities: {
    sessionResume: true,
    permissionModes: false,
    toolSelection: "both",
    fileArtifacts: true,
  },
  async streamPrompt(options: RuntimeStreamOptions) {
    if (shouldProxyCliToMachine()) {
      const { proxyStreamPrompt } = await import("@/lib/server/tunnel/remoteCliProxy");
      return proxyStreamPrompt({ ...options, runtimeKind: "pi" });
    }

    const cwd = normalizeWorkingDirectory(options.workingDirectory);
    const resolvedToolPolicy = resolveRuntimeToolPolicy({
      filePolicy: options.filePolicy,
      permissionMode: options.permissionMode,
      channelPolicy: options.channelPolicy ?? { mode: options.workspacePolicy === "task" ? "task" : "conversation" },
    });
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

    const cliPath = await resolveCliPath(options.cliPath, { packageName: PI_PACKAGE_NAME });
    options.onEvent({ type: "status", status: "checking" });
    const args = buildPiArgs({
      systemPrompt,
      sessionId: options.resumeSessionId,
      enabledCapabilities: resolvedToolPolicy.enabledCapabilities,
    });
    const trace = createClaudeTrace({
      cwd,
      cliPath,
      args,
      permissionMode: options.permissionMode,
      toolPolicy: resolvedToolPolicy,
      resumeSessionId: options.resumeSessionId,
      scope: "conversation_chat",
      stepLabel: "Pi 会话流式回复",
    });
    trace?.writePrompt(promptInput);
    options.onEvent({ type: "prompt", sections: promptSections });

    await new Promise<void>((resolve, reject) => {
      const child = spawn(cliPath, args, {
        cwd,
        env: buildPiEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });

      if (typeof child.pid === "number") options.onSpawn?.(child.pid);
      child.stdin.write(promptInput);
      child.stdin.end();

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let aggregatedAssistantText = "";
      let callbackError: unknown = null;
      let emittedFatalError = false;
      let settled = false;
      let terminalResultReceived = false;
      const toolCalls = new Map<string, PiToolState>();
      const pendingFilePaths = new Set<string>();

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

      const abort = () => {
        if (terminalResultReceived) return;
        emittedFatalError = true;
        killChildTree(child);
        trace?.finish("aborted", "Pi CLI 流式调用已中断");
        if (emitEvent({ type: "done" })) resolveOnce();
      };

      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });

      const finishSuccess = (content: string) => {
        if (
          !emitRuntimeFileEvents({
            cwd,
            filePaths: pendingFilePaths,
            emitEvent,
            appendDiagnostic: (message) => trace?.appendStderr(message),
          })
        ) return;
        if (!emitEvent({ type: "message", content: content.trim() || aggregatedAssistantText.trim() })) return;
        trace?.writeOutput(content.trim() || aggregatedAssistantText.trim());
        emitEvent({ type: "status", status: "completed" });
      };

      const consumeLine = (rawLine: string) => {
        if (callbackError) return;
        const line = rawLine.trim();
        if (!line) return;
        try {
          const parsed = JSON.parse(line) as PiJsonLine;
          trace?.appendParsedEvent(parsed);
          const type = typeof parsed.type === "string" ? parsed.type : "";

          if (type === "session" && typeof parsed.id === "string") {
            emitEvent({ type: "session", sessionId: parsed.id });
            return;
          }
          if (type === "agent_start" || type === "turn_start") {
            emitEvent({ type: "status", status: "running" });
            return;
          }
          if (type === "message_update") {
            const delta = extractTextDelta(parsed);
            if (!delta) return;
            aggregatedAssistantText += delta;
            trace?.appendThinking(isThinkingDelta(parsed) ? `${delta}\n` : "");
            emitEvent(isThinkingDelta(parsed) ? { type: "thinking", text: delta } : { type: "delta", text: delta });
            return;
          }
          if (type === "message_end") {
            const text = extractAssistantTextFromLine(parsed);
            if (text.trim()) aggregatedAssistantText = text.trim();
            return;
          }
          if (type === "tool_execution_start") {
            const toolCallId = readStringField(parsed, ["toolCallId", "tool_call_id", "id"]) ?? `tool-${toolCalls.size}`;
            const toolName = readStringField(parsed, ["toolName", "tool_name", "name"]) ?? "tool";
            toolCalls.set(toolCallId, { toolName, args: parsed.args });
            return;
          }
          if (type === "tool_execution_end") {
            const toolCallId = readStringField(parsed, ["toolCallId", "tool_call_id", "id"]) ?? "";
            const state = toolCalls.get(toolCallId);
            const toolName = readStringField(parsed, ["toolName", "tool_name", "name"]) ?? state?.toolName ?? "tool";
            const argsInput = parsed.args ?? state?.args;
            const summary = summarizeToolCall(toolName, argsInput);
            emitEvent({ type: "tool_call", toolName, summary, input: argsInput });
            if (parsed.isError !== true) {
              const filePath = collectWritableFilePath(toolName, argsInput);
              if (filePath) pendingFilePaths.add(filePath);
            }
            return;
          }
          if (type === "agent_end") {
            terminalResultReceived = true;
            finishSuccess(extractAgentEndText(parsed));
          }
        } catch (error) {
          trace?.appendStderr(`Pi JSON 行解析失败：${error instanceof Error ? error.message : String(error)}\n`);
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
        options.signal?.removeEventListener("abort", abort);
        emittedFatalError = true;
        trace?.finish("failed", error.message);
        rejectOnce(error);
      });

      child.on("close", (code) => {
        options.signal?.removeEventListener("abort", abort);
        if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
        if (callbackError) return;
        const exitCode = code ?? 0;
        if (exitCode !== 0) {
          emittedFatalError = true;
          const message = stderrBuffer.trim() || "Pi CLI 流式调用失败";
          if (options.resumeSessionId && /session|not found|invalid/i.test(message)) {
            emitEvent({ type: "session_invalid", sessionId: options.resumeSessionId, message });
          } else {
            emitEvent({ type: "error", message });
          }
          trace?.finish("failed", message);
        } else if (!terminalResultReceived && !emittedFatalError) {
          finishSuccess(aggregatedAssistantText);
          trace?.finish("completed");
        } else if (!emittedFatalError) {
          trace?.finish("completed");
        }
        emitEvent({ type: "done" });
        resolveOnce();
      });
    });
  },
  runPromptJson: (input) => runPiPrompt(input, "json"),
  runPromptText: (input) => runPiPrompt(input, "text"),
  async healthCheck(input) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const result = await runPiPrompt(
        {
          prompt: "请只回复 ok",
          runtimeEnv: {
            id: "health-check",
            type: "local",
            runtimeKind: "pi",
            name: "Pi CLI",
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
          abortMessage: "Pi CLI 可用性检测超时",
          failureMessage: "Pi CLI 可用性检测失败",
        },
        "json",
      );
      return { authenticated: Boolean(result.raw.trim()), result: result.raw.trim() };
    } finally {
      clearTimeout(timeout);
    }
  },
};
