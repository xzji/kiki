import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

/**
 * daemon 进程级单例保障。
 *
 * 解决“覆盖安装新版后，旧版进程仍在后台常驻”的问题：
 * npm i -g 只替换磁盘文件，不会终止已运行的进程；launchctl/systemctl 也只能管
 * 自己托管的那个进程，碰不到游离的前台/孤儿进程。结果是新旧两个进程用同一 apiKey
 * 抢同一 machineId 的 WS 连接互相顶替，谁都收不全消息。
 *
 * 这里在每个 `run` 进程启动时：
 *   1. 通过 pidfile 精确定位上一次记录的实例；
 *   2. 通过 ps 扫描兜底发现 pidfile 未跟踪的孤儿实例；
 *   3. 终止它们（SIGTERM，宽限后 SIGKILL），再写入自己的 pidfile 接管。
 * 因为 launchd/systemd 拉起的也是 `run`，所有启动路径都会自动收敛到单实例。
 */

const PID_FILE_MARKER = "@kiki_agent/daemon";

function runtimeDir() {
  const dir = path.join(os.homedir(), ".kiki", "runtime");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pidFilePath() {
  return path.join(runtimeDir(), "daemon.pid");
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    // signal 0 不发送信号，仅探测存在性与权限。
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH=不存在；EPERM=存在但无权限（仍视为存活）。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读取某个 pid 的完整命令行，用于确认它确实是 kiki-daemon（避免误杀 pid 复用进程）。 */
function readProcessCommand(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 3_000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function looksLikeDaemonRun(command: string) {
  if (!command.includes(PID_FILE_MARKER) && !command.includes("kiki-daemon")) return false;
  // 仅匹配 `run` 子命令进程，排除 install/uninstall/status 等一次性命令进程。
  return /\brun\b/.test(command);
}

/** ps 全量扫描，兜底发现 pidfile 未跟踪的孤儿 daemon run 进程。 */
function scanDaemonRunPids(): number[] {
  if (process.platform === "win32") return [];
  let out = "";
  try {
    out = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const spaceIndex = line.indexOf(" ");
    if (spaceIndex <= 0) continue;
    const pid = Number(line.slice(0, spaceIndex));
    const command = line.slice(spaceIndex + 1);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (looksLikeDaemonRun(command)) pids.push(pid);
  }
  return pids;
}

function sleepSync(ms: number) {
  // 单例终止发生在启动早期主流程，用 Atomics.wait 做精确的同步等待，
  // 确保旧进程退出后再接管 WS 连接，避免短暂的双实例顶替。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function terminatePid(pid: number, log: (message: string) => void) {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
    log(`已向旧 daemon 进程 ${pid} 发送 SIGTERM`);
  } catch {
    return;
  }
  // 宽限等待优雅退出。
  for (let i = 0; i < 10; i += 1) {
    if (!isProcessAlive(pid)) {
      log(`旧 daemon 进程 ${pid} 已退出`);
      return;
    }
    sleepSync(300);
  }
  // 宽限超时后强制结束。
  try {
    process.kill(pid, "SIGKILL");
    log(`旧 daemon 进程 ${pid} 未在宽限期内退出，已发送 SIGKILL`);
  } catch {
    // ignore
  }
}

function readTrackedPid(): number | null {
  try {
    const raw = fs.readFileSync(pidFilePath(), "utf8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { pid?: number };
    const pid = Number(parsed.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(version: string) {
  const payload = {
    pid: process.pid,
    version,
    startedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(pidFilePath(), JSON.stringify(payload), "utf8");
  } catch {
    // pidfile 写入失败不应阻塞启动，仅丢失精确跟踪能力。
  }
}

function registerPidFileCleanup() {
  const cleanup = () => {
    try {
      const tracked = readTrackedPid();
      // 仅当 pidfile 仍指向自己时才清理，避免误删后继进程写入的 pidfile。
      if (tracked === process.pid) fs.rmSync(pidFilePath(), { force: true });
    } catch {
      // ignore
    }
  };
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
  }
}

/**
 * 终止其它存活的 daemon `run` 实例，并写入自己的 pidfile 接管。
 * 在 `run` 主循环启动前调用。
 */
export function ensureSingleDaemonInstance(input: { version: string; log: (message: string) => void }) {
  const { log } = input;
  const targets = new Set<number>();

  // 1) pidfile 精确跟踪的上一实例。
  const tracked = readTrackedPid();
  if (tracked && tracked !== process.pid && isProcessAlive(tracked)) {
    const command = readProcessCommand(tracked);
    // pidfile 内的 pid 可能已被系统复用为其它进程，命令行校验避免误杀。
    if (!command || looksLikeDaemonRun(command)) targets.add(tracked);
  }

  // 2) ps 扫描兜底，覆盖 pidfile 未跟踪的孤儿/前台旧进程。
  for (const pid of scanDaemonRunPids()) {
    if (pid !== process.pid) targets.add(pid);
  }

  if (targets.size > 0) {
    log(`检测到 ${targets.size} 个存活的旧 daemon 进程，准备终止以保证单实例：${Array.from(targets).join(", ")}`);
    for (const pid of Array.from(targets)) terminatePid(pid, log);
  }

  writePidFile(input.version);
  registerPidFileCleanup();
}
