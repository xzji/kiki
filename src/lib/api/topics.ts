"use client";

import type { GoalBreakdownDraft } from "@/types/kiki";
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

export async function generateTopicSagaPlan(input: {
  topicText: string;
  runtimeEnv: RuntimeEnvironment;
  conversationContext?: string;
  maxRefineLoops?: number;
  signal?: AbortSignal;
}): Promise<TopicSagaPlanResult> {
  const { signal, ...body } = input;
  const response = await fetch("/api/topics/plan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-topic-saga-request-id": `topic-saga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json()) as TopicSagaPlanResult & { reason?: string };
  if (!response.ok) {
    throw new Error(data.reason || "5 角色 Saga 规划失败");
  }
  return data;
}
