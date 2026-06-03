/**
 * legacyGoalToTopic spec — covers §9.4 问题 13 + §9.5 问题 18：
 *  1. SubGoal[] 全量映射为 Thread[]，id 不变
 *  2. Goal.deadline 严格透传，禁止默认兜底
 *  3. SubGoal.successCriteria/tasks 在 Thread 上被丢弃
 *  4. revision/silentCount/failureCount 默认 0，memory={}，status=active
 *
 * Plan ref: §9.4 + §10.10。
 */

import assert from "node:assert/strict";

import type { Goal, SubGoal } from "@/types/kiki";

import { legacyGoalToTopic } from "./legacyGoalToTopic";
import { legacySubGoalToThread } from "./legacySubGoalToThread";

function makeSubGoal(partial: Partial<SubGoal> & Pick<SubGoal, "id" | "goalId" | "title">): SubGoal {
  return {
    description: partial.description,
    why: partial.why,
    priority: partial.priority,
    weight: partial.weight,
    dependencies: partial.dependencies,
    estimatedDurationMinutes: partial.estimatedDurationMinutes,
    successCriteria: partial.successCriteria,
    tasks: partial.tasks ?? [],
    ...partial,
  };
}

function makeGoal(partial: Partial<Goal> & Pick<Goal, "id" | "title">): Goal {
  return {
    deadline: partial.deadline ?? "",
    progress: partial.progress ?? 0,
    subGoals: partial.subGoals ?? [],
    createdAt: partial.createdAt ?? "2026-05-31T00:00:00.000Z",
    summary: partial.summary,
    chatTurns: partial.chatTurns,
    conversationId: partial.conversationId,
    workflow: partial.workflow,
    kind: partial.kind,
    ...partial,
  };
}

export function runLegacyGoalToTopicSpecs() {
  // 1. SubGoal → Thread mapping preserves id, drops successCriteria/tasks.
  const sub = makeSubGoal({
    id: "sg-1",
    goalId: "g-1",
    title: "盯盘 NVDA",
    description: "每天盯一次大盘和持仓",
    successCriteria: ["命中目标价 ≥ 1 次"],
    tasks: [],
  });
  const thread = legacySubGoalToThread({ subGoal: sub, topicId: "g-1" });
  assert.equal(thread.id, "sg-1");
  assert.equal(thread.topicId, "g-1");
  assert.equal(thread.title, "盯盘 NVDA");
  assert.equal(thread.intent, "每天盯一次大盘和持仓");
  assert.equal(thread.loopInterval, "weekly");
  assert.equal(thread.status, "active");
  assert.equal(thread.silentCount, 0);
  assert.equal(thread.failureCount, 0);
  assert.equal(thread.revision, 0);
  assert.deepEqual(thread.memory, {});
  // SubGoal 上的 successCriteria 不应该被搬运到 Thread 上
  assert.equal(("successCriteria" in (thread as Record<string, unknown>)), false);
  assert.equal(("tasks" in (thread as Record<string, unknown>)), false);

  // 2. Goal.deadline 严格透传：空串 / undefined → undefined（禁止默认兜底）
  const goalNoDeadline = makeGoal({
    id: "g-empty",
    title: "美股投资监控",
    deadline: "",
    subGoals: [sub],
  });
  const topicNoDeadline = legacyGoalToTopic({ goal: goalNoDeadline });
  assert.equal(topicNoDeadline.deadline, undefined);
  assert.equal(topicNoDeadline.completionCriteria, undefined);
  assert.equal(topicNoDeadline.threads.length, 1);
  assert.equal(topicNoDeadline.threads[0].id, "sg-1");
  assert.equal(topicNoDeadline.status, "active");
  assert.equal(topicNoDeadline.revision, 0);

  // 3. Goal.deadline 显式给出 → 透传
  const goalWithDeadline = makeGoal({
    id: "g-dl",
    title: "Q3 财报跟踪",
    deadline: "2026-09-30",
    subGoals: [],
  });
  const topicWithDeadline = legacyGoalToTopic({ goal: goalWithDeadline });
  assert.equal(topicWithDeadline.deadline, "2026-09-30");

  // 4. intent fallback：description 为空时回退到 why → successCriteria[0] → title
  const subFallback = makeSubGoal({
    id: "sg-2",
    goalId: "g-2",
    title: "兜底 Title",
    successCriteria: ["criteria-first"],
  });
  const threadFallback = legacySubGoalToThread({ subGoal: subFallback, topicId: "g-2" });
  assert.equal(threadFallback.intent, "criteria-first");

  const subTitleOnly = makeSubGoal({ id: "sg-3", goalId: "g-3", title: "只剩标题" });
  const threadTitleOnly = legacySubGoalToThread({ subGoal: subTitleOnly, topicId: "g-3" });
  assert.equal(threadTitleOnly.intent, "只剩标题");

  const subWithReview = makeSubGoal({
    id: "sg-review",
    goalId: "g-review",
    title: "风险预警",
    reviewInterval: "daily",
    terminationCondition: "用户停止关注",
  });
  const threadWithReview = legacySubGoalToThread({ subGoal: subWithReview, topicId: "g-review" });
  assert.equal(threadWithReview.loopInterval, "daily");
  assert.equal(threadWithReview.terminationCondition, "用户停止关注");

  // 5. conversationId 透传
  const goalWithConv = makeGoal({
    id: "g-conv",
    title: "T",
    conversationId: "conv-1",
    subGoals: [],
  });
  const topicWithConv = legacyGoalToTopic({ goal: goalWithConv });
  assert.equal(topicWithConv.conversationId, "conv-1");
}
