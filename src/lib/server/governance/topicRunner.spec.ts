import assert from "node:assert/strict";

import { runTopicTick } from "@/lib/server/governance/topicRunner";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { Topic } from "@/types/topic";

function makeTopic(): Topic {
  return {
    id: "goal_topic_runner",
    title: "Topic runner",
    summary: "Track topic progress",
    loop: { kind: "daily" },
    phase: "idle",
    lastTickAt: "2026-05-31T00:00:00.000Z",
    nextTickAt: "2026-06-01T00:00:00.000Z",
    silentCount: 0,
    failureCount: 0,
    threads: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
  };
}

export async function runTopicRunnerSpecs() {
  {
    let seenPrompt = "";
    const invoke: LlmInvoke = async ({ prompt }) => {
      seenPrompt = prompt;
      return {
        rawText: "{}",
        parsed: {
          assessment: "topic is still active",
          confidence: "high",
          actions: [{ kind: "mark_running", reason: "work remains" }],
        },
      };
    };
    const result = await runTopicTick({
      ctx: { topic: makeTopic(), now: new Date("2026-06-01T00:00:00.000Z") },
      invoke,
      agentRunId: "agent-topic-1",
    });
    assert.equal(result.ok, true);
    assert.match(seenPrompt, /Topic governance runner/);
    assert.equal(result.patch.phase, "running");
    assert.equal(result.patch.lastTickAt, "2026-06-01T00:00:00.000Z");
    assert.equal(result.patch.failureCount, 0);
  }

  {
    const invoke: LlmInvoke = async () => ({
      rawText: JSON.stringify({
        assessment: "no topic-level change",
        confidence: "medium",
        actions: [{ kind: "silent", reason: "no new signal" }],
      }),
    });
    const result = await runTopicTick({
      ctx: { topic: makeTopic(), now: new Date("2026-06-01T00:00:00.000Z") },
      invoke,
      agentRunId: "agent-topic-2",
    });
    assert.equal(result.ok, true);
    assert.equal(result.patch.silentCount, 1);
  }

  {
    const invoke: LlmInvoke = async () => ({
      rawText: "{}",
      parsed: { assessment: "missing actions", confidence: "low", actions: [] },
    });
    const result = await runTopicTick({
      ctx: { topic: makeTopic(), now: new Date("2026-06-01T00:00:00.000Z") },
      invoke,
      agentRunId: "agent-topic-3",
    });
    assert.equal(result.ok, false);
    assert.equal(result.patch.phase, "failed");
    assert.equal(result.patch.failureCount, 1);
  }

  {
    const invoke: LlmInvoke = async () => ({
      rawText: "{}",
      parsed: {
        assessment: "cadence should be adjusted but topic remains active",
        confidence: "high",
        actions: [{ kind: "adjust_loop", loop: { kind: "weekly" }, reason: "slow down" }],
      },
    });
    const result = await runTopicTick({
      ctx: { topic: makeTopic(), now: new Date("2026-06-01T00:00:00.000Z") },
      invoke,
      agentRunId: "agent-topic-4",
    });
    assert.equal(result.ok, true);
    assert.equal(result.patch.phase, "idle", "adjust_loop alone must not mark the topic completed");
  }
}
