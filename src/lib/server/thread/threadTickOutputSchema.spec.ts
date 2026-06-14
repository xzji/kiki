/**
 * threadTickOutputSchema spec — 验证 §3.3.4 全部 8 条约束都会在解析阶段被强制。
 */

import assert from "node:assert/strict";

import {
  ThreadTickOutputValidationError,
  parseThreadTickOutput,
} from "@/lib/server/thread/threadTickOutputSchema";
import { THREAD_TICK_POST_MESSAGE_TEXT_LIMIT } from "@/types/topic";

const THREAD_ID = "thread-runner-spec";

function decision(
  actions: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assessment: "证据 task-1 显示状态健康",
    confidence: "high",
    actions,
    ...extra,
  };
}

function expectError(fn: () => unknown, code: ThreadTickOutputValidationError["code"], hint: string) {
  try {
    fn();
  } catch (error) {
    if (error instanceof ThreadTickOutputValidationError) {
      assert.equal(error.code, code, `${hint}: 期望错误 code ${code}，实际 ${error.code} (${error.message})`);
      return;
    }
    throw new Error(`${hint}: 抛出了非 ThreadTickOutputValidationError 错误：${String(error)}`);
  }
  throw new Error(`${hint}: 期望抛出错误 ${code}，但执行成功`);
}

