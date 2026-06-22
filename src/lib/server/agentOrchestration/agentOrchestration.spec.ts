import assert from "node:assert/strict";

import { assembleFinalTaskResult, extractCandidateBlocks } from "@/lib/server/agentOrchestration/assemble";
import { normalizeReviewDecision } from "@/lib/server/agentOrchestration/review";
import { sanitizeDeliverableMetaNarration } from "@/lib/server/agentOrchestration/sanitize";
import { selectAgentCollaborationStrategy } from "@/lib/server/agentOrchestration/strategy";
import type { Task } from "@/types/kiki";
import type { ResultBlock, TaskResult } from "@/types/taskResult";

function task(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    subGoalId: "thread-1",
    title: "生成视觉报告",
    description: "整理信息",
    expectedOutcome: "一份报告",
    taskType: "one_shot",
    triggerRule: "manual",
    progress: 0,
    instances: [],
    executionKind: "generic_result",
    ...overrides,
  };
}

function baseTaskResult(blocks: ResultBlock[]): TaskResult {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    instanceId: "inst-1",
    title: "报告",
    status: "done",
    blocks,
    meta: {
      producedAt: "2026-06-22T00:00:00.000Z",
      surfaces: ["interactive"],
    },
  };
}

export function runAgentOrchestrationSpecs() {
  {
    const strategy = selectAgentCollaborationStrategy({
      task: task({
        expectedResult: {
          type: "deliverable",
          description: "报告",
          format: "table",
          presentation: "visual_report",
          surfaces: ["interactive"],
        },
      }),
    });
    assert.equal(strategy, "single_agent");
  }

  {
    const strategy = selectAgentCollaborationStrategy({
      task: task({
        priority: "high",
        title: "调研并比较方案",
        expectedResult: {
          type: "deliverable",
          description: "对比表",
          format: "table",
          presentation: "comparison_table",
          surfaces: ["interactive"],
        },
      }),
    });
    assert.equal(strategy, "research_then_write");
  }

  {
    const candidateBlocks: ResultBlock[] = [
      { kind: "heading", text: "A", level: 2 },
      { kind: "paragraph", text: "原文不可被改写" },
    ];
    const assembled = assembleFinalTaskResult({
      base: baseTaskResult(candidateBlocks),
      candidateBlocks,
      plan: {
        order: ["block-2", "block-1"],
        appendBlocks: [{ kind: "callout", tone: "info", text: "追加摘要" }],
      },
    });
    assert.deepEqual(assembled.blocks[0], candidateBlocks[1]);
    assert.deepEqual(assembled.blocks[1], candidateBlocks[0]);
    assert.deepEqual(assembled.blocks[2], { kind: "callout", tone: "info", text: "追加摘要" });
  }

  {
    // 回归：无显式 id 的 block 在 order 重排 + drop 时必须按稳定 key 删除，不能按重排后位置错配。
    const candidateBlocks: ResultBlock[] = [
      { kind: "paragraph", text: "A" },
      { kind: "paragraph", text: "B" },
      { kind: "paragraph", text: "C" },
    ];
    const assembled = assembleFinalTaskResult({
      base: baseTaskResult(candidateBlocks),
      candidateBlocks,
      plan: { order: ["block-3", "block-1", "block-2"], dropBlockIds: ["block-2"] },
    });
    assert.deepEqual(
      assembled.blocks.map((block) => (block.kind === "paragraph" ? block.text : "")),
      ["C", "A"],
    );
  }

  {
    const blocks = extractCandidateBlocks({
      candidateBlocks: [{ kind: "paragraph", text: "完整正文" }],
    });
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0], { kind: "paragraph", text: "完整正文" });
  }

  {
    const safe = sanitizeDeliverableMetaNarration(baseTaskResult([
      { kind: "paragraph", text: "本节讨论 tool use 与 agent memory 的边界。" },
    ]));
    assert.equal(safe.blocks.length, 1);
    const sanitized = sanitizeDeliverableMetaNarration(baseTaskResult([
      { kind: "callout", tone: "info", text: "当前 runtime 已禁用写入文件工具，待授权后落盘。" },
      { kind: "paragraph", text: "正文保留。" },
    ]));
    assert.deepEqual(sanitized.blocks, [{ kind: "paragraph", text: "正文保留。" }]);
  }

  {
    const review = normalizeReviewDecision({
      passed: false,
      severity: "blocking",
      issues: [],
      decisionReason: "需要用户选择路线",
      needsUserDecision: {
        question: "采用哪条路线？",
        options: ["路线 A", "路线 B"],
        reason: "两条路线会改变最终交付方向",
      },
    }, "fallback");
    assert.deepEqual(review.needsUserDecision, {
      question: "采用哪条路线？",
      options: ["路线 A", "路线 B"],
      reason: "两条路线会改变最终交付方向",
      partialSummary: undefined,
    });
  }

  console.log("agentOrchestration specs passed");
}
