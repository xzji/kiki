import fs from "fs";

import { getTelemetryFilePath } from "@/lib/server/storage/paths";
import type {
  GoalProgressStatus,
  GoalServerLogEntry,
  GoalServerLogLevel,
  GoalServerLogsResponse,
  GoalTaskStepEventType,
  GoalServerProgress,
  GoalTelemetryScope,
} from "@/types/goalTelemetry";
import type { GoalWorkflowPhase } from "@/types/kiki";

const MAX_LOGS = 2000;

function telemetryFilePath() {
  return getTelemetryFilePath();
}

const progressByRequest = new Map<string, GoalServerProgress>();
const logBuffer: GoalServerLogEntry[] = [];

type GoalTelemetryObserver = {
  onProgress?: (progress: GoalServerProgress) => void;
  onLog?: (entry: GoalServerLogEntry) => void;
};

let telemetryObserver: GoalTelemetryObserver | null = null;

export function setGoalTelemetryObserver(observer: GoalTelemetryObserver | null) {
  telemetryObserver = observer;
}

function nowIso() {
  return new Date().toISOString();
}

function readTelemetryFromFile() {
  try {
    const raw = fs.readFileSync(telemetryFilePath(), "utf8");
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
    fs.writeFileSync(telemetryFilePath(), JSON.stringify(payload), "utf8");
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

function isVisibleGoalLogEntry(entry: GoalServerLogEntry) {
  return entry.toolName !== "debug.stream_event";
}

export function beginGoalTelemetry(input: {
  requestId: string;
  scope: GoalTelemetryScope;
  phase: GoalWorkflowPhase;
  message: string;
  goalId?: string;
  taskId?: string;
  taskInstanceId?: string;
  attemptCount?: number;
  summary?: string;
  resultPayload?: Record<string, unknown> | null;
}) {
  const now = nowIso();
  const progress: GoalServerProgress = {
    requestId: input.requestId,
    scope: input.scope,
    status: "running",
    phase: input.phase,
    message: input.message,
    startedAt: now,
    updatedAt: now,
    goalId: input.goalId,
    taskId: input.taskId,
    taskInstanceId: input.taskInstanceId,
    attemptCount: input.attemptCount,
    summary: input.summary,
    resultPayload: input.resultPayload,
  };
  progressByRequest.set(input.requestId, progress);
  telemetryObserver?.onProgress?.(progress);
  appendGoalLog({
    requestId: input.requestId,
    scope: input.scope,
    level: "info",
    phase: input.phase,
    message: input.message,
    goalId: input.goalId,
    taskId: input.taskId,
    taskInstanceId: input.taskInstanceId,
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
  goalId?: string;
  taskId?: string;
  taskInstanceId?: string;
  attemptCount?: number;
  summary?: string;
  resultPayload?: Record<string, unknown> | null;
}) {
  const current = progressByRequest.get(input.requestId);
  const now = nowIso();
  const progress: GoalServerProgress = {
    requestId: input.requestId,
    scope: input.scope,
    status: current?.status ?? "running",
    phase: input.phase,
    message: input.message,
    startedAt: current?.startedAt ?? now,
    updatedAt: now,
    finishedAt: current?.finishedAt,
    error: current?.error,
    goalId: input.goalId ?? current?.goalId,
    taskId: input.taskId ?? current?.taskId,
    taskInstanceId: input.taskInstanceId ?? current?.taskInstanceId,
    attemptCount: input.attemptCount ?? current?.attemptCount,
    summary: input.summary ?? current?.summary,
    resultPayload: input.resultPayload ?? current?.resultPayload,
  };
  progressByRequest.set(input.requestId, progress);
  telemetryObserver?.onProgress?.(progress);
  appendGoalLog({
    requestId: input.requestId,
    scope: input.scope,
    level: input.level ?? "info",
    phase: input.phase,
    message: input.message,
    details: input.details,
    goalId: input.goalId ?? current?.goalId,
    taskId: input.taskId ?? current?.taskId,
    taskInstanceId: input.taskInstanceId ?? current?.taskInstanceId,
  });
  writeTelemetryToFile();
}

export function finishGoalTelemetry(input: {
  requestId: string;
  scope: GoalTelemetryScope;
  phase: GoalWorkflowPhase;
  message: string;
  goalId?: string;
  taskId?: string;
  taskInstanceId?: string;
  summary?: string;
  resultPayload?: Record<string, unknown> | null;
}) {
  finalizeGoalTelemetry({
    requestId: input.requestId,
    scope: input.scope,
    phase: input.phase,
    message: input.message,
    status: "completed",
    goalId: input.goalId,
    taskId: input.taskId,
    taskInstanceId: input.taskInstanceId,
    summary: input.summary,
    resultPayload: input.resultPayload,
  });
}

export function failGoalTelemetry(input: {
  requestId: string;
  scope: GoalTelemetryScope;
  phase: GoalWorkflowPhase;
  message: string;
  error?: string;
  goalId?: string;
  taskId?: string;
  taskInstanceId?: string;
  summary?: string;
  resultPayload?: Record<string, unknown> | null;
}) {
  finalizeGoalTelemetry({
    requestId: input.requestId,
    scope: input.scope,
    phase: input.phase,
    message: input.message,
    status: "failed",
    error: input.error,
    goalId: input.goalId,
    taskId: input.taskId,
    taskInstanceId: input.taskInstanceId,
    summary: input.summary,
    resultPayload: input.resultPayload,
  });
}

function finalizeGoalTelemetry(input: {
  requestId: string;
  scope: GoalTelemetryScope;
  phase: GoalWorkflowPhase;
  message: string;
  status: GoalProgressStatus;
  error?: string;
  goalId?: string;
  taskId?: string;
  taskInstanceId?: string;
  summary?: string;
  resultPayload?: Record<string, unknown> | null;
}) {
  const current = progressByRequest.get(input.requestId);
  const now = nowIso();
  const progress: GoalServerProgress = {
    requestId: input.requestId,
    scope: input.scope,
    status: input.status,
    phase: input.phase,
    message: input.message,
    startedAt: current?.startedAt ?? now,
    updatedAt: now,
    finishedAt: now,
    error: input.error,
    goalId: input.goalId ?? current?.goalId,
    taskId: input.taskId ?? current?.taskId,
    taskInstanceId: input.taskInstanceId ?? current?.taskInstanceId,
    attemptCount: current?.attemptCount,
    summary: input.summary ?? current?.summary,
    resultPayload: input.resultPayload ?? current?.resultPayload,
  };
  progressByRequest.set(input.requestId, progress);
  telemetryObserver?.onProgress?.(progress);
  appendGoalLog({
    requestId: input.requestId,
    scope: input.scope,
    level: input.status === "failed" ? "error" : "info",
    phase: input.phase,
    message: input.message,
    details: input.error,
    goalId: input.goalId ?? current?.goalId,
    taskId: input.taskId ?? current?.taskId,
    taskInstanceId: input.taskInstanceId ?? current?.taskInstanceId,
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
  eventType?: GoalTaskStepEventType;
  goalId?: string;
  taskId?: string;
  taskInstanceId?: string;
  toolName?: string;
  status?: "pending" | "running" | "completed" | "failed" | "awaiting_user";
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
    eventType: input.eventType,
    goalId: input.goalId,
    taskId: input.taskId,
    taskInstanceId: input.taskInstanceId,
    toolName: input.toolName,
    status: input.status,
  };
  pushLog(entry);
  telemetryObserver?.onLog?.(entry);

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

export function getTaskTelemetryProgress(taskInstanceId: string) {
  readTelemetryFromFile();
  return (
    Array.from(progressByRequest.values())
      .filter((entry) => entry.taskInstanceId === taskInstanceId)
      .sort((left, right) => +new Date(right.updatedAt) - +new Date(left.updatedAt))[0] ?? null
  );
}

export function getTaskTelemetryLogs(taskInstanceId: string, limit = MAX_LOGS) {
  readTelemetryFromFile();
  return logBuffer
    .filter((entry) => entry.taskInstanceId === taskInstanceId)
    .filter(isVisibleGoalLogEntry)
    .slice(0, Math.max(1, Math.min(limit, MAX_LOGS)));
}

export function getGoalTelemetryLogs(limit = 120): GoalServerLogsResponse {
  readTelemetryFromFile();
  return {
    logs: logBuffer.filter(isVisibleGoalLogEntry).slice(0, Math.max(1, Math.min(limit, MAX_LOGS))),
    activeRequests: Array.from(progressByRequest.values())
      .filter((entry) => entry.status === "running")
      .sort((left, right) => +new Date(right.updatedAt) - +new Date(left.updatedAt)),
  };
}
