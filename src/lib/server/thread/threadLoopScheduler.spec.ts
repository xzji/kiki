/**
 * threadLoopScheduler spec — 验证 §3.4.4 调度选择器。
 */

import assert from "node:assert/strict";

import { isThreadDue, selectDueThreads } from "@/lib/server/thread/threadLoopScheduler";
import { THREAD_FAILURE_PAUSE_THRESHOLD, type Thread } from "@/types/topic";

const NOW = new Date("2026-06-01T08:00:00.000Z");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t-1",
    topicId: "topic-1",
    title: "x",
    intent: "y",
    loopInterval: "daily",
    status: "active",
    memory: {},
    silentCount: 0,
    failureCount: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    revision: 1,
    ...overrides,
  };
}

export function runThreadLoopSchedulerSpecs() {
  // ---------- 非 active 全部排除 ----------
  for (const status of ["paused", "archived"] as const) {
    assert.equal(isThreadDue(makeThread({ status }), NOW), null, `status=${status} 应不 due`);
  }

  // ---------- failureCount 阈值排除 ----------
  assert.equal(
    isThreadDue(makeThread({ failureCount: THREAD_FAILURE_PAUSE_THRESHOLD }), NOW),
    null,
    "failureCount 阈值应排除",
  );

  // ---------- one_shot ----------
  {
    // 从未触发：due
    const verdict = isThreadDue(makeThread({ loopInterval: "one_shot" }), NOW);
    assert.equal(verdict?.reason, "first_tick");
    // 已触发：不再 due
    assert.equal(
      isThreadDue(makeThread({ loopInterval: "one_shot", lastTickAt: NOW.toISOString() }), NOW),
      null,
    );
  }

  // ---------- cron 透传 ----------
  {
    const verdict = isThreadDue(
      makeThread({ loopInterval: { kind: "cron", expr: "0 8 * * *" } }),
      NOW,
    );
    assert.equal(verdict?.reason, "cron_passthrough");
  }

  // ---------- 显式 nextTickAt 在过去：due ----------
  {
    const verdict = isThreadDue(
      makeThread({ nextTickAt: "2026-06-01T07:30:00.000Z", lastTickAt: "2026-05-31T08:00:00.000Z" }),
      NOW,
    );
    assert.equal(verdict?.reason, "event_triggered");
  }

  // ---------- 正常 review 到期：interval_due ----------
  {
    const verdict = isThreadDue(
      makeThread({ nextTickAt: "2026-06-01T08:00:00.000Z", lastTickAt: "2026-05-31T08:00:00.000Z" }),
      NOW,
    );
    assert.equal(verdict?.reason, "interval_due");
  }

  // ---------- 显式 nextTickAt 在未来：不 due ----------
  {
    const verdict = isThreadDue(makeThread({ nextTickAt: "2026-06-02T08:00:00.000Z" }), NOW);
    assert.equal(verdict, null);
  }

  // ---------- 缺 nextTickAt + 缺 lastTickAt：首次触发立即 due ----------
  {
    const verdict = isThreadDue(makeThread({ nextTickAt: undefined, lastTickAt: undefined }), NOW);
    assert.equal(verdict?.reason, "first_tick");
  }

  // ---------- 缺 nextTickAt + 有 lastTickAt：fallback 到 computeNextTickAt ----------
  {
    const verdict = isThreadDue(
      makeThread({
        loopInterval: "hourly",
        nextTickAt: undefined,
        lastTickAt: "2026-06-01T06:00:00.000Z",
      }),
      NOW,
    );
    assert.equal(verdict?.reason, "interval_due", "hourly 间隔应 due");
  }

  // ---------- 缺 nextTickAt + 损坏 nextTickAt 字符串 ----------
  {
    const verdict = isThreadDue(makeThread({ nextTickAt: "not-a-date", lastTickAt: undefined }), NOW);
    assert.equal(verdict?.reason, "first_tick", "损坏字符串应回落到 first_tick 路径");
  }

  // ---------- selectDueThreads 排序 ----------
  {
    const list = selectDueThreads(
      [
        makeThread({ id: "t-late", nextTickAt: "2026-06-01T07:55:00.000Z" }),
        makeThread({ id: "t-early", nextTickAt: "2026-06-01T07:00:00.000Z" }),
        makeThread({ id: "t-future", nextTickAt: "2026-06-02T00:00:00.000Z" }),
        makeThread({ id: "t-paused", status: "paused", nextTickAt: "2026-06-01T07:00:00.000Z" }),
      ],
      NOW,
    );
    assert.deepEqual(
      list.map((d) => d.thread.id),
      ["t-early", "t-late"],
      "排序：早 due 优先；非 active / 未来 due 排除",
    );
  }
}
