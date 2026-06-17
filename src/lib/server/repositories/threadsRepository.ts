/**
 * threadsRepository — Thread 行级仓库（PR14.1）。
 *
 * 计划 ref：§12.3.1.1 + §3.4.1。
 *
 * 存储策略：
 *  - 一期确立 `runtime_state_snapshots["goals"]` 为唯一权威源。
 *  - 读：`readTopicsSnapshot` 从 goals 实时投影 topic/thread 视图。
 *  - 写：定位权威源 `goal.subGoals[]` 后，把 Thread 治理字段写回 SubGoal。
 *
 * 并发控制（双重 revision 校验）：
 *  - thread 级：`thread.revision === baseRevision`，不匹配抛 `ThreadRevisionMismatchError`。
 *  - envelope 级：通过 `writeGoalsProjection` 透传 `expectedRevision`，冲突时抛同一异常类。
 */

import {
  readGoalsSnapshotMeta,
  readTopicsSnapshotMeta,
} from "@/lib/server/runtime/stateSnapshot";
import { writeGoalsProjection } from "@/lib/server/services/goalRuntimeService";
import { normalizeTriggerSpec } from "@/types/trigger";
import type { Goal, SubGoal } from "@/types/kiki";
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

function locateSubGoal(
  goals: Goal[],
  threadId: string,
): { goalIndex: number; subGoalIndex: number } | null {
  for (let goalIndex = 0; goalIndex < goals.length; goalIndex += 1) {
    const goal = goals[goalIndex];
    if (!goal || !Array.isArray(goal.subGoals)) continue;
    const subGoalIndex = goal.subGoals.findIndex((subGoal) => subGoal.id === threadId);
    if (subGoalIndex >= 0) return { goalIndex, subGoalIndex };
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
    | "terminationCondition"
    | "status"
    | "lastTickAt"
    | "nextTickAt"
    | "memory"
    | "silentCount"
    | "failureCount"
    | "infraFailureCount"
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
  const snapshot = readGoalsSnapshotMeta([]);
  const located = locateSubGoal(snapshot.value, threadId);
  if (!located) throw new ThreadNotFoundError(threadId);

  const { goalIndex, subGoalIndex } = located;
  const goal = snapshot.value[goalIndex];
  const subGoal = goal.subGoals[subGoalIndex];
  const currentRevision = subGoal.threadRevision ?? 0;

  if (currentRevision !== baseRevision) {
    throw new ThreadRevisionMismatchError(
      threadId,
      baseRevision,
      currentRevision,
      "thread",
    );
  }

  const updatedAt = nowIso();
  const patchedLoopTrigger = patch.loopInterval !== undefined ? normalizeTriggerSpec(patch.loopInterval) ?? undefined : undefined;
  const patchedReviewInterval =
    patch.loopInterval !== undefined && typeof patch.loopInterval === "string"
      ? patch.loopInterval
      : subGoal.reviewInterval;
  const updatedSubGoal: SubGoal = {
    ...subGoal,
    title: patch.title ?? subGoal.title,
    description: patch.intent ?? subGoal.description,
    reviewInterval: patchedReviewInterval,
    reviewTrigger: patch.loopInterval !== undefined ? patchedLoopTrigger : subGoal.reviewTrigger,
    terminationCondition: patch.terminationCondition ?? subGoal.terminationCondition,
    threadStatus: patch.status ?? subGoal.threadStatus,
    // lastTickAt / nextTickAt 用「键是否存在」区分「未提供」与「显式清空」：
    // ThreadRunner 在 archive / failure_threshold 暂停时会显式传 nextTickAt=undefined
    // 以清空下一拍时间（恢复时再重算），若用 ?? 回落会导致永远清不掉。
    lastTickAt: "lastTickAt" in patch ? patch.lastTickAt : subGoal.lastTickAt,
    nextTickAt: "nextTickAt" in patch ? patch.nextTickAt : subGoal.nextTickAt,
    threadUpdatedAt: updatedAt,
    threadMemory: patch.memory !== undefined ? { ...(subGoal.threadMemory ?? {}), ...patch.memory } : subGoal.threadMemory,
    silentCount: patch.silentCount ?? subGoal.silentCount,
    failureCount: patch.failureCount ?? subGoal.failureCount,
    infraFailureCount: "infraFailureCount" in patch ? patch.infraFailureCount : subGoal.infraFailureCount,
    threadRevision: currentRevision + 1,
  };

  const nextSubGoals = goal.subGoals.slice();
  nextSubGoals[subGoalIndex] = updatedSubGoal;
  const nextGoals = snapshot.value.slice();
  nextGoals[goalIndex] = { ...goal, subGoals: nextSubGoals };

  const writeResult = writeGoalsProjection(nextGoals, snapshot.revision);
  if (!writeResult.ok) {
    throw new ThreadRevisionMismatchError(
      threadId,
      snapshot.revision,
      writeResult.revision,
      "envelope",
    );
  }

  const updatedThread = findThreadById(threadId);
  if (!updatedThread) throw new ThreadNotFoundError(threadId);
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
  void _reason;
  const current = findThreadById(threadId);
  if (!current) throw new ThreadNotFoundError(threadId);
  if (current.status === "paused" || current.status === "archived") return current;
  return updateThread(threadId, { status: "paused" satisfies ThreadStatus }, current.revision);
}
