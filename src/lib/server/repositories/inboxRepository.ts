/**
 * inboxRepository — Thread/Saga 派生的 inbox 消息追加（PR14.3）。
 *
 * 计划 ref：§12.3.1.3 + §12.3.2 (sendThreadMessage 双写 callback 之 inbox 半路径)。
 *
 * 存储现状（重要）：
 *  - inbox **不是物理表**，而是 `goal_event_log.notification.delivered` 事件的派生
 *    投影。前端通过 `RuntimeEventBridge` 监听 `notification.delivered{target:"inbox"}`
 *    渲染 inbox 列表项；inboxItemId 仅是事件 payload 内的字符串引用。
 *  - 现有 `goalSideEffects`（旧名 goalNotificationWorker）写 `inbox-${instance.id}`；
 *    本仓库针对
 *    Thread/Saga 派生的非 task-instance 通知（thread tick post_message /
 *    thread paused 通告 / saga 失败告警）写 `inbox-${source}-${threadId|topicId}-${ts}`。
 *  - 严格走 `appendGoalEventOnce`（带 idempotencyKey）保证同一 traceId 重写不重复。
 *
 * thread/saga 派生 inbox 没有 task instanceId — appendGoalEventOnce 的 instanceId
 * 字段允许为 undefined；goalId 用 topicId（在 envelope 双写期 topicId === goalId）。
 */

import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import type { ThreadTickPostMessageSeverity } from "@/types/topic";

export type InboxAppendSource = "thread_tick" | "thread_paused" | "saga_failed";

export type AppendInboxMessageInput = {
  /** Topic ID（与 envelope 中 goalId 等价；driver 双写期保证一致）。 */
  topicId: string;
  /** 触发源关联的 Thread；saga_failed 场景可缺省。 */
  threadId?: string;
  /** 文本内容（建议 ≤ 500 字符以满足 post_message 硬约束）。 */
  text: string;
  /** UI 渲染优先级 — 与 ThreadTickPostMessageSeverity 取值一致。 */
  severity: ThreadTickPostMessageSeverity;
  /** 派生来源；用于 inboxItemId 命名与诊断。 */
  source: InboxAppendSource;
  /** 调用方提供的 trace 字符串；同 trace 重入会去重。默认 nowIso()。 */
  traceId?: string;
  /** 注入时钟，spec 用；默认 new Date()。 */
  now?: () => Date;
};

export type AppendInboxMessageResult = {
  inboxMessageId: string;
};

function deriveInboxId(source: InboxAppendSource, anchor: string, traceId: string) {
  return `inbox-${source}-${anchor}-${traceId}`;
}

/**
 * 追加一条 thread/saga 派生的 inbox 消息。
 *
 * 实现：写一条 `notification.delivered{target:"inbox"}` 事件到 goal_event_log；
 * inboxMessageId 派生于 source/threadId/topicId/traceId，保证幂等。
 *
 * idempotencyKey：`inbox.append:${source}:${anchor}:${traceId}`
 *  - anchor = threadId ?? topicId
 *  - 同 idempotencyKey 重入返回首次产生的 inboxMessageId（不重复写事件）
 *
 * 注意：text/severity 不写入 goal_event_log payload（payload 仅记录 target +
 * notificationId），避免 ≤8KB 限制；UI 端通过 conversation_messages 拉文本，
 * inbox 仅承载"有未读项"的标记。
 */
export function appendInboxMessage(input: AppendInboxMessageInput): AppendInboxMessageResult {
  if (!input.topicId) {
    throw new Error("appendInboxMessage: topicId required");
  }
  if (!input.text || !input.text.trim()) {
    throw new Error("appendInboxMessage: text required");
  }

  const nowFn = input.now ?? (() => new Date());
  const nowIso = nowFn().toISOString();
  const traceId = input.traceId ?? nowIso;
  const anchor = input.threadId ?? input.topicId;
  const inboxMessageId = deriveInboxId(input.source, anchor, traceId);
  // idempotencyKey 包含 topicId，避免跨 topic 同 traceId+source+threadId 误命中
  const idempotencyKey = `inbox.append:${input.topicId}:${input.source}:${anchor}:${traceId}`;

  appendGoalEventOnce({
    goalId: input.topicId,
    kind: "notification.delivered",
    producedBy: "worker",
    idempotencyKey,
    payload: {
      target: "inbox",
      notificationId: inboxMessageId,
    },
    createdAt: nowIso,
  });

  return { inboxMessageId };
}
