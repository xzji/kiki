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
  updatedAt: new Date().toISOString(),
};

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
