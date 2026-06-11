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
  /** worker 进程实际打开的数据库绝对路径，用于跨进程同库自检。 */
  dbPath?: string | null;
  /** worker 进程实际打开的数据库文件 inode，用于检测 inode 漂移。 */
  dbInode?: number | null;
  updatedAt: string;
};

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function getRuntimeDaemonLogFilePath() {
  return path.join(getRuntimeLogsDir(), "daemon.log");
}

/**
 * 生成本机本地时区的日志时间戳，形如 `2026-06-11 21:43:56 +08:00`。
 * 相比 UTC 的 toISOString()，便于用户直接对照本地时间排障。
 */
function formatLocalLogTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  // getTimezoneOffset 返回的是「本地比 UTC 慢多少分钟」，东八区为 -480。
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${offset}`;
}

export function appendRuntimeDaemonLog(message: string) {
  const logFile = getRuntimeDaemonLogFilePath();
  ensureParentDir(logFile);
  fs.appendFileSync(logFile, `[${formatLocalLogTimestamp()}] ${message}\n`, "utf8");
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
