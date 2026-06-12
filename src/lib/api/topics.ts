"use client";

import type { GoalBreakdownDraft } from "@/types/kiki";
import type { Goal } from "@/types/kiki";
import type { CliProcessEventInput, RuntimeEnvironment } from "@/types/runtime";

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

type TopicSagaPlanStreamFrame =
  | { type: "cli_event"; event: CliProcessEventInput }
  | { type: "result"; result: TopicSagaPlanResult }
  | {
      type: "error";
      reason?: string;
      sagaId?: string;
      failedStep?: string;
      failedAgentRunId?: string;
    };

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
  onCliEvent?: (event: CliProcessEventInput) => void;
}): Promise<TopicSagaPlanResult> {
  const { signal, requestId, onCliEvent, ...body } = input;
  const response = await fetch("/api/topics/plan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-topic-saga-request-id": requestId ?? `topic-saga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
    body: JSON.stringify({ ...body, stream: Boolean(onCliEvent) }),
    signal,
  });
  if (onCliEvent && response.ok) {
    if (!response.body) {
      throw new TopicSagaPlanError({ reason: "Saga 流式响应为空" });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: TopicSagaPlanResult | null = null;
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const frame = JSON.parse(line) as TopicSagaPlanStreamFrame;
      if (frame.type === "cli_event") {
        onCliEvent(frame.event);
        return;
      }
      if (frame.type === "result") {
        finalResult = frame.result;
        return;
      }
      throw new TopicSagaPlanError({
        reason: frame.reason || "5 角色 Saga 规划失败",
        sagaId: frame.sagaId,
        failedStep: frame.failedStep,
        failedAgentRunId: frame.failedAgentRunId,
      });
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    handleLine(buffer);
    if (!finalResult) {
      throw new TopicSagaPlanError({ reason: "Saga 流式响应缺少最终结果" });
    }
    return finalResult;
  }
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
