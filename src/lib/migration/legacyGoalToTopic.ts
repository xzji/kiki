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

import { DEFAULT_TOPIC_LOOP } from "@/types/topic";
import { normalizeTriggerSpec } from "@/types/trigger";
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

function readWorkflowDeliveryContract(goal: Goal) {
  const value = goal.workflow?.collectedInfo?.deliveryContract;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const finalDeliverable = typeof record.finalDeliverable === "string" ? record.finalDeliverable.trim() : "";
  const doneEvidence = Array.isArray(record.doneEvidence)
    ? record.doneEvidence.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
  if (!finalDeliverable || doneEvidence.length === 0) return undefined;
  const nonCompletionExamples = Array.isArray(record.nonCompletionExamples)
    ? record.nonCompletionExamples.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : undefined;
  return {
    finalDeliverable,
    doneEvidence,
    nonCompletionExamples,
  };
}

export function legacyGoalToTopic(input: LegacyGoalToTopicInput): Topic {
  const { goal } = input;
  const createdAt = input.createdAt ?? goal.createdAt ?? new Date().toISOString();
  const updatedAt = goal.topicLastTickAt ?? createdAt;

  const trimmedDeadline = typeof goal.deadline === "string" ? goal.deadline.trim() : "";
  const deadline = trimmedDeadline.length > 0 ? trimmedDeadline : undefined;
  const loop = normalizeTriggerSpec(goal.topicLoop) ?? DEFAULT_TOPIC_LOOP;

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
    loop,
    phase: goal.topicPhase ?? "idle",
    lastTickAt: goal.topicLastTickAt,
    nextTickAt: goal.topicNextTickAt,
    silentCount: goal.topicSilentCount ?? 0,
    failureCount: goal.topicFailureCount ?? 0,
    deadline,
    completionCriteria: undefined,
    deliveryContract: goal.deliveryContract ?? readWorkflowDeliveryContract(goal),
    threads,
    status: mapGoalPhaseToTopicStatus(goal.workflow?.phase),
    createdAt,
    updatedAt,
    revision: goal.topicRevision ?? 0,
  };
}
