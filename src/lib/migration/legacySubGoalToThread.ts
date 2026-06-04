/**
 * legacySubGoalToThread — 把旧 SubGoal 投影为新 Thread。
 *
 * Plan ref: §9.4 问题 13。
 *  - SubGoal.successCriteria[] 在 Thread 上不存在 → 丢弃（仅保留首项作为 intent 的兜底）
 *  - SubGoal.tasks 不映射到 Thread 上（Task 仍按 threadId 关联），由调用方处理
 *  - loopInterval 表示 Thread 治理 review 节拍；未显式给出时，
 *    含 repeat Task 的板块默认 weekly，否则默认 one_shot。
 *    Task 执行频率由各 Task 自己的 triggerRule 决定。
 */

import type { SubGoal } from "@/types/kiki";
import type { Thread, ThreadLoopInterval, ThreadStatus } from "@/types/topic";

export type LegacySubGoalToThreadInput = {
  subGoal: SubGoal;
  topicId: string;
  /** 默认 weekly；调用方若已知治理 review 节拍请显式覆盖。 */
  loopInterval?: ThreadLoopInterval;
  terminationCondition?: string;
  createdAt?: string;
};

function normalizeThreadLoopInterval(value: unknown): ThreadLoopInterval | undefined {
  if (
    value === "realtime" ||
    value === "hourly" ||
    value === "daily" ||
    value === "weekly" ||
    value === "one_shot"
  ) {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.kind === "cron" && typeof record.expr === "string" && record.expr.trim()) {
      return { kind: "cron", expr: record.expr.trim() };
    }
  }
  return undefined;
}

function inferDefaultReviewInterval(subGoal: SubGoal): ThreadLoopInterval {
  return subGoal.tasks.some((task) => task.taskType === "repeat") ? "weekly" : "one_shot";
}

function normalizeThreadStatus(value: unknown): ThreadStatus {
  if (value === "active" || value === "paused" || value === "archived") return value;
  return "active";
}

function normalizeNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeMemory(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

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
    loopInterval:
      input.loopInterval ??
      normalizeThreadLoopInterval(subGoal.reviewInterval) ??
      inferDefaultReviewInterval(subGoal),
    terminationCondition: input.terminationCondition ?? subGoal.terminationCondition,
    status: normalizeThreadStatus(subGoal.threadStatus),
    lastTickAt: subGoal.lastTickAt,
    nextTickAt: subGoal.nextTickAt,
    memory: normalizeMemory(subGoal.threadMemory),
    silentCount: normalizeNonNegativeNumber(subGoal.silentCount),
    failureCount: normalizeNonNegativeNumber(subGoal.failureCount),
    createdAt: now,
    updatedAt: subGoal.threadUpdatedAt ?? now,
    revision: normalizeNonNegativeNumber(subGoal.threadRevision),
  };
}
