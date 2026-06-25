import fs from "fs";
import os from "os";
import path from "path";

const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export type DaemonLogPaths = {
  logsDir: string;
  daemonLog: string;
  stdoutLog: string;
  stderrLog: string;
};

export function resolveDaemonLogPaths(): DaemonLogPaths {
  const runtimeHome = process.env.KIKI_RUNTIME_HOME?.trim()
    ? path.resolve(process.env.KIKI_RUNTIME_HOME)
    : path.join(os.homedir(), ".kiki", "runtime");
  const logsDir = path.join(runtimeHome, "logs");
  return {
    logsDir,
    daemonLog: path.join(logsDir, "daemon.log"),
    stdoutLog: path.join(logsDir, "daemon.stdout.log"),
    stderrLog: path.join(logsDir, "daemon.stderr.log"),
  };
}

export function parseTailLineCount(value: string | undefined, fallback = DEFAULT_TAIL_LINES) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_TAIL_LINES);
}

export function readLastLogLines(filePath: string, lineCount: number) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (!trimmed) return "";
  const lines = trimmed.split(/\r?\n/).slice(-lineCount);
  return `${lines.join("\n")}\n`;
}

function readFileSize(filePath: string) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function readFileRange(filePath: string, start: number, endExclusive: number) {
  if (endExclusive <= start) return "";
  const length = endExclusive - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export async function runDaemonLogMode(input: {
  paths?: DaemonLogPaths;
  lines?: number;
  follow?: boolean;
  pollIntervalMs?: number;
  output?: NodeJS.WriteStream;
  errorOutput?: NodeJS.WriteStream;
}) {
  const paths = input.paths ?? resolveDaemonLogPaths();
  const output = input.output ?? process.stdout;
  const errorOutput = input.errorOutput ?? process.stderr;
  const follow = input.follow ?? true;
  const lines = input.lines ?? DEFAULT_TAIL_LINES;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  fs.mkdirSync(paths.logsDir, { recursive: true });
  output.write("进入 kiki-daemon log 模式（Ctrl+C 退出）\n");
  output.write(`执行日志: ${paths.daemonLog}\n`);
  output.write(`控制台输出: ${paths.stdoutLog}\n`);
  output.write(`错误输出: ${paths.stderrLog}\n\n`);

  const initialTail = readLastLogLines(paths.daemonLog, lines);
  if (initialTail) output.write(initialTail);
  else output.write(follow ? "暂无 daemon 执行记录，等待日志写入...\n" : "暂无 daemon 执行记录。\n");

  if (!follow) return;

  let position = readFileSize(paths.daemonLog);
  await new Promise<void>((resolve) => {
    const poll = () => {
      try {
        const size = readFileSize(paths.daemonLog);
        if (size < position) {
          position = 0;
          output.write("\n[log] 检测到日志轮转，继续跟随新日志。\n");
        }
        if (size > position) {
          output.write(readFileRange(paths.daemonLog, position, size));
          position = size;
        }
      } catch (error) {
        errorOutput.write(
          `[kiki-daemon] 读取日志失败: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    };

    const timer = setInterval(poll, pollIntervalMs);
    const cleanup = () => {
      clearInterval(timer);
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      output.write("\n已退出 kiki-daemon log 模式。\n");
      resolve();
    };
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}
