import assert from "node:assert/strict";

import { evaluateGovernanceGate } from "./governanceGate";

export function runGovernanceGateSpecs() {
  // 1) 未绑定 goal：始终不通过
  {
    const result = evaluateGovernanceGate({
      message: "把这个任务重跑一遍",
      conversation: { goalId: undefined },
      taskRef: null,
    });
    assert.equal(result.pass, false, "无 goal 绑定必须拦截");
  }

  // 2) 有 taskRef：直接放行（最强信号），无需命中关键词
  {
    const result = evaluateGovernanceGate({
      message: "嗯",
      conversation: { goalId: "goal-x" },
      taskRef: { goalId: "goal-x", subGoalId: "sub-x", taskId: "task-x", instanceId: "inst-x" },
    });
    assert.equal(result.pass, true, "有 taskRef 应放行");
    if (result.pass) {
      assert.equal(result.signals.hasTaskRef, true);
    }
  }

  // 3) 无引用 + 自然澄清措辞：放宽后的关键词应放行
  {
    for (const message of ["这个方向不对", "不是这样的，得改成按人均算", "重新来一遍", "这块儿不太对"]) {
      const result = evaluateGovernanceGate({
        message,
        conversation: { goalId: "goal-x" },
        taskRef: null,
      });
      assert.equal(result.pass, true, `自然澄清「${message}」应放行`);
    }
  }

  // 4) 无引用 + 纯闲聊：仍然拦截（门控只决定要不要喊 LLM）
  {
    const result = evaluateGovernanceGate({
      message: "今天天气真好啊",
      conversation: { goalId: "goal-x" },
      taskRef: null,
    });
    assert.equal(result.pass, false, "纯闲聊无信号应拦截");
  }

  console.log("governanceGate specs passed");
}
