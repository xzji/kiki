import assert from "node:assert/strict";

import { DEFAULT_EASTER_EGG_SETTINGS } from "@/lib/goalSystemConfig";
import { buildTaskDraftPrompt } from "./taskDraftPrompt";

export function runTaskDraftPromptSpecs() {
  const prompt = buildTaskDraftPrompt({
    goalTitle: "把想法落成可试用版本",
    goalDescription: "用户希望别人能试用并给反馈",
    userContext: {},
    subGoalName: "原型落地",
    subGoalDescription: "把前序设计转为可验收产物",
    successCriteria: ["形成可试用版本", "收集反馈"],
    deliveryContract: {
      finalDeliverable: "别人能试用并反馈的版本",
      doneEvidence: ["用户能进入并完成一次试用", "能收集反馈"],
      nonCompletionExamples: ["只有选型说明", "只有空骨架"],
    },
    isFinalSubGoal: true,
    config: DEFAULT_EASTER_EGG_SETTINGS,
  });

  assert.ok(prompt.includes("目标交付契约"));
  assert.ok(prompt.includes("别人能试用并反馈的版本"));
  assert.ok(prompt.includes("准备任务"));
  assert.ok(prompt.includes("构建任务"));
  assert.ok(prompt.includes("验收任务"));
  assert.ok(prompt.includes("不得把关键交付缺口留给“后续再说”"));
  assert.ok(!prompt.includes("如果标题包含"));
}
