import os from "os";

import { pickDirectoryWithOsascript } from "@/lib/server/runtime/selectWorkingDirectory";
import { discoverLocalRuntimes, validateRuntimeEnvironment } from "@/lib/server/runtimeEnvValidation";
import { isServerLocalCliDisabled } from "@/lib/server/runtime/cloudExecutionPolicy";
import { getKikiDefaultSkillsStatus, installKikiDefaultSkills } from "@/lib/server/kikiSkills/installService";
import type { RuntimeDiscoveryResult, RuntimeEnvironmentCheckInput, RuntimeEnvironmentCheckResult } from "@/types/runtime";

import { getTunnelHub } from "./tunnelHub";

export function pickOnlineMachineIdForUser(userId: string): string | null {
  const hub = getTunnelHub();
  const connected = hub.getOnlineMachineIdsForUser(userId);
  if (connected.length > 0) {
    return connected[0];
  }
  return null;
}

export async function discoverRuntimesForUser(userId: string): Promise<RuntimeDiscoveryResult & { source: "remote" | "local" }> {
  if (isServerLocalCliDisabled()) {
    const machineId = pickOnlineMachineIdForUser(userId);
    if (!machineId) {
      throw new Error("请先连接本机电脑并保持在线，再扫描 Runtime");
    }
    const result = await getTunnelHub().requestDiscoverRuntimes({ machineId });
    return { ...result, source: "remote" };
  }

  const result = await discoverLocalRuntimes();
  return {
    ...result,
    workingDirectory: process.cwd(),
    source: "local",
  };
}

export async function validateRuntimeEnvironmentForUser(
  userId: string,
  input: RuntimeEnvironmentCheckInput,
): Promise<RuntimeEnvironmentCheckResult> {
  if (isServerLocalCliDisabled()) {
    const machineId = pickOnlineMachineIdForUser(userId);
    if (!machineId) {
      return {
        ok: false,
        runtimeKind: input.runtimeKind,
        cliPath: input.cliPath,
        workingDirectoryExists: false,
        authenticated: false,
        reason: "本机电脑未在线，无法检测 Runtime",
      };
    }
    return getTunnelHub().requestCheckRuntime({ machineId, payload: input });
  }
  return validateRuntimeEnvironment(input);
}

export function defaultRemoteWorkingDirectory() {
  return os.homedir();
}

export async function selectWorkingDirectoryForUser(userId: string): Promise<string | null> {
  if (isServerLocalCliDisabled()) {
    const machineId = pickOnlineMachineIdForUser(userId);
    if (!machineId) {
      throw new Error("请先连接本机电脑并保持在线，再选择工作目录");
    }
    const result = await getTunnelHub().requestSelectDirectory({ machineId });
    if ("canceled" in result) return null;
    return result.path;
  }

  const result = await pickDirectoryWithOsascript();
  if ("canceled" in result) return null;
  return result.path;
}

export async function getKikiSkillsStatusForUser(userId: string) {
  if (isServerLocalCliDisabled()) {
    const machineId = pickOnlineMachineIdForUser(userId);
    if (!machineId) {
      throw new Error("请先连接本机电脑并保持在线，再查看 KiKi 默认 skills 状态");
    }
    return getTunnelHub().requestKikiSkillsStatus({ machineId });
  }

  return getKikiDefaultSkillsStatus();
}

export async function installKikiSkillsForUser(userId: string) {
  if (isServerLocalCliDisabled()) {
    const machineId = pickOnlineMachineIdForUser(userId);
    if (!machineId) {
      throw new Error("请先连接本机电脑并保持在线，再安装 KiKi 默认 skills");
    }
    return getTunnelHub().requestInstallKikiSkills({ machineId });
  }

  return installKikiDefaultSkills();
}
