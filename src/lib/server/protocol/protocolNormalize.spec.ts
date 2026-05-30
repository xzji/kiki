import assert from "node:assert/strict";

import { normalizeAwaitingInteraction } from "@/lib/server/protocol/normalizeAwaitingInteraction";
import { normalizeResultHeadline } from "@/lib/server/protocol/normalizeResultHeadline";
import type { TaskInstanceAwaitingUser, TaskResultNotificationDecision } from "@/types/kiki";

function awaiting(overrides?: Partial<TaskInstanceAwaitingUser>): TaskInstanceAwaitingUser {
  return {
    reason: "需要补充出发城市。",
    interactionRequirement: {
      type: "provide_context",
      timing: "before_execution",
      reason: "需要补充出发城市。",
      question: "你打算从哪个城市出发？",
      fields: [
        {
          id: "departure_city",
          label: "出发城市",
          question: "你打算从哪个城市出发？",
          description: "查询航班必须知道出发城市。",
          options: [],
          source: "user",
        },
      ],
      shouldNotifyUser: true,
    },
    ...overrides,
  };
}

function decision(overrides?: Partial<TaskResultNotificationDecision>): TaskResultNotificationDecision {
  return {
    shouldNotify: true,
    channel: "both",
    notificationType: "context_required",
    priority: "high",
    reason: "需要补充出发城市。",
    title: "测试通知",
    snippet: "[待补充] 你打算从哪个城市出发？",
    userMessage: "任务需要补充信息。",
    badge: "need_confirm",
    resultSummary: {
      headline: "你打算从哪个城市出发？",
      keyPoints: [],
      nextActions: [],
    },
    detailPolicy: {
      showTimelineByDefault: false,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: true,
    },
    createdAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

export function runProtocolNormalizeSpecs() {
  const normalized = normalizeAwaitingInteraction(awaiting());
  assert.equal(normalized.interactionRequirement?.question, "你打算从哪个城市出发？");
  assert.equal(normalized.interactionRequirement?.fields?.[0]?.question, "");

  const distinctField = normalizeAwaitingInteraction(
    awaiting({
      interactionRequirement: {
        type: "provide_context",
        timing: "before_execution",
        reason: "需要补充多个字段。",
        question: "请补充出发城市和出行日期。",
        fields: [
          {
            id: "travel_date",
            label: "出行日期",
            question: "你计划什么时候出行？",
            description: "查询航班必须知道日期。",
            options: [],
            source: "user",
          },
        ],
        shouldNotifyUser: true,
      },
    }),
  );
  assert.equal(distinctField.interactionRequirement?.fields?.[0]?.question, "你计划什么时候出行？");

  const normalizedBlocker = normalizeAwaitingInteraction(
    awaiting({
      blocker: {
        executionId: "exec-1",
        taskId: "task-1",
        instanceId: "inst-1",
        blockedStepIndex: 0,
        resumeToken: "resume-1",
        interactionRequirement: {
          type: "confirm",
          timing: "after_agent_output",
          reason: "请选择方案。",
          question: "请选择方案。",
          fields: [
            {
              id: "choice",
              label: "选择",
              question: "请选择方案。",
              description: "请选择一个方案。",
              options: [],
              source: "user",
            },
          ],
          shouldNotifyUser: true,
        },
        resumeStrategy: "rerun_with_feedback",
        status: "waiting",
        createdAt: "2026-05-29T00:00:00.000Z",
      },
    }),
  );
  assert.equal(normalizedBlocker.blocker?.interactionRequirement.fields?.[0]?.question, "");

  const normalizedDecision = normalizeResultHeadline(decision());
  assert.equal(normalizedDecision.snippet, "");

  const distinctDecision = normalizeResultHeadline(
    decision({
      snippet: "任务需要你补充信息后继续推进。",
      resultSummary: {
        headline: "你打算从哪个城市出发？",
        keyPoints: [],
        nextActions: [],
      },
    }),
  );
  assert.equal(distinctDecision.snippet, "任务需要你补充信息后继续推进。");

  // #2 扩展：snippet 与 interactionRequirement.question 重叠也应被清空。
  const overlapWithQuestion = normalizeResultHeadline(
    decision({
      snippet: "[待补充] 你打算从哪个城市出发？",
      resultSummary: {
        headline: "请补充关键信息。",
        keyPoints: [],
        nextActions: [],
      },
    }),
    ["你打算从哪个城市出发？"],
  );
  assert.equal(overlapWithQuestion.snippet, "");

  // #7 reason 比 canonical 长且额外含信息时，保留原 reason 不被覆写。
  const reasonWithExtraContext = normalizeAwaitingInteraction(
    awaiting({
      reason: "需要补充出发城市。注：仅工作日航班。",
      interactionRequirement: {
        type: "provide_context",
        timing: "before_execution",
        reason: "需要补充出发城市。注：仅工作日航班。",
        question: "你打算从哪个城市出发？",
        fields: [
          {
            id: "departure_city",
            label: "出发城市",
            question: "你打算从哪个城市出发？",
            description: "查询航班必须知道出发城市。",
            options: [],
            source: "user",
          },
        ],
        shouldNotifyUser: true,
      },
    }),
  );
  assert.equal(
    reasonWithExtraContext.reason,
    "需要补充出发城市。注：仅工作日航班。",
  );

  // #7 reason 与 canonical 严格相等且带通知前缀时，剥离前缀后落地。
  const reasonWithPrefix = normalizeAwaitingInteraction(
    awaiting({
      reason: "[待补充] 你打算从哪个城市出发？",
    }),
  );
  assert.equal(reasonWithPrefix.reason, "你打算从哪个城市出发？");
}
