import assert from "node:assert/strict";
import {
  applyDraftReview,
  buildDegradedReviewDecision,
  buildTaskDraftReviewDecisionPrompt,
  buildTaskDraftReviewPresentationPrompt,
  getReviewLowAlignmentCount,
  validateTaskReviewDecision,
  type TaskDraftReviewDecisionPayload,
  type TaskDraftReviewPayload,
} from "./taskDraftReview";
import type { TaskDraft } from "./taskDraftSchema";

const sampleDrafts: TaskDraft[] = [
  {
    index: 1,
    title: "周报看板",
    objective: "生成周报",
    deliverable: "周报",
    acceptanceCriteria: ["完成"],
    priorityHint: "high",
  },
  {
    index: 2,
    title: "风险分析",
    objective: "识别风险",
    deliverable: "风险清单",
    acceptanceCriteria: ["列出风险"],
    priorityHint: "medium",
  },
];

export function runTaskDraftReviewSpecs() {
  // 1. validateTaskReviewDecision：新字段 results 优先
  {
    const decision = validateTaskReviewDecision({
      results: [
        { taskId: "1", aligned: true, goalContribution: "high", subGoalContribution: "high" },
        { taskId: "2", aligned: false, goalContribution: "low", subGoalContribution: "low" },
      ],
    });
    assert.equal(decision.results.length, 2);
    assert.equal(decision.results[0]?.aligned, true);
    assert.equal(decision.results[1]?.goalContribution, "low");
  }

  // 2. validateTaskReviewDecision：dual-key 兼容旧字段 reviewResults
  {
    const decision = validateTaskReviewDecision({
      reviewResults: [
        {
          taskId: "1",
          aligned: true,
          goalContribution: "medium",
          subGoalContribution: "high",
          reasoning: "legacy",
        },
      ],
    });
    assert.equal(decision.results.length, 1);
    assert.equal(decision.results[0]?.taskId, "1");
    assert.equal(decision.results[0]?.subGoalContribution, "high");
  }

  // 3. validateTaskReviewDecision：缺 results & reviewResults 抛错
  {
    assert.throws(() => validateTaskReviewDecision({}));
    assert.throws(() => validateTaskReviewDecision(null));
  }

  // 4. validateTaskReviewDecision：非法 priority 归一化为 low
  {
    const decision = validateTaskReviewDecision({
      results: [{ taskId: "1", aligned: true, goalContribution: "garbage", subGoalContribution: undefined }],
    });
    assert.equal(decision.results[0]?.goalContribution, "low");
    assert.equal(decision.results[0]?.subGoalContribution, "low");
  }

  // 5. buildDegradedReviewDecision：默认全部 aligned=true、medium、_degraded
  {
    const decision = buildDegradedReviewDecision(sampleDrafts);
    assert.equal(decision.results.length, 2);
    assert.equal(decision.results[0]?.aligned, true);
    assert.equal(decision.results[0]?.goalContribution, "medium");
    assert.equal(decision._degraded, true);
  }

  // 6. applyDraftReview：新 payload + low alignment 全部低优先级 → 剔除
  {
    const payload: TaskDraftReviewDecisionPayload = {
      results: [
        { taskId: "1", aligned: true, goalContribution: "high", subGoalContribution: "high" },
        { taskId: "2", aligned: false, goalContribution: "low", subGoalContribution: "low" },
      ],
    };
    const retained = applyDraftReview(sampleDrafts, payload);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.index, 1);
  }

  // 7. applyDraftReview：旧 payload（reviewResults）也能工作 — dual-key 兼容
  {
    const legacy: TaskDraftReviewPayload = {
      reviewResults: [
        { taskId: "1", aligned: true, goalContribution: "high", subGoalContribution: "high", reasoning: "" },
        { taskId: "2", aligned: false, goalContribution: "low", subGoalContribution: "low", reasoning: "" },
      ],
    };
    const retained = applyDraftReview(sampleDrafts, legacy);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.index, 1);
  }

  // 8. applyDraftReview：所有 task 全被剔除时回退保留首个，避免空集
  {
    const allDropped: TaskDraftReviewDecisionPayload = {
      results: [
        { taskId: "1", aligned: false, goalContribution: "low", subGoalContribution: "low" },
        { taskId: "2", aligned: false, goalContribution: "low", subGoalContribution: "low" },
      ],
    };
    const retained = applyDraftReview(sampleDrafts, allDropped);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.index, 1);
  }

  // 9. getReviewLowAlignmentCount：统计 aligned=false 的项数（dual-key）
  {
    const newPayload: TaskDraftReviewDecisionPayload = {
      results: [
        { taskId: "1", aligned: true, goalContribution: "high", subGoalContribution: "high" },
        { taskId: "2", aligned: false, goalContribution: "low", subGoalContribution: "low" },
        { taskId: "3", aligned: false, goalContribution: "medium", subGoalContribution: "medium" },
      ],
    };
    assert.equal(getReviewLowAlignmentCount(newPayload), 2);

    const legacyPayload: TaskDraftReviewPayload = {
      reviewResults: [
        { taskId: "1", aligned: false, goalContribution: "low", subGoalContribution: "low", reasoning: "" },
      ],
    };
    assert.equal(getReviewLowAlignmentCount(legacyPayload), 1);
  }

  // 10. buildTaskDraftReviewDecisionPrompt：禁止 reasoning/suggestions/explanation 字段
  {
    const prompt = buildTaskDraftReviewDecisionPrompt({
      goalTitle: "目标",
      subGoalTitle: "子目标",
      goalDescription: "描述",
      drafts: sampleDrafts,
    });
    assert.ok(prompt.includes("results"));
    assert.ok(prompt.includes("禁止"));
    assert.ok(prompt.includes("reasoning"));
    assert.ok(/≤\s*50\s*行/.test(prompt));
    assert.ok(/≤\s*2000\s*字符/.test(prompt));
  }

  // 11. buildTaskDraftReviewPresentationPrompt：要求 markdown，不输出 JSON
  {
    const prompt = buildTaskDraftReviewPresentationPrompt({
      goalTitle: "目标",
      subGoalTitle: "子目标",
      goalDescription: "描述",
      drafts: sampleDrafts,
      decision: {
        results: [
          { taskId: "1", aligned: true, goalContribution: "high", subGoalContribution: "high" },
          { taskId: "2", aligned: false, goalContribution: "low", subGoalContribution: "low" },
        ],
      },
    });
    assert.ok(prompt.includes("markdown"));
    assert.ok(prompt.includes("不要输出 JSON"));
    assert.ok(prompt.includes("Task 1"));
    assert.ok(prompt.includes("Task 2"));
  }
}
