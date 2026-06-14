import fs from "fs";
import path from "path";

import { getRuntimeLogsDir } from "@/lib/server/storage/paths";

export type DaemonLogLevel = "info" | "debug" | "trace";
export type DaemonLogDomain = "life" | "conn" | "hb" | "cmd" | "exec" | "stream" | "err" | "loop";

type DaemonLogFields = Record<string, string | number | boolean | null | undefined>;

const LOG_LEVEL_ORDER: Record<DaemonLogLevel, number> = {
  info: 0,
  debug: 1,
  trace: 2,
};

const DEFAULT_LOG_MAX_MB = 10;
const DEFAULT_LOG_KEEP = 5;
const DEFAULT_TRACE_KEEP_DAYS = 7;
const MAX_ROTATE_RETRIES = 3;
let traceWarningPrinted = false;

function daemonLogFilePath() {
  return path.join(getRuntimeLogsDir(), "daemon.log");
}

function parseLogLevel(value: string | undefined): DaemonLogLevel {
  if (value === "debug" || value === "trace") return value;
  return "info";
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getDaemonLogLevel() {
  return parseLogLevel(process.env.KIKI_DAEMON_LOG_LEVEL);
}

export function isDaemonTraceEnabled() {
  return getDaemonLogLevel() === "trace" && process.env.KIKI_DAEMON_TRACE === "1";
}

function shouldLog(level: DaemonLogLevel) {
  const configured = getDaemonLogLevel();
  if (level === "trace" && !isDaemonTraceEnabled()) return false;
  return LOG_LEVEL_ORDER[level] <= LOG_LEVEL_ORDER[configured];
}

export function formatLocalLogTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${offset}`;
}

function getLogMaxBytes() {
  return parsePositiveInteger(process.env.KIKI_DAEMON_LOG_MAX_MB, DEFAULT_LOG_MAX_MB) * 1024 * 1024;
}

function getLogKeepCount() {
  return parsePositiveInteger(process.env.KIKI_DAEMON_LOG_KEEP, DEFAULT_LOG_KEEP);
}

function getTraceKeepDays() {
  return parsePositiveInteger(process.env.KIKI_DAEMON_TRACE_KEEP_DAYS, DEFAULT_TRACE_KEEP_DAYS);
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function rotateDaemonLogIfNeeded(logFile: string) {
  const maxBytes = getLogMaxBytes();
  let size = 0;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;

  const keep = getLogKeepCount();
  for (let attempt = 0; attempt < MAX_ROTATE_RETRIES; attempt += 1) {
    try {
      for (let index = keep - 1; index >= 1; index -= 1) {
        const source = `${logFile}.${index}`;
        const target = `${logFile}.${index + 1}`;
        if (fs.existsSync(source)) {
          if (index + 1 > keep) fs.rmSync(source, { force: true });
          else fs.renameSync(source, target);
        }
      }
      fs.renameSync(logFile, `${logFile}.1`);
      return;
    } catch {
      // 多进程交接期可能同时轮转，短暂退让后由下一次写入重试。
      continue;
    }
  }
}

function redactValue(key: string, value: string | number | boolean) {
  const keyLower = key.toLowerCase();
  const text = String(value);
  if (/(api[-_]?key|token|secret|cookie|authorization|password)/i.test(keyLower)) {
    if (text.length <= 8) return "<redacted>";
    return `${text.slice(0, 4)}…${text.slice(-4)}`;
  }
  return text.replace(/(api[-_]?key|token|secret|cookie|authorization|password)=([^\\s]+)/gi, "$1=<redacted>");
}

function formatFields(fields: DaemonLogFields | undefined) {
  const merged: DaemonLogFields = { pid: process.pid, ...(fields ?? {}) };
  return Object.entries(merged)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${redactValue(key, value as string | number | boolean)}`)
    .join(" ");
}

function appendLine(line: string) {
  const logFile = daemonLogFilePath();
  ensureParentDir(logFile);
  rotateDaemonLogIfNeeded(logFile);
  fs.appendFileSync(logFile, `${line}\n`, "utf8");
}

