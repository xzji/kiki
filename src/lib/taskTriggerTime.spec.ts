import assert from "node:assert/strict";

import { isTaskTriggerDue, parseTaskTriggerRule } from "@/lib/taskTriggerTime";
import type { Task } from "@/types/kiki";

function oneShotTask(triggerRule: string): Task {
  return {
    id: "task-trigger-spec",
    subGoalId: "sub-trigger-spec",
    title: "触发规则测试",
    description: "",
    expectedOutcome: "",
    taskType: "one_shot",
    triggerRule,
    progress: 0,
    instances: [],
    executionKind: "generic_result",
    resultViewKind: "generic_result",
  };
}

export function runTaskTriggerTimeSpecs() {
  assert.deepEqual(parseTaskTriggerRule("立即执行"), { kind: "immediate" });
  assert.equal(isTaskTriggerDue(oneShotTask("立即执行"), new Date("2026-05-30T03:00:00.000Z")), true);
}
