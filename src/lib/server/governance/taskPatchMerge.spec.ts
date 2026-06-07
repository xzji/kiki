import assert from "node:assert/strict";

import { mergeTaskPatch } from "@/lib/server/governance/taskPatchMerge";
import type { Task } from "@/types/kiki";

function makeTask(): Task {
  return {
    id: "task-merge-1",
    subGoalId: "sg-merge-1",
    title: "信息监测",
    description: "监测 AI 信息",
    expectedOutcome: "输出信息清单",
    expectedResult: {
      type: "deliverable",
      description: "结构化清单",
      format: "markdown",
      completionCriteria: "包含重要事件",
      requiredBlocks: ["list"],
    },
    taskType: "repeat",
    triggerRule: "每周一 09:00",
    instances: [],
    executionKind: "generic_result",
    progress: 0,
    taskSpec: {
      content: "原规格",
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceRevision: "rev-1",
    },
  };
}

export function runTaskPatchMergeSpecs() {
  const merged = mergeTaskPatch(makeTask(), {
    expectedResult: {
      completionCriteria: "包含重要事件\n增加具体 AI 产品扫描\n附新闻来源 URL",
      requiredBlocks: ["list", "markdown"],
    },
  });

  assert.equal(
    merged.expectedResult?.completionCriteria,
    "包含重要事件\n增加具体 AI 产品扫描\n附新闻来源 URL",
  );
  assert.deepEqual(merged.expectedResult?.requiredBlocks, ["list", "markdown"]);

  const replaced = mergeTaskPatch(makeTask(), {
    title: "每周 AI 产品监测",
    expectedOutcome: "输出可追溯的信息监测周报",
  });
  assert.equal(replaced.title, "每周 AI 产品监测");
  assert.equal(replaced.expectedOutcome, "输出可追溯的信息监测周报");
  assert.equal(replaced.taskSpec?.stale, true);

  const untouched = mergeTaskPatch(makeTask(), {});
  assert.equal(untouched.taskSpec?.stale, undefined);
}
