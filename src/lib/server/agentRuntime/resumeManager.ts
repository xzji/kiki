/**
 * resumeManager — daemon restart hook.
 *
 * Plan ref: §3.1.4 + §9.6 problem 20. On daemon boot we walk every saga that is
 * still in a non-terminal state and decide what to do:
 *
 *  - status="running" + last event is "llm.request" without a paired
 *    "llm.response" → mark the run as paused and surface to UI for retry.
 *  - status="awaiting_user" → leave alone (saga waits for a /commands resume).
 *  - status="running" + last event is "dispatch" → next tick will pick up;
 *    nothing to do here.
 *
 * The actual *replay* of saga step logic is owned by each concrete saga (it
 * knows which step it is on); resumeManager only ensures lifecycle bookkeeping
 * is consistent and emits a synthetic snapshot event for observability.
 */

import {
  findAgentRunById,
  listRunningAgentRunsBySaga,
  updateAgentRun,
} from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { getLastAgentEvent } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import { listRunningSagas } from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";
import type { AgentRun, SagaInstance } from "@/types/agentRuntime";

import { appendGuardedEvent } from "./agentExecutor";

export type ResumeAction =
  | { kind: "skip"; reason: string }
  | { kind: "pause_run"; agentRunId: string }
  | { kind: "redispatch_step"; sagaInstanceId: string; agentRunId: string };

export type ResumeReport = {
  sagaInstanceId: string;
  status: SagaInstance["status"];
  actions: ResumeAction[];
};

function classifyRun(run: AgentRun): ResumeAction {
  const last = getLastAgentEvent(run.id);
  if (!last) {
    return { kind: "skip", reason: `agent_run ${run.id} has no events` };
  }
  if (last.type === "llm.request") {
    return { kind: "pause_run", agentRunId: run.id };
  }
  if (last.type === "dispatch") {
    return { kind: "redispatch_step", sagaInstanceId: run.sagaInstanceId ?? "", agentRunId: run.id };
  }
  return { kind: "skip", reason: `last event type ${last.type} requires no resume action` };
}

/**
 * Drive a single saga through the resume policy. Returns the report so
 * callers (daemonRunner) can log per-saga decisions.
 */
export function resumeSaga(saga: SagaInstance): ResumeReport {
  const actions: ResumeAction[] = [];

  if (saga.status === "awaiting_user") {
    actions.push({ kind: "skip", reason: "awaiting user input — no replay" });
    return { sagaInstanceId: saga.id, status: saga.status, actions };
  }

  const runs = listRunningAgentRunsBySaga(saga.id);
  for (const run of runs) {
    const action = classifyRun(run);
    actions.push(action);
    if (action.kind === "pause_run") {
      updateAgentRun({
        id: run.id,
        status: "paused",
      });
      appendGuardedEvent({
        agentRunId: run.id,
        type: "snapshot",
        payload: { reason: "resume_pause", recoveredAt: new Date().toISOString() },
      });
    }
  }

  return { sagaInstanceId: saga.id, status: saga.status, actions };
}

/** Walk every non-terminal saga at boot. */
export function resumeAllPendingSagas(): ResumeReport[] {
  const sagas = listRunningSagas();
  return sagas.map(resumeSaga);
}

/** Test helper: re-run classification against a single run. */
export function classifyRunForTesting(agentRunId: string): ResumeAction {
  const run = findAgentRunById(agentRunId);
  if (!run) return { kind: "skip", reason: `unknown run ${agentRunId}` };
  return classifyRun(run);
}
