import { spawn } from "child_process";

import type { RuntimePermissionMode } from "@/types/runtime";

import { buildClaudeEnv } from "./claudeEnv";
import { normalizeWorkingDirectory, resolveCliPath } from "./runtimeEnvValidation";

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

type ClaudeStreamOptions = {
  message: string;
  workingDirectory: string;
  cliPath: string;
  permissionMode: RuntimePermissionMode;
  claudeSessionId?: string;
  quotedMessage?: {
    roleLabel: string;
    content: string;
  } | null;
  signal?: AbortSignal;
  onEvent: (event:
    | { type: "session"; sessionId: string }
    | { type: "status"; status: "checking" | "running" | "completed" }
    | { type: "delta"; text: string }
    | { type: "message"; content: string }
    | { type: "tool_call"; toolName: string; summary: string }
    | { type: "permission_request"; reason: string }
    | { type: "error"; message: string }
    | { type: "done" }) => void;
};

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

function looksHighRisk(message: string) {
  return /(修改|编辑|删除|运行|执行|重构|创建文件|安装|修复|改代码|写代码|write|edit|delete|rm |npm |pnpm |yarn |git )/i.test(
    message,
  );
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
  if (rawInput !== undefined) return rawInput;
  if (!partialJson.trim()) return undefined;
  try {
    return JSON.parse(partialJson) as unknown;
  } catch {
    return undefined;
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

export async function streamClaudeCli(options: ClaudeStreamOptions) {
  const cwd = normalizeWorkingDirectory(options.workingDirectory);
  const cliPath = await resolveCliPath(options.cliPath);

  if (options.permissionMode === "confirm" && looksHighRisk(options.message)) {
    options.onEvent({
      type: "permission_request",
      reason: "这条消息可能触发文件修改或命令执行。当前为手动确认模式，请先切换到“项目内可执行”，或改为只读问题后再发送。",
    });
    options.onEvent({ type: "done" });
    return;
  }

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
    args.push("--allowedTools", ...allowedTools);
  }
  args.push(buildPrompt(options.message, options.quotedMessage));

  await new Promise<void>((resolve) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: buildClaudeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let finalMessage = "";
    let emittedFatalError = false;
    let aborted = false;
    let terminalResultReceived = false;
    const toolUseBlocks = new Map<number, ToolUseBlockState>();

    const abort = () => {
      if (terminalResultReceived) return;
      aborted = true;
      emittedFatalError = true;
      child.kill("SIGTERM");
      options.onEvent({ type: "done" });
      resolve();
    };

    if (options.signal?.aborted) {
      abort();
      return;
    }

    options.signal?.addEventListener("abort", abort, { once: true });

    const consumeLine = (line: string) => {
      if (!line.trim()) return;

      try {
        const payload = JSON.parse(line) as ClaudeCliPayload;
        const nextSessionId = payload.session_id;
        if (nextSessionId) {
          options.onEvent({ type: "session", sessionId: nextSessionId });
        }

        if (payload.type === "system" && payload.subtype === "status") {
          const status = payload.status === "requesting" ? "running" : "checking";
          options.onEvent({ type: "status", status });
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
              options.onEvent({ type: "delta", text });
            }
            return;
          }
          if (eventType === "content_block_stop" && eventIndex >= 0) {
            const currentTool = toolUseBlocks.get(eventIndex);
            if (currentTool) {
              const parsedInput = parseToolInput(currentTool.rawInput, currentTool.partialJson);
              options.onEvent({
                type: "tool_call",
                toolName: currentTool.name,
                summary: summarizeToolCall(currentTool.name, parsedInput),
              });
              toolUseBlocks.delete(eventIndex);
            }
          }
          return;
        }

        if (payload.type === "assistant") {
          const content =
            payload.message?.content
              ?.map((item: { text?: string }) => item.text || "")
              .join("") || "";
          finalMessage = content;
          return;
        }

        if (payload.type === "result") {
          terminalResultReceived = true;
          if (payload.subtype === "success") {
            finalMessage = payload.result || finalMessage;
            options.onEvent({ type: "message", content: finalMessage });
            options.onEvent({ type: "status", status: "completed" });
          } else {
            emittedFatalError = true;
            options.onEvent({
              type: "error",
              message:
                payload.result ||
                payload.errors?.join("\n") ||
                payload.api_error_status ||
                "Claude 返回了错误结果",
            });
          }
        }
      } catch {
        // Ignore non-JSON lines; Claude stream-json may emit incidental text in some environments.
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
      options.onEvent({
        type: "error",
        message: error.message || "Claude CLI 启动失败",
      });
      options.onEvent({ type: "done" });
      resolve();
    });

    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (aborted) return;
      if (stdoutBuffer.trim()) {
        consumeLine(stdoutBuffer.trim());
      }

      if (code !== 0 && !emittedFatalError) {
        options.onEvent({
          type: "error",
          message: stderrBuffer.trim() || "Claude CLI 异常退出",
        });
      }

      options.onEvent({ type: "done" });
      resolve();
    });
  });
}
