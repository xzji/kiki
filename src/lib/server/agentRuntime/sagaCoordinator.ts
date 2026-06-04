/**
 * sagaCoordinator — generic saga state machine helpers.
 *
 * Plan ref: §3.1.4 + §9.2. This module is *not* a saga itself; the concrete
 * sagas (TopicInitSaga, ThreadLoopSaga) call into these helpers to advance
 * `saga_instances` rows in a uniform way.
 *
 * Coordinator responsibilities:
 *  - advance(): move a saga to the next step (writes current_step + revision)
 *  - markAwaitingUser(): pause for user input (Interviewer needs_user_input case)
 *  - markCompleted(): terminal success
 *  - markFailed(): terminal failure with reason
 *  - retry(): increment retry_count
 */

import {
  findSagaInstanceById,
  incrementSagaRetry,
  updateSagaInstance,
} from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import type { SagaInstance, SagaStatus } from "@/types/agentRuntime";

import { appendGuardedEvent } from "./agentExecutor";

export type AdvanceSagaInput = {
  sagaInstanceId: string;
  toStep: string;
  /** Optional agent_run id to also tag with a "dispatch" event. */
  notifyAgentRunId?: string;
  expectedRevision?: number;
};

export function advanceSaga(input: AdvanceSagaInput): SagaInstance | null {
  const next = updateSagaInstance({
    id: input.sagaInstanceId,
    status: "running",
    currentStep: input.toStep,
    expectedRevision: input.expectedRevision,
  });
  if (next && input.notifyAgentRunId) {
    appendGuardedEvent({
      agentRunId: input.notifyAgentRunId,
      type: "dispatch",
      payload: { sagaInstanceId: input.sagaInstanceId, toStep: input.toStep },
    });
  }
  publishSagaStep(next, `advance:${input.toStep}:${next?.revision ?? 0}`);
  return next;
}

export function markAwaitingUser(
  sagaInstanceId: string,
  reason: { agentRunId: string; questions: string[] },
): SagaInstance | null {
  appendGuardedEvent({
    agentRunId: reason.agentRunId,
    type: "awaiting_user",
    payload: { questions: reason.questions },
  });
  const next = updateSagaInstance({
    id: sagaInstanceId,
    status: "awaiting_user",
  });
  publishSagaStep(next, `awaiting_user:${next?.revision ?? 0}`);
  return next;
}

export function markCompleted(sagaInstanceId: string): SagaInstance | null {
  const next = updateSagaInstance({
    id: sagaInstanceId,
    status: "completed",
    finishedAt: new Date().toISOString(),
  });
  publishSagaStep(next, `completed:${next?.revision ?? 0}`);
  return next;
}

export function markFailed(
  sagaInstanceId: string,
  reason: { agentRunId?: string; message: string },
): SagaInstance | null {
  if (reason.agentRunId) {
    appendGuardedEvent({
      agentRunId: reason.agentRunId,
      type: "error",
      payload: { message: reason.message },
    });
  }
  const next = updateSagaInstance({
    id: sagaInstanceId,
    status: "failed",
    finishedAt: new Date().toISOString(),
  });
  publishSagaStep(next, `failed:${next?.revision ?? 0}`);
  return next;
}

export function retrySaga(sagaInstanceId: string): SagaInstance | null {
  incrementSagaRetry(sagaInstanceId);
  return findSagaInstanceById(sagaInstanceId);
}

/** Mirrors the SagaStatus → next allowed transitions used by /commands route. */
export function isTerminalStatus(status: SagaStatus): boolean {
  return status === "completed" || status === "failed";
}

function publishSagaStep(saga: SagaInstance | null, suffix: string) {
  if (!saga) return;
  try {
    appendGoalEventOnce({
      goalId: saga.topicId,
      kind: "saga.step.advanced",
      payload: { saga },
      producedBy: "daemon",
      idempotencyKey: `saga.step.advanced:${saga.id}:${suffix}`,
    });
  } catch {
    // Runtime projection events are best-effort; saga state remains durable.
  }
}
