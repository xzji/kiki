import { sleep } from "@/lib/utils";
import { getGoalById, useGoalStore } from "@/stores/goalStore";
import type { CollectedInfoSummary, GoalBreakdownDraft } from "@/types/kiki";
import type { GoalServerProgress } from "@/types/goalTelemetry";
import type { EasterEggSettings } from "@/lib/goalSystemConfig";
import type { RuntimeEnvironment } from "@/types/runtime";

export async function getGoals() {
  await sleep();
  return useGoalStore.getState().goals;
}

export async function getGoal(goalId: string) {
  await sleep();
  return getGoalById(goalId) ?? null;
}

function createGoalRequestId(prefix: "plan" | "collect") {
  return `goal-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function getGoalProgress(requestId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/goals/progress?requestId=${encodeURIComponent(requestId)}`, {
    method: "GET",
    signal,
    cache: "no-store",
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { progress?: GoalServerProgress | null };
  return data.progress ?? null;
}

async function withGoalProgressPolling<T>(input: {
  requestId: string;
  signal?: AbortSignal;
  onProgress?: (progress: GoalServerProgress) => void;
  task: () => Promise<T>;
}) {
  let pollingStopped = false;
  const poll = async () => {
    while (!pollingStopped && !input.signal?.aborted) {
      try {
        const progress = await getGoalProgress(input.requestId, input.signal);
        if (progress) {
          input.onProgress?.(progress);
          if (progress.status !== "running") return;
        }
      } catch {
        // ignore polling failures and keep main request authoritative
      }
      await sleep(800);
    }
  };

  const pollingPromise = poll();
  try {
    return await input.task();
  } finally {
    pollingStopped = true;
    await pollingPromise.catch(() => undefined);
  }
}

export async function generateGoalPlan(input: {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
  conversationId?: string;
  conversationContext?: string;
  collectedInfo?: string;
  signal?: AbortSignal;
  onServerProgress?: (progress: GoalServerProgress) => void;
}): Promise<GoalBreakdownDraft> {
  const { signal, ...body } = input;
  const requestId = createGoalRequestId("plan");
  const response = await withGoalProgressPolling({
    requestId,
    signal,
    onProgress: input.onServerProgress,
    task: () =>
      fetch("/api/goals/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goal-request-id": requestId,
        },
        body: JSON.stringify(body),
        signal,
      }),
  });
  const data = (await response.json()) as { draft?: GoalBreakdownDraft; reason?: string };

  if (!response.ok || !data.draft) {
    throw new Error(data.reason || "目标规划生成失败");
  }

  return data.draft;
}

export async function generateGoalClarificationQuestions(input: {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
  conversationId?: string;
  conversationContext?: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const { signal, ...body } = input;
  const response = await fetch("/api/goals/clarify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json()) as { questions?: string[]; reason?: string };

  if (!response.ok || !data.questions?.length) {
    throw new Error(data.reason || "目标澄清问题生成失败");
  }

  return data.questions;
}

export type GoalInfoCollectionTurnInput = {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
  conversationId?: string;
  conversationContext?: string;
  history: Array<{
    questions: string[];
    answer?: string;
  }>;
  minRounds?: number;
  maxRounds?: number;
  signal?: AbortSignal;
  onServerProgress?: (progress: GoalServerProgress) => void;
};

export type GoalInfoCollectionTurnResult = {
  status: "continue" | "complete";
  assistantMessage: string;
  questions?: string[];
  summary?: CollectedInfoSummary;
};

export async function advanceGoalInfoCollection(input: GoalInfoCollectionTurnInput) {
  const { signal, ...body } = input;
  const requestId = createGoalRequestId("collect");
  const response = await withGoalProgressPolling({
    requestId,
    signal,
    onProgress: input.onServerProgress,
    task: () =>
      fetch("/api/goals/collect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goal-request-id": requestId,
        },
        body: JSON.stringify(body),
        signal,
      }),
  });
  const data = (await response.json()) as GoalInfoCollectionTurnResult & { reason?: string };

  if (!response.ok || !data.status || !data.assistantMessage) {
    throw new Error(data.reason || "目标信息收集失败");
  }

  if (data.status === "continue" && !data.questions?.length) {
    throw new Error("目标信息收集缺少后续问题");
  }

  return data;
}
