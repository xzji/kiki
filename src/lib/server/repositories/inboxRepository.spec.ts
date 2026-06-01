/**
 * inboxRepository spec — 验证 PR14.3 行为。
 *
 * 计划 ref：§12.3.4。
 *
 * 覆盖：
 *  1. 写入成功返回符合规则的 inboxMessageId；goal_event_log 中存在
 *     一条 `notification.delivered{target:"inbox"}` 事件。
 *  2. 同 idempotencyKey 重入返回相同 ID，不重复写事件。
 *  3. 不同 source / anchor 派生不同 ID。
 *  4. 缺 topicId / 空 text 抛错。
 */

import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { getDatabase } from "@/lib/server/db/client";

import { appendInboxMessage } from "./inboxRepository";

function countInboxEvents(): number {
  const rows = getDatabase()
    .prepare(`SELECT payload_json FROM goal_event_log WHERE kind = 'notification.delivered'`)
    .all() as Array<{ payload_json: string }>;
  return rows.filter((row) => {
    try {
      const payload = JSON.parse(row.payload_json) as { target?: string; notificationId?: string };
      return payload?.target === "inbox";
    } catch {
      return false;
    }
  }).length;
}

export async function runInboxRepositorySpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // -----------------------------------------------------------------------
  // 1. 基本写入 + ID 派生
  // -----------------------------------------------------------------------
  {
    const traceId = "2026-06-01T00:00:00.000Z";
    const result = appendInboxMessage({
      topicId: "topic-1",
      threadId: "thread-1",
      text: "hello",
      severity: "info",
      source: "thread_tick",
      traceId,
    });
    assert.equal(
      result.inboxMessageId,
      `inbox-thread_tick-thread-1-${traceId}`,
      "inboxMessageId 派生规则",
    );
    const total = countInboxEvents();
    assert.ok(total >= 1, "goal_event_log 至少 1 条 inbox 事件");
  }

  // -----------------------------------------------------------------------
  // 2. 同 idempotencyKey 幂等：返回相同 ID + 不重复写事件
  // -----------------------------------------------------------------------
  {
    const before = countInboxEvents();
    const traceId = "2026-06-01T01:00:00.000Z";
    const r1 = appendInboxMessage({
      topicId: "topic-2",
      threadId: "thread-2",
      text: "alert",
      severity: "warning",
      source: "thread_paused",
      traceId,
    });
    const r2 = appendInboxMessage({
      topicId: "topic-2",
      threadId: "thread-2",
      text: "alert",
      severity: "warning",
      source: "thread_paused",
      traceId,
    });
    assert.equal(r1.inboxMessageId, r2.inboxMessageId, "重入返回同一 ID");
    const after = countInboxEvents();
    assert.equal(after - before, 1, "幂等：仅写入 1 条事件");
  }

  // -----------------------------------------------------------------------
  // 3. saga_failed 缺 threadId 时回退使用 topicId 作为 anchor
  // -----------------------------------------------------------------------
  {
    const traceId = "2026-06-01T02:00:00.000Z";
    const result = appendInboxMessage({
      topicId: "topic-3",
      text: "saga abort",
      severity: "important",
      source: "saga_failed",
      traceId,
    });
    assert.equal(
      result.inboxMessageId,
      `inbox-saga_failed-topic-3-${traceId}`,
      "saga_failed 用 topicId 作 anchor",
    );
  }

  // -----------------------------------------------------------------------
  // 4. 不同 source / anchor 产生不同 ID
  // -----------------------------------------------------------------------
  {
    const traceId = "2026-06-01T03:00:00.000Z";
    const r1 = appendInboxMessage({
      topicId: "topic-4",
      threadId: "thread-4",
      text: "x",
      severity: "info",
      source: "thread_tick",
      traceId,
    });
    const r2 = appendInboxMessage({
      topicId: "topic-4",
      threadId: "thread-4",
      text: "x",
      severity: "info",
      source: "thread_paused",
      traceId,
    });
    assert.notEqual(r1.inboxMessageId, r2.inboxMessageId, "不同 source 产生不同 ID");
  }

  // -----------------------------------------------------------------------
  // 5. 输入校验
  // -----------------------------------------------------------------------
  {
    assert.throws(
      () =>
        appendInboxMessage({
          topicId: "",
          text: "ok",
          severity: "info",
          source: "thread_tick",
        }),
      /topicId required/,
    );
    assert.throws(
      () =>
        appendInboxMessage({
          topicId: "topic-x",
          text: "   ",
          severity: "info",
          source: "thread_tick",
        }),
      /text required/,
    );
  }
}
