/**
 * composedTopicsView —— Topic/Thread 只读视图的执行态合成入口。
 *
 * stateSnapshot.ts 的 readTopicsSnapshot 是从 raw goals 投影出的结构视图；
 * 本模块先用 runtime_jobs 权威状态合成 goals，再投影 Topic/Thread。
 * 治理 tick、调度判断等会读取执行态的路径应使用本模块，避免裸投影滞后。
 */

import { legacyGoalToTopic } from "@/lib/migration/legacyGoalToTopic";
import {
  readComposedGoalsSnapshot,
  readComposedGoalsSnapshotMeta,
} from "@/lib/server/runtime/instanceComposition";
import type { Topic } from "@/types/topic";

function projectGoalsToTopics(goals: Parameters<typeof legacyGoalToTopic>[0]["goal"][]): Topic[] {
  return goals.map((goal) => legacyGoalToTopic({ goal }));
}

export function readComposedTopicsSnapshot(fallback: Topic[]): Topic[] {
  const goals = readComposedGoalsSnapshot([]);
  return goals.length > 0 ? projectGoalsToTopics(goals) : fallback;
}

export function readComposedTopicsSnapshotMeta(fallback: Topic[]) {
  const goals = readComposedGoalsSnapshotMeta([]);
  const value = goals.value.length > 0 ? projectGoalsToTopics(goals.value) : fallback;
  return {
    value,
    revision: goals.revision,
    updatedAt: goals.updatedAt,
    source: value === fallback ? ("fallback" as const) : ("goals_fallback" as const),
  };
}
