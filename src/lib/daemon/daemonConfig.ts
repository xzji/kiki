import fs from "fs";
import path from "path";

import { getRuntimeConfigFilePath } from "@/lib/server/storage/paths";
import {
  DEFAULT_RUNTIME_FILE_POLICY,
  type RuntimeFilePolicy,
  type RuntimePermissionMode,
} from "@/types/runtime";
import { normalizeRuntimeFilePolicy } from "@/lib/runtime/toolPolicy";

export type RuntimeDaemonConfig = {
  deviceId: string;
  name: string;
  cliPath: string;
  workingDirectory: string;
  permissionMode: RuntimePermissionMode;
  filePolicy: RuntimeFilePolicy;
  autoStart: boolean;
  authorizedDirectories: string[];
  schedulerIntervalMs: number;
  heartbeatIntervalMs: number;
  /** 同一时刻最多并行执行的 goal task 数量上限，超出的任务在队列中等待空位。 */
  maxConcurrentTasks: number;
  /** 单个 goal task 执行的总时长上限（毫秒），超时即 abort 并标记 failed。 */
  jobMaxDurationMs: number;
  /** 单个 goal task 执行的空闲超时（毫秒），期间无任何进展事件即判定卡死并 abort。 */
  jobIdleTimeoutMs: number;
  /** 为 true 时暂停调度与派发，并阻止新建任务进入执行队列。 */
  dispatchPaused: boolean;
  updatedAt: string;
};

const DEFAULT_CONFIG: RuntimeDaemonConfig = {
  deviceId: `device-${Math.random().toString(36).slice(2, 10)}`,
  name: "KiKi Local Runtime",
  cliPath: "claude",
  workingDirectory: process.cwd(),
  permissionMode: "execute",
  filePolicy: DEFAULT_RUNTIME_FILE_POLICY,
  autoStart: false,
  authorizedDirectories: [process.cwd()],
  schedulerIntervalMs: 60_000,
  heartbeatIntervalMs: 15_000,
  maxConcurrentTasks: 3,
  jobMaxDurationMs: 30 * 60_000,
  jobIdleTimeoutMs: 5 * 60_000,
  dispatchPaused: false,
  updatedAt: new Date().toISOString(),
};

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** 与 EASTER_EGG_SETTING_META.maxConcurrentTasks 的 1~10 边界保持一致。 */
function clampMaxConcurrentTasks(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CONFIG.maxConcurrentTasks;
  }
  return Math.min(Math.max(Math.round(value), 1), 10);
}

export function getDefaultRuntimeDaemonConfig() {
  return { ...DEFAULT_CONFIG };
}

export function readRuntimeDaemonConfig() {
  const filePath = getRuntimeConfigFilePath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeDaemonConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      filePolicy: normalizeRuntimeFilePolicy(parsed.filePolicy),
      maxConcurrentTasks: clampMaxConcurrentTasks(parsed.maxConcurrentTasks),
      dispatchPaused: parsed.dispatchPaused === true,
      authorizedDirectories:
        parsed.authorizedDirectories?.filter((item): item is string => Boolean(item?.trim())) ??
        DEFAULT_CONFIG.authorizedDirectories,
    } satisfies RuntimeDaemonConfig;
  } catch {
    return getDefaultRuntimeDaemonConfig();
  }
}

export function writeRuntimeDaemonConfig(config: RuntimeDaemonConfig) {
  const filePath = getRuntimeConfigFilePath();
  ensureParentDir(filePath);
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        ...config,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}
