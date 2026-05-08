import { spawn } from "child_process";
import { randomUUID } from "crypto";

import type { RuntimePermissionMode } from "@/types/runtime";

import { normalizeWorkingDirectory, resolveCliPath } from "./runtimeEnvValidation";

type ClaudeCliPayload = {
  type?: string;
  subtype?: string;
  status?: string;
  session_id?: string;
  result?: string;
  api_error_status?: string;
  event?: {
    type?: string;
    delta?: {
      text?: string;
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
  onEvent: (event:
    | { type: "session"; sessionId: string }
    | { type: "status"; status: "checking" | "running" | "completed" }
    | { type: "delta"; text: string }
    | { type: "message"; content: string }
    | { type: "permission_request"; reason: string }
    | { type: "error"; message: string }
    | { type: "done" }) => void;
};

function mapPermissionMode(permissionMode: RuntimePermissionMode) {
  switch (permissionMode) {
    case "execute":
      return "acceptEdits";
    default:
      return "default";
  }
}

function buildPrompt(message: string, quotedMessage?: ClaudeStreamOptions["quotedMessage"]) {
  if (!quotedMessage) return message;
  return [
    `以下是当前用户引用的上下文，请优先参考：`,
    `[${quotedMessage.roleLabel}] ${quotedMessage.content}`,
    "",
    `当前用户消息：`,
    message,
  ].join("\n");
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

  const sessionId = options.claudeSessionId || randomUUID();
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    mapPermissionMode(options.permissionMode),
    "--session-id",
    sessionId,
  ];
  const allowedTools = buildAllowedTools(options.permissionMode);
  if (allowedTools.length > 0) {
    args.push("--allowedTools", ...allowedTools);
  }
  args.push(buildPrompt(options.message, options.quotedMessage));

  options.onEvent({ type: "session", sessionId });
  options.onEvent({ type: "status", status: "checking" });

  await new Promise<void>((resolve) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let finalMessage = "";
    let emittedFatalError = false;

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
          if (eventType === "content_block_delta") {
            const text = payload.event?.delta?.text;
            if (typeof text === "string" && text.length > 0) {
              options.onEvent({ type: "delta", text });
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
          if (payload.subtype === "success") {
            finalMessage = payload.result || finalMessage;
            options.onEvent({ type: "message", content: finalMessage });
            options.onEvent({ type: "status", status: "completed" });
          } else {
            emittedFatalError = true;
            options.onEvent({
              type: "error",
              message: payload.result || payload.api_error_status || "Claude 返回了错误结果",
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
