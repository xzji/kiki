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
      snapshot: { topic: {}, thread: {} },
    },
  };
  assert.equal(isGovernanceTickCommand(command), true, "thread governance command schema accepted");
  assert.equal(
    isGovernanceTickCommand({ ...command, type: "topic_governance_tick" }),
    false,
    "command type must match targetKind",
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
