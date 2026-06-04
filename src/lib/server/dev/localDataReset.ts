import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { unloadLaunchAgentOnly } from "@/lib/daemon/launchAgent";
import { closeDatabaseForReset } from "@/lib/server/db/client";
import {
  getConversationWorkspacesRootDir,
  getDatabaseFilePath,
  getLaunchAgentPlistPath,
  getProjectRootDataDir,
  getRuntimeConfigFilePath,
  getRuntimeDeviceFilePath,
  getRuntimeLogsDir,
  getRuntimeStateFilePath,
  getStorageRootDir,
} from "@/lib/server/storage/paths";

const execFileAsync = promisify(execFile);
const TERM_GRACE_MS = 2_000;

export type StoppedProcess = {
  pid: number;
  command: string;
  signal: "SIGTERM" | "SIGKILL" | "skipped";
};

export type LocalDataResetResult = {
  ok: boolean;
  stoppedProcesses: StoppedProcess[];
  deletedPaths: string[];
  preservedPaths: string[];
  warnings: string[];
};

type ProcessInfo = {
  pid: number;
  command: string;
  cwd: string | undefined;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeRm(targetPath: string, result: LocalDataResetResult) {
  if (!fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
  result.deletedPaths.push(targetPath);
}

async function assertNoExternalDatabaseHandles(databaseFile: string) {
  const files = [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`].filter((filePath) =>
    fs.existsSync(filePath),
  );
  if (files.length === 0) return;
  try {
    const { stdout } = await execFileAsync("lsof", ["-F", "pc", ...files], { maxBuffer: 1024 * 128 });
    const holders: Array<{ pid: number; command?: string }> = [];
    let current: { pid: number; command?: string } | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) {
        if (current) holders.push(current);
        current = { pid: Number(line.slice(1)) };
      } else if (line.startsWith("c") && current) {
        current.command = line.slice(1);
      }
    }
    if (current) holders.push(current);
    const external = holders.filter((holder) => holder.pid !== process.pid);
    if (external.length > 0) {
      const summary = external
        .map((holder) => `${holder.pid}${holder.command ? `(${holder.command})` : ""}`)
        .join(", ");
      throw new Error(
        `数据库仍被其他 Web/Node 进程打开，已中止清理以避免幽灵库：${summary}。请先重启/关闭多余 Web 进程后再试。`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("数据库仍被其他 Web/Node 进程打开")) {
      throw error;
    }
    // lsof 查不到持有者时通常会返回非 0，视为无外部句柄。
  }
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isSameOrInside(candidate: string | undefined, parent: string) {
  if (!candidate) return false;
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`);
}

function assertSafeDataDir(dataDir: string) {
  const resolved = path.resolve(dataDir);
  const projectRoot = path.resolve(process.cwd());
  const homeDir = path.resolve(os.homedir());

  if (!path.isAbsolute(resolved)) {
    throw new Error(`数据目录必须是绝对路径：${dataDir}`);
  }
  if (resolved === path.parse(resolved).root) {
    throw new Error("拒绝清理文件系统根目录");
  }
  if (resolved === homeDir) {
    throw new Error("拒绝清理用户 home 目录");
  }
  if (resolved === projectRoot) {
    throw new Error("拒绝清理项目根目录");
  }

  const configured = process.env.KIKI_DATA_DIR?.trim();
  const defaultDataDir = path.resolve(projectRoot, "data");
  if (!configured && resolved !== defaultDataDir) {
    throw new Error(`默认数据目录异常：${resolved}`);
  }
}

async function listProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], { maxBuffer: 1024 * 1024 * 4 });
  const rows = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const items = await Promise.all(
    rows.map(async (line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      const pid = Number(match[1]);
      if (!Number.isFinite(pid)) return null;
      return {
        pid,
        command: match[2],
        cwd: await readProcessCwd(pid),
      };
    }),
  );
  return items.filter((item): item is ProcessInfo => Boolean(item));
}

async function readProcessCwd(pid: number) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      maxBuffer: 1024 * 64,
    });
    const line = stdout
      .split("\n")
      .find((entry) => entry.startsWith("n"));
    return line ? line.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

