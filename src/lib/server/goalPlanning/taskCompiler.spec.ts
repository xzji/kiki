import assert from "node:assert/strict";
import { compileTaskDraftsToDraftTasks } from "./taskCompiler";
import { buildCollaboration, buildExpectedResult, inferRequiredBlocks, validateCadence } from "@/lib/goalPlanning/taskCompiler";
import type { TaskDraft } from "./taskDraftSchema";

const base: TaskDraft = {
  index: 1,
  title: "周报看板",
  objective: "生成候选人进度周报和风险提示",
  deliverable: "候选人对比表和行动清单",
  acceptanceCriteria: ["包含表格", "包含行动清单"],
  cadence: "每周日 20:00 触发",
  priorityHint: "high",
};

export function runTaskCompilerSpecs() {
  assert.equal(validateCadence(base).cadence, "每周日 20:00 触发");
  assert.equal(validateCadence({ ...base, cadence: "晚上触发" }).cadence, undefined);
  assert.equal(buildCollaboration({ ...base, userInvolvement: { mode: "confirm" } }, base.objective, base.deliverable).userInteractionType, "confirm");
  assert.equal(buildExpectedResult("generic_result", "确认方案", "生成方案").type, "deliverable");
  assert.equal(inferRequiredBlocks("generic_result", "候选人对比表", "输出矩阵").includes("comparison_table"), true);
  const compiled = compileTaskDraftsToDraftTasks({
    drafts: [base, { ...base, index: 2, title: "依赖任务", dependencyHints: ["1"], cadence: undefined }],
    subGoalContext: { id: 1, name: "子目标", description: "描述", criteria: ["完成"], priority: "high" },
    taskIdBatchSeed: "seed",
    subGoalDraftId: "draft-subgoal-1",
    subGoalIndex: 1,
  });
  assert.equal(compiled.tasks.length, 2);
  assert.equal(compiled.tasks[1]?.dependencies?.length, 1);
}
