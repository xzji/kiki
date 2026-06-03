import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  readGoalsSnapshot,
  readGoalsSnapshotMeta,
  upsertGoalsSnapshot,
} from "@/lib/server/runtime/stateSnapshot";
import { deriveOpaqueId } from "@/lib/opaqueIds";
import type { Goal } from "@/types/kiki";

import { mutateGoalsProjection } from "./goalRuntimeService";

const GOAL_ID = deriveOpaqueId("goal", "goal-runtime-service-spec");

function seedGoals(goals: Goal[]) {
  const meta = readGoalsSnapshotMeta([]);
  const first = upsertGoalsSnapshot(goals, meta.revision);
  if (first.ok) return;
  const retry = upsertGoalsSnapshot(goals, first.revision);
  assert.equal(retry.ok, true, "seed goals ok");
}

function buildGoal(): Goal {
  return {
    id: GOAL_ID,
    title: "初始目标",
    deadline: "",
    progress: 0,
    createdAt: "2026-06-03T00:00:00.000Z",
    subGoals: [],
  };
}

export function runGoalRuntimeServiceSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  seedGoals([buildGoal()]);

  let injectedConflict = false;
  const nextGoals = mutateGoalsProjection((goals) => {
    if (!injectedConflict) {
      injectedConflict = true;
      const concurrentMeta = readGoalsSnapshotMeta([]);
      const concurrentGoals = concurrentMeta.value.map((goal) =>
        goal.id === GOAL_ID
          ? { ...goal, title: "并发写入已保留" }
          : goal,
      );
      const write = upsertGoalsSnapshot(concurrentGoals, concurrentMeta.revision);
      assert.equal(write.ok, true, "inject concurrent write");
    }
    return goals.map((goal) =>
      goal.id === GOAL_ID
        ? { ...goal, progress: 42 }
        : goal,
    );
  });

  const stored = readGoalsSnapshot([]).find((goal) => goal.id === GOAL_ID);
  const returned = nextGoals.find((goal) => goal.id === GOAL_ID);
  assert.equal(injectedConflict, true, "conflict injected");
  assert.equal(stored?.title, "并发写入已保留");
  assert.equal(stored?.progress, 42);
  assert.equal(returned?.title, "并发写入已保留");
  assert.equal(returned?.progress, 42);
}