export function runThreadTickOutputSchemaSpecs() {
  // ---------- happy path ----------
  const happy = parseThreadTickOutput(
    decision(
      [{ kind: "post_message", threadId: THREAD_ID, text: "盘前简报：NVDA 拉升", severity: "info" }],
      { memoryDelta: { lastDigestAt: "2026-06-01T00:00:00.000Z" } },
    ),
    THREAD_ID,
  );
  assert.equal(happy.assessment, "证据 task-1 显示状态健康");
  assert.equal(happy.confidence, "high");
  assert.equal(happy.actions.length, 1);
  assert.equal(happy.actions[0]?.kind, "post_message");
  assert.deepEqual(happy.memoryDelta, { lastDigestAt: "2026-06-01T00:00:00.000Z" });

  // dispatch_task happy
  const dispatchHappy = parseThreadTickOutput(
    decision([
      {
        kind: "dispatch_task",
        threadId: THREAD_ID,
        reason: "需要深度分析",
        taskDraft: {
          title: "复盘 NVDA 财报",
          objective: "提炼核心信号",
          deliverable: "300 字简报",
          acceptanceCriteria: ["覆盖 EPS/营收/Guidance"],
        },
      },
    ]),
    THREAD_ID,
  );
  assert.equal(dispatchHappy.actions[0]?.kind, "dispatch_task");
  if (dispatchHappy.actions[0]?.kind === "dispatch_task") {
    assert.equal(dispatchHappy.actions[0].taskDraft.triggerSpec, undefined);
  }

  const dispatchTriggerSpecHappy = parseThreadTickOutput(
    decision([
      {
        kind: "dispatch_task",
        threadId: THREAD_ID,
        reason: "需要盘中跟踪",
        taskDraft: {
          title: "盘中跟踪",
          objective: "跟踪美股盘中异动",
          deliverable: "异动摘要",
          acceptanceCriteria: ["包含触发原因"],
          triggerSpec: { kind: "cron", expr: "*/15 * * * *", timezone: "America/New_York" },
        },
      },
    ]),
    THREAD_ID,
  );
  assert.equal(dispatchTriggerSpecHappy.actions[0]?.kind, "dispatch_task");
  if (dispatchTriggerSpecHappy.actions[0]?.kind === "dispatch_task") {
    assert.deepEqual(dispatchTriggerSpecHappy.actions[0].taskDraft.triggerSpec, {
      kind: "cron",
      expr: "*/15 * * * *",
      timezone: "America/New_York",
    });
  }

  const updateHappy = parseThreadTickOutput(
    decision([
      {
        kind: "update_task",
        threadId: THREAD_ID,
        taskId: "task-1",
        reason: "调低频率",
        patch: { cadence: "每周一" },
      },
    ]),
    THREAD_ID,
  );
  assert.equal(updateHappy.actions[0]?.kind, "update_task");

  const updateTriggerSpecHappy = parseThreadTickOutput(
    decision([
      {
        kind: "update_task",
        threadId: THREAD_ID,
        taskId: "task-1",
        reason: "改为事件触发",
        patch: { triggerSpec: { kind: "event", sources: ["task_completed"] } },
      },
    ]),
    THREAD_ID,
  );
  assert.equal(updateTriggerSpecHappy.actions[0]?.kind, "update_task");
  if (updateTriggerSpecHappy.actions[0]?.kind === "update_task") {
    assert.deepEqual(updateTriggerSpecHappy.actions[0].patch.triggerSpec, {
      kind: "event",
      sources: ["task_completed"],
    });
  }

  const cancelHappy = parseThreadTickOutput(
    decision([
      {
        kind: "cancel_task",
        threadId: THREAD_ID,
        taskId: "task-1",
        reason: "关注点永久消失，task-1 已无需继续",
      },
    ]),
    THREAD_ID,
  );
  assert.equal(cancelHappy.actions[0]?.kind, "cancel_task");

  const cancelReplacementHappy = parseThreadTickOutput(
    decision([
      {
        kind: "cancel_task",
        threadId: THREAD_ID,
        taskId: "task-1",
        reason: "已被 task-2 替代，原任务无需继续",
      },
    ]),
    THREAD_ID,
  );
  assert.equal(cancelReplacementHappy.actions[0]?.kind, "cancel_task");

  const archiveHappy = parseThreadTickOutput(
    decision([
      {
        kind: "archive_thread",
        threadId: THREAD_ID,
        reason: "terminationCondition=完成一次复盘；证据 task-1 / instanceId=inst-1 的结果已完成一次复盘",
      },
    ], { assessment: "完成一次复盘已有 task-1 / instanceId=inst-1 结果证据" }),
    { expectedThreadId: THREAD_ID, terminationCondition: "完成一次复盘" },
  );
  assert.equal(archiveHappy.actions[0]?.kind, "archive_thread");

  // silent 单独存在 — OK
  const silent = parseThreadTickOutput(
    decision([{ kind: "silent", reason: "今日无新增信号" }]),
    THREAD_ID,
  );
  assert.equal(silent.actions[0]?.kind, "silent");

  // ---------- 失败路径 ----------
  // 非对象
  expectError(() => parseThreadTickOutput("oops", THREAD_ID), "not_object", "string 输入");
  expectError(() => parseThreadTickOutput(null, THREAD_ID), "not_object", "null 输入");
  expectError(() => parseThreadTickOutput([], THREAD_ID), "not_object", "数组输入");

  // actions 类型 / 空
  expectError(() => parseThreadTickOutput({ assessment: "x", confidence: "high", actions: "x" }, THREAD_ID), "actions_not_array", "actions 字符串");
  expectError(() => parseThreadTickOutput(decision([]), THREAD_ID), "actions_empty", "actions 空数组");
  expectError(
    () => parseThreadTickOutput({ confidence: "high", actions: [{ kind: "silent", reason: "x" }] }, THREAD_ID),
    "missing_field",
    "缺 assessment",
  );
  expectError(
    () => parseThreadTickOutput({ assessment: "x", actions: [{ kind: "silent", reason: "x" }] }, THREAD_ID),
    "invalid_confidence",
    "缺 confidence",
  );
  expectError(
    () => parseThreadTickOutput(decision([{ kind: "silent", reason: "x" }], { extra: true }), THREAD_ID),
    "unknown_root_field",
    "顶层未知字段",
  );

  // unknown kind
  expectError(
    () => parseThreadTickOutput(decision([{ kind: "explode" }]), THREAD_ID),
    "unknown_kind",
    "未知 kind",
  );

  // silent 与其他动作并存
  expectError(
    () =>
      parseThreadTickOutput(
        decision([
            { kind: "silent", reason: "无信号" },
            { kind: "post_message", threadId: THREAD_ID, text: "测试", severity: "info" },
        ]),
        THREAD_ID,
      ),
    "silent_with_others",
    "silent 与 post_message 并存",
  );

  // threadId 不一致
  expectError(
    () =>
      parseThreadTickOutput(
        decision([
            { kind: "post_message", threadId: "other-thread", text: "x", severity: "info" },
        ]),
        THREAD_ID,
      ),
    "thread_id_mismatch",
    "post_message threadId 不一致",
  );

  expectError(
    () =>
      parseThreadTickOutput(
        decision([
            {
              kind: "dispatch_task",
              threadId: "other-thread",
              reason: "x",
              taskDraft: { title: "t" },
            },
        ]),
        THREAD_ID,
      ),
    "thread_id_mismatch",
    "dispatch_task threadId 不一致",
  );

  // post_message 长度超限
  expectError(
    () =>
      parseThreadTickOutput(
        decision([
            {
              kind: "post_message",
              threadId: THREAD_ID,
              text: "a".repeat(THREAD_TICK_POST_MESSAGE_TEXT_LIMIT + 1),
              severity: "info",
            },
        ]),
        THREAD_ID,
      ),
    "post_message_too_long",
    "post_message 超过 500 字",
  );

  // severity 非法
  expectError(
    () =>
      parseThreadTickOutput(
        decision([{ kind: "post_message", threadId: THREAD_ID, text: "x", severity: "critical" }]),
        THREAD_ID,
      ),
    "invalid_severity",
    "未知 severity",
  );

  // taskDraft 缺 title
  expectError(
    () =>
      parseThreadTickOutput(
        decision([
            { kind: "dispatch_task", threadId: THREAD_ID, reason: "x", taskDraft: {} },
        ]),
        THREAD_ID,
      ),
    "missing_field",
    "taskDraft 缺 title",
  );

  // update_task 缺 taskId
  expectError(
    () =>
      parseThreadTickOutput(
        decision([
            { kind: "update_task", threadId: THREAD_ID, reason: "x", patch: { cadence: "每天" } },
        ]),
        THREAD_ID,
      ),
    "missing_field",
    "update_task 缺 taskId",
  );

  // 8KB payload
  const huge = "x".repeat(9 * 1024);
  expectError(
    () =>
      parseThreadTickOutput(
        decision([{ kind: "silent", reason: "padding" }], { memoryDelta: { huge } }),
        THREAD_ID,
      ),
    "payload_too_large",
    "payload > 8KB",
  );

  // memoryDelta 类型错
  expectError(
    () =>
      parseThreadTickOutput(
        decision([{ kind: "silent", reason: "x" }], { memoryDelta: "not-object" }),
        THREAD_ID,
      ),
    "missing_field",
    "memoryDelta 非对象",
  );

  // confidence=low 禁止高风险动作
  expectError(
    () =>
      parseThreadTickOutput(
        decision(
          [{
            kind: "dispatch_task",
            threadId: THREAD_ID,
            reason: "x",
            taskDraft: { title: "新增任务" },
          }],
          { confidence: "low" },
        ),
        THREAD_ID,
      ),
    "low_confidence_high_risk",
    "低置信禁止 dispatch_task",
  );

  // archive_thread 必须有 terminationCondition 和证据
  expectError(
    () =>
      parseThreadTickOutput(
        decision([{ kind: "archive_thread", threadId: THREAD_ID, reason: "已完成" }]),
        THREAD_ID,
      ),
    "archive_without_termination_condition",
    "archive 缺 terminationCondition",
  );
  expectError(
    () =>
      parseThreadTickOutput(
        decision([{ kind: "archive_thread", threadId: THREAD_ID, reason: "已满足终止条件" }]),
        { expectedThreadId: THREAD_ID, terminationCondition: "完成一次复盘" },
      ),
    "archive_missing_evidence",
    "archive 缺证据",
  );

  // cancel_task 必须说明永久消失 / 无需继续 / 替代关系
  expectError(
    () =>
      parseThreadTickOutput(
        decision(
          [{ kind: "cancel_task", threadId: THREAD_ID, taskId: "task-1", reason: "不需要了" }],
          { assessment: "缺少可追溯原因" },
        ),
        THREAD_ID,
      ),
    "cancel_missing_evidence",
    "cancel 缺证据",
  );

  // dispatch_task 不能与当前任务 title/objective 近似重复
  expectError(
    () =>
      parseThreadTickOutput(
        decision([
          {
            kind: "dispatch_task",
            threadId: THREAD_ID,
            reason: "新增覆盖",
            taskDraft: { title: "每日市场情绪速览", objective: "追踪市场情绪" },
          },
        ]),
        {
          expectedThreadId: THREAD_ID,
          currentTasks: [
            {
              id: "task-existing",
              subGoalId: THREAD_ID,
              title: "每日市场情绪速览",
              description: "追踪市场情绪",
              expectedOutcome: "市场情绪摘要",
              taskType: "repeat",
              triggerRule: "每天 09:00",
              progress: 0,
              instances: [],
              executionKind: "generic_result",
            },
          ],
        },
      ),
    "duplicate_dispatch_task",
    "重复 dispatch",
  );
}
