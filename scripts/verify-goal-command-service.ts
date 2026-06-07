import fs from "fs";
import os from "os";
import path from "path";

import { DEFAULT_LOCAL_USER_ID, runWithUserContext } from "../src/lib/server/context/userContext";
import type { Goal, Task } from "../src/types/kiki";

type GoalCommandServiceModule = typeof import("../src/lib/server/services/goalCommandService");
type DbClientModule = typeof import("../src/lib/server/db/client");

let service: GoalCommandServiceModule;
let dbClient: DbClientModule;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows<T extends Error>(fn: () => unknown, errorType: { new (...args: never[]): T }, message: string) {
  try {
    fn();
  } catch (error) {
    assert(error instanceof errorType, `${message}: expected ${errorType.name}, got ${error instanceof Error ? error.name : typeof error}`);
    return error;
  }
  throw new Error(`${message}: expected ${errorType.name}`);
}

function eventCount() {
  const row = dbClient.getDatabase().prepare(`SELECT COUNT(*) as count FROM goal_event_log`).get() as { count: number };
  return row.count;
}

function taskInput(overrides: Partial<Task> = {}) {
  return {
    title: overrides.title ?? "验证任务",
    description: overrides.description ?? "验证命令服务",
    expectedOutcome: overrides.expectedOutcome ?? "验证通过",
    taskType: overrides.taskType ?? "one_shot",
    triggerRule: overrides.triggerRule ?? "手动触发",
    executionKind: overrides.executionKind ?? "generic_result",
  };
}

function goalFixture(overrides: Partial<Goal> = {}): Goal {
  const now = "2026-05-20T00:00:00.000Z";
  return {
    id: "goal-command-verify",
    title: "命令服务验证目标",
    deadline: "2026-06-01T00:00:00.000Z",
    progress: 0,
    createdAt: now,
    conversationId: "conversation-command-verify",
    workflow: {
      phase: "presenting_plan",
      planDecision: "pending",
      startedAt: now,
      updatedAt: now,
    },
    subGoals: [
      {
        id: "sub-goal-command-verify",
        goalId: "goal-command-verify",
        title: "验证子目标",
        tasks: [],
      },
    ],
    ...overrides,
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-goal-command-"));
  process.env.KIKI_DATA_DIR = tempDir;
  service = await import("../src/lib/server/services/goalCommandService");
  dbClient = await import("../src/lib/server/db/client");

  try {
  runWithUserContext(DEFAULT_LOCAL_USER_ID, () => {
  const goal = goalFixture();
  const createResult = service.applyGoalCommand({
    command: { type: "create_goal", goal },
    idempotencyKey: "verify:create-goal",
    baseRevision: 0,
  });
  assert(createResult.revision === 1, "create_goal should advance snapshot revision to 1");
  assert(eventCount() === 1, "create_goal should append one event");

  const repeatCreate = service.applyGoalCommand({
    command: { type: "create_goal", goal },
    idempotencyKey: "verify:create-goal",
    baseRevision: 0,
  });
  assert(repeatCreate.revision === 1, "idempotent create_goal retry must not advance revision");
  assert(eventCount() === 1, "idempotent create_goal retry must not append event");

  assertThrows(
    () =>
      service.applyGoalCommand({
        command: { type: "create_goal", goal: goalFixture({ title: "不同目标内容" }) },
        idempotencyKey: "verify:create-goal",
        baseRevision: 1,
      }),
    service.GoalCommandIdempotencyConflictError,
    "same idempotency key with different create_goal payload should conflict",
  );
  assert(eventCount() === 1, "idempotency conflict must not append event");

  assertThrows(
    () =>
      service.applyGoalCommand({
        command: { type: "create_goal", goal },
        idempotencyKey: "verify:create-goal-duplicate",
        baseRevision: 1,
      }),
    service.GoalCommandValidationError,
    "duplicate create_goal with a new idempotency key should fail",
  );
  assert(eventCount() === 1, "duplicate create_goal must not append event");

  assertThrows(
    () =>
      service.applyGoalCommand({
        command: { type: "confirm_goal_plan", goalId: goal.id },
        idempotencyKey: "verify:stale-confirm",
        baseRevision: 0,
      }),
    service.GoalCommandConflictError,
    "stale baseRevision should conflict",
  );
  assert(eventCount() === 1, "revision conflict must not append event");

  assertThrows(
    () =>
      service.applyGoalCommand({
        command: {
          type: "create_task",
          goalId: goal.id,
          subGoalId: "missing-sub-goal",
          task: taskInput(),
        },
        idempotencyKey: "verify:missing-sub-goal",
        baseRevision: 1,
      }),
    service.GoalCommandValidationError,
    "create_task with missing subGoal should fail",
  );
  assert(eventCount() === 1, "missing subGoal command must not append event");

  const createTaskResult = service.applyGoalCommand({
    command: {
      type: "create_task",
      goalId: goal.id,
      subGoalId: "sub-goal-command-verify",
      task: taskInput(),
    },
    idempotencyKey: "verify:create-task",
    baseRevision: 1,
  });
  assert(createTaskResult.revision === 2, "create_task should advance revision");
  assert(eventCount() === 2, "create_task should append one event");

  const repeatCreateTask = service.applyGoalCommand({
    command: {
      type: "create_task",
      goalId: goal.id,
      subGoalId: "sub-goal-command-verify",
      task: taskInput(),
    },
    idempotencyKey: "verify:create-task",
    baseRevision: 1,
  });
  assert(repeatCreateTask.revision === 2, "idempotent create_task retry must not advance revision");
  assert(eventCount() === 2, "idempotent create_task retry must not append event");

  assertThrows(
    () =>
      service.applyGoalCommand({
        command: {
          type: "create_goal",
          goal: goalFixture({
            id: "goal-invalid-shape",
            subGoals: [{ id: "sub-invalid", goalId: "other-goal", title: "错误引用", tasks: [] }],
          }),
        },
        idempotencyKey: "verify:invalid-goal",
        baseRevision: 2,
      }),
    service.GoalCommandValidationError,
    "invalid create_goal entity should fail",
  );
  assert(eventCount() === 2, "invalid create_goal must not append event");

  console.log("Goal command service verification passed.");
  });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

void main();
