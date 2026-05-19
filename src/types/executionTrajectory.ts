import type { AgentRole } from "@/types/agentOrchestration";

export type ExecutionTrajectoryStepType =
  | "system"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "approval"
  | "result"
  | "error";

export type ExecutionTrajectoryStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "awaiting_user";

export type ExecutionTrajectoryToolCall = {
  name: string;
  input?: unknown;
  summary?: string;
};

export type ExecutionTrajectoryToolResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

export type ExecutionTrajectoryStep = {
  id: string;
  index: number;
  type: ExecutionTrajectoryStepType;
  status: ExecutionTrajectoryStepStatus;
  title: string;
  agentRole?: AgentRole;
  thought?: string;
  toolCall?: ExecutionTrajectoryToolCall;
  toolResult?: ExecutionTrajectoryToolResult;
  handoff?: {
    fromRole?: AgentRole;
    toRole?: AgentRole;
    summary: string;
  };
  startedAt: string;
  endedAt?: string;
};
