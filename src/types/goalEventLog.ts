import type { AgentEvent, AgentRun, SagaInstance } from "@/types/agentRuntime";
import type { GoalWorkflowPhase, TaskInstanceStatus } from "@/types/kiki";

export type GoalEventKind =
  | "goal.workflow_changed"
  | "goal.structure_changed"
  | "job.status_changed"
  | "instance.created"
  | "instance.status_changed"
  | "instance.progress"
  | "instance.artifact_produced"
  | "instance.notification_pending"
  | "notification.delivered"
  | "instance.user_response"
  | "instance.timeout_paused"
  | "instance.user_command"
  | "task.definition_amended"
  | "schedule.event_synthesized"
  // Topic/Thread runtime events — Plan ref: §10.6 problem 26
  | "agent.run.started"
  | "agent.run.event"
  | "agent.run.completed"
  | "saga.step.advanced"
  | "topic.created"
  | "topic.updated"
  | "thread.tick.started"
  | "thread.tick.completed";

export type GoalEventProducer = "scheduler" | "worker" | "user" | "judge" | "daemon" | "api";

export type GoalEventPayloadMap = {
  "goal.workflow_changed": {
    previousPhase?: GoalWorkflowPhase;
    nextPhase: GoalWorkflowPhase;
    reason?: string;
  };
  "goal.structure_changed": {
    action:
      | "goal.created"
      | "goal.plan_replaced"
      | "task.updated"
      | "task.created"
      | "task.deleted"
      | "sub_goal.created"
      | "goal.conversation_unlinked";
    entityId?: string;
    entityHash?: string;
    parentId?: string;
    title?: string;
  };
  "job.status_changed": {
    previousStatus?: "queued" | "running" | "awaiting_user" | "completed" | "failed" | "cancelled";
    nextStatus: "queued" | "running" | "awaiting_user" | "completed" | "failed" | "cancelled";
    requestId?: string;
    reason?: string;
  };
  "instance.created": {
    requestId?: string;
    status: TaskInstanceStatus;
    runtimeEnvId?: string;
    source: "scheduler" | "user" | "feedback" | "resume";
  };
  "instance.status_changed": {
    previousStatus?: TaskInstanceStatus | "failed" | "cancelled" | "queued" | "running";
    nextStatus: TaskInstanceStatus | "failed" | "cancelled" | "queued" | "running";
    requestId?: string;
    reason?: string;
  };
  "instance.progress": {
    requestId?: string;
    message?: string;
    progress?: unknown;
    trajectoryLength?: number;
  };
  "instance.artifact_produced": {
    requestId?: string;
    artifactIds?: string[];
    artifactCount?: number;
  };
  "instance.notification_pending": {
    requestId?: string;
    reason?: string;
  };
  "notification.delivered": {
    target: "inbox" | "conversation" | "schedule";
    notificationId?: string;
  };
  "instance.user_response": {
    responseId?: string;
    responseSummary?: string;
  };
  "instance.timeout_paused": {
    reason: string;
    timeoutMs?: number;
  };
  "instance.user_command": {
    command: "pause" | "resume" | "retry" | "cancel" | "transition";
    reason?: string;
  };
  "task.definition_amended": {
    source: "conversation_governance";
    message?: string;
    patch?: unknown;
  };
  "schedule.event_synthesized": {
    scheduleEventId: string;
  };
  // Topic/Thread runtime payloads — Plan ref: §10.6 problem 26
  "agent.run.started": { run: AgentRun };
  "agent.run.event": { event: AgentEvent };
  "agent.run.completed": { run: AgentRun };
  "saga.step.advanced": { saga: SagaInstance };
  "topic.created": { topicId: string; title: string };
  "topic.updated": { topicId: string; revision: number };
  "thread.tick.started": { threadId: string; tickAt: string };
  "thread.tick.completed": {
    threadId: string;
    silentCount?: number;
    failureCount?: number;
  };
};

export type GoalEventPayload<K extends GoalEventKind = GoalEventKind> = GoalEventPayloadMap[K];

export type GoalEventRecord<K extends GoalEventKind = GoalEventKind> = {
  id: number;
  eventId: string;
  goalId: string;
  taskId?: string;
  instanceId?: string;
  kind: K;
  payload: GoalEventPayload<K>;
  producedBy: GoalEventProducer;
  idempotencyKey?: string;
  createdAt: string;
};
