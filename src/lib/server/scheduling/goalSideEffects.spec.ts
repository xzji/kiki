import assert from "node:assert/strict";

import {
  markGoalTaskNotificationDeliveredSnapshot,
  normalizeNotificationFromProgress,
} from "@/lib/server/runtime/goalStateSnapshot";
import type {
  Goal,
  TaskInstance,
  TaskInstanceNotificationState,
  TaskResultNotificationDecision,
} from "@/types/kiki";
import type { GoalServerProgress } from "@/types/goalTelemetry";

function buildDecision(overrides: Partial<TaskResultNotificationDecision> = {}): TaskResultNotificationDecision {
  return {
    shouldNotify: true,
    channel: "conversation",
    notificationType: "context_required",
    priority: "normal",
    reason: "需要补充信息",
    title: "请补充信息",
    snippet: "请提供执行所需的关键信息",
    userMessage: "请补充信息以继续执行任务",
    badge: "need_answer",
    resultSummary: {
      headline: "等待补充",
      keyPoints: [],
      nextActions: [],
    },
    detailPolicy: {
      showTimelineByDefault: false,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: false,
    },
    createdAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

function buildInstance(notification?: TaskInstanceNotificationState): TaskInstance {
  return {
    id: "inst-A",
    taskId: "task-A",
    dateLabel: "2026-05-29",
    status: "awaiting_user",
    intro: "测试任务",
    payload: { kind: "generic_result", summary: "摘要" },
    createdAt: "2026-05-29T00:00:00.000Z",
    notification,
  };
}

function buildProgress(decision: TaskResultNotificationDecision): GoalServerProgress {
  return {
    requestId: "req-1",
    scope: "goal_task_execute",
    status: "running",
    phase: "executing",
    message: "",
    startedAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    resultPayload: {
      notificationDecision: decision,
    },
  };
}

function buildGoals(notification?: TaskInstanceNotificationState): Goal[] {
  const instance = buildInstance(notification);
  return [
    {
      id: "goal-A",
      title: "测试 Goal",
      description: "",
      conversationId: "conv-1",
      status: "active",
      createdAt: "2026-05-29T00:00:00.000Z",
      workflowPhase: "execute",
      subGoals: [
        {
          id: "sub-A",
          goalId: "goal-A",
          title: "子目标",
          description: "",
          tasks: [
            {
              id: "task-A",
              subGoalId: "sub-A",
              title: "任务1：测试任务",
              description: "",
              expectedOutcome: "",
              taskType: "one_shot",
              triggerRule: "立即执行",
              progress: 0,
              executionKind: "generic_result",
              instances: [instance],
            },
          ],
        },
      ],
    } as unknown as Goal,
  ];
}

export function runGoalNotificationWorkerSpecs() {
  // case A: 首次 pending → normalize 维持 pending；markDelivered + sequence=1 写入 -n1 messageId
  {
    const decision = buildDecision();
    const instance = buildInstance({
      ...decision,
      deliveryState: "pending",
    });
    const normalized = normalizeNotificationFromProgress(buildProgress(decision), instance);
    assert.equal(normalized?.deliveryState, "pending");

    const goals = buildGoals(normalized);
    const next = markGoalTaskNotificationDeliveredSnapshot(goals, {
      taskId: "task-A",
      instanceId: "inst-A",
      conversationMessageId: "msg-task-inst-A-n1",
      notificationSequence: 1,
    });
    const nextNotification = next[0]!.subGoals[0]!.tasks[0]!.instances[0]!.notification!;
    assert.equal(nextNotification.deliveryState, "delivered");
    assert.equal(nextNotification.conversationMessageId, "msg-task-inst-A-n1");
    assert.equal(nextNotification.notificationSequence, 1);
    assert.deepEqual(nextNotification.pushedConversationMessageIds, ["msg-task-inst-A-n1"]);
    assert.ok(nextNotification.lastDeliveredHash);
  }

  // case B: 已 delivered，progress 内容变了（hash 差异）→ normalize 退回 pending；markDelivered 后 pushedIds 累加
  {
    const previousDecision = buildDecision({
      snippet: "旧的提示",
      userMessage: "旧的引导",
    });
    const previousNotification: TaskInstanceNotificationState = {
      ...previousDecision,
      deliveryState: "delivered",
      conversationMessageId: "msg-task-inst-A-n1",
      notificationSequence: 1,
      pushedConversationMessageIds: ["msg-task-inst-A-n1"],
      lastDeliveredHash: JSON.stringify({
        snippet: previousDecision.snippet,
        userMessage: previousDecision.userMessage,
        notificationType: previousDecision.notificationType,
      }),
    };
    const instance = buildInstance(previousNotification);
    const newDecision = buildDecision({
      snippet: "新的提示",
      userMessage: "新的引导",
    });
    const normalized = normalizeNotificationFromProgress(buildProgress(newDecision), instance);
    assert.equal(normalized?.deliveryState, "pending");
    assert.equal(normalized?.notificationSequence, 1);
    assert.deepEqual(normalized?.pushedConversationMessageIds, ["msg-task-inst-A-n1"]);

    const goals = buildGoals(normalized);
    const next = markGoalTaskNotificationDeliveredSnapshot(goals, {
      taskId: "task-A",
      instanceId: "inst-A",
      conversationMessageId: "msg-task-inst-A-n2",
      notificationSequence: 2,
    });
    const nextNotification = next[0]!.subGoals[0]!.tasks[0]!.instances[0]!.notification!;
    assert.equal(nextNotification.notificationSequence, 2);
    assert.equal(nextNotification.conversationMessageId, "msg-task-inst-A-n2");
    assert.deepEqual(nextNotification.pushedConversationMessageIds, [
      "msg-task-inst-A-n1",
      "msg-task-inst-A-n2",
    ]);
  }

  // case C: shouldNotify=false → normalize 进入 silent（worker 不会派发）
  {
    const decision = buildDecision({ shouldNotify: false });
    const instance = buildInstance(undefined);
    const normalized = normalizeNotificationFromProgress(buildProgress(decision), instance);
    assert.equal(normalized?.deliveryState, "silent");
  }

  // case D: 已 delivered，hash 与新 decision 相同 → 维持 delivered，不退回 pending
  {
    const decision = buildDecision();
    const previousNotification: TaskInstanceNotificationState = {
      ...decision,
      deliveryState: "delivered",
      conversationMessageId: "msg-task-inst-A-n1",
      notificationSequence: 1,
      pushedConversationMessageIds: ["msg-task-inst-A-n1"],
      lastDeliveredHash: JSON.stringify({
        snippet: decision.snippet,
        userMessage: decision.userMessage,
        notificationType: decision.notificationType,
      }),
    };
    const instance = buildInstance(previousNotification);
    const normalized = normalizeNotificationFromProgress(buildProgress(decision), instance);
    assert.equal(normalized?.deliveryState, "delivered");
  }
}
