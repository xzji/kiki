/**
 * agentRunCommandService spec — covers state-machine transitions, revision
 * lock and validation errors for /api/agents/runs/commands.
 *
 * Plan ref: §3.1.5 + §10.10.
 */

import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  createAgentRun,
  findAgentRunById,
  updateAgentRun,
} from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { listAgentEvents } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import {
  createSagaInstance,
  findSagaInstanceById,
  updateSagaInstance,
} from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";

import {
  applyAgentRunCommand,
  AgentRunCommandConflictError,
  AgentRunCommandIdempotencyConflictError,
  AgentRunCommandValidationError,
} from "../services/agentRunCommandService";

export function runAgentRunCommandServiceSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // 1. pause running run → paused，并同步 saga → awaiting_user
  const saga1 = createSagaInstance({ topicId: "topic-cmd-pause", type: "topic_init" });
  updateSagaInstance({ id: saga1.id, status: "running" });
  const run1 = createAgentRun({
    role: "planner",
    status: "running",
    sagaInstanceId: saga1.id,
  });
  const r1 = applyAgentRunCommand({
    command: { kind: "pause", agentRunId: run1.id },
    idempotencyKey: "ik-1",
  });
  assert.equal(r1.agentRun.status, "paused");
  assert.equal(findSagaInstanceById(saga1.id)?.status, "awaiting_user");

  // 2. resume paused run → running，并同步 saga → running
  const r2 = applyAgentRunCommand({
    command: { kind: "resume", agentRunId: run1.id, input: { ack: true } },
    idempotencyKey: "ik-2",
  });
  assert.equal(r2.agentRun.status, "running");
  assert.equal(findSagaInstanceById(saga1.id)?.status, "running");

  // 3. cancel mirrors to saga (running saga becomes failed)
  const saga = createSagaInstance({ topicId: "topic-cmd-1", type: "topic_init" });
  updateSagaInstance({ id: saga.id, status: "running" });
  const run3 = createAgentRun({
    role: "thread_runner",
    status: "running",
    sagaInstanceId: saga.id,
  });
  const r3 = applyAgentRunCommand({
    command: { kind: "cancel", agentRunId: run3.id },
    idempotencyKey: "ik-3",
  });
  assert.equal(r3.agentRun.status, "failed");
  const sagaAfter = findSagaInstanceById(saga.id);
  assert.equal(sagaAfter?.status, "failed");

  // 4. retry only allowed from failed
  const run4 = createAgentRun({ role: "presenter", status: "running" });
  let threwValidation = false;
  try {
    applyAgentRunCommand({
      command: { kind: "retry", agentRunId: run4.id },
      idempotencyKey: "ik-4",
    });
  } catch (err) {
    if (err instanceof AgentRunCommandValidationError) threwValidation = true;
  }
  assert.equal(threwValidation, true);

  // After marking failed, retry should reset to pending
  updateAgentRun({ id: run4.id, status: "failed" });
  const r4 = applyAgentRunCommand({
    command: { kind: "retry", agentRunId: run4.id },
    idempotencyKey: "ik-5",
  });
  assert.equal(r4.agentRun.status, "pending");

  // 5. revision conflict
  const run5 = createAgentRun({ role: "critic", status: "running" });
  const stale = findAgentRunById(run5.id)!;
  // simulate concurrent update bumping the revision first
  updateAgentRun({ id: run5.id, status: "paused" });
  let threwConflict = false;
  try {
    applyAgentRunCommand({
      command: { kind: "cancel", agentRunId: run5.id },
      idempotencyKey: "ik-6",
      baseRevision: stale.revision,
    });
  } catch (err) {
    if (err instanceof AgentRunCommandConflictError) threwConflict = true;
  }
  assert.equal(threwConflict, true);
  assert.equal(
    listAgentEvents({ agentRunId: run5.id }).some((event) => event.payload.command === "cancel"),
    false,
  );

  // 6. unknown run id → validation 404
  let threwNotFound = false;
  try {
    applyAgentRunCommand({
      command: { kind: "pause", agentRunId: "agent-run-does-not-exist" },
      idempotencyKey: "ik-7",
    });
  } catch (err) {
    if (err instanceof AgentRunCommandValidationError && err.status === 404) {
      threwNotFound = true;
    }
  }
  assert.equal(threwNotFound, true);

  // 7. idempotency short-circuit：相同 key + 相同 kind 重复 POST 不再推进 revision
  const run7 = createAgentRun({ role: "planner", status: "running" });
  const first = applyAgentRunCommand({
    command: { kind: "pause", agentRunId: run7.id },
    idempotencyKey: "ik-idem-same",
  });
  const firstRevision = first.agentRun.revision;
  const second = applyAgentRunCommand({
    command: { kind: "pause", agentRunId: run7.id },
    idempotencyKey: "ik-idem-same",
  });
  // 重复命令不应再产生事件 / 推 revision
  assert.equal(second.agentRun.revision, firstRevision);
  assert.equal(second.agentRun.status, "paused");

  // 8. idempotency 冲突：相同 key 但 kind 不同 → 409
  let threwIdemConflict = false;
  try {
    applyAgentRunCommand({
      command: { kind: "cancel", agentRunId: run7.id },
      idempotencyKey: "ik-idem-same",
    });
  } catch (err) {
    if (err instanceof AgentRunCommandIdempotencyConflictError) {
      threwIdemConflict = true;
    }
  }
  assert.equal(threwIdemConflict, true);

  // 9. 缺失 idempotencyKey → 400 validation
  let threwMissingKey = false;
  try {
    applyAgentRunCommand({
      command: { kind: "pause", agentRunId: run7.id },
      idempotencyKey: "",
    });
  } catch (err) {
    if (err instanceof AgentRunCommandValidationError && err.status === 400) {
      threwMissingKey = true;
    }
  }
  assert.equal(threwMissingKey, true);
}