export function appendDaemonLogLine(message: string) {
  appendLine(`[${formatLocalLogTimestamp()}] ${message}`);
}

export function logDaemonEvent(
  level: DaemonLogLevel,
  domain: DaemonLogDomain,
  message: string,
  fields?: DaemonLogFields,
) {
  if (!shouldLog(level)) return;
  const fieldText = formatFields(fields);
  appendLine(`[${formatLocalLogTimestamp()}] [${level}] [${domain}] ${message}${fieldText ? ` ${fieldText}` : ""}`);
}

export function logTraceEnabledWarning() {
  if (traceWarningPrinted || !isDaemonTraceEnabled()) return;
  traceWarningPrinted = true;
  cleanupExpiredDaemonTraces();
  logDaemonEvent("info", "life", "TRACE 已开启，原始输入/输出可能写入本机 trace 目录", {
    traceDir: path.join(getRuntimeLogsDir(), "trace"),
  });
}

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "unknown";
}

function traceRootDir() {
  return path.join(getRuntimeLogsDir(), "trace");
}

function ensurePrivateDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // 忽略非 POSIX 文件系统权限差异。
  }
}

function writePrivateFile(filePath: string, content: string) {
  ensurePrivateDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
}

function appendPrivateFile(filePath: string, content: string) {
  ensurePrivateDir(path.dirname(filePath));
  fs.appendFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
}

function cleanupExpiredDaemonTraces() {
  const root = traceRootDir();
  const keepMs = getTraceKeepDays() * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - keepMs;
  try {
    if (!fs.existsSync(root)) return;
    for (const dateEntry of fs.readdirSync(root)) {
      const datePath = path.join(root, dateEntry);
      const stat = fs.statSync(datePath);
      if (stat.mtimeMs < cutoff) fs.rmSync(datePath, { recursive: true, force: true });
    }
  } catch {
    // 清理失败不应影响 daemon 主流程。
  }
}

export function createDaemonTrace(input: {
  type: string;
  requestId?: string;
  sessionId?: string;
  jobId?: string;
  metadata?: Record<string, unknown>;
}) {
  if (!isDaemonTraceEnabled()) return null;
  const startedAt = new Date();
  const dateSegment = startedAt.toISOString().slice(0, 10);
  const id = sanitizeSegment(input.requestId ?? input.sessionId ?? input.jobId ?? `${input.type}-${Date.now()}`);
  const traceDir = path.join(traceRootDir(), dateSegment, id);
  ensurePrivateDir(traceDir);

  const metaPath = path.join(traceDir, "meta.json");
  const promptPath = path.join(traceDir, "prompt.txt");
  const payloadPath = path.join(traceDir, "payload.json");
  const streamPath = path.join(traceDir, "stream.jsonl");
  const outputPath = path.join(traceDir, "output.json");

  const baseMeta = {
    type: input.type,
    requestId: input.requestId,
    sessionId: input.sessionId,
    jobId: input.jobId,
    startedAt: startedAt.toISOString(),
    ...input.metadata,
  };
  writePrivateFile(metaPath, `${JSON.stringify(baseMeta, null, 2)}\n`);

  return {
    traceDir,
    writePrompt: (value: string) => writePrivateFile(promptPath, value),
    writePayload: (value: unknown) => writePrivateFile(payloadPath, `${JSON.stringify(value, null, 2)}\n`),
    appendStreamEvent: (value: unknown) => appendPrivateFile(streamPath, `${JSON.stringify(value)}\n`),
    writeOutput: (value: unknown) => writePrivateFile(outputPath, `${JSON.stringify(value, null, 2)}\n`),
    finish: (status: "completed" | "failed", error?: string) => {
      writePrivateFile(
        metaPath,
        `${JSON.stringify(
          {
            ...baseMeta,
            status,
            finishedAt: new Date().toISOString(),
            error,
          },
          null,
          2,
        )}\n`,
      );
    },
  };
}
