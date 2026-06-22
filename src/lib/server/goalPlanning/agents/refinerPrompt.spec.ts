import assert from "node:assert/strict";

import {
  buildTopicPlanRefinerPrompt,
  validateRefinedTopicPlan,
} from "./refinerPrompt";

export function runRefinerPromptSpecs() {
  {
    const prompt = buildTopicPlanRefinerPrompt({
      topicText: "搭建自动化研究系统",
      currentPlan: { subGoals: [{ id: 1, name: "旧板块" }] },
      criticDecision: { verdict: "needs_refinement", notes: "任务不可执行" },
      conversationContext: "需要每天更新",
      userContext: { command: "/topic" },
    });

    assert.ok(prompt.includes("Refiner"), "prompt includes Refiner role");
    assert.ok(prompt.includes("Critic 决策"), "prompt includes critic decision");
    assert.ok(prompt.includes("当前 Planner 草稿"), "prompt includes current plan");
    assert.ok(prompt.includes("搭建自动化研究系统"), "prompt includes topic");
    assert.ok(prompt.includes("只能输出一个严格合法的 JSON 对象"), "prompt requires JSON only");
  }

  {
    assert.deepEqual(
      validateRefinedTopicPlan({ subGoals: [{ id: 1, name: "板块" }] }),
      { subGoals: [{ id: 1, name: "板块" }] },
    );
    assert.deepEqual(
      validateRefinedTopicPlan({ threads: [{ id: "t1", title: "板块" }] }),
      { threads: [{ id: "t1", title: "板块" }] },
    );
  }

  {
    assert.throws(() => validateRefinedTopicPlan(null), /不是 JSON 对象/);
    assert.throws(() => validateRefinedTopicPlan([]), /不是 JSON 对象/);
    assert.throws(() => validateRefinedTopicPlan({ risks: [] }), /缺少 subGoals 或 threads/);
    assert.throws(() => validateRefinedTopicPlan({ subGoals: [] }), /subGoals 不是非空数组/);
    assert.throws(() => validateRefinedTopicPlan({ threads: [] }), /threads 不是非空数组/);
  }
}
