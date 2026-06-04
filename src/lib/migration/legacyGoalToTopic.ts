/**
 * legacyGoalToTopic — 把旧 Goal 投影为新 Topic（含 threads[]）。
 *
 * Plan ref: §9.4 问题 13 + §3.2.2。
 *  - Goal.deadline 严格透传：值为空字符串/undefined 时 Topic.deadline 必须为 undefined，
 *    禁止用虚构截止日期常量或固定日期兜底（§9.5 问题 18）。
 *  - SubGoal[] → Thread[] 通过 legacySubGoalToThread。
 *  - Topic.status 由 workflow.phase 投影；历史数据缺失 workflow 时保持 active。
 */

import type { Goal, GoalWorkflowPhase } from "@/types/kiki";
import type { Topic, TopicStatus } from "@/types/topic";

import { legacySubGoalToThread } from "./legacySubGoalToThread";

export type LegacyGoalToTopicInput = {
  goal: Goal;
  /** 可选覆盖 Topic 创建时间，默认沿用 goal.createdAt 或 now()。 */
  createdAt?: string;
};

function mapGoalPhaseToTopicStatus(phase: GoalWorkflowPhase | undefined): TopicStatus {
  if (!phase) return "active";
  if (phase === "executing" || phase === "monitoring" || phase === "reviewing") return "active";
  if (phase === "paused" || phase === "error") return "paused";
  if (phase === "completed") return "archived";
  return "collecting_info";
}

export function legacyGoalToTopic(input: LegacyGoalToTopicInput): Topic {
  const { goal } = input;
  const createdAt = input.createdAt ?? goal.createdAt ?? new Date().toISOString();
  const updatedAt = createdAt;

  const trimmedDeadline = typeof goal.deadline === "string" ? goal.deadline.trim() : "";
  const deadline = trimmedDeadline.length > 0 ? trimmedDeadline : undefined;

  const threads = goal.subGoals.map((sub) =>
    legacySubGoalToThread({
      subGoal: sub,
      topicId: goal.id,
      loopInterval: undefined,
      terminationCondition: sub.terminationCondition,
      createdAt,
    }),
  );

  return {
    id: goal.id,
    conversationId: goal.conversationId,
    title: goal.title,
    summary: goal.summary?.trim() ?? "",
    deadline,
    completionCriteria: undefined,
    threads,
    status: mapGoalPhaseToTopicStatus(goal.workflow?.phase),
    createdAt,
    updatedAt,
    revision: 0,
  };
}
