import assert from "node:assert/strict";

import { normalizeAwaitingInteraction } from "@/lib/server/protocol/normalizeAwaitingInteraction";
import { normalizeResultHeadline } from "@/lib/server/protocol/normalizeResultHeadline";
import type { TaskInstanceAwaitingUser, TaskResultNotificationDecision } from "@/types/kiki";

function buildAwaiting(): TaskInstanceAwaitingUser {
  return {
    reason: "请补充预算。",
    interactionRequirement: {
      type: "provide_context",
      timing: "before_execution",
      reason: "请补充预算。",
      question: "你的预算上限是多少？",
      fields: [
        {
          id: "budget",
          label: "预算",
          question: "你的预算上限是多少？",
          description: "预算会影响方案筛选。",
          options: [],
          source: "user",
        },
      ],
      shouldNotifyUser: true,
    },
  };
}

function buildDecision(): TaskResultNotificationDecision {
  return {
    shouldNotify: true,
    channel: "both",
    notificationType: "context_required",
    priority: "normal",
    reason: "请补充预算。",
    title: "需要补充信息",
    snippet: "[待补充] 你的预算上限是多少？",
    userMessage: "请补充预算后继续。",
    badge: "need_answer",
    resultSummary: {
      headline: "你的预算上限是多少？",
      keyPoints: [],
      nextActions: [],
    },
    detailPolicy: {
      showTimelineByDefault: false,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: false,
    },
    createdAt: "2026-05-30T00:00:00.000Z",
  };
}

export function runPromptDuplicationGuardSpecs() {
  const awaiting = normalizeAwaitingInteraction(buildAwaiting());
  assert.equal(awaiting.interactionRequirement?.question, "你的预算上限是多少？");
  assert.equal(awaiting.interactionRequirement?.fields?.[0]?.question, "");

  const decision = normalizeResultHeadline(buildDecision(), ["你的预算上限是多少？"]);
  assert.equal(decision.snippet, "");
}
