import assert from "node:assert/strict";

import {
  readCadenceHistoryFromMemory,
  tuneLoopCadence,
  tuneTopicTickPatch,
  writeCadenceHistoryToMemory,
} from "@/lib/server/governance/cadenceTuner";
import type { Topic } from "@/types/topic";

const NOW = new Date("2026-06-01T08:00:00.000Z");

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: "topic-cadence",
    title: "Topic",
    summary: "Summary",
    loop: { kind: "weekly" },
    phase: "idle",
    silentCount: 0,
    failureCount: 0,
    threads: [],
    status: "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

export function runCadenceTunerSpecs() {
  {
    const result = tuneLoopCadence({
      entityKind: "thread",
      currentLoop: { kind: "weekly" },
      deadline: "2026-06-02T08:00:00.000Z",
      silentCount: 0,
      now: NOW,
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.loop, { kind: "daily" });
    assert.deepEqual(result.reasons, ["deadline_upgrade"]);
    assert.equal(result.history.length, 1);
  }

  {
    const result = tuneLoopCadence({
      entityKind: "thread",
      currentLoop: { kind: "hourly" },
      silentCount: 4,
      now: NOW,
    });
    assert.deepEqual(result.loop, { kind: "weekly" });
    assert.deepEqual(result.reasons, ["silent_downgrade"]);
  }

  {
    const result = tuneLoopCadence({
      entityKind: "thread",
      currentLoop: { kind: "weekly" },
      silentCount: 3,
      hasImportantOutput: true,
      now: NOW,
    });
    assert.deepEqual(result.loop, { kind: "hourly" });
    assert.deepEqual(result.reasons, ["silent_downgrade", "important_output_boost"]);
    assert.ok(result.appendedHistory?.boostUntil);
  }

  {
    const first = tuneLoopCadence({
      entityKind: "thread",
      currentLoop: { kind: "weekly" },
      silentCount: 0,
      hasImportantOutput: true,
      now: NOW,
    });
    const second = tuneLoopCadence({
      entityKind: "thread",
      currentLoop: { kind: "daily" },
      silentCount: 0,
      now: new Date("2026-06-01T12:00:00.000Z"),
      history: first.history,
    });
    assert.deepEqual(second.loop, { kind: "hourly" });
    assert.deepEqual(second.reasons, ["important_output_boost_active"]);
  }

  {
    const memory = writeCadenceHistoryToMemory({}, [
      {
        at: NOW.toISOString(),
        entityKind: "thread",
        from: { kind: "weekly" },
        to: { kind: "daily" },
        reasons: ["deadline_upgrade"],
        silentCount: 0,
      },
    ]);
    assert.equal(readCadenceHistoryFromMemory(memory).length, 1);
  }

  {
    const tuned = tuneTopicTickPatch({
      topic: makeTopic({ deadline: "2026-06-01T12:00:00.000Z" }),
      patch: { lastTickAt: NOW.toISOString(), silentCount: 0 },
      now: NOW,
    });
    assert.deepEqual(tuned.patch.loop, { kind: "hourly" });
    assert.ok(tuned.patch.nextTickAt);
    assert.equal(tuned.cadenceHistory.length, 1);
  }
}
