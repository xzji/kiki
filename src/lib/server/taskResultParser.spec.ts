import assert from "node:assert/strict";

import { parseTaskRunnerResult, type TaskParserContext } from "./taskResultParser";
import type { Task, TaskInstance } from "@/types/kiki";

function ctx(): TaskParserContext {
  const task = {
    id: "task-1",
    title: "每周长程运行 agent 进展简报",
    executionKind: "generic_result",
  } as Task;
  const instance = {
    id: "inst-1",
    intro: "用户手动发起执行“每周长程运行 agent 进展简报”。",
  } as TaskInstance;
  return {
    task,
    instance,
    requestId: "request-1",
  };
}

export function runTaskResultParserSpecs() {
  const parsed = parseTaskRunnerResult(
    ctx(),
    JSON.stringify({
      summary: "围绕长程 Agent，本周三条主线。",
      final_message: "任务已完成，点击卡片可以查看结果。",
      task_result: {
        title: "每周长程运行 agent 进展简报",
        status: "done",
        blocks: [
          { kind: "paragraph", text: "用户手动发起执行“每周长程运行 agent 进展简报”。" },
          { kind: "paragraph", text: "围绕长程 Agent，本周三条主线。" },
          { kind: "paragraph", text: "真正的可视化报告正文。" },
        ],
        meta: { producedAt: "2026-06-23T00:00:00.000Z", surfaces: ["interactive"], presentation: "visual_report" },
      },
    }),
    "generic_result",
  );

  assert.deepEqual(parsed.taskResult?.blocks, [
    { kind: "paragraph", text: "真正的可视化报告正文。" },
  ]);
  assert.ok(parsed.structuredOutput);
  assert.deepEqual((parsed.structuredOutput.taskResult as { blocks?: unknown[] }).blocks, parsed.taskResult?.blocks);
}
