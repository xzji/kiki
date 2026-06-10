"use client";

import type { GoalBreakdownDraft } from "@/types/kiki";
import type { Goal } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

export type TopicSagaPlanResult =
  | {
      kind: "planned";
      draft: GoalBreakdownDraft;
      saga: {
        id: string;
        refineLoops: number;
        forcedAccept: boolean;
      };
    }
  | {
      kind: "awaiting_user";
      questions: string[];
      sagaId?: string;
    };

export class TopicSagaPlanError extends Error {
  sagaId?: string;
  failedStep?: string;
  failedAgentRunId?: string;

  constructor(input: {
    reason: string;
    sagaId?: string;
    failedStep?: string;
    failedAgentRunId?: string;
  }) {
    super(input.reason);
    this.name = "TopicSagaPlanError";
    this.sagaId = input.sagaId;
    this.failedStep = input.failedStep;
    this.failedAgentRunId = input.failedAgentRunId;
  }
}

export async function generateTopicSagaPlan(input: {
  topicText: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  conversationContext?: string;
  revisionFeedback?: string;
  previousPlanContext?: string;
  maxRefineLoops?: number;
  requestId?: string;
  signal?: AbortSignal;
}): Promise<TopicSagaPlanResult> {
  const { signal, requestId, ...body } = input;
  const response = await fetch("/api/topics/plan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-topic-saga-request-id": requestId ?? `topic-saga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json()) as TopicSagaPlanResult & {
    reason?: string;
    sagaId?: string;
    failedStep?: string;
    failedAgentRunId?: string;
  };
  if (!response.ok) {
    throw new TopicSagaPlanError({
      reason: data.reason || "5 角色 Saga 规划失败",
      sagaId: data.sagaId,
      failedStep: data.failedStep,
      failedAgentRunId: data.failedAgentRunId,
    });
  }
  return data;
}

export async function replaceTopicPlanCommand(input: {
  topic: Goal;
  baseRevision?: number;
  idempotencyKey: string;
}): Promise<{
  ok: true;
  goals: Goal[];
  revision: number;
}> {
  const response = await fetch("/api/topics/commands", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      command: {
        type: "replace_topic_plan",
        topic: input.topic,
      },
      baseRevision: input.baseRevision,
    }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    reason?: string;
    goals?: Goal[];
    revision?: number;
  };
  if (!response.ok || !data.ok || !data.goals || typeof data.revision !== "number") {
    throw new Error(data.reason || "主题规划替换失败");
  }
  return data as { ok: true; goals: Goal[]; revision: number };
}
