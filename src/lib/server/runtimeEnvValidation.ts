import { access, stat } from "fs/promises";
import { constants } from "fs";
import { execFile, spawn } from "child_process";
import { promisify } from "util";

import type {
  LocalRuntimeKind,
  RuntimeEnvironmentCheckInput,
  RuntimeEnvironmentCheckResult,
  RuntimeDiscoveryItem,
} from "@/types/runtime";

import { buildClaudeEnv } from "./claudeEnv";

const execFileAsync = promisify(execFile);

const runtimeDefinitions: Record<LocalRuntimeKind, {
  label: string;
  command: string;
  versionArgs: string[];
  installHint: string;
}> = {
  claude: {
    label: "Claude CLI",
    command: "claude",
    versionArgs: ["--version"],
    installHint: "安装 Claude Code 后确保 `claude` 命令在 PATH 中可用。",
  },
  codex: {
    label: "Codex CLI",
    command: "codex",
    versionArgs: ["--version"],
    installHint: "安装 Codex CLI 后确保 `codex` 命令在 PATH 中可用。",
  },
  gemini: {
    label: "Gemini CLI",
    command: "gemini",
    versionArgs: ["--version"],
    installHint: "安装 Gemini CLI 后确保 `gemini` 命令在 PATH 中可用。",
  },
};

function expandHomeDir(input: string) {
  if (!input.startsWith("~/")) return input;
  return `${process.env.HOME || ""}/${input.slice(2)}`;
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCliPath(cliPath: string) {
  const normalized = expandHomeDir(cliPath || "claude");

  if (normalized.includes("/")) {
    await access(normalized, constants.X_OK);
    return normalized;
  }

  const { stdout } = await execFileAsync("which", [normalized]);
  return stdout.trim();
}

async function getRuntimeVersion(runtimeKind: LocalRuntimeKind, cliPath: string) {
  const definition = runtimeDefinitions[runtimeKind];
  const { stdout, stderr } = await execFileAsync(cliPath, definition.versionArgs, {
    timeout: 10000,
    maxBuffer: 512 * 1024,
  });
  return (stdout || stderr).trim();
}

export async function discoverLocalRuntimes() {
  const items: RuntimeDiscoveryItem[] = await Promise.all(
    (Object.keys(runtimeDefinitions) as LocalRuntimeKind[]).map(async (runtimeKind) => {
      const definition = runtimeDefinitions[runtimeKind];
      try {
        const cliPath = await resolveCliPath(definition.command);
        const version = await getRuntimeVersion(runtimeKind, cliPath);
        return {
          runtimeKind,
          label: definition.label,
          command: definition.command,
          cliPath,
          installed: true,
          version,
          installHint: definition.installHint,
        };
      } catch {
        return {
          runtimeKind,
          label: definition.label,
          command: definition.command,
          installed: false,
          installHint: definition.installHint,
        };
      }
    }),
  );

  return { items };
}

async function runHealthCheck(cliPath: string, workingDirectory: string) {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(cliPath, ["-p", "--output-format", "json", "请只回复 ok"], {
      cwd: workingDirectory,
      env: buildClaudeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude CLI 可用性检测超时"));
    }, 30000);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(errorOutput.trim() || "Claude CLI 可用性检测失败"));
        return;
      }
      resolve(output);
    });
  });

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines[lines.length - 1];
  const parsed = JSON.parse(lastLine) as { result?: string; subtype?: string; is_error?: boolean };

  return {
    authenticated: parsed.subtype === "success" && !parsed.is_error,
    result: parsed.result?.trim() || "",
  };
}

export async function validateRuntimeEnvironment(
  input: RuntimeEnvironmentCheckInput,
): Promise<RuntimeEnvironmentCheckResult> {
  const workingDirectory = expandHomeDir(input.workingDirectory);
  const workingDirectoryExists = await pathExists(workingDirectory);

  if (!workingDirectoryExists) {
    return {
      ok: false,
      runtimeKind: input.runtimeKind,
      cliPath: input.cliPath,
      workingDirectoryExists: false,
      authenticated: false,
      reason: "工作目录不存在，无法连接本地 Claude CLI",
    };
  }

  try {
    const runtimeKind = input.runtimeKind || "claude";
    const resolvedCliPath = await resolveCliPath(input.cliPath);
    const version = await getRuntimeVersion(runtimeKind, resolvedCliPath);
    const health =
      runtimeKind === "claude"
        ? await runHealthCheck(resolvedCliPath, workingDirectory)
        : { authenticated: true, result: version };

    if (!health.authenticated) {
      return {
        ok: false,
        runtimeKind: input.runtimeKind,
        cliPath: resolvedCliPath,
        workingDirectoryExists: true,
        authenticated: false,
        version,
        reason: "Claude CLI 可执行，但当前未通过可用性检测",
      };
    }

    return {
      ok: true,
      runtimeKind: input.runtimeKind,
      cliPath: resolvedCliPath,
      workingDirectoryExists: true,
      authenticated: true,
      version,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知错误";
    return {
      ok: false,
      runtimeKind: input.runtimeKind,
      cliPath: input.cliPath,
      workingDirectoryExists: true,
      authenticated: false,
      reason,
    };
  }
}

export function normalizeWorkingDirectory(path: string) {
  return expandHomeDir(path);
}
