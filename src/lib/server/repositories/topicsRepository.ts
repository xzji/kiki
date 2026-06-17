/**
 * topicsRepository — Topic loop 状态写回 Goal 权威源。
 *
 * 存储策略：
 *  - `runtime_state_snapshots["goals"]` 是唯一权威源；
 *  - 读通过 goals -> Topic 投影；
 *  - 写定位 Goal 后更新 topic* 字段，并用 topicRevision 做乐观锁。
 */

import { legacyGoalToTopic } from "@/lib/migration/legacyGoalToTopic";
import { readGoalsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import { writeGoalsProjection } from "@/lib/server/services/goalRuntimeService";
import { DEFAULT_TOPIC_LOOP, type Topic } from "@/types/topic";
import { normalizeTriggerSpec } from "@/types/trigger";
import type { Goal } from "@/types/kiki";

export class TopicRevisionMismatchError extends Error {
  constructor(
    public readonly topicId: string,
    public readonly expected: number,
    public readonly actual: number,
    public readonly scope: "topic" | "envelope",
  ) {
    super(
      `Topic ${topicId} revision mismatch (${scope}): expected=${expected}, actual=${actual}`,
    );
    this.name = "TopicRevisionMismatchError";
  }
}

export class TopicNotFoundError extends Error {
  constructor(public readonly topicId: string) {
    super(`Topic ${topicId} not found`);
    this.name = "TopicNotFoundError";
  }
}

function locateGoal(goals: Goal[], topicId: string): { goalIndex: number } | null {
  const goalIndex = goals.findIndex((goal) => goal.id === topicId);
  return goalIndex >= 0 ? { goalIndex } : null;
}

export function findTopicById(topicId: string): Topic | null {
  const snapshot = readGoalsSnapshotMeta([]);
  const located = locateGoal(snapshot.value, topicId);
  if (!located) return null;
  return legacyGoalToTopic({ goal: snapshot.value[located.goalIndex] });
}

export type TopicPatch = Partial<
  Pick<
    Topic,
    | "loop"
    | "phase"
    | "lastTickAt"
    | "nextTickAt"
    | "silentCount"
    | "failureCount"
    | "infraFailureCount"
  >
>;

export function updateTopic(
  topicId: string,
  patch: TopicPatch,
  baseRevision: number,
): Topic {
  const snapshot = readGoalsSnapshotMeta([]);
  const located = locateGoal(snapshot.value, topicId);
  if (!located) throw new TopicNotFoundError(topicId);

  const { goalIndex } = located;
  const goal = snapshot.value[goalIndex];
  const currentRevision = goal.topicRevision ?? 0;
  if (currentRevision !== baseRevision) {
    throw new TopicRevisionMismatchError(topicId, baseRevision, currentRevision, "topic");
  }

  const nextGoal: Goal = {
    ...goal,
    topicLoop: "loop" in patch ? normalizeTriggerSpec(patch.loop) ?? DEFAULT_TOPIC_LOOP : goal.topicLoop,
    topicPhase: "phase" in patch ? patch.phase : goal.topicPhase,
    topicLastTickAt: "lastTickAt" in patch ? patch.lastTickAt : goal.topicLastTickAt,
    topicNextTickAt: "nextTickAt" in patch ? patch.nextTickAt : goal.topicNextTickAt,
    topicSilentCount: "silentCount" in patch ? patch.silentCount : goal.topicSilentCount,
    topicFailureCount: "failureCount" in patch ? patch.failureCount : goal.topicFailureCount,
    topicInfraFailureCount: "infraFailureCount" in patch ? patch.infraFailureCount : goal.topicInfraFailureCount,
    topicRevision: currentRevision + 1,
  };

  const nextGoals = snapshot.value.slice();
  nextGoals[goalIndex] = nextGoal;

  const writeResult = writeGoalsProjection(nextGoals, snapshot.revision);
  if (!writeResult.ok) {
    throw new TopicRevisionMismatchError(
      topicId,
      snapshot.revision,
      writeResult.revision,
      "envelope",
    );
  }

  return legacyGoalToTopic({ goal: nextGoal });
}
