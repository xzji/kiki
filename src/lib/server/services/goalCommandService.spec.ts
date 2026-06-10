import assert from "node:assert/strict";

import { normalizeGoalId } from "@/lib/opaqueIds";
import { getGoalEventByIdempotencyKey } from "@/lib/server/repositories/goalEventLogRepository";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { readGoalsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import {
  applyGoalCommand,
  GoalCommandConflictError,
  GoalCommandValidationError,
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
  ensureIsolatedPlanningSpecDataDir();
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

  const replaceSourceId = "goal-command-service-replace";
  const replaceSource = makeGoal(replaceSourceId);
  applyGoalCommand({
    command: {
      type: "create_goal",
      goal: replaceSource,
    },
    idempotencyKey: "goal-command-service:replace-source",
  });
  const replaceMeta = readGoalsSnapshotMeta([]);
  const replaceResult = applyGoalCommand({
    command: {
      type: "replace_goal_plan",
      goal: {
        ...makeGoal(replaceSourceId),
        title: "Replaced Plan",
        createdAt: "2099-01-01T00:00:00.000Z",
        conversationId: "conversation-should-not-change",
        workflow: {
          phase: "presenting_plan",
          planDecision: "pending",
          startedAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
        subGoals: [
          {
            id: "replace-sub-goal",
            goalId: replaceSourceId,
            title: "Replacement SubGoal",
            tasks: [],
          },
        ],
      },
    },
    idempotencyKey: "goal-command-service:replace-plan",
    baseRevision: replaceMeta.revision,
  });
  const replacedGoal = replaceResult.goals.find((goal) => goal.id === normalizeGoalId(replaceSourceId));
  const replacePayload = replaceResult.event.payload as { action?: unknown; entityId?: unknown };
  assert.equal(replacedGoal?.title, "Replaced Plan", "replace_goal_plan should replace goal plan content");
  assert.equal(replacedGoal?.createdAt, replaceSource.createdAt, "replace_goal_plan should preserve createdAt");
  assert.equal(replacedGoal?.conversationId, replaceSource.conversationId, "replace_goal_plan should preserve conversation binding");
  assert.equal(replacedGoal?.subGoals[0]?.goalId, normalizeGoalId(replaceSourceId), "replacement sub goals should reference existing goal id");
  assert.equal(replacePayload.action, "goal.plan_replaced");
  assert.equal(replacePayload.entityId, normalizeGoalId(replaceSourceId));
  assert.throws(
    () =>
      applyGoalCommand({
        command: {
          type: "replace_goal_plan",
          goal: {
            ...makeGoal(replaceSourceId),
            workflow: {
              phase: "executing",
              planDecision: "confirmed",
              startedAt: "2026-06-01T00:00:00.000Z",
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
          },
        },
        idempotencyKey: "goal-command-service:replace-plan-invalid-workflow",
      }),
    GoalCommandValidationError,
    "replace_goal_plan should reject non-pending replacement workflow",
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

  const expectedResultGoalId = "goal-command-service-expected-result";
  const expectedResultSubGoalId = "sg-expected-result";
  applyGoalCommand({
    command: {
      type: "create_goal",
      goal: {
        ...makeGoal(expectedResultGoalId),
        subGoals: [
          {
            id: expectedResultSubGoalId,
            goalId: expectedResultGoalId,
            title: "SubGoal",
            tasks: [],
          },
        ],
      },
    },
    idempotencyKey: "goal-command-service:expected-result-goal",
  });
  const created = applyGoalCommand({
    command: {
      type: "create_task",
      goalId: expectedResultGoalId,
      subGoalId: expectedResultSubGoalId,
      task: {
        title: "信息监测",
        description: "监测信息",
        expectedOutcome: "输出信息清单",
        expectedResult: {
          type: "deliverable",
          description: "结构化清单",
          format: "markdown",
          completionCriteria: "必须包含来源 URL",
          requiredBlocks: ["list"],
        },
        taskType: "repeat",
        triggerRule: "每周一 09:00",
        executionKind: "generic_result",
        taskSpec: {
          content: "原规格",
          generatedAt: "2026-01-01T00:00:00.000Z",
          sourceRevision: "rev-1",
        },
      },
    },
    idempotencyKey: "goal-command-service:expected-result-create-task",
  });
  const createdTask = created.goals
    .find((goal) => goal.id === normalizeGoalId(expectedResultGoalId))
    ?.subGoals[0]?.tasks[0];
  assert.equal(createdTask?.expectedResult?.completionCriteria, "必须包含来源 URL");
  assert.deepEqual(createdTask?.expectedResult?.requiredBlocks, ["list"]);

  const updated = applyGoalCommand({
    command: {
      type: "update_task",
      goalId: expectedResultGoalId,
      taskId: createdTask?.id ?? "",
      task: {
        title: "信息监测",
        description: "监测信息",
        expectedOutcome: "输出信息清单",
        expectedResult: {
          type: "deliverable",
          description: "结构化清单",
          format: "markdown",
          completionCriteria: "必须包含 AI 产品扫描和来源 URL",
          requiredBlocks: ["list", "markdown"],
        },
        taskType: "repeat",
        triggerRule: "每周一 09:00",
        executionKind: "generic_result",
      },
    },
    idempotencyKey: "goal-command-service:expected-result-update-task",
  });
  const updatedTask = updated.goals
    .find((goal) => goal.id === normalizeGoalId(expectedResultGoalId))
    ?.subGoals[0]?.tasks[0];
  assert.equal(updatedTask?.expectedResult?.completionCriteria, "必须包含 AI 产品扫描和来源 URL");
  assert.deepEqual(updatedTask?.expectedResult?.requiredBlocks, ["list", "markdown"]);
  assert.equal(updatedTask?.taskSpec?.stale, true);
}
