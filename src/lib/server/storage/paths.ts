import fs from "fs";
import os from "os";
import path from "path";

import { getCurrentUserId } from "@/lib/server/context/userContext";

const DATA_DIR_ENV = "KIKI_DATA_DIR";
const RUNTIME_HOME_DIR = path.join(os.homedir(), ".kiki", "runtime");

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getDataBaseDir() {
  const configured = process.env[DATA_DIR_ENV]?.trim();
  return ensureDir(configured ? path.resolve(configured) : path.resolve(process.cwd(), "data"));
}

/** 系统级路径（context-free）：registry、全局配置等 */
export function getSystemDataDir() {
  return ensureDir(path.join(getDataBaseDir(), "system"));
}

export function getRegistryDatabaseFilePath() {
  return path.join(getSystemDataDir(), "registry.db");
}

/** 用户级数据根目录（要求 ALS 用户上下文） */
export function getProjectRootDataDir() {
  const userId = getCurrentUserId();
  return ensureDir(path.join(getDataBaseDir(), "users", userId));
}

export function getDatabaseFilePath() {
  return path.join(getProjectRootDataDir(), "kiki.db");
}

export function getStorageRootDir() {
  return ensureDir(path.join(getProjectRootDataDir(), "storage"));
}

export function getWorkspaceStorageRootDir() {
  return ensureDir(path.join(getProjectRootDataDir(), "workspaces"));
}

export function getConversationWorkspacesRootDir() {
  return ensureDir(path.join(getWorkspaceStorageRootDir(), "conversations"));
}

export function getUserMemoryDir() {
  return ensureDir(path.join(getProjectRootDataDir(), "memory"));
}

export function getUserProfileMemoryFilePath() {
  return path.join(getUserMemoryDir(), "profile.md");
}

export function getTelemetryFilePath() {
  return path.join(getStorageRootDir(), "kiki-goal-telemetry.json");
}

export function getRuntimeHomeDir() {
  return ensureDir(RUNTIME_HOME_DIR);
}

export function getRuntimeLogsDir() {
  return ensureDir(path.join(getRuntimeHomeDir(), "logs"));
}

export function getRuntimeConfigFilePath() {
  return path.join(getRuntimeHomeDir(), "config.json");
}

export function getRuntimeDeviceFilePath() {
  return path.join(getRuntimeHomeDir(), "device.json");
}

export function getRuntimeStateFilePath() {
  return path.join(getRuntimeHomeDir(), "state.json");
}

export function getLaunchAgentPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.kiki.runtime-daemon.plist");
}