function isProjectWorkerProcess(processInfo: ProcessInfo, projectRoot: string) {
  const looksLikeWorker =
    /(?:scripts\/start-worker\.ts|start-worker\.ts|src\/bin\/kiki-runtime-daemon\.ts|tsx.*start-worker)/.test(
      processInfo.command,
    );
  if (!looksLikeWorker) return false;
  return isSameOrInside(processInfo.cwd, projectRoot) || processInfo.command.includes(projectRoot);
}

function isProjectClaudeProcess(processInfo: ProcessInfo, projectRoot: string, dataDir: string) {
  if (!/(^|\s|\/)claude(\s|$)/.test(processInfo.command)) return false;
  if (isSameOrInside(processInfo.cwd, projectRoot)) return true;
  if (isSameOrInside(processInfo.cwd, dataDir)) return true;
  return processInfo.command.includes(projectRoot) || processInfo.command.includes(dataDir);
}

async function killProcess(pid: number): Promise<"SIGTERM" | "SIGKILL" | "skipped"> {
  if (pid === process.pid) return "skipped";
  if (!isProcessAlive(pid)) return "skipped";
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return "skipped";
  }
  await sleep(TERM_GRACE_MS);
  if (!isProcessAlive(pid)) return "SIGTERM";
  try {
    process.kill(pid, "SIGKILL");
    return "SIGKILL";
  } catch {
    return "SIGTERM";
  }
}

async function stopRuntimeProcesses(result: LocalDataResetResult, dataDir: string) {
  try {
    await unloadLaunchAgentOnly();
  } catch (err) {
    result.warnings.push(`停止 LaunchAgent 失败：${err instanceof Error ? err.message : String(err)}`);
  }

  const projectRoot = path.resolve(process.cwd());
  const processes = await listProcesses();
  const candidates = processes.filter((item) => {
    if (item.pid === process.pid) return false;
    if (item.command.includes("next dev") || item.command.includes("next-server")) return false;
    return isProjectWorkerProcess(item, projectRoot) || isProjectClaudeProcess(item, projectRoot, dataDir);
  });

  for (const candidate of candidates) {
    const signal = await killProcess(candidate.pid);
    result.stoppedProcesses.push({
      pid: candidate.pid,
      command: candidate.command,
      signal,
    });
  }
}

function deleteKnownDataPaths(dataDir: string, result: LocalDataResetResult) {
  ensureDir(dataDir);
  const targets = [
    path.join(dataDir, "kiki.db"),
    path.join(dataDir, "kiki.db-wal"),
    path.join(dataDir, "kiki.db-shm"),
    path.join(dataDir, "workspaces"),
    path.join(dataDir, "storage"),
    path.join(dataDir, "backups"),
  ];
  for (const target of targets) {
    safeRm(target, result);
  }
}

function deleteRuntimeStateAndLogs(result: LocalDataResetResult) {
  safeRm(getRuntimeStateFilePath(), result);
  const logsDir = getRuntimeLogsDir();
  ensureDir(logsDir);
  for (const entry of fs.readdirSync(logsDir)) {
    safeRm(path.join(logsDir, entry), result);
  }
}

export async function resetLocalDataForDev(): Promise<LocalDataResetResult> {
  const result: LocalDataResetResult = {
    ok: true,
    stoppedProcesses: [],
    deletedPaths: [],
    preservedPaths: [getRuntimeConfigFilePath(), getRuntimeDeviceFilePath(), getLaunchAgentPlistPath()],
    warnings: [],
  };

  const dataDir = getProjectRootDataDir();
  assertSafeDataDir(dataDir);

  await stopRuntimeProcesses(result, dataDir);
  await assertNoExternalDatabaseHandles(getDatabaseFilePath());
  closeDatabaseForReset();

  deleteKnownDataPaths(dataDir, result);
  deleteRuntimeStateAndLogs(result);

  ensureDir(dataDir);
  ensureDir(getStorageRootDir());
  ensureDir(getConversationWorkspacesRootDir());
  ensureDir(getRuntimeLogsDir());

  return result;
}
