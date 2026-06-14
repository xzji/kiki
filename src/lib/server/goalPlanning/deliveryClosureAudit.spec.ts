import assert from "node:assert/strict";

import {
  buildDeliveryClosureAuditPrompt,
  validateDeliveryClosureAudit,
} from "@/lib/server/goalPlanning";

type AuditPromptInput = Parameters<typeof buildDeliveryClosureAuditPrompt>[0];

function inputWithTask(deliverable: string): AuditPromptInput {
  return {
    goalText: "把想法落成可试用版本",
    decomposition: {
      goalAnalysis: {
        coreIntent: "让别人能试用这个想法",
        successState: "别人能完成一次试用并给出反馈",
        deliveryContract: {
          finalDeliverable: "可试用版本",
          doneEvidence: ["完成一次试用", "反馈被记录"],
          nonCompletionExamples: ["只有方案", "只有骨架"],
        },
      },
      subGoals: [
        {
          id: 1,
          name: "原型落地",
          description: "把方案转成可验收产物",
          priority: "high",
          dependencies: [],
          successCriteria: [{ description: "形成可试用版本", type: "deliverable" }],
        },
      ],
      executionOrder: "先构建后验收",
      risks: [],
      reasoning: "闭环交付",
    },
    subGoals: [
      {
        id: "draft-subgoal-1",
        title: "原型落地",
        description: "把方案转成可验收产物",
        successCriteria: ["形成可试用版本"],
        tasks: [
          {
            id: "task-1",
            title: "交付任务",
            description: "完成交付",
            expectedOutcome: deliverable,
            taskType: "one_shot",
            triggerRule: "准备好后执行一次",
            executionKind: "generic_result",
          },
        ],
      },
    ],
  };
}

export function runDeliveryClosureAuditSpecs() {
  {
    const prompt = buildDeliveryClosureAuditPrompt(inputWithTask("只有选型说明和空骨架"));
    assert.ok(prompt.includes("全局交付闭环审计器"));
    assert.ok(prompt.includes("不得按领域关键词判断"));
    assert.ok(prompt.includes("finalDeliverable"));
    assert.ok(prompt.includes("doneEvidence"));
    assert.ok(prompt.includes("nonCompletionExamples"));
  }

  {
    const audit = validateDeliveryClosureAudit({
      verdict: "needs_repair",
      missingEvidence: ["缺少一次完整试用证据"],
      insufficientThreads: [{ subGoalId: 1, reason: "只有骨架，没有验收任务" }],
      repairInstruction: "追加可试用版本构建与验收任务",
    });
    assert.equal(audit.verdict, "needs_repair");
    assert.equal(audit.missingEvidence.length, 1);
    assert.equal(audit.insufficientThreads[0]?.subGoalId, 1);
    assert.equal(audit.repairInstruction, "追加可试用版本构建与验收任务");
  }

  {
    const audit = validateDeliveryClosureAudit({
      verdict: "accept",
      missingEvidence: [],
      insufficientThreads: [],
    });
    assert.equal(audit.verdict, "accept");
    assert.deepEqual(audit.missingEvidence, []);
  }

  {
    const audit = validateDeliveryClosureAudit({
      verdict: "unexpected",
      missingEvidence: ["缺少可验收产物"],
      insufficientThreads: [],
    });
    assert.equal(audit.verdict, "needs_repair");
    assert.deepEqual(audit.missingEvidence, ["缺少可验收产物"]);
  }
}
