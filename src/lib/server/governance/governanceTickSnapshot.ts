/**
 * governanceTickSnapshot — 治理 tick payload 的快照构造与刷新。
 *
 * 职责：
 *  1. 入队时构造 thread / topic snapshot（含 currentTasks / recentTaskInstances / threads）
 *  2. 派发前从 envelope 重新刷新 snapshot（snapshot freshness）
 *  3. 兼容旧 payload（缺字段补 []，让协议层 guard 不拒）
 *  4. lease 时 revision staleness 检查（避免烧 LLM）
 *
 * 不变量：
 *  - 与本地 `runThreadLoopFrame` callback (`threadGovernorCallbacks.collectCurrentThreadTasks`
 *    + `collectRecentTaskInstances`) 行为对齐；本模块是云路径的等价数据来源。
 *  - 漏装 currentTasks / recentTaskInstances 会让远端 ThreadRunner prompt 看到
 *    "板块尚无 Task / 最近无实例"，进而幻觉 dispatch_task；同时 schema 层
 *    duplicate_dispatch_task 校验依赖 currentTasks，缺失会让重复检测被绕过。
 *  - 不修改 baseRevision；revision 校验仍用入队时的 leased.baseRevision。
 */

import type {
  GovernanceTickJobPayload,
  GovernanceTickJobRecord,
} from "@/lib/server/repositories/governanceTickJobsRepository";
import { findThreadById } from "@/lib/server/repositories/threadsRepository";
import { findTopicById } from "@/lib/server/repositories/topicsRepository";
import { readTopicsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { buildThreadTickContext } from "@/lib/server/governance/governanceTickContext";
import type { Thread, Topic } from "@/types/topic";

function logSnapshot(message: string, fields: Record<string, unknown>) {
  console.info("[governance_tick_snapshot]", message, fields);
}

/**
 * 构造 thread tick payload 的 snapshot。
 *
 * 与本地 `runThreadLoopFrame` 的 callback 对齐（threadGovernorCallbacks.ts）：
 *  - currentTasks   ← goalsSnapshotThreadTaskView.listByThread（envelope 当前快照）
 *  - recentTaskInstances ← listRecentByThreadId（最近 7 天，limit 12）
 *
 * §candidate-3 P5：实际数据获取统一走 buildThreadTickContext；本函数只负责
 * 把 ContextData 拍成 snapshot 字段。
 */
export function buildThreadSnapshot(topic: Topic, thread: Thread) {
  const ctx = buildThreadTickContext({ topicId: topic.id, threadId: thread.id });
  if (!ctx.ok) {
    // entity 在入队这一刻已不存在；回退为空数组，让协议层 guard 仍然能通过。
    return {
      topic,
      thread,
      currentTasks: [],
      recentTaskInstances: [],
    } satisfies Record<string, unknown>;
  }
  return {
    topic: ctx.data.topic,
    thread: ctx.data.thread,
    currentTasks: ctx.data.currentTasks,
    recentTaskInstances: ctx.data.recentTaskInstances,
  } satisfies Record<string, unknown>;
}

/**
 * 构造 topic tick payload 的 snapshot。
 *
 * Topic.threads 已在 Topic 结构上，但显式再写一份 `threads` 字段，与
 * `governanceTickLocalExecutor.readArrayField(snapshot, "threads")` 的优先级对齐，
 * 且为后续 lease-time 刷新留接口（届时 threads 可独立于 topic 被刷新）。
 */
export function buildTopicSnapshot(topic: Topic) {
  return {
    topic,
    threads: topic.threads,
  } satisfies Record<string, unknown>;
}

/**
 * 在派发前用 envelope 当前态刷新 payload.snapshot。
 *
 * 行为：
 *  - thread：重新从 readTopicsSnapshot 取最新 topic + thread + currentTasks +
 *    recentTaskInstances；任何字段不可用就回退到原 payload 对应字段，
 *    并把新字段 `currentTasks` / `recentTaskInstances` / `threads` 默认为空数组，
 *    保证下游协议层（isGovernanceTickPayload）不会因为旧 payload 缺字段被拒。
 *  - topic：重新取 topic + threads；不可用则回退原 payload 并补 `threads: []`。
 *  - 不修改 baseRevision；revision 校验仍用入队时的 leased.baseRevision。
 *
 * 失败回退到原 payload 而不是抛错：保证派发链路稳健。
 */
export function refreshGovernancePayload(payload: GovernanceTickJobPayload): GovernanceTickJobPayload {
  try {
    const topics = readTopicsSnapshot([]);
    const topic = topics.find((item) => item.id === payload.topicId);
    if (!topic) return ensureSnapshotShape(payload);
    if (payload.targetKind === "topic") {
      return { ...payload, snapshot: buildTopicSnapshot(topic) };
    }
    const thread = topic.threads.find((item) => item.id === payload.threadId);
    if (!thread) return ensureSnapshotShape(payload);
    return { ...payload, snapshot: buildThreadSnapshot(topic, thread) };
  } catch (error) {
    logSnapshot("refreshGovernancePayload failed; fallback to enqueued snapshot", {
      jobTopicId: payload.topicId,
      jobThreadId: payload.threadId,
      targetKind: payload.targetKind,
      error: error instanceof Error ? error.message : String(error),
    });
    return ensureSnapshotShape(payload);
  }
}

/**
 * 兼容旧 job：旧 payload 可能不带 currentTasks / recentTaskInstances / threads，
 * 协议层校验（isGovernanceTickPayload）会因此拒绝。这里把缺失字段补为空数组，
 * 保证至少能下发；远端 governanceTickLocalExecutor 仍按 `?? []` 兜底。
 */
export function ensureSnapshotShape(payload: GovernanceTickJobPayload): GovernanceTickJobPayload {
  const snapshot = payload.snapshot ?? {};
  if (payload.targetKind === "thread") {
    return {
      ...payload,
      snapshot: {
        ...snapshot,
        currentTasks: Array.isArray(snapshot.currentTasks) ? snapshot.currentTasks : [],
        recentTaskInstances: Array.isArray(snapshot.recentTaskInstances) ? snapshot.recentTaskInstances : [],
      },
    };
  }
  return {
    ...payload,
    snapshot: {
      ...snapshot,
      threads: Array.isArray(snapshot.threads) ? snapshot.threads : [],
    },
  };
}

/**
 * 派发前 revision staleness 检查。
 *
 * lease 时 envelope 可能已经被会话治理 / 用户编辑改过；如果 fresh entity revision
 * 已经超过 leased.baseRevision，回执 apply 必然 stale_revision 失败，直接派发就是
 * 烧 LLM。提前在派发链路放弃，让上层失败计数 / dashboard 早一点看到事实。
 *
 * 找不到 entity（被删）也视为 stale——后续的 readRecordField 会抛错，不如此刻就拒。
 */
export function checkLeasedRevisionStaleness(
  leased: GovernanceTickJobRecord,
): { stale: false } | { stale: true; currentRevision: number | null } {
  try {
    if (leased.targetKind === "topic") {
      const topic = findTopicById(leased.topicId);
      if (!topic) return { stale: true, currentRevision: null };
      return topic.revision === leased.baseRevision
        ? { stale: false }
        : { stale: true, currentRevision: topic.revision };
    }
    if (!leased.threadId) return { stale: true, currentRevision: null };
    const thread = findThreadById(leased.threadId);
    if (!thread) return { stale: true, currentRevision: null };
    return thread.revision === leased.baseRevision
      ? { stale: false }
      : { stale: true, currentRevision: thread.revision };
  } catch (error) {
    logSnapshot("checkLeasedRevisionStaleness failed; treating as not stale to keep lease alive", {
      jobId: leased.id,
      targetKind: leased.targetKind,
      error: error instanceof Error ? error.message : String(error),
    });
    return { stale: false };
  }
}
