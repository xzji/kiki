import fs from "fs";
import path from "path";

import {
  getRuntimeDeviceFilePath,
  getRuntimeLogsDir,
  getRuntimeStateFilePath,
} from "@/lib/server/storage/paths";

export type RuntimeDaemonDeviceState = {
  deviceId: string;
  installedAt: string;
  daemonVersion: string;
};

export type RuntimeDaemonState = {
  deviceId: string;
  status: "idle" | "running" | "error";
  lastHeartbeatAt?: string;
  lastJobId?: string;
  lastJobFinishedAt?: string;
  lastError?: string;
  updatedAt: string;
};

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function getRuntimeDaemonLogFilePath() {
  return path.join(getRuntimeLogsDir(), "daemon.log");
}

export function appendRuntimeDaemonLog(message: string) {
  const logFile = getRuntimeDaemonLogFilePath();
  ensureParentDir(logFile);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

export function readRuntimeDaemonDeviceState(): RuntimeDaemonDeviceState | null {
  try {
    const raw = fs.readFileSync(getRuntimeDeviceFilePath(), "utf8");
    return JSON.parse(raw) as RuntimeDaemonDeviceState;
  } catch {
    return null;
  }
}

export function writeRuntimeDaemonDeviceState(state: RuntimeDaemonDeviceState) {
  const filePath = getRuntimeDeviceFilePath();
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

export function readRuntimeDaemonState(): RuntimeDaemonState | null {
  try {
    const raw = fs.readFileSync(getRuntimeStateFilePath(), "utf8");
    return JSON.parse(raw) as RuntimeDaemonState;
  } catch {
    return null;
  }
}

export function writeRuntimeDaemonState(state: RuntimeDaemonState) {
  const filePath = getRuntimeStateFilePath();
  ensureParentDir(filePath);
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        ...state,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}
