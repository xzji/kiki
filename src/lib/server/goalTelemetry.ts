import fs from "fs";
import os from "os";
import path from "path";

import type {
  GoalProgressStatus,
  GoalServerLogEntry,
  GoalServerLogLevel,
  GoalServerLogsResponse,
  GoalServerProgress,
  GoalTelemetryScope,
} from "@/types/goalTelemetry";
import type { GoalWorkflowPhase } from "@/types/kiki";

const MAX_LOGS = 400;
const TELEMETRY_FILE = path.join(os.tmpdir(), "kiki-goal-telemetry.json");

const progressByRequest = new Map<string, GoalServerProgress>();
const logBuffer: GoalServerLogEntry[] = [];

function nowIso() {
  return new Date().toISOString();
}

function readTelemetryFromFile() {
  try {
    const raw = fs.readFileSync(TELEMETRY_FILE, "utf8");
    const parsed = JSON.parse(raw) as {
      progressByRequest?: Record<string, GoalServerProgress>;
      logs?: GoalServerLogEntry[];
    };
    if (parsed.logs && Array.isArray(parsed.logs)) {
      logBuffer.length = 0;
      logBuffer.push(...parsed.logs.slice(0, MAX_LOGS));
    }
    if (parsed.progressByRequest) {
      progressByRequest.clear();
      Object.entries(parsed.progressByRequest).forEach(([key, value]) => {
        if (value) progressByRequest.set(key, value);
      });
    }
  } catch {
    // ignore read errors
  }
}

function writeTelemetryToFile() {
  try {
    const payload = {
      logs: logBuffer.slice(0, MAX_LOGS),
      progressByRequest: Object.fromEntries(progressByRequest.entries()),
    };
    fs.writeFileSync(TELEMETRY_FILE, JSON.stringify(payload), "utf8");
  } catch {
    // ignore write errors
  }
}

function pushLog(entry: GoalServerLogEntry) {
  logBuffer.unshift(entry);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.length = MAX_LOGS;
  }
  writeTelemetryToFile();
}

export function beginGoalTelemetry(input: {
  requestId: string;
  scope: GoalTelemetryScope;
  phase: GoalWorkflowPhase;
  message: string;
}) {
  const now = nowIso();
  progressByRequest.set(input.requestId, {
    requestId: input.requestId,
    scope: input.scope,
    status: "running",
    phase: input.phase,
    message: input.message,
    startedAt: now,
    updatedAt: now,
  });
  appendGoalLog({
    requestId: input.requestId,
    scope: input.scope,
    level: "info",
    phase: input.phase,
    message: input.message,
  });
  writeTelemetryToFile();
}

export function updateGoalTelemetry(input: {
  requestId: string;
  scope: GoalTelemetryScope;
  phase: GoalWorkflowPhase;
  message: string;
  level?: GoalServerLogLevel;
  details?: string;
}) {
  const current = progressByRequest.get(input.requestId);
  const now = nowIso();
  progressByRequest.set(input.requestId, {
    requestId: input.requestId,
    scope: input.scope,
    status: current?.status ?? "running",
    phase: input.phase,
    message: input.message,
    startedAt: current?.startedAt ?? now,
    updatedAt: now,
    finishedAt: current?.finishedAt,
    error: current?.error,
  });
  appendGoalLog({
    requestId: input.requestId,
    scope: input.scope,
    level: input.level ?? "info",
    phase: input.phase,
    message: input.message,
    details: input.details,
  });
  writeTelemetryToFile();
}

export function finishGoalTelemetry(input: {
  requestId: string;
  scope: GoalTelemetryScope;
  phase: GoalWorkflowPhase;
  message: string;
}) {
  finalizeGoalTelemetry({
    requestId: input.requestId,
    scope: input.scope,
    phase: input.phase,
    message: input.message,
    status: "completed",
  });
}

export function failGoalTelemetry(input: {
  requestId: string;
  scope: GoalTelemetryScope;
  phase: GoalWorkflowPhase;
  message: string;
  error?: string;
}) {
  finalizeGoalTelemetry({
    requestId: input.requestId,
    scope: input.scope,
    phase: input.phase,
    message: input.message,
    status: "failed",
    error: input.error,
  });
}

function finalizeGoalTelemetry(input: {
  requestId: string;
  scope: GoalTelemetryScope;
  phase: GoalWorkflowPhase;
  message: string;
  status: GoalProgressStatus;
  error?: string;
}) {
  const current = progressByRequest.get(input.requestId);
  const now = nowIso();
  progressByRequest.set(input.requestId, {
    requestId: input.requestId,
    scope: input.scope,
    status: input.status,
    phase: input.phase,
    message: input.message,
    startedAt: current?.startedAt ?? now,
    updatedAt: now,
    finishedAt: now,
    error: input.error,
  });
  appendGoalLog({
    requestId: input.requestId,
    scope: input.scope,
    level: input.status === "failed" ? "error" : "info",
    phase: input.phase,
    message: input.message,
    details: input.error,
  });
  writeTelemetryToFile();
}

export function appendGoalLog(input: {
  requestId?: string;
  scope: GoalTelemetryScope;
  level: GoalServerLogLevel;
  phase?: GoalWorkflowPhase;
  message: string;
  details?: string;
}) {
  const entry: GoalServerLogEntry = {
    id: `goal-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: nowIso(),
    requestId: input.requestId,
    scope: input.scope,
    level: input.level,
    phase: input.phase,
    message: input.message,
    details: input.details,
  };
  pushLog(entry);

  const consolePrefix = `[${entry.scope}]${entry.requestId ? ` [${entry.requestId}]` : ""}`;
  const consoleLine = `${consolePrefix} ${entry.phase ? `[${entry.phase}] ` : ""}${entry.message}`;
  if (entry.level === "error") {
    console.error(consoleLine, entry.details ?? "");
  } else if (entry.level === "warn") {
    console.warn(consoleLine, entry.details ?? "");
  } else {
    console.log(consoleLine, entry.details ?? "");
  }
}

export function getGoalTelemetryProgress(requestId: string) {
  readTelemetryFromFile();
  return progressByRequest.get(requestId) ?? null;
}

export function getGoalTelemetryLogs(limit = 120): GoalServerLogsResponse {
  readTelemetryFromFile();
  return {
    logs: logBuffer.slice(0, Math.max(1, Math.min(limit, MAX_LOGS))),
    activeRequests: Array.from(progressByRequest.values())
      .filter((entry) => entry.status === "running")
      .sort((left, right) => +new Date(right.updatedAt) - +new Date(left.updatedAt)),
  };
}
