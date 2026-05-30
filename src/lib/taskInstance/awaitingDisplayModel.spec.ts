import assert from "node:assert/strict";

import { buildAwaitingDisplayModel, isPendingUserPlaceholderTaskResult } from "@/lib/taskInstance/awaitingDisplayModel";
import type { Task, TaskInstance } from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";

function task(): Task {
  return {
    id: "task-1",
    subGoalId: "sub-1",
    title: "任务1：测试任务",
    description: "测试描述",
    expectedOutcome: "测试产出",
    taskType: "one_shot",
    triggerRule: "立即执行",
    progress: 0,
    instances: [],
    executionKind: "generic_result",
  };
}

function instance(partial: Partial<TaskInstance>): TaskInstance {
  return {
    id: "inst-1",
    taskId: "task-1",
    dateLabel: "2026-05-28",
    status: "awaiting_user",
    intro: "任务简介",
    payload: { kind: "generic_result", summary: "摘要" },
    createdAt: "2026-05-28T00:00:00.000Z",
    ...partial,
  };
}

export function runAwaitingDisplayModelSpecs() {
  const baseTask = task();

  const singleField = instance({
    awaitingUser: {
      reason: "需要你补充关键信息后才能继续执行。",
      interactionRequirement: {
        type: "provide_context",
        timing: "before_execution",
        reason: "需要你补充关键信息后才能继续执行。",
        question: "你打算从哪个城市出发？",
        fields: [
          {
            id: "departure_city",
            label: "出发城市",
            question: "",
            description: "查询航班必须知道出发城市。",
            options: ["北京", "上海", "广州"],
            source: "user",
          },
        ],
        options: ["北京", "上海", "广州"],
        shouldNotifyUser: true,
      },
    },
    notification: {
      shouldNotify: true,
      channel: "both",
      notificationType: "context_required",
      priority: "high",
      reason: "需要你补充关键信息后才能继续执行。",
      title: "测试通知",
      snippet: "",
      userMessage: "你打算从哪个城市出发？",
      badge: "need_confirm",
      resultSummary: { headline: "你打算从哪个城市出发？", keyPoints: [], nextActions: [] },
      detailPolicy: { showTimelineByDefault: false, showRawOutputBehindMore: true, showArtifactsExpanded: true },
      createdAt: "2026-05-28T00:00:00.000Z",
      deliveryState: "delivered",
    },
  });
  const singleFieldModel = buildAwaitingDisplayModel(baseTask, singleField, "card");
  assert.equal(singleFieldModel.active, true);
  assert.equal(singleFieldModel.headline, "你打算从哪个城市出发？");
  assert.equal(singleFieldModel.notice, undefined);
  assert.equal(singleFieldModel.hideFieldQuestions.has("departure_city"), false);
  assert.equal(singleFieldModel.hideOuterSummary, true);

  const multiField = instance({
    awaitingUser: {
      reason: "缺少多个字段。",
      interactionRequirement: {
        type: "provide_context",
        timing: "before_execution",
        reason: "缺少多个字段。",
        question: "请补充：出发城市、出行日期",
        fields: [
          {
            id: "departure_city",
            label: "出发城市",
            question: "你打算从哪个城市出发？",
            description: "查询航班必须知道出发城市。",
            options: ["北京", "上海", "广州"],
            source: "user",
          },
          {
            id: "travel_dates",
            label: "出行日期",
            question: "你计划什么时候出行？",
            description: "查询航班必须知道日期。",
            options: ["本周内", "下周出发", "时间未定"],
            source: "user",
          },
        ],
        shouldNotifyUser: true,
      },
    },
  });
  const multiFieldModel = buildAwaitingDisplayModel(baseTask, multiField, "card");
  assert.equal(multiFieldModel.hideFieldQuestions.size, 0);
  assert.equal(multiFieldModel.fields.length, 2);

  const submitted = instance({
    status: "completed",
    result: {
      interactionSubmission: {
        type: "provide_context",
        status: "submitted",
        action: "提交信息",
        feedback: "出发城市：上海",
        submittedAt: "2026-05-28T01:00:00.000Z",
      },
    },
  });
  const submittedModel = buildAwaitingDisplayModel(baseTask, submitted, "card");
  assert.equal(submittedModel.active, false);
  assert.equal(submittedModel.submitted?.feedback, "出发城市：上海");

  const pendingTaskResult: TaskResult = {
    schemaVersion: 1,
    taskId: "task-1",
    instanceId: "inst-1",
    title: "需要补充信息后继续",
    status: "pending_user",
    blocks: [],
    meta: { producedAt: "2026-05-28T00:00:00.000Z" },
  };
  assert.equal(isPendingUserPlaceholderTaskResult(pendingTaskResult), true);

  const pendingDecisionResult: TaskResult = {
    schemaVersion: 1,
    taskId: "task-1",
    instanceId: "inst-1",
    title: "候选方案",
    status: "pending_user",
    blocks: [
      { kind: "markdown", content: "方案 A / 方案 B 对比" },
      { kind: "decision", question: "请选择方案", options: [] },
    ],
    meta: { producedAt: "2026-05-28T00:00:00.000Z" },
  };
  assert.equal(isPendingUserPlaceholderTaskResult(pendingDecisionResult), false);
}
