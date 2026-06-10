import { normalizeRuntimeFilePolicy } from "@/lib/runtime/toolPolicy";
import {
  runPromptJson,
  runPromptText,
  streamPrompt,
  type ClaudeCliPayload,
} from "@/lib/server/claude/transport";
import type { RuntimeAdapter } from "@/lib/server/runtime/adapters/types";

export const claudeAdapter: RuntimeAdapter = {
  kind: "claude",
  meta: {
    label: "Claude CLI",
    command: "claude",
    versionArgs: ["--version"],
    installHint: "安装 Claude Code 后确保 `claude` 命令在 PATH 中可用。",
    uiAccent: "bg-[#F3EEFF] text-[#5B3DBE]",
    uiIcon: "Sparkles",
  },
  capabilities: {
    sessionResume: true,
    permissionModes: true,
    toolSelection: "both",
    fileArtifacts: true,
  },
  streamPrompt,
  runPromptJson,
  runPromptText,
  async healthCheck(input) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let stdout = "";
    try {
      const result = await runPromptJson({
        prompt: "请只回复 ok",
        runtimeEnv: {
          id: "health-check",
          type: "local",
          runtimeKind: "claude",
          name: "Claude CLI",
          workingDirectory: input.workingDirectory,
          cliPath: input.cliPath,
          permissionMode: "readonly",
          filePolicy: normalizeRuntimeFilePolicy(input.filePolicy),
        },
        cwd: input.workingDirectory,
        filePolicy: normalizeRuntimeFilePolicy(input.filePolicy),
        channelPolicy: { mode: "readonly_json" },
        abortSignal: controller.signal,
        abortMessage: "Claude CLI 可用性检测超时",
        failureMessage: "Claude CLI 可用性检测失败",
      });
      stdout = result.raw;
    } finally {
      clearTimeout(timeout);
    }

    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) {
      throw new Error("Claude CLI 可用性检测失败：未返回有效 JSON 输出");
    }
    let parsed: { result?: string; subtype?: string; is_error?: boolean };
    try {
      parsed = JSON.parse(lastLine) as ClaudeCliPayload & { is_error?: boolean };
    } catch {
      throw new Error("Claude CLI 可用性检测失败：返回内容不是有效 JSON");
    }

    return {
      authenticated: parsed.subtype === "success" && !parsed.is_error,
      result: parsed.result?.trim() || "",
    };
  },
};
