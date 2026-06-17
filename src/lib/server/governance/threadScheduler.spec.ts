/**
 * threadScheduler spec — 验证 §3.4.4 调度选择器。
 */

import assert from "node:assert/strict";

import { isThreadDue, selectDueThreads } from "@/lib/server/governance/threadScheduler";
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
    infraFailureCount: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    revision: 1,
    ...overrides,
  };
}

export function runThreadSchedulerSpecs() {
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

  // ---------- cron ----------
  {
    const verdict = isThreadDue(
      makeThread({ loopInterval: { kind: "cron", expr: "0 8 * * *", timezone: "UTC" } }),
      NOW,
    );
    assert.equal(verdict?.reason, "cron_due");
  }

  // ---------- event-only 无事件 nextTickAt 时不 due ----------
  {
    assert.equal(
      isThreadDue(makeThread({ loopInterval: { kind: "event", sources: ["task_completed"] } }), NOW),
      null,
    );
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

  // ---------- phased 美股窗口二次校验 ----------
  {
    const marketLoop = {
      kind: "phased" as const,
      timezone: "America/New_York",
      phases: [
        {
          id: "market",
          start: "09:30",
          end: "16:00",
          daysOfWeek: [1, 2, 3, 4, 5],
          trigger: { kind: "interval" as const, everyMs: 900_000, value: 15, unit: "m" as const },
        },
      ],
    };
    const open = isThreadDue(
      makeThread({
        loopInterval: marketLoop,
        lastTickAt: "2026-06-01T13:15:00.000Z",
        nextTickAt: "2026-06-01T13:30:00.000Z",
      }),
      new Date("2026-06-01T13:30:00.000Z"),
    );
    assert.equal(open?.reason, "interval_due", "美东 09:30 窗口内应 due");
    assert.equal(
      isThreadDue(
        makeThread({
          loopInterval: marketLoop,
          lastTickAt: "2026-06-01T07:45:00.000Z",
          nextTickAt: "2026-06-01T08:00:00.000Z",
        }),
        new Date("2026-06-01T08:00:00.000Z"),
      ),
      null,
      "美股凌晨窗口外不 due",
    );
    assert.equal(
      isThreadDue(
        makeThread({
          loopInterval: marketLoop,
          lastTickAt: "2026-06-06T13:15:00.000Z",
          nextTickAt: "2026-06-06T13:30:00.000Z",
        }),
        new Date("2026-06-06T13:30:00.000Z"),
      ),
      null,
      "周末不 due",
    );
  }

  // ---------- composed 取最早可 due 分支 ----------
  {
    const verdict = isThreadDue(
      makeThread({
        loopInterval: {
          kind: "composed",
          triggers: [
            { kind: "event", sources: ["task_completed"] },
            { kind: "cron", expr: "0 8 * * *", timezone: "UTC" },
          ],
        },
      }),
      NOW,
    );
    assert.equal(verdict?.reason, "first_tick");
    assert.equal(verdict?.scheduledAt.toISOString(), NOW.toISOString());
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
