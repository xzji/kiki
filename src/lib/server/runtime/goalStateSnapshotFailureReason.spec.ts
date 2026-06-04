import assert from "node:assert/strict";

import { syncGoalInstanceFromProgress } from "@/lib/server/runtime/goalStateSnapshot";
import type { Goal, Task, TaskInstance } from "@/types/kiki";
import type { GoalServerProgress } from "@/types/goalTelemetry";

function makeInstance(): TaskInstance {
  return {
    id: "inst-fail",
    taskId: "task-fail",
    dateLabel: "2026-06-03",
    status: "in_progress",
    intro: "失败原因测试实例",
    payload: { kind: "generic_result", summary: "失败原因测试实例" },
    createdAt: "2026-06-03T00:00:00.000Z",
  };
}

function makeTask(instance: TaskInstance): Task {
  return {
    id: "task-fail",
    subGoalId: "thread-fail",
    title: "任务1：失败原因测试",
    description: "",
    expectedOutcome: "",
    taskType: "one_shot",
    triggerRule: "立即触发",
    progress: 0,
    instances: [instance],
    executionKind: "generic_result",
  };
}

function makeGoal(instance = makeInstance()): Goal {
  return {
    id: "goal-fail",
    title: "失败原因测试目标",
    deadline: "",
    progress: 0,
    createdAt: "2026-06-03T00:00:00.000Z",
    subGoals: [
      {
        id: "thread-fail",
        goalId: "goal-fail",
        title: "失败原因测试板块",
        tasks: [makeTask(instance)],
      },
    ],
  };
}

function makeFailedProgress(overrides: Partial<GoalServerProgress> = {}): GoalServerProgress {
  return {
    requestId: "req-fail",
    scope: "goal_task_execute",
    status: "failed",
    phase: "error",
    message: "任务执行失败",
    startedAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:01:00.000Z",
    finishedAt: "2026-06-03T00:01:00.000Z",
    taskId: "task-fail",
    taskInstanceId: "inst-fail",
    ...overrides,
  };
}

function getProjectedInstance(goals: Goal[]) {
  return goals[0]!.subGoals[0]!.tasks[0]!.instances[0]!;
}

export function runGoalStateSnapshotFailureReasonSpecs() {
  {
    const projected = syncGoalInstanceFromProgress([makeGoal()], {
      taskId: "task-fail",
      instanceId: "inst-fail",
      progress: makeFailedProgress({
        resultPayload: {
          errorCategory: "unknown",
          errorMessage: "payload 中的失败原因",
        },
      }),
    });
    const instance = getProjectedInstance(projected);
    assert.equal(instance.status, "error");
    assert.equal(instance.execution?.errorMessage, "payload 中的失败原因");
  }

  {
    const projected = syncGoalInstanceFromProgress([makeGoal()], {
      taskId: "task-fail",
      instanceId: "inst-fail",
      progress: makeFailedProgress({
        error: "progress 中的失败原因",
        resultPayload: {
          errorCategory: "unknown",
          errorMessage: "payload 中的失败原因",
        },
      }),
    });
    const instance = getProjectedInstance(projected);
    assert.equal(instance.status, "error");
    assert.equal(instance.execution?.errorMessage, "progress 中的失败原因");
  }

  {
    const staleInstance = {
      ...makeInstance(),
      execution: {
        phase: "failed",
        status: "error",
        startedAt: "2026-06-03T00:00:00.000Z",
        finishedAt: "2026-06-03T00:01:00.000Z",
        lastUpdatedAt: "2026-06-03T00:01:00.000Z",
        errorMessage: "旧失败原因",
      },
    } satisfies TaskInstance;
    const projected = syncGoalInstanceFromProgress([makeGoal(staleInstance)], {
      taskId: "task-fail",
      instanceId: "inst-fail",
      progress: makeFailedProgress({
        error: "新失败原因",
        resultPayload: {
          errorCategory: "unknown",
        },
      }),
    });
    const instance = getProjectedInstance(projected);
    assert.equal(instance.status, "error");
    assert.equal(instance.execution?.errorMessage, "新失败原因", "当前 progress 原因应覆盖旧 execution 原因");
  }

  {
    const staleInstance = {
      ...makeInstance(),
      execution: {
        phase: "failed",
        status: "error",
        startedAt: "2026-06-03T00:00:00.000Z",
        finishedAt: "2026-06-03T00:01:00.000Z",
        lastUpdatedAt: "2026-06-03T00:01:00.000Z",
        errorMessage: "历史 execution 原因",
      },
      result: {
        summary: "历史摘要不是错误根因",
      },
    } satisfies TaskInstance;
    const projected = syncGoalInstanceFromProgress([makeGoal(staleInstance)], {
      taskId: "task-fail",
      instanceId: "inst-fail",
      progress: makeFailedProgress({
        resultPayload: {
          errorCategory: "unknown",
        },
      }),
    });
    const instance = getProjectedInstance(projected);
    assert.equal(instance.status, "error");
    assert.equal(
      instance.execution?.errorMessage,
      "历史 execution 原因",
      "当前运行无错误字段时，历史 execution 原因应优先于历史 result 摘要",
    );
  }
}
