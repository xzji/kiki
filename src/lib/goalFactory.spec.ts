import assert from "node:assert/strict";

import { buildGoalFromDraft } from "@/lib/goalFactory";
import type { GoalBreakdownDraft } from "@/types/kiki";

export function runGoalFactorySpecs() {
  const draft: GoalBreakdownDraft = {
    goalTitle: "可试用版本",
    deliveryContract: {
      finalDeliverable: "可试用版本",
      doneEvidence: ["完成一次试用"],
      nonCompletionExamples: ["只有方案"],
    },
    subGoals: [
      {
        id: "sg-1",
        title: "原型落地",
        tasks: [
          {
            id: "task-1",
            title: "交付可试用版本",
            description: "完成一次可试用交付",
            expectedOutcome: "可试用版本",
            taskType: "one_shot",
            triggerRule: "准备好后执行一次",
            executionKind: "generic_result",
          },
        ],
      },
    ],
  };
  const goal = buildGoalFromDraft(draft);
  assert.equal(goal.deliveryContract?.finalDeliverable, "可试用版本");
  assert.deepEqual(goal.deliveryContract?.doneEvidence, ["完成一次试用"]);
}
