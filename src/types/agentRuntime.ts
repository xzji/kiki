/**
 * Agent Runtime types — Topic / Thread Event Sourcing infrastructure.
 *
 * Plan ref: .trae/documents/Topic_Thread_代码实现计划_v1.md §3.1.3 + §9.1
 *
 * Note: this is the *generic* runtime layer that powers Topic Init Saga and
 * Thread Loop Saga. It is intentionally **separate from**
 * `src/types/agentOrchestration.ts`, which describes the legacy single-task
 * 5-role collaboration (coordinator/researcher/executor/reviewer/synthesizer).
 */

export type AgentRunRole =
  | "interviewer"
  | "planner"
  | "critic"
  | "refiner"
  | "presenter"
  | "thread_runner";

export type AgentRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "paused";

export type AgentEventType =
  | "llm.request"
  | "llm.response"
  | "decision"
  | "dispatch"
  | "message"
  | "error"
  | "thread_paused"
  | "snapshot"
  | "awaiting_user"
  | "forced_accept"
  | "presentation_failed";

export type AgentRun = {
  id: string;
  topicId?: string;
  threadId?: string;
  taskId?: string;
  sagaInstanceId?: string;
  role: AgentRunRole;
  status: AgentRunStatus;
  startedAt: string;
  finishedAt?: string;
  lastEventSeq: number;
  revision: number;
  idempotencyKey?: string;
};

export type AgentEvent = {
  id: string;
  agentRunId: string;
  seq: number;
  type: AgentEventType;
  /** Inline payload (≤ 8KB after JSON.stringify). May be empty object when payloadRef is set. */
  payload: Record<string, unknown>;
  /** Set when the original payload exceeded 8KB and was off-loaded to disk. */
  payloadRef?: string;
  createdAt: string;
};

export type AgentMessageKind = "handoff" | "review" | "refinement";

export type AgentMessage = {
  id: string;
  sagaInstanceId: string;
  fromRole: AgentRunRole;
  toRole: AgentRunRole;
  kind: AgentMessageKind;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type SagaType = "topic_init" | "thread_loop";

export type SagaStatus =
  | "pending"
  | "running"
  | "awaiting_user"
  | "completed"
  | "failed";

export type SagaInstance = {
  id: string;
  topicId: string;
  type: SagaType;
  status: SagaStatus;
  currentStep?: string;
  retryCount: number;
  revision: number;
  startedAt: string;
  finishedAt?: string;
  idempotencyKey?: string;
};

export type AgentSnapshot = {
  agentRunId: string;
  lastEventSeq: number;
  state: Record<string, unknown>;
  updatedAt: string;
};

/** Hard cap for inline event payload size, in bytes. */
export const AGENT_EVENT_PAYLOAD_INLINE_LIMIT_BYTES = 8 * 1024;
