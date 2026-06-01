/**
 * threadsRepository — Thread 行级仓库（PR14.1）。
 *
 * 计划 ref：§12.3.1.1 + §3.4.1。
 *
 * 存储策略：
 *  - 不新建 `threads` 表，复用 `runtime_state_snapshots["topics"]` envelope 内嵌的
 *    `topic.threads[]` 数组（避免 v12 后再次扩 schema）。
 *  - 读：`readTopicsSnapshot` → 遍历 `topic.threads[]` 定位 threadId。
 *  - 写：定位后 patch，再 `upsertTopicsSnapshot(..., expectedRevision)` 提交。
 *
 * 并发控制（双重 revision 校验）：
 *  - thread 级：`thread.revision === baseRevision`，不匹配抛 `ThreadRevisionMismatchError`。
 *  - envelope 级：`upsertTopicsSnapshot` 透传 `expectedRevision`，冲突时抛同一异常类
 *    （envelope 冲突 = 别的 writer 同时改了任何 topic）。
 */

import {
  readTopicsSnapshotMeta,
  upsertTopicsSnapshot,
} from "@/lib/server/runtime/stateSnapshot";
import type { Thread, ThreadStatus, Topic, TopicStatus } from "@/types/topic";

export class ThreadRevisionMismatchError extends Error {
  constructor(
    public readonly threadId: string,
    public readonly expected: number,
    public readonly actual: number,
    public readonly scope: "thread" | "envelope",
  ) {
    super(
      `Thread ${threadId} revision mismatch (${scope}): expected=${expected}, actual=${actual}`,
    );
    this.name = "ThreadRevisionMismatchError";
  }
}

export class ThreadNotFoundError extends Error {
  constructor(public readonly threadId: string) {
    super(`Thread ${threadId} not found`);
    this.name = "ThreadNotFoundError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 在 envelope 中按 threadId 定位 thread + 所属 topic 索引。
 */
function locate(
  topics: Topic[],
  threadId: string,
): { topicIndex: number; threadIndex: number } | null {
  for (let topicIndex = 0; topicIndex < topics.length; topicIndex += 1) {
    const topic = topics[topicIndex];
    if (!topic || !Array.isArray(topic.threads)) continue;
    const threadIndex = topic.threads.findIndex((thread) => thread.id === threadId);
    if (threadIndex >= 0) return { topicIndex, threadIndex };
  }
  return null;
}

/** 读取单个 thread；不存在返回 null。 */
export function findThreadById(threadId: string): Thread | null {
  const snapshot = readTopicsSnapshotMeta([]);
  const located = locate(snapshot.value, threadId);
  if (!located) return null;
  const thread = snapshot.value[located.topicIndex].threads[located.threadIndex];
  return thread ?? null;
}

/**
 * 列出指定 TopicStatus 下的所有 thread；常用于 daemon 收集 active topic 的活跃 thread。
 *
 * 注意：返回结果**不再过滤** thread.status — 调用方按需筛选（例如 daemon
 * `collectActiveThreads` 需要进一步过滤 `thread.status === "active"`）。
 */
export function listThreadsByTopicStatus(topicStatus: TopicStatus): Thread[] {
  const snapshot = readTopicsSnapshotMeta([]);
  const result: Thread[] = [];
  for (const topic of snapshot.value) {
    if (topic.status !== topicStatus) continue;
    if (!Array.isArray(topic.threads)) continue;
    result.push(...topic.threads);
  }
  return result;
}

export type ThreadPatch = Partial<
  Pick<
    Thread,
    | "title"
    | "intent"
    | "loopInterval"
    | "status"
    | "lastTickAt"
    | "nextTickAt"
    | "memory"
    | "silentCount"
    | "failureCount"
  >
>;

/**
 * 乐观锁更新 thread；
 *  - thread.revision 不匹配 → 抛 ThreadRevisionMismatchError(scope=thread)
 *  - envelope 冲突 → 抛 ThreadRevisionMismatchError(scope=envelope)
 *  - threadId 不存在 → 抛 ThreadNotFoundError
 *
 * 返回更新后的 thread（revision 已 +1）。
 */
export function updateThread(
  threadId: string,
  patch: ThreadPatch,
  baseRevision: number,
): Thread {
  const snapshot = readTopicsSnapshotMeta([]);
  const located = locate(snapshot.value, threadId);
  if (!located) throw new ThreadNotFoundError(threadId);

  const { topicIndex, threadIndex } = located;
  const topic = snapshot.value[topicIndex];
  const thread = topic.threads[threadIndex];

  if (thread.revision !== baseRevision) {
    throw new ThreadRevisionMismatchError(
      threadId,
      baseRevision,
      thread.revision,
      "thread",
    );
  }

  const updatedThread: Thread = {
    ...thread,
    ...patch,
    // memory 浅合并（与 ThreadRunner.tick memoryDelta 语义对齐）
    memory: patch.memory !== undefined ? { ...thread.memory, ...patch.memory } : thread.memory,
    revision: thread.revision + 1,
    updatedAt: nowIso(),
  };

  // 不可变更新整 envelope 数组
  const nextThreads = topic.threads.slice();
  nextThreads[threadIndex] = updatedThread;
  const nextTopics = snapshot.value.slice();
  nextTopics[topicIndex] = { ...topic, threads: nextThreads };

  const expectedEnvelopeRevision = snapshot.source === "topics" ? snapshot.revision : 0;
  const writeResult = upsertTopicsSnapshot(nextTopics, expectedEnvelopeRevision);
  if (!writeResult.ok) {
    throw new ThreadRevisionMismatchError(
      threadId,
      expectedEnvelopeRevision,
      writeResult.revision,
      "envelope",
    );
  }
  return updatedThread;
}

/**
 * 标记 thread 为 paused（连续失败 ≥ THREAD_FAILURE_PAUSE_THRESHOLD 触发）。
 *
 * 不依赖调用方提供 baseRevision — 内部自取最新 thread.revision，确保 daemon
 * 的 paused 写入能在不持锁的情况下幂等推进。返回 paused 后的 thread；如果
 * thread 已是 paused/archived 则原样返回（不做无意义写入）。
 */
export function markThreadPaused(threadId: string, _reason: string): Thread {
  const current = findThreadById(threadId);
  if (!current) throw new ThreadNotFoundError(threadId);
  if (current.status === "paused" || current.status === "archived") return current;
  return updateThread(threadId, { status: "paused" satisfies ThreadStatus }, current.revision);
}
