import { stat } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

import type {
  LocalRuntimeKind,
  RuntimeEnvironmentCheckInput,
  RuntimeEnvironmentCheckResult,
  RuntimeDiscoveryItem,
} from "@/types/runtime";

import { getRuntimeAdapter, listRuntimeAdapters } from "@/lib/server/runtime/adapters/registry";
import { expandHomeDir, normalizeWorkingDirectory, resolveCliPath } from "@/lib/server/runtimePath";

const execFileAsync = promisify(execFile);

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function getRuntimeVersion(runtimeKind: LocalRuntimeKind, cliPath: string) {
  const adapter = getRuntimeAdapter(runtimeKind);
  const { stdout, stderr } = await execFileAsync(cliPath, adapter.meta.versionArgs, {
    timeout: 10000,
    maxBuffer: 512 * 1024,
  });
  return (stdout || stderr).trim();
}

export async function discoverLocalRuntimes() {
  const items: RuntimeDiscoveryItem[] = await Promise.all(
    listRuntimeAdapters().map(async (adapter) => {
      const { kind: runtimeKind, meta } = adapter;
      try {
        const cliPath = await resolveCliPath(meta.command, { packageName: meta.packageName });
        const version = await getRuntimeVersion(runtimeKind, cliPath);
        return {
          runtimeKind,
          label: meta.label,
          command: meta.command,
          cliPath,
          installed: true,
          version,
          installHint: meta.installHint,
          uiAccent: meta.uiAccent,
          uiIcon: meta.uiIcon,
        };
      } catch {
        return {
          runtimeKind,
          label: meta.label,
          command: meta.command,
          installed: false,
          installHint: meta.installHint,
          uiAccent: meta.uiAccent,
          uiIcon: meta.uiIcon,
        };
      }
    }),
  );

  return { items };
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
      reason: "工作目录不存在，无法连接本地 Runtime",
    };
  }

  try {
    const runtimeKind = input.runtimeKind || "claude";
    const adapter = getRuntimeAdapter(runtimeKind);
    const resolvedCliPath = await resolveCliPath(input.cliPath, { packageName: adapter.meta.packageName });
    const version = await getRuntimeVersion(runtimeKind, resolvedCliPath);
    const health = await adapter.healthCheck({
      cliPath: resolvedCliPath,
      workingDirectory,
      filePolicy: input.filePolicy,
    });

    if (!health.authenticated) {
      return {
        ok: false,
        runtimeKind: input.runtimeKind,
        cliPath: resolvedCliPath,
        workingDirectoryExists: true,
        authenticated: false,
        version,
        reason: `${adapter.meta.label} 可执行，但当前未通过可用性检测`,
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

export { normalizeWorkingDirectory, resolveCliPath };
