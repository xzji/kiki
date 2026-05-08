import type {
  RuntimeEnvironmentCheckInput,
  RuntimeEnvironmentCheckResult,
  RuntimeDiscoveryResult,
} from "@/types/runtime";

export async function checkRuntimeEnv(
  input: RuntimeEnvironmentCheckInput,
): Promise<RuntimeEnvironmentCheckResult> {
  const response = await fetch("/api/runtime-envs/check", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  const data = (await response.json()) as RuntimeEnvironmentCheckResult;
  if (!response.ok) {
    throw new Error(data.reason || "本地环境检测失败");
  }
  return data;
}

export async function getRuntimeEnvStatus(input: {
  workingDirectory: string;
  cliPath: string;
  runtimeKind?: string;
}): Promise<RuntimeEnvironmentCheckResult> {
  const query = new URLSearchParams({
    workingDirectory: input.workingDirectory,
    cliPath: input.cliPath,
    runtimeKind: input.runtimeKind || "claude",
  });

  const response = await fetch(`/api/runtime-envs/status?${query.toString()}`);
  const data = (await response.json()) as RuntimeEnvironmentCheckResult;
  if (!response.ok) {
    throw new Error(data.reason || "本地环境状态获取失败");
  }
  return data;
}

export async function discoverRuntimeEnvs(): Promise<RuntimeDiscoveryResult> {
  const response = await fetch("/api/runtime-envs/discover");
  const data = (await response.json()) as RuntimeDiscoveryResult;
  if (!response.ok) {
    throw new Error("本地 Runtime 扫描失败");
  }
  return data;
}

export async function selectRuntimeWorkingDirectory(): Promise<string | null> {
  const response = await fetch("/api/runtime-envs/select-directory", {
    method: "POST",
  });
  const data = (await response.json()) as {
    path?: string;
    canceled?: boolean;
    reason?: string;
  };

  if (data.canceled) return null;
  if (!response.ok || !data.path) {
    throw new Error(data.reason || "目录选择失败");
  }
  return data.path;
}
