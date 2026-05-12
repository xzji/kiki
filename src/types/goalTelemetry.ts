import type { GoalWorkflowPhase } from "@/types/kiki";

export type GoalTelemetryScope = "goal_plan" | "goal_collect" | "goal_task_execute";
export type GoalTaskStepEventType =
  | "phase_started"
  | "tool_call_started"
  | "tool_call_finished"
  | "assistant_output"
  | "retry_scheduled"
  | "await_user"
  | "result_ready"
  | "resume_mode_started"
  | "resume_duplicate_tool_call"
  | "resume_replanning_detected"
  | "readiness_semantic_judge";

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
  goalId?: string;
  taskId?: string;
  taskInstanceId?: string;
  attemptCount?: number;
  summary?: string;
  resultPayload?: Record<string, unknown> | null;
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
  eventType?: GoalTaskStepEventType;
  goalId?: string;
  taskId?: string;
  taskInstanceId?: string;
  toolName?: string;
  status?: "pending" | "running" | "completed" | "failed" | "awaiting_user";
};

export type GoalServerLogsResponse = {
  logs: GoalServerLogEntry[];
  activeRequests: GoalServerProgress[];
};
