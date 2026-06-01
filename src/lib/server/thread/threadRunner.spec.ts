/**
 * threadRunner spec — 验证 §3.4.2 编排核心。
 *
 * 覆盖：
 *  - happy path（dispatch_task / post_message / silent / 多动作叠加）
 *  - 全 silent → silentCount 累加；非全 silent → silentCount 重置
 *  - memoryDelta 浅合并 + 缺省时不动 memory
 *  - failureCount 累加规则（invoke 异常 / 校验失败 / 阈值触发 paused）
 *  - 成功一次重置 failureCount
 *  - rawText fallback 解析路径
 */

import assert from "node:assert/strict";

import {
  groupActions,
  runThreadTick,
  type ThreadTickContext,
} from "@/lib/server/thread/threadRunner";
import { ThreadTickOutputValidationError } from "@/lib/server/thread/threadTickOutputSchema";
import {
  THREAD_FAILURE_PAUSE_THRESHOLD,
  type Thread,
  type ThreadTickOutput,
  type Topic,
} from "@/types/topic";

const FIXED_NOW = new Date("2026-06-01T08:00:00.000Z");

function makeTopic(): Topic {
  return {
    id: "topic-runner-1",
    title: "美股投资监控",
    summary: "持续追踪 NVDA",
    threads: [],
    status: "active",
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    revision: 1,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-runner-1",
    topicId: "topic-runner-1",
    title: "盘前简报",
    intent: "每日盘前总结",
    loopInterval: "daily",
    status: "active",
    memory: { lastDigest: "2026-05-31" },
    silentCount: 0,
    failureCount: 0,
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    revision: 3,
    lastTickAt: "2026-05-31T08:00:00.000Z",
    nextTickAt: "2026-06-01T08:00:00.000Z",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ThreadTickContext> = {}): ThreadTickContext {
  return {
    topic: makeTopic(),
    thread: makeThread(),
    recentTaskInstances: [],
    now: FIXED_NOW,
    ...overrides,
  };
}

export async function runThreadRunnerSpecs() {
  // ---------- happy: post_message + memoryDelta 合并 ----------
  {
    const output: ThreadTickOutput = {
      actions: [
        { kind: "post_message", threadId: "thread-runner-1", text: "盘前简报", severity: "info" },
      ],
      memoryDelta: { lastDigest: "2026-06-01" },
    };
    const result = await runThreadTick({
      ctx: makeCtx(),
      agentRunId: "ar-1",
      invoke: async () => ({ rawText: JSON.stringify(output), parsed: output as unknown as Record<string, unknown> }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.patch.silentCount, 0, "post_message 不计 silent");
    assert.equal(result.patch.failureCount, 0);
    assert.equal(result.patch.memory.lastDigest, "2026-06-01", "memoryDelta 合并");
    assert.equal(result.patch.lastTickAt, FIXED_NOW.toISOString());
    assert.ok(result.patch.nextTickAt && result.patch.nextTickAt > result.patch.lastTickAt, "nextTickAt 严格在未来");
    assert.equal(result.output.actions[0]?.kind, "post_message");
  }

  // ---------- happy: 全 silent → silentCount 累加 ----------
  {
    const result = await runThreadTick({
      ctx: makeCtx({ thread: makeThread({ silentCount: 3 }) }),
      agentRunId: "ar-2",
      invoke: async () => ({
        rawText: "",
        parsed: { actions: [{ kind: "silent", reason: "无信号" }] },
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.patch.silentCount, 4, "全 silent 应累加 silentCount");
    assert.equal(result.patch.failureCount, 0);
  }

  // ---------- happy: 多动作叠加 ----------
  {
    const result = await runThreadTick({
      ctx: makeCtx({ thread: makeThread({ silentCount: 7 }) }),
      agentRunId: "ar-3",
      invoke: async () => ({
        rawText: "",
        parsed: {
          actions: [
            { kind: "post_message", threadId: "thread-runner-1", text: "x", severity: "info" },
            {
              kind: "dispatch_task",
              threadId: "thread-runner-1",
              reason: "深度分析",
              taskDraft: { title: "复盘 NVDA" },
            },
          ],
        },
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.patch.silentCount, 0, "非全 silent 应重置 silentCount");
    const grouped = groupActions(result.output.actions);
    assert.equal(grouped.dispatch.length, 1);
    assert.equal(grouped.postMessage.length, 1);
  }

  // ---------- failure: invoke 异常 → failureCount + 1 ----------
  {
    const result = await runThreadTick({
      ctx: makeCtx({ thread: makeThread({ failureCount: 1 }) }),
      agentRunId: "ar-4",
      invoke: async () => {
        throw new Error("network down");
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "invoke_error");
    assert.equal(result.patch.failureCount, 2);
    assert.equal(result.patch.silentCount, 0, "失败不计 silent");
    assert.equal(result.patch.status, "active", "未达阈值不应 paused");
    assert.ok(result.patch.nextTickAt, "未达阈值仍应有 nextTickAt");
  }

  // ---------- failure: 校验失败 → failureCount + 1 ----------
  {
    const result = await runThreadTick({
      ctx: makeCtx(),
      agentRunId: "ar-5",
      invoke: async () => ({
        rawText: "",
        parsed: { actions: [{ kind: "explode" }] },
      }),
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "validation_error");
    if (result.error.kind === "validation_error") {
      assert.ok(
        result.error.error instanceof ThreadTickOutputValidationError,
        "validation_error 应包装 ThreadTickOutputValidationError",
      );
    }
    assert.equal(result.patch.failureCount, 1);
  }

  // ---------- failure: 阈值触发 paused ----------
  {
    const result = await runThreadTick({
      ctx: makeCtx({
        thread: makeThread({ failureCount: THREAD_FAILURE_PAUSE_THRESHOLD - 1 }),
      }),
      agentRunId: "ar-6",
      invoke: async () => {
        throw new Error("still down");
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.patch.status, "paused");
    assert.equal(result.patch.failureCount, THREAD_FAILURE_PAUSE_THRESHOLD);
    assert.equal(result.patch.nextTickAt, undefined, "paused 后应清空 nextTickAt");
    assert.equal(result.pauseReason, "failure_threshold");
  }

  // ---------- rawText fallback：parsed 缺失 + 合法 JSON ----------
  {
    const output = { actions: [{ kind: "silent", reason: "rawText path" }] };
    const result = await runThreadTick({
      ctx: makeCtx(),
      agentRunId: "ar-7",
      invoke: async () => ({ rawText: JSON.stringify(output) }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.output.actions[0]?.kind, "silent");
  }

  // ---------- rawText fallback：parsed 缺失 + 非法 JSON ----------
  {
    const result = await runThreadTick({
      ctx: makeCtx(),
      agentRunId: "ar-8",
      invoke: async () => ({ rawText: "not-json {" }),
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "validation_error");
  }

  // ---------- 成功一次后 failureCount 重置 ----------
  {
    const result = await runThreadTick({
      ctx: makeCtx({ thread: makeThread({ failureCount: 3 }) }),
      agentRunId: "ar-9",
      invoke: async () => ({
        rawText: "",
        parsed: { actions: [{ kind: "silent", reason: "ok" }] },
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.patch.failureCount, 0);
  }
}
