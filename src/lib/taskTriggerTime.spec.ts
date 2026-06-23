import assert from "node:assert/strict";

import {
  computeTaskNextTriggerAt,
  computeNextTickAt,
  isTaskTriggerDue,
  parseTaskTriggerRule,
  parseThreadLoopInterval,
} from "@/lib/taskTriggerTime";
import { normalizeTriggerSpec, normalizeTriggerSpecWithWarnings } from "@/types/trigger";
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
    infraFailureCount: 0,
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

export function runTaskTriggerTimeSpecs() {
  assert.deepEqual(parseTaskTriggerRule("立即执行"), { kind: "immediate" });
  assert.equal(isTaskTriggerDue(oneShotTask("立即执行"), new Date("2026-05-30T03:00:00.000Z")), true);
  assert.equal(
    computeTaskNextTriggerAt(oneShotTask("立即执行"), new Date("2026-05-30T03:00:00.000Z"))?.toISOString(),
    "2026-05-30T03:00:00.000Z",
  );

  // 依赖驱动的自然语言触发（解析为 unsupported/condition）：尚无实例的 one_shot 应放行，
  // 把触发时机交给调度器的依赖就绪判定，而非被时间门永久拦死。
  assert.deepEqual(parseTaskTriggerRule("1-1 完成后立即触发"), { kind: "unsupported" });
  assert.equal(isTaskTriggerDue(oneShotTask("1-1 完成后立即触发"), new Date("2026-05-30T03:00:00.000Z")), true);
  assert.equal(isTaskTriggerDue(oneShotTask("目的地确认后立即触发"), new Date("2026-05-30T03:00:00.000Z")), true);
  // 但已有实例（已执行过）的 one_shot 不应再次触发。
  const ranOnce = oneShotTask("1-1 完成后立即触发");
  ranOnce.instances = [{ id: "inst-x", taskId: ranOnce.id, status: "completed", createdAt: "2026-05-30T01:00:00.000Z" } as never];
  assert.equal(isTaskTriggerDue(ranOnce, new Date("2026-05-30T03:00:00.000Z")), false);
  assert.equal(computeTaskNextTriggerAt(ranOnce, new Date("2026-05-30T03:00:00.000Z")), null);

  const weeklyNext = computeTaskNextTriggerAt(oneShotTask("每周二 09:30 触发"), new Date("2026-06-01T00:00:00.000Z"));
  assert.equal(weeklyNext?.getDay(), 2);
  assert.equal(weeklyNext?.getHours(), 9);
  assert.equal(weeklyNext?.getMinutes(), 30);

  const dailyTask = oneShotTask("每天 07:30 触发");
  dailyTask.taskType = "repeat";
  dailyTask.instances = [
    {
      id: "inst-daily",
      taskId: dailyTask.id,
      status: "completed",
      dateLabel: "06-01",
      createdAt: "2026-06-01T00:30:00.000Z",
    } as never,
  ];
  const dailyNext = computeTaskNextTriggerAt(dailyTask, new Date("2026-06-01T08:00:00.000Z"));
  assert.equal(dailyNext?.getHours(), 7);
  assert.equal(dailyNext?.getMinutes(), 30);

  const intervalTask = oneShotTask("每 3 个小时触发");
  intervalTask.taskType = "repeat";
  intervalTask.instances = [
    { id: "inst-interval", taskId: intervalTask.id, status: "completed", createdAt: "2026-06-01T01:00:00.000Z" } as never,
  ];
  assert.equal(
    computeTaskNextTriggerAt(intervalTask, new Date("2026-06-01T02:00:00.000Z"))?.toISOString(),
    "2026-06-01T04:00:00.000Z",
  );

  // ---------- normalizeTriggerSpec ----------
  assert.deepEqual(normalizeTriggerSpec("hourly"), { kind: "hourly" });
  assert.deepEqual(normalizeTriggerSpec("daily"), { kind: "daily" });
  assert.deepEqual(normalizeTriggerSpec("weekly"), { kind: "weekly" });
  assert.deepEqual(normalizeTriggerSpec("monthly"), { kind: "monthly" });
  assert.deepEqual(
    normalizeTriggerSpec("cron:0 9 * * 1-5 tz=America/New_York"),
    { kind: "cron", expr: "0 9 * * 1-5", timezone: "America/New_York" },
  );
  assert.deepEqual(
    normalizeTriggerSpec("interval:15m"),
    { kind: "interval", everyMs: 900_000, value: 15, unit: "m" },
  );
  assert.deepEqual(
    normalizeTriggerSpec(
      'phased:{"timezone":"America/New_York","phases":[{"id":"market","start":"09:30","end":"16:00","daysOfWeek":[1,2,3,4,5],"trigger":"interval:15m"}]}',
    ),
    {
      kind: "phased",
      timezone: "America/New_York",
      phases: [
        {
          id: "market",
          label: undefined,
          start: "09:30",
          end: "16:00",
          timezone: undefined,
          daysOfWeek: [1, 2, 3, 4, 5],
          daysOfMonth: undefined,
          months: undefined,
          trigger: { kind: "interval", everyMs: 900_000, value: 15, unit: "m" },
          metadata: undefined,
        },
      ],
    },
  );
  assert.equal(normalizeTriggerSpec("phased:not-json"), null);
  {
    const result = normalizeTriggerSpecWithWarnings("phased:not-json", { path: "planner.tasks.1.triggerSpec" });
    assert.equal(result.trigger, null);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, "trigger_spec_invalid");
    assert.equal(result.warnings[0]?.path, "planner.tasks.1.triggerSpec");
  }

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
  assert.deepEqual(
    parseThreadLoopInterval("interval:15m" as unknown as Parameters<typeof parseThreadLoopInterval>[0]),
    { kind: "interval", intervalMs: 900_000 },
  );
  assert.deepEqual(
    parseThreadLoopInterval({ kind: "monthly", daysOfMonth: [1] }),
    { kind: "monthly", spec: { kind: "monthly", daysOfMonth: [1], time: undefined, timezone: undefined } },
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
  // one_shot / event-only 永不调度
  assert.equal(computeNextTickAt(buildThread({ loopInterval: "one_shot" }), new Date()), null);
  assert.equal(
    computeNextTickAt(buildThread({ loopInterval: { kind: "event", sources: ["task_completed"] } }), new Date()),
    null,
  );
  assert.equal(
    computeNextTickAt(
      buildThread({ loopInterval: { kind: "cron", expr: "0 8 * * *", timezone: "UTC" } }),
      new Date("2026-06-01T07:59:00.000Z"),
    )?.toISOString(),
    "2026-06-01T08:00:00.000Z",
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

  // monthly
  const nextMonthly = computeNextTickAt(
    buildThread({ loopInterval: { kind: "monthly", daysOfMonth: [15], time: "09:00", timezone: "UTC" } }),
    new Date("2026-06-01T10:00:00.000Z"),
  );
  assert.equal(nextMonthly?.toISOString(), "2026-06-15T09:00:00.000Z");

  // phased 美股窗口：美东 09:30 对应夏令时 13:30Z，窗口内按 15 分钟推进
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
  assert.equal(
    computeNextTickAt(buildThread({ loopInterval: marketLoop }), new Date("2026-06-01T13:30:00.000Z"))?.toISOString(),
    "2026-06-01T13:45:00.000Z",
  );
  assert.equal(
    computeNextTickAt(buildThread({ loopInterval: marketLoop }), new Date("2026-06-01T08:00:00.000Z"))?.toISOString(),
    "2026-06-01T13:30:00.000Z",
  );

  // composed：取最早的可计算触发时间，event-only 不参与时间计算
  assert.equal(
    computeNextTickAt(
      buildThread({
        loopInterval: {
          kind: "composed",
          triggers: [
            { kind: "event", sources: ["task_completed"] },
            { kind: "cron", expr: "0 8 * * *", timezone: "UTC" },
          ],
        },
      }),
      new Date("2026-06-01T07:59:00.000Z"),
    )?.toISOString(),
    "2026-06-01T08:00:00.000Z",
  );

  // Task.trigger 优先于 triggerRule
  assert.equal(
    isTaskTriggerDue(
      { ...oneShotTask("立即执行"), trigger: { kind: "event", sources: ["task_completed"] } },
      new Date("2026-06-01T08:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    isTaskTriggerDue(
      { ...oneShotTask("满足触发条件后执行：等待"), trigger: { kind: "cron", expr: "0 8 * * *", timezone: "UTC" } },
      new Date("2026-06-01T08:00:00.000Z"),
    ),
    true,
  );
}
