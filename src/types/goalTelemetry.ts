import type { GoalWorkflowPhase } from "@/types/kiki";

export type GoalTelemetryScope = "goal_plan" | "goal_collect";

export type GoalProgressStatus = "running" | "completed" | "failed";

export type GoalServerProgress = {
  requestId: string;
  scope: GoalTelemetryScope;
  status: GoalProgressStatus;
  phase: GoalWorkflowPhase;
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
};

export type GoalServerLogLevel = "info" | "warn" | "error";

export type GoalServerLogEntry = {
  id: string;
  timestamp: string;
  requestId?: string;
  scope: GoalTelemetryScope;
  level: GoalServerLogLevel;
  phase?: GoalWorkflowPhase;
  message: string;
  details?: string;
};

export type GoalServerLogsResponse = {
  logs: GoalServerLogEntry[];
  activeRequests: GoalServerProgress[];
};
