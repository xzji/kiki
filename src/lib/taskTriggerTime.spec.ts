import assert from "node:assert/strict";

import {
  computeNextTickAt,
  isTaskTriggerDue,
  parseTaskTriggerRule,
  parseThreadLoopInterval,
} from "@/lib/taskTriggerTime";
import type { Task } from "@/types/kiki";
import type { Thread } from "@/types/topic";

function oneShotTask(triggerRule: string): Task {
  return {
    id: "task-trigger-spec",
    subGoalId: "sub-trigger-spec",
    title: "触发规则测试",
    description: "",
    expectedOutcome: "",
    taskType: "one_shot",
    triggerRule,
    progress: 0,
    instances: [],
    executionKind: "generic_result",
    resultViewKind: "generic_result",
  };
}

function buildThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-spec",
    topicId: "topic-spec",
    title: "spec",
    intent: "",
    loopInterval: "daily",
    status: "active",
    memory: {},
    silentCount: 0,
    failureCount: 0,
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

export function runTaskTriggerTimeSpecs() {
  assert.deepEqual(parseTaskTriggerRule("立即执行"), { kind: "immediate" });
  assert.equal(isTaskTriggerDue(oneShotTask("立即执行"), new Date("2026-05-30T03:00:00.000Z")), true);

  // ---------- parseThreadLoopInterval ----------
  assert.deepEqual(parseThreadLoopInterval("realtime"), { kind: "realtime", intervalMs: 60_000 });
  assert.deepEqual(parseThreadLoopInterval("hourly"), { kind: "hourly", intervalMs: 3_600_000 });
  assert.deepEqual(parseThreadLoopInterval("daily"), { kind: "daily", intervalMs: 86_400_000 });
  assert.deepEqual(parseThreadLoopInterval("weekly"), { kind: "weekly", intervalMs: 604_800_000 });
  assert.deepEqual(parseThreadLoopInterval("one_shot"), { kind: "one_shot" });
  assert.deepEqual(
    parseThreadLoopInterval({ kind: "cron", expr: "  0 9 * * *  " }),
    { kind: "cron", expr: "0 9 * * *" },
  );
  // 脏化兜底：未来扩展或脏数据传入未知字面量 / 非 cron 对象 → one_shot
  assert.deepEqual(
    parseThreadLoopInterval("unknown" as unknown as Parameters<typeof parseThreadLoopInterval>[0]),
    { kind: "one_shot" },
  );
  assert.deepEqual(
    parseThreadLoopInterval({ kind: "weird" } as unknown as Parameters<typeof parseThreadLoopInterval>[0]),
    { kind: "one_shot" },
  );

  // ---------- computeNextTickAt ----------
  // one_shot / cron 永不调度
  assert.equal(computeNextTickAt(buildThread({ loopInterval: "one_shot" }), new Date()), null);
  assert.equal(
    computeNextTickAt(buildThread({ loopInterval: { kind: "cron", expr: "* * * * *" } }), new Date()),
    null,
  );

  // 缺失 lastTickAt → now（首次立即生效）
  const nowFirst = new Date("2026-06-01T10:00:00.000Z");
  const firstTick = computeNextTickAt(buildThread({ lastTickAt: undefined }), nowFirst);
  assert.equal(firstTick?.toISOString(), nowFirst.toISOString());

  // 正常推进
  const nowNormal = new Date("2026-06-01T10:00:00.000Z");
  const nextHourly = computeNextTickAt(
    buildThread({ loopInterval: "hourly", lastTickAt: "2026-06-01T09:30:00.000Z" }),
    nowNormal,
  );
  assert.equal(nextHourly?.toISOString(), "2026-06-01T10:30:00.000Z");

  // 追赶场景：lastTickAt + interval 仍 < now → 跳到 now 之后最近一格
  const nowCatchup = new Date("2026-06-01T15:00:00.000Z");
  const nextCatchup = computeNextTickAt(
    buildThread({ loopInterval: "hourly", lastTickAt: "2026-06-01T08:00:00.000Z" }),
    nowCatchup,
  );
  // 09:00, 10:00, ..., 15:00 都已过去，下一格 = 16:00
  assert.equal(nextCatchup?.toISOString(), "2026-06-01T16:00:00.000Z");

  // lastTickAt 损坏字符串 → 回退 now
  const nextBroken = computeNextTickAt(
    buildThread({ lastTickAt: "not-a-date" }),
    nowFirst,
  );
  assert.equal(nextBroken?.toISOString(), nowFirst.toISOString());
}
