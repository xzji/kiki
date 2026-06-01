/**
 * resumeManager spec — covers §9.6 problem 20 three scenarios:
 *  1. saga running + agent_run running + last event = llm.request → pause_run
 *  2. saga awaiting_user → skip (no replay)
 *  3. saga running + last event = dispatch → redispatch_step
 *
 * Plan ref: §9.6 + §10.10.
 */

import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { appendAgentEvent } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import {
  createAgentRun,
  findAgentRunById,
  updateAgentRun,
} from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import {
  createSagaInstance,
  updateSagaInstance,
} from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";

import { resumeAllPendingSagas, resumeSaga } from "./resumeManager";

function findReportFor(reports: ReturnType<typeof resumeAllPendingSagas>, sagaId: string) {
  return reports.find((r) => r.sagaInstanceId === sagaId);
}

export function runResumeManagerSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // --- Scenario 1: saga running, run last event = llm.request → pause ---
  const saga1 = createSagaInstance({ topicId: "topic-rs-1", type: "topic_init" });
  updateSagaInstance({ id: saga1.id, status: "running" });
  const run1 = createAgentRun({
    topicId: "topic-rs-1",
    sagaInstanceId: saga1.id,
    role: "planner",
    status: "running",
  });
  appendAgentEvent({
    agentRunId: run1.id,
    type: "llm.request",
    payloadJson: "{}",
  });

  // --- Scenario 2: saga awaiting_user → skip ---
  const saga2 = createSagaInstance({ topicId: "topic-rs-2", type: "topic_init" });
  updateSagaInstance({ id: saga2.id, status: "awaiting_user" });
  const run2 = createAgentRun({
    topicId: "topic-rs-2",
    sagaInstanceId: saga2.id,
    role: "interviewer",
    status: "running",
  });
  appendAgentEvent({
    agentRunId: run2.id,
    type: "awaiting_user",
    payloadJson: "{}",
  });

  // --- Scenario 3: saga running, run last event = dispatch → redispatch ---
  const saga3 = createSagaInstance({ topicId: "topic-rs-3", type: "topic_init" });
  updateSagaInstance({ id: saga3.id, status: "running" });
  const run3 = createAgentRun({
    topicId: "topic-rs-3",
    sagaInstanceId: saga3.id,
    role: "refiner",
    status: "running",
  });
  appendAgentEvent({ agentRunId: run3.id, type: "llm.request", payloadJson: "{}" });
  appendAgentEvent({ agentRunId: run3.id, type: "llm.response", payloadJson: "{}" });
  appendAgentEvent({ agentRunId: run3.id, type: "dispatch", payloadJson: "{}" });

  const reports = resumeAllPendingSagas();

  const r1 = findReportFor(reports, saga1.id);
  assert.ok(r1);
  assert.ok(r1!.actions.some((a) => a.kind === "pause_run"));
  const updated1 = findAgentRunById(run1.id);
  assert.equal(updated1?.status, "paused");

  const r2 = findReportFor(reports, saga2.id);
  assert.ok(r2);
  assert.equal(r2!.actions[0].kind, "skip");
  const untouched2 = findAgentRunById(run2.id);
  assert.equal(untouched2?.status, "running");

  const r3 = findReportFor(reports, saga3.id);
  assert.ok(r3);
  assert.ok(r3!.actions.some((a) => a.kind === "redispatch_step"));
  const untouched3 = findAgentRunById(run3.id);
  assert.equal(untouched3?.status, "running");

  // Direct invocation works as well.
  const direct = resumeSaga({ ...saga1, status: "running" });
  assert.equal(direct.sagaInstanceId, saga1.id);
}
