/**
 * topicsRepository spec — 验证 Topic loop 状态通过 Goal 权威源持久化。
 */

import assert from "node:assert/strict";

import { normalizeGoalId } from "@/lib/opaqueIds";
import { legacyGoalToTopic } from "@/lib/migration/legacyGoalToTopic";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { readGoalsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import { writeGoalsProjection } from "@/lib/server/services/goalRuntimeService";
import type { Goal } from "@/types/kiki";

import {
  TopicNotFoundError,
  TopicRevisionMismatchError,
  findTopicById,
  updateTopic,
} from "./topicsRepository";

function makeGoal(overrides: Partial<Goal> & Pick<Goal, "id" | "title">): Goal {
  return {
    deadline: "",
    progress: 0,
    subGoals: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function seedGoals(goals: Goal[]) {
  const result = writeGoalsProjection(goals);
  assert.equal(result.ok, true, "seed goals ok");
}

export async function runTopicsRepositorySpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // -----------------------------------------------------------------------
  // 1. legacy projection uses default Topic loop when Goal has no topicLoop
  // -----------------------------------------------------------------------
  {
    const topic = legacyGoalToTopic({
      goal: makeGoal({ id: "topic-default-loop", title: "Default Loop" }),
    });
    assert.deepEqual(topic.loop, { kind: "daily" });
    assert.equal(topic.phase, "idle");
    assert.equal(topic.silentCount, 0);
    assert.equal(topic.failureCount, 0);
    assert.equal(topic.revision, 0);
  }

  // -----------------------------------------------------------------------
  // 2. updateTopic writes back to Goal authority fields and bumps topicRevision
  // -----------------------------------------------------------------------
  {
    const topicId = normalizeGoalId("topic-update");
    seedGoals([
      makeGoal({
        id: "topic-update",
        title: "Topic Update",
        topicLoop: { kind: "daily" },
        topicPhase: "idle",
        topicRevision: 2,
      }),
    ]);

    const updated = updateTopic(
      topicId,
      {
        loop: { kind: "interval", everyMs: 900_000, value: 15, unit: "m" },
        phase: "completed",
        lastTickAt: "2026-06-01T00:00:00.000Z",
        nextTickAt: "2026-06-01T00:15:00.000Z",
        silentCount: 4,
        failureCount: 1,
      },
      2,
    );

    assert.equal(updated.revision, 3);
    assert.deepEqual(updated.loop, { kind: "interval", everyMs: 900_000, value: 15, unit: "m" });
    assert.equal(updated.phase, "completed");
    assert.equal(updated.lastTickAt, "2026-06-01T00:00:00.000Z");
    assert.equal(updated.nextTickAt, "2026-06-01T00:15:00.000Z");
    assert.equal(updated.silentCount, 4);
    assert.equal(updated.failureCount, 1);

    const persisted = readGoalsSnapshotMeta([]).value[0];
    assert.deepEqual(persisted?.topicLoop, { kind: "interval", everyMs: 900_000, value: 15, unit: "m" });
    assert.equal(persisted?.topicPhase, "completed");
    assert.equal(persisted?.topicLastTickAt, "2026-06-01T00:00:00.000Z");
    assert.equal(persisted?.topicNextTickAt, "2026-06-01T00:15:00.000Z");
    assert.equal(persisted?.topicSilentCount, 4);
    assert.equal(persisted?.topicFailureCount, 1);
    assert.equal(persisted?.topicRevision, 3);

    const found = findTopicById(topicId);
    assert.equal(found?.revision, 3);
    assert.deepEqual(found?.loop, { kind: "interval", everyMs: 900_000, value: 15, unit: "m" });
  }

  // -----------------------------------------------------------------------
  // 3. topicRevision mismatch prevents stale writes
  // -----------------------------------------------------------------------
  {
    const topicId = normalizeGoalId("topic-revision-conflict");
    seedGoals([
      makeGoal({
        id: "topic-revision-conflict",
        title: "Conflict",
        topicRevision: 7,
      }),
    ]);

    assert.throws(
      () => updateTopic(topicId, { silentCount: 1 }, 6),
      (err: unknown) =>
        err instanceof TopicRevisionMismatchError &&
        err.scope === "topic" &&
        err.expected === 6 &&
        err.actual === 7,
      "topic-level revision mismatch",
    );
  }

  // -----------------------------------------------------------------------
  // 4. missing topic throws and explicit undefined can clear nextTickAt
  // -----------------------------------------------------------------------
  {
    seedGoals([makeGoal({ id: "topic-clear", title: "Clear", topicNextTickAt: "2026-06-02T00:00:00.000Z" })]);
    assert.throws(
      () => updateTopic("missing", { silentCount: 0 }, 0),
      (err: unknown) => err instanceof TopicNotFoundError && err.topicId === "missing",
      "missing topic throws",
    );

    const cleared = updateTopic(normalizeGoalId("topic-clear"), { nextTickAt: undefined }, 0);
    assert.equal(cleared.nextTickAt, undefined);
    assert.equal(readGoalsSnapshotMeta([]).value[0]?.topicNextTickAt, undefined);
  }
}
