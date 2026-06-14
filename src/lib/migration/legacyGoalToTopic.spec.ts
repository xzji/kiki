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

import type { Goal, GoalWorkflowPhase, SubGoal } from "@/types/kiki";

import { legacyGoalToTopic } from "./legacyGoalToTopic";
import { legacySubGoalToThread } from "./legacySubGoalToThread";

function makeSubGoal(partial: Partial<SubGoal> & Pick<SubGoal, "id" | "goalId" | "title">): SubGoal {
  return {
    description: partial.description,
    why: partial.why,
    priority: partial.priority,
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

function makeWorkflow(phase: GoalWorkflowPhase): Goal["workflow"] {
  return {
    phase,
    planDecision: phase === "presenting_plan" || phase === "collecting_info" ? "pending" : "confirmed",
    startedAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
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
  assert.equal(thread.loopInterval, "one_shot");
  assert.equal(thread.status, "active");
  assert.equal(thread.silentCount, 0);
  assert.equal(thread.failureCount, 0);
  assert.equal(thread.revision, 0);
  assert.deepEqual(thread.memory, {});
  // SubGoal 上的 successCriteria 不应该被搬运到 Thread 上
  assert.equal(("successCriteria" in (thread as Record<string, unknown>)), false);
  assert.equal(("tasks" in (thread as Record<string, unknown>)), false);

  const subWithGovernance = makeSubGoal({
    id: "sg-governed",
    goalId: "g-1",
    title: "治理态 Thread",
    threadStatus: "paused",
    lastTickAt: "2026-06-01T00:00:00.000Z",
    nextTickAt: "2026-06-02T00:00:00.000Z",
    threadUpdatedAt: "2026-06-01T01:00:00.000Z",
    threadMemory: { foo: 1 },
    silentCount: 2,
    failureCount: 3,
    threadRevision: 4,
  });
  const governedThread = legacySubGoalToThread({ subGoal: subWithGovernance, topicId: "g-1" });
  assert.equal(governedThread.status, "paused");
  assert.equal(governedThread.lastTickAt, "2026-06-01T00:00:00.000Z");
  assert.equal(governedThread.nextTickAt, "2026-06-02T00:00:00.000Z");
  assert.equal(governedThread.updatedAt, "2026-06-01T01:00:00.000Z");
  assert.deepEqual(governedThread.memory, { foo: 1 });
  assert.equal(governedThread.silentCount, 2);
  assert.equal(governedThread.failureCount, 3);
  assert.equal(governedThread.revision, 4);

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
  assert.deepEqual(topicNoDeadline.loop, { kind: "daily" });
  assert.equal(topicNoDeadline.phase, "idle");
  assert.equal(topicNoDeadline.lastTickAt, undefined);
  assert.equal(topicNoDeadline.nextTickAt, undefined);
  assert.equal(topicNoDeadline.silentCount, 0);
  assert.equal(topicNoDeadline.failureCount, 0);

  const goalWithTopicLoop = makeGoal({
    id: "g-topic-loop",
    title: "Topic loop",
    topicLoop: { kind: "cron", expr: "0 9 * * *", timezone: "Asia/Shanghai" },
    topicPhase: "failed",
    topicLastTickAt: "2026-06-01T01:00:00.000Z",
    topicNextTickAt: "2026-06-02T01:00:00.000Z",
    topicSilentCount: 2,
    topicFailureCount: 3,
    topicRevision: 8,
  });
  const topicWithLoop = legacyGoalToTopic({ goal: goalWithTopicLoop });
  assert.deepEqual(topicWithLoop.loop, { kind: "cron", expr: "0 9 * * *", timezone: "Asia/Shanghai" });
  assert.equal(topicWithLoop.phase, "failed");
  assert.equal(topicWithLoop.lastTickAt, "2026-06-01T01:00:00.000Z");
  assert.equal(topicWithLoop.nextTickAt, "2026-06-02T01:00:00.000Z");
  assert.equal(topicWithLoop.updatedAt, "2026-06-01T01:00:00.000Z");
  assert.equal(topicWithLoop.silentCount, 2);
  assert.equal(topicWithLoop.failureCount, 3);
  assert.equal(topicWithLoop.revision, 8);

  assert.equal(
    legacyGoalToTopic({ goal: makeGoal({ id: "g-plan", title: "待确认", workflow: makeWorkflow("presenting_plan") }) }).status,
    "collecting_info",
  );
  assert.equal(
    legacyGoalToTopic({ goal: makeGoal({ id: "g-exec", title: "执行中", workflow: makeWorkflow("executing") }) }).status,
    "active",
  );
  assert.equal(
    legacyGoalToTopic({ goal: makeGoal({ id: "g-paused", title: "暂停", workflow: makeWorkflow("paused") }) }).status,
    "paused",
  );
  assert.equal(
    legacyGoalToTopic({ goal: makeGoal({ id: "g-done", title: "完成", workflow: makeWorkflow("completed") }) }).status,
    "archived",
  );

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

  const subWithRepeatTask = makeSubGoal({
    id: "sg-repeat",
    goalId: "g-repeat",
    title: "持续巡检",
    tasks: [
      {
        id: "task-repeat",
        subGoalId: "sg-repeat",
        title: "每日巡检",
        description: "巡检",
        expectedOutcome: "摘要",
        taskType: "repeat",
        triggerRule: "每天 09:00",
        progress: 0,
        instances: [],
        executionKind: "generic_result",
      },
    ],
  });
  const threadWithRepeatTask = legacySubGoalToThread({ subGoal: subWithRepeatTask, topicId: "g-repeat" });
  assert.equal(threadWithRepeatTask.loopInterval, "weekly");

  // 5. conversationId 透传
  const goalWithConv = makeGoal({
    id: "g-conv",
    title: "T",
    conversationId: "conv-1",
    subGoals: [],
  });
  const topicWithConv = legacyGoalToTopic({ goal: goalWithConv });
  assert.equal(topicWithConv.conversationId, "conv-1");

  const goalWithContract = makeGoal({
    id: "g-contract",
    title: "可试用版本",
    deliveryContract: {
      finalDeliverable: "可试用版本",
      doneEvidence: ["完成一次试用"],
      nonCompletionExamples: ["只有方案"],
    },
  });
  const topicWithContract = legacyGoalToTopic({ goal: goalWithContract });
  assert.equal(topicWithContract.deliveryContract?.finalDeliverable, "可试用版本");
  assert.deepEqual(topicWithContract.deliveryContract?.doneEvidence, ["完成一次试用"]);
}
