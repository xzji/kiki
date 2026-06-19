import assert from "node:assert/strict";

import {
  isGovernanceTickCommand,
  isGovernanceTickMachineResult,
  isGovernanceTickOutcome,
} from "@/lib/server/governance/governanceTickProtocol";

export function runGovernanceTickProtocolSpecs() {
  const command = {
    type: "thread_governance_tick",
    requestId: "req-1",
    governanceJobId: "job-1",
    leaseOwner: "worker-1",
    leaseToken: "lease-1",
    targetKind: "thread",
    payload: {
      targetKind: "thread",
      topicId: "goal_1",
      threadId: "sg_1",
      baseRevision: 0,
      snapshot: { topic: {}, thread: {}, currentTasks: [], recentTaskInstances: [] },
    },
  };
  assert.equal(isGovernanceTickCommand(command), true, "thread governance command schema accepted");
  assert.equal(
    isGovernanceTickCommand({ ...command, type: "topic_governance_tick" }),
    false,
    "command type must match targetKind",
  );
  assert.equal(
    isGovernanceTickCommand({
      ...command,
      payload: { ...command.payload, snapshot: { topic: {}, thread: {} } },
    }),
    false,
    "thread payload missing currentTasks/recentTaskInstances must be rejected",
  );

  const topicCommand = {
    ...command,
    type: "topic_governance_tick",
    targetKind: "topic",
    payload: {
      targetKind: "topic",
      topicId: "goal_1",
      baseRevision: 0,
      snapshot: { topic: {}, threads: [] },
    },
  };
  assert.equal(isGovernanceTickCommand(topicCommand), true, "topic governance command schema accepted");
  assert.equal(
    isGovernanceTickCommand({
      ...topicCommand,
      payload: { ...topicCommand.payload, snapshot: { topic: {} } },
    }),
    false,
    "topic payload missing threads must be rejected",
  );

  const threadOutcome = {
    governanceJobId: "job-1",
    targetKind: "thread",
    topicId: "goal_1",
    threadId: "sg_1",
    baseRevision: 0,
    result: {
      ok: true,
      patch: {
        status: "active",
        lastTickAt: "2026-06-01T00:00:00.000Z",
        memory: {},
        silentCount: 1,
        failureCount: 0,
        infraFailureCount: 0,
      },
      output: {
        assessment: "no change",
        confidence: "high",
        actions: [{ kind: "silent", reason: "no change" }],
      },
    },
    currentTasks: [],
  };
  assert.equal(isGovernanceTickOutcome(threadOutcome), true, "thread outcome schema accepted");

  // §candidate-6 P4: 深化 guards 后这些异常 outcome 应被拒
  assert.equal(
    isGovernanceTickOutcome({
      ...threadOutcome,
      result: {
        ...threadOutcome.result,
        output: { ...threadOutcome.result.output, confidence: "very-high" },
      },
    }),
    false,
    "invalid confidence value must be rejected",
  );
  assert.equal(
    isGovernanceTickOutcome({
      ...threadOutcome,
      result: {
        ...threadOutcome.result,
        output: { ...threadOutcome.result.output, actions: [{ kind: "unknown_kind", reason: "x" }] },
      },
    }),
    false,
    "unknown action kind must be rejected",
  );
  assert.equal(
    isGovernanceTickOutcome({
      ...threadOutcome,
      result: {
        ...threadOutcome.result,
        output: { ...threadOutcome.result.output, actions: [{}] },
      },
    }),
    false,
    "shape-only action object must be rejected",
  );
  assert.equal(
    isGovernanceTickOutcome({
      ...threadOutcome,
      result: { ...threadOutcome.result, patch: { ...threadOutcome.result.patch, status: "weird" } },
    }),
    false,
    "invalid thread status must be rejected",
  );
  assert.equal(
    isGovernanceTickMachineResult({
      type: "thread_governance_tick",
      governanceJobId: "job-1",
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
      ok: true,
      outcome: threadOutcome,
    }),
    true,
    "machine result accepts matching thread outcome",
  );
  assert.equal(
    isGovernanceTickMachineResult({
      type: "topic_governance_tick",
      governanceJobId: "job-1",
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
      ok: true,
      outcome: threadOutcome,
    }),
    false,
    "machine result rejects mismatched outcome kind",
  );

  const topicOutcome = {
    governanceJobId: "job-2",
    targetKind: "topic",
    topicId: "goal_1",
    baseRevision: 0,
    ok: true,
    patch: {
      phase: "completed",
      lastTickAt: "2026-06-01T00:00:00.000Z",
      nextTickAt: "2026-06-02T00:00:00.000Z",
      silentCount: 0,
      failureCount: 0,
    },
  };
  assert.equal(isGovernanceTickOutcome(topicOutcome), true, "topic outcome schema accepted");
  assert.equal(isGovernanceTickOutcome({ ...topicOutcome, patch: null }), false, "topic outcome requires patch");
}
