import assert from "node:assert/strict";

import { normalizeGovernanceJudgeResult } from "./governanceIntent";

export function runGovernanceIntentSpecs() {
  const fallbackRef = {
    goalId: "goal-x",
    subGoalId: "sub-x",
    taskId: "task-x",
  };

  // 1) replan 始终降级为 clarify，并保留 _downgradedFrom 供埋点
  {
    const result = normalizeGovernanceJudgeResult(
      { intent: "replan", confidence: 0.95, targetRef: fallbackRef },
      fallbackRef,
    );
    assert.equal(result.intent, "clarify", "replan 必须降级为 clarify");
    assert.equal(result._downgradedFrom, "replan", "降级应保留原意图供埋点");
    assert.ok(result.assistantMessage.includes("逐个") || result.assistantMessage.includes("哪几个"), "应给出逐项调整引导语");
  }

  // 2) replan 即使高置信度也不直通命令（避免破坏性整盘替换）
  {
    const result = normalizeGovernanceJudgeResult(
      { intent: "replan", confidence: 1, targetRef: fallbackRef },
      fallbackRef,
    );
    assert.notEqual(result.intent, "replan", "replan 不能作为最终意图返回");
    assert.equal(result.intent, "clarify");
  }

  // 3) applyMode 正常归一化（amend + redo_now）
  {
    const result = normalizeGovernanceJudgeResult(
      {
        intent: "amend_task",
        confidence: 0.9,
        targetRef: fallbackRef,
        patch: { description: "改成按人均算" },
        applyMode: "redo_now",
      },
      fallbackRef,
    );
    assert.equal(result.intent, "amend_task");
    assert.equal(result.applyMode, "redo_now", "redo_now 应被保留");
  }

  // 4) 非法 applyMode 归一化为 undefined（snake_case 兼容）
  {
    const result = normalizeGovernanceJudgeResult(
      {
        intent: "update_task",
        confidence: 0.9,
        targetRef: fallbackRef,
        patch: { title: "新标题" },
        apply_mode: "garbage",
      },
      fallbackRef,
    );
    assert.equal(result.applyMode, undefined, "非法 applyMode 应被丢弃");
  }

  console.log("governanceIntent specs passed");
}
