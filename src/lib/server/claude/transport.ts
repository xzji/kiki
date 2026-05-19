import { spawn } from "child_process";

import type { QuotedConversationMessageContext, RuntimeEnvironment, RuntimePermissionMode } from "@/types/runtime";

import { buildClaudeEnv } from "@/lib/server/claudeEnv";
import { normalizeWorkingDirectory, resolveCliPath } from "@/lib/server/runtimePath";

type ClaudeCliPayload = {
  type?: string;
  subtype?: string;
  status?: string;
  session_id?: string;
  result?: string;
  api_error_status?: string;
  errors?: string[];
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
      text?: string;
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
  signal?: AbortSignal;
  onEvent: (event: ClaudeStreamEvent) => void;
};

export type ClaudeStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "status"; status: "checking" | "running" | "completed" }
  | { type: "delta"; text: string }
  | { type: "message"; content: string }
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

export async function runPromptJson(input: {
  prompt: string;
  runtimeEnv: RuntimeEnvironment;
  abortSignal?: AbortSignal;
  cwd: string;
  permissionMode?: RuntimePermissionMode;
  abortMessage?: string;
  failureMessage?: string;
}): Promise<ClaudePromptJsonResult> {
  const cwd = normalizeWorkingDirectory(input.cwd);
  const cliPath = await resolveCliPath(input.runtimeEnv.cliPath);
  const startedAt = Date.now();
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    mapPermissionMode(input.permissionMode ?? input.runtimeEnv.permissionMode),
  ];

  return new Promise<ClaudePromptJsonResult>((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: buildClaudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.write(input.prompt);
    child.stdin.end();

    let output = "";
    let errorOutput = "";
    let aborted = false;

    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      reject(new DOMException(input.abortMessage ?? "Claude CLI 调用已中断", "AbortError"));
    };

    if (input.abortSignal?.aborted) {
      abort();
      return;
    }

    input.abortSignal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      input.abortSignal?.removeEventListener("abort", abort);
      reject(error);
    });

    child.on("close", (code) => {
      input.abortSignal?.removeEventListener("abort", abort);
      if (aborted) return;
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        reject(new Error(errorOutput.trim() || input.failureMessage || "Claude CLI JSON 调用失败"));
        return;
      }
      resolve({
        raw: output,
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

function buildPrompt(
  message: string,
  quotedMessage?: ClaudeStreamOptions["quotedMessage"],
) {
  const parts: string[] = [];
  if (quotedMessage) {
    parts.push(
      `以下是当前用户引用的上下文，请优先参考：`,
      `[${quotedMessage.roleLabel}] ${quotedMessage.content}`,
      "",
    );
  }
  parts.push(`当前用户消息：`, message);
  return parts.join("\n");
}

function buildWorkspaceBoundPrompt(input: {
  message: string;
  quotedMessage?: ClaudeStreamOptions["quotedMessage"];
  contextPack?: string;
  workspaceDir: string;
  workspacePolicy?: string;
}) {
  const parts: string[] = [
    "你是 KiKi 当前会话助手，不是代码仓库开发助手。",
    `当前工作目录是隔离 workspace：${input.workspaceDir}`,
    "你只能依据当前上下文包、用户消息和当前工作目录内的文件回答。",
    "不得读取父目录、项目源码目录、其他会话 workspace 或 IDE 上下文。",
    "如果用户要求继续/恢复，但当前上下文包没有可恢复状态，请说明当前会话没有找到可恢复任务。",
  ];
  if (input.workspacePolicy) {
    parts.push(`workspaceMode: ${input.workspacePolicy}`);
  }
  if (input.contextPack?.trim()) {
    parts.push("", "【当前会话上下文包】", input.contextPack.trim());
  }
  parts.push("", buildPrompt(input.message, input.quotedMessage));
  return parts.join("\n");
}

function buildAllowedTools(permissionMode: RuntimePermissionMode) {
  if (permissionMode !== "readonly") return [];
  return ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
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
  const allowedTools = buildAllowedTools(options.permissionMode);
  if (allowedTools.length > 0) {
    // Claude CLI 的 --allowedTools 在 Commander.js 中被定义为 variadic（<tools...>），
    // 会贪婪吞掉所有后续位置参数。即使我们用逗号分隔成单 token，后面的 prompt argv 仍然
    // 会被吃进 tools 列表，导致 CLI 报 "Input must be provided either through stdin or
    // as a prompt argument when using --print"。
    // 使用逗号分隔形式，并通过 stdin 传 prompt（见下方 spawn），双重规避。
    args.push("--allowedTools", allowedTools.join(","));
  }
  const promptInput = buildWorkspaceBoundPrompt({
    message: options.message,
    quotedMessage: options.quotedMessage,
    contextPack: options.contextPack,
    workspaceDir: cwd,
    workspacePolicy: options.workspacePolicy,
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: buildClaudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 通过 stdin 传入 prompt，彻底规避 --allowedTools 的 variadic 参数吞食问题。
    child.stdin.write(promptInput);
    child.stdin.end();

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let emittedFatalError = false;
    let aborted = false;
    let terminalResultReceived = false;
    let callbackError: unknown = null;
    let settled = false;
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
        child.kill("SIGTERM");
        rejectOnce(error);
        return false;
      }
    };

    const abort = () => {
      if (terminalResultReceived) return;
      aborted = true;
      emittedFatalError = true;
      child.kill("SIGTERM");
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

      const nextSessionId = payload.session_id;
      if (nextSessionId && !emitEvent({ type: "session", sessionId: nextSessionId })) return;

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
        return;
      }

      if (payload.type === "result") {
        terminalResultReceived = true;
        if (payload.subtype === "success") {
          if (typeof payload.result !== "string" || !payload.result.trim()) {
            emittedFatalError = true;
            emitEvent({
              type: "error",
              message: "Claude CLI 成功结束，但没有返回 result.result，无法提取最终任务结果。",
            });
            return;
          }
          if (!emitEvent({ type: "message", content: payload.result })) return;
          emitEvent({ type: "status", status: "completed" });
        } else {
          emittedFatalError = true;
          emitEvent({
            type: "error",
            message:
              payload.result ||
              payload.errors?.join("\n") ||
              payload.api_error_status ||
              "Claude 返回了错误结果",
          });
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let lineBreakIndex = stdoutBuffer.indexOf("\n");
      while (lineBreakIndex !== -1) {
        const line = stdoutBuffer.slice(0, lineBreakIndex);
        stdoutBuffer = stdoutBuffer.slice(lineBreakIndex + 1);
        consumeLine(line);
        lineBreakIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      emittedFatalError = true;
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
        if (!emitEvent({
          type: "error",
          message: stderrBuffer.trim() || "Claude CLI 异常退出",
        })) return;
      }

      if (emitEvent({ type: "done" })) {
        resolveOnce();
      }
    });
  });
}
