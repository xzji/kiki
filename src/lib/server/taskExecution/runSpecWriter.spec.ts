import assert from "node:assert/strict";

import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";

import { runSpecWriter } from "./runSpecWriter";

function invokeWith(parsed: Record<string, unknown>): LlmInvoke {
  return async () => ({ rawText: JSON.stringify(parsed), parsed });
}

const baseInput = {
  goalContext: { goalTitle: "测试目标" },
  attribution: { topicId: "topic-spec-writer" },
  tasks: [
    {
      taskId: "sg1#1",
      title: "任务一",
      description: "完成任务一",
      expectedOutcome: "任务一交付物",
      taskType: "one_shot" as const,
      triggerRule: "立即触发",
    },
    {
      taskId: "sg1#2",
      title: "任务二",
      description: "完成任务二",
      expectedOutcome: "任务二交付物",
      taskType: "repeat" as const,
      triggerRule: "每天 09:00",
    },
  ],
};

export async function runSpecWriterSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  {
    const result = await runSpecWriter({
      ...baseInput,
      invoke: invokeWith({
        specs: [
          { taskId: "sg1#1", content: "规格一" },
          { taskId: "sg1#2", content: "规格二" },
        ],
      }),
    });
    assert.equal(result.degraded, false);
    assert.deepEqual(result.specs, [
      { taskId: "sg1#1", content: "规格一" },
      { taskId: "sg1#2", content: "规格二" },
    ]);
  }

  {
    const result = await runSpecWriter({
      ...baseInput,
      invoke: invokeWith({
        specs: [{ taskId: "sg1#1", content: "规格一" }],
      }),
    });
    assert.equal(result.degraded, true);
    assert.deepEqual(result.specs, [{ taskId: "sg1#1", content: "规格一" }]);
  }

  {
    const result = await runSpecWriter({
      ...baseInput,
      invoke: invokeWith({
        specs: [
          { taskId: "sg1#1", content: "规格一" },
          { taskId: "sg1#1", content: "重复规格" },
        ],
      }),
    });
    assert.equal(result.degraded, true);
    assert.deepEqual(result.specs, [{ taskId: "sg1#1", content: "规格一" }]);
  }

  {
    const result = await runSpecWriter({
      ...baseInput,
      invoke: async () => {
        throw new Error("invoke failed");
      },
    });
    assert.equal(result.degraded, true);
    assert.deepEqual(result.specs, []);
  }

  {
    let invoked = false;
    const result = await runSpecWriter({
      ...baseInput,
      tasks: [],
      invoke: async () => {
        invoked = true;
        return { rawText: "{}", parsed: {} };
      },
    });
    assert.equal(invoked, false);
    assert.deepEqual(result, { specs: [], degraded: false });
  }
}
