import type {
  RuntimeEnvironmentCheckInput,
  RuntimeEnvironmentCheckResult,
  RuntimeDiscoveryResult,
} from "@/types/runtime";

const RUNTIME_ENV_STATUS_TIMEOUT_MS = 45_000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("本地环境状态获取超时，请确认本机 daemon 在线且 CLI 可用");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

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

  const response = await fetchWithTimeout(
    `/api/runtime-envs/status?${query.toString()}`,
    {},
    RUNTIME_ENV_STATUS_TIMEOUT_MS,
  );
  const data = (await response.json()) as RuntimeEnvironmentCheckResult;
  if (!response.ok) {
    throw new Error(data.reason || "本地环境状态获取失败");
  }
  return data;
}

export async function discoverRuntimeEnvs(): Promise<RuntimeDiscoveryResult & { source?: "remote" | "local" }> {
  const response = await fetch("/api/runtime-envs/discover");
  const data = (await response.json()) as RuntimeDiscoveryResult & { reason?: string; source?: "remote" | "local" };
  if (!response.ok) {
    throw new Error(data.reason || "本地 Runtime 扫描失败");
  }
  return data;
}

export type SelectDirectoryResult =
  | { kind: "path"; path: string }
  | { kind: "canceled" }
  | { kind: "manual"; reason: string };

export async function selectRuntimeWorkingDirectory(): Promise<SelectDirectoryResult> {
  const response = await fetch("/api/runtime-envs/select-directory", {
    method: "POST",
  });
  const data = (await response.json()) as {
    path?: string;
    canceled?: boolean;
    useManualInput?: boolean;
    reason?: string;
  };

  if (data.canceled) return { kind: "canceled" };
  if (data.useManualInput) {
    return { kind: "manual", reason: data.reason || "请手动输入本机工作目录路径" };
  }
  if (!response.ok || !data.path) {
    throw new Error(data.reason || "目录选择失败");
  }
  return { kind: "path", path: data.path };
}
