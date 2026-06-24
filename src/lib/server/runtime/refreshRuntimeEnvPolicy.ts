import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { normalizeRuntimeFilePolicy } from "@/lib/runtime/toolPolicy";
import { readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import type { RuntimeEnvironment, RuntimeFilePolicy } from "@/types/runtime";

/**
 * 任务入队时会把 runtimeEnv 快照进 job.payload，但「始终允许并写入 Runtime 策略」是在阻塞后
 * 才写入 runtimeEnvironments 快照的。续跑/再分发时若仍用 payload 里的旧 runtimeEnv，
 * 新写入的 allowedToolRules 不会生效，daemon 会对同一工具反复弹窗。
 *
 * 这里在下发前用最新快照里的 filePolicy 覆盖 payload.runtimeEnv.filePolicy，
 * 使运行时授权规则即时生效。找不到对应环境（如已删除）时保持原值。
 */
export function refreshRuntimeEnvFilePolicy(runtimeEnv: RuntimeEnvironment): RuntimeEnvironment {
  const filePolicy = readLatestRuntimeFilePolicy(runtimeEnv.id, runtimeEnv.filePolicy);
  if (!filePolicy) return runtimeEnv;
  return {
    ...runtimeEnv,
    filePolicy,
  };
}

export function readLatestRuntimeFilePolicy(
  runtimeEnvId: string | undefined,
  fallback?: RuntimeFilePolicy | null,
): RuntimeFilePolicy | undefined {
  if (!runtimeEnvId) return fallback ? normalizeRuntimeFilePolicy(fallback) : undefined;
  const environments = readRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS);
  const latest = environments.find((environment) => environment.id === runtimeEnvId);
  return normalizeRuntimeFilePolicy(latest?.filePolicy ?? fallback);
}
