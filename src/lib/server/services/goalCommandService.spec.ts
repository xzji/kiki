import assert from "node:assert/strict";

import { normalizeGoalId } from "@/lib/opaqueIds";
import { getGoalEventByIdempotencyKey } from "@/lib/server/repositories/goalEventLogRepository";
import { readGoalsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import {
  applyGoalCommand,
  GoalCommandConflictError,
} from "@/lib/server/services/goalCommandService";
import type { Goal } from "@/types/kiki";

function makeGoal(id: string): Goal {
  return {
    id,
    title: `Goal ${id}`,
    deadline: "",
    progress: 0,
    subGoals: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    conversationId: `conversation-${id}`,
  };
}

export function runGoalCommandServiceSpecs() {
  const createKey = "goal-command-service:create-normalized-response";
  const rawGoalId = "goal-command-service-normalized";
  const result = applyGoalCommand({
    command: {
      type: "create_goal",
      goal: makeGoal(rawGoalId),
    },
    idempotencyKey: createKey,
  });
  const normalizedGoalId = normalizeGoalId(rawGoalId);
  const payload = result.event.payload as { entityId?: unknown };

  assert.equal(result.event.goalId, normalizedGoalId, "event goalId should be normalized");
  assert.equal(payload.entityId, normalizedGoalId, "event entityId should match normalized goal id");
  assert.equal(
    result.goals.find((goal) => goal.id === normalizedGoalId)?.id,
    normalizedGoalId,
    "create_goal response should return normalized goal ids",
  );

  const snapshot = readGoalsSnapshotMeta([]);
  const staleKey = "goal-command-service:stale-revision-no-event";
  assert.throws(
    () =>
      applyGoalCommand({
        command: {
          type: "create_goal",
          goal: makeGoal("goal-command-service-stale"),
        },
        idempotencyKey: staleKey,
        baseRevision: snapshot.revision - 1,
      }),
    GoalCommandConflictError,
    "stale revisions should fail before any command event is written",
  );
  assert.equal(getGoalEventByIdempotencyKey(staleKey), null);
}
