/**
 * agentExecutor spec — verifies the run lifecycle + event sourcing pipeline.
 * Plan ref: §9.6.
 */

import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { listAgentEvents } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import { createAgentRun, findAgentRunById } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { loadAgentSnapshot } from "@/lib/server/repositories/agentRuntime/agentSnapshotsRepository";
import { createSagaInstance } from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";

import { executeAgentRun } from "./agentExecutor";

export async function runAgentExecutorSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // --- Happy path: run completes, events recorded, snapshot upserted ---
  const saga = createSagaInstance({ topicId: "topic-exec-1", type: "topic_init" });
  const run = createAgentRun({
    topicId: "topic-exec-1",
    sagaInstanceId: saga.id,
    role: "planner",
  });

  const happyResult = await executeAgentRun({
    agentRunId: run.id,
    prompt: "decide threads",
    invoke: async () => ({
      rawText: "{\"threads\":[]}",
      parsed: { threads: [] },
    }),
  });

  assert.equal(happyResult.run.status, "completed");
  const events = listAgentEvents({ agentRunId: run.id });
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["llm.request", "llm.response", "decision"]);
  assert.equal(events[0].seq, 1);
  assert.equal(events[2].seq, 3);

  const snapshot = loadAgentSnapshot(run.id);
  assert.ok(snapshot, "snapshot should be upserted");
  assert.equal(snapshot!.lastEventSeq, 3);

  // --- Failure path: invoke throws → status=failed + error event ---
  const run2 = createAgentRun({
    topicId: "topic-exec-1",
    sagaInstanceId: saga.id,
    role: "critic",
  });

  let threw = false;
  try {
    await executeAgentRun({
      agentRunId: run2.id,
      prompt: "review",
      invoke: async () => {
        throw new Error("boom");
      },
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, true);

  const failed = findAgentRunById(run2.id);
  assert.equal(failed?.status, "failed");

  const errorEvents = listAgentEvents({ agentRunId: run2.id });
  assert.deepEqual(
    errorEvents.map((e) => e.type),
    ["llm.request", "error"],
  );
}
