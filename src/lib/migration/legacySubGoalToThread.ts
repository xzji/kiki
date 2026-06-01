/**
 * legacySubGoalToThread — 把旧 SubGoal 投影为新 Thread。
 *
 * Plan ref: §9.4 问题 13。
 *  - SubGoal.successCriteria[] 在 Thread 上不存在 → 丢弃（仅保留首项作为 intent 的兜底）
 *  - SubGoal.tasks 不映射到 Thread 上（Task 仍按 threadId 关联），由调用方处理
 *  - loopInterval 默认 daily，silentCount/failureCount 默认 0，memory={}
 */

import type { SubGoal } from "@/types/kiki";
import type { Thread, ThreadLoopInterval } from "@/types/topic";

export type LegacySubGoalToThreadInput = {
  subGoal: SubGoal;
  topicId: string;
  /** 默认 daily；调用方若已知频率请显式覆盖。 */
  loopInterval?: ThreadLoopInterval;
  createdAt?: string;
};

export function legacySubGoalToThread(input: LegacySubGoalToThreadInput): Thread {
  const { subGoal, topicId } = input;
  const now = input.createdAt ?? new Date().toISOString();
  const intent =
    subGoal.description?.trim() ||
    subGoal.why?.trim() ||
    subGoal.successCriteria?.[0]?.trim() ||
    subGoal.title;
  return {
    id: subGoal.id,
    topicId,
    title: subGoal.title,
    intent,
    loopInterval: input.loopInterval ?? "daily",
    status: "active",
    memory: {},
    silentCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
}
