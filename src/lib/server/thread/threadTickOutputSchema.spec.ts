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
    {
      actions: [
        { kind: "post_message", threadId: THREAD_ID, text: "盘前简报：NVDA 拉升", severity: "info" },
      ],
      memoryDelta: { lastDigestAt: "2026-06-01T00:00:00.000Z" },
    },
    THREAD_ID,
  );
  assert.equal(happy.actions.length, 1);
  assert.equal(happy.actions[0]?.kind, "post_message");
  assert.deepEqual(happy.memoryDelta, { lastDigestAt: "2026-06-01T00:00:00.000Z" });

  // dispatch_task happy
  const dispatchHappy = parseThreadTickOutput(
    {
      actions: [
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
      ],
    },
    THREAD_ID,
  );
  assert.equal(dispatchHappy.actions[0]?.kind, "dispatch_task");

  const updateHappy = parseThreadTickOutput(
    {
      actions: [
        {
          kind: "update_task",
          threadId: THREAD_ID,
          taskId: "task-1",
          reason: "调低频率",
          patch: { cadence: "每周一" },
        },
      ],
    },
    THREAD_ID,
  );
  assert.equal(updateHappy.actions[0]?.kind, "update_task");

  const cancelHappy = parseThreadTickOutput(
    {
      actions: [
        {
          kind: "cancel_task",
          threadId: THREAD_ID,
          taskId: "task-1",
          reason: "关注点关闭",
        },
      ],
    },
    THREAD_ID,
  );
  assert.equal(cancelHappy.actions[0]?.kind, "cancel_task");

  const archiveHappy = parseThreadTickOutput(
    {
      actions: [
        {
          kind: "archive_thread",
          threadId: THREAD_ID,
          reason: "已满足终止条件",
        },
      ],
    },
    THREAD_ID,
  );
  assert.equal(archiveHappy.actions[0]?.kind, "archive_thread");

  // silent 单独存在 — OK
  const silent = parseThreadTickOutput(
    { actions: [{ kind: "silent", reason: "今日无新增信号" }] },
    THREAD_ID,
  );
  assert.equal(silent.actions[0]?.kind, "silent");

  // ---------- 失败路径 ----------
  // 非对象
  expectError(() => parseThreadTickOutput("oops", THREAD_ID), "not_object", "string 输入");
  expectError(() => parseThreadTickOutput(null, THREAD_ID), "not_object", "null 输入");
  expectError(() => parseThreadTickOutput([], THREAD_ID), "not_object", "数组输入");

  // actions 类型 / 空
  expectError(() => parseThreadTickOutput({ actions: "x" }, THREAD_ID), "actions_not_array", "actions 字符串");
  expectError(() => parseThreadTickOutput({ actions: [] }, THREAD_ID), "actions_empty", "actions 空数组");

  // unknown kind
  expectError(
    () => parseThreadTickOutput({ actions: [{ kind: "explode" }] }, THREAD_ID),
    "unknown_kind",
    "未知 kind",
  );

  // silent 与其他动作并存
  expectError(
    () =>
      parseThreadTickOutput(
        {
          actions: [
            { kind: "silent", reason: "无信号" },
            { kind: "post_message", threadId: THREAD_ID, text: "测试", severity: "info" },
          ],
        },
        THREAD_ID,
      ),
    "silent_with_others",
    "silent 与 post_message 并存",
  );

  // threadId 不一致
  expectError(
    () =>
      parseThreadTickOutput(
        {
          actions: [
            { kind: "post_message", threadId: "other-thread", text: "x", severity: "info" },
          ],
        },
        THREAD_ID,
      ),
    "thread_id_mismatch",
    "post_message threadId 不一致",
  );

  expectError(
    () =>
      parseThreadTickOutput(
        {
          actions: [
            {
              kind: "dispatch_task",
              threadId: "other-thread",
              reason: "x",
              taskDraft: { title: "t" },
            },
          ],
        },
        THREAD_ID,
      ),
    "thread_id_mismatch",
    "dispatch_task threadId 不一致",
  );

  // post_message 长度超限
  expectError(
    () =>
      parseThreadTickOutput(
        {
          actions: [
            {
              kind: "post_message",
              threadId: THREAD_ID,
              text: "a".repeat(THREAD_TICK_POST_MESSAGE_TEXT_LIMIT + 1),
              severity: "info",
            },
          ],
        },
        THREAD_ID,
      ),
    "post_message_too_long",
    "post_message 超过 500 字",
  );

  // severity 非法
  expectError(
    () =>
      parseThreadTickOutput(
        {
          actions: [{ kind: "post_message", threadId: THREAD_ID, text: "x", severity: "critical" }],
        },
        THREAD_ID,
      ),
    "invalid_severity",
    "未知 severity",
  );

  // taskDraft 缺 title
  expectError(
    () =>
      parseThreadTickOutput(
        {
          actions: [
            { kind: "dispatch_task", threadId: THREAD_ID, reason: "x", taskDraft: {} },
          ],
        },
        THREAD_ID,
      ),
    "missing_field",
    "taskDraft 缺 title",
  );

  // update_task 缺 taskId
  expectError(
    () =>
      parseThreadTickOutput(
        {
          actions: [
            { kind: "update_task", threadId: THREAD_ID, reason: "x", patch: { cadence: "每天" } },
          ],
        },
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
        {
          actions: [{ kind: "silent", reason: "padding" }],
          memoryDelta: { huge },
        },
        THREAD_ID,
      ),
    "payload_too_large",
    "payload > 8KB",
  );

  // memoryDelta 类型错
  expectError(
    () =>
      parseThreadTickOutput(
        { actions: [{ kind: "silent", reason: "x" }], memoryDelta: "not-object" },
        THREAD_ID,
      ),
    "missing_field",
    "memoryDelta 非对象",
  );
}
