import assert from "node:assert/strict";

import { handleGovernanceTickDaemonCommand } from "@/lib/daemon/remoteDaemonLoop";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { GovernanceTickMachineCommand } from "@/lib/server/governance/governanceTickProtocol";
import type { MachineResult } from "@/lib/server/tunnel/tunnelHub";
import type { Topic } from "@/types/topic";

function makeTopic(): Topic {
  return {
    id: "goal_daemon_governance",
    title: "Daemon governance",
    summary: "Run topic governance locally",
    loop: { kind: "daily" },
    phase: "idle",
    lastTickAt: "2026-05-31T00:00:00.000Z",
    nextTickAt: "2026-06-01T00:00:00.000Z",
    silentCount: 0,
    failureCount: 0,
    infraFailureCount: 0,
    threads: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
  };
}

export async function runRemoteDaemonLoopSpecs() {
  const topic = makeTopic();
  const command: GovernanceTickMachineCommand = {
    type: "topic_governance_tick",
    requestId: "req-governance-topic",
    governanceJobId: "job-governance-topic",
    leaseOwner: "lease-owner",
    leaseToken: "lease-token",
    targetKind: "topic",
    payload: {
      targetKind: "topic",
      topicId: topic.id,
      baseRevision: topic.revision,
      snapshot: { topic },
      dueReason: "interval_due",
      scheduledAt: "2026-06-01T00:00:00.000Z",
    },
  };
  const invoke: LlmInvoke = async ({ context }) => {
    assert.deepEqual(context, { topicId: topic.id });
    return {
      rawText: "{}",
      parsed: {
        assessment: "topic can continue",
        confidence: "high",
        actions: [{ kind: "mark_running", reason: "still active" }],
      },
    };
  };
  const sent: MachineResult[] = [];
  const result = await handleGovernanceTickDaemonCommand({
    command,
    invoke,
    now: new Date("2026-06-01T00:00:00.000Z"),
    sendResult: async (machineResult) => {
      sent.push(machineResult);
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(result.type, "topic_governance_tick");
  assert.equal(result.ok, true);
  assert.equal(result.governanceJobId, command.governanceJobId);
  assert.equal(result.leaseOwner, command.leaseOwner);
  assert.equal(result.leaseToken, command.leaseToken);
  assert.equal(result.outcome?.targetKind, "topic");
  if (result.outcome?.targetKind !== "topic") throw new Error("expected topic outcome");
  assert.equal(result.outcome.ok, true);
  assert.equal(result.outcome.patch.phase, "running");
}
