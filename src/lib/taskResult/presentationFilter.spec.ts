import assert from "node:assert/strict";

import { filterTaskResultForPresentation } from "./presentationFilter";
import type { TaskResult } from "@/types/taskResult";

function taskResult(blocks: TaskResult["blocks"]): TaskResult {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    instanceId: "inst-1",
    title: "报告",
    status: "done",
    blocks,
    meta: { producedAt: "2026-06-23T00:00:00.000Z" },
  };
}

export function runTaskResultPresentationFilterSpecs() {
  const filtered = filterTaskResultForPresentation(
    taskResult([
      { kind: "paragraph", text: "围绕长程 Agent，本周三条主线。" },
      { kind: "paragraph", text: "真正的报告正文。" },
    ]),
    { outerTexts: ["围绕长程 Agent，本周三条主线。"] },
  );
  assert.deepEqual(filtered.blocks, [{ kind: "paragraph", text: "真正的报告正文。" }]);
}
