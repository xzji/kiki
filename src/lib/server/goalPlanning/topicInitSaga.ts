/**
 * topicInitSaga — Topic 初始化 5 角色 Saga 编排器。
 *
 * Plan ref: §3.1.4 + §9.5（决策/展示拆分 + Critic↔Refiner 循环）。
 *
 * 角色顺序：
 *   1. Interviewer  → 决定是否还需要继续问用户（awaiting_user 暂停）
 *   2. Planner      → 生成 SubGoal/Task 草稿
 *   3. Critic       → 评审草稿，决定 accept / needs_refinement / reject
 *   4. Refiner      → 仅当 Critic 标记 needs_refinement 时调用，修正后回到 Critic 重审
 *                     （最多 maxRefineLoops 次，超限走 forced_accept）
 *   5. Presenter    → 生成最终展示摘要（goalTitle / summary / notificationStrategy / deadline?）
 *
 * 设计取舍：
 * - 5 个 invoke 通过参数注入（claudeJsonInvoke / 测试 mock 自由切换），本编排器不直接 import transport
 * - 每个角色一个 agent_run + 一组 events，由 agentExecutor 统一管理生命周期
 * - 每完成一步即 advanceSaga 到下一 currentStep，保证可中断 + resumable
 * - Refiner 缺失 LLM 实现（PR9b 占位）时由调用方传 noopRefinerInvoke 走确定性 fallback
 */

import { createAgentRun } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { findSagaInstanceById } from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";
import type { SagaInstance } from "@/types/agentRuntime";

import { executeAgentRun, type LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import {
  advanceSaga,
  markAwaitingUser,
  markCompleted,
  markFailed,
} from "@/lib/server/agentRuntime/sagaCoordinator";

export type TopicInitSagaStep =
  | "interview"
  | "plan"
  | "critic"
  | "refine"
  | "present"
  | "completed";

export type CriticDecisionPayload = {
  /** Decision verdict; "accept" advances to Presenter, others trigger Refiner loop. */
  verdict: "accept" | "needs_refinement" | "reject";
  notes?: string;
};

export type InterviewerDecisionPayload = {
  /** When set, saga pauses and surfaces these to the user via awaiting_user event. */
  needsUserInput?: string[];
  /** Otherwise, structured info collected so far. */
  collectedInfo?: Record<string, unknown>;
};

export type TopicInitSagaInput = {
  sagaInstanceId: string;
  topicId: string;
  /** Initial prompt builders, one per role. Saga is agnostic to their content. */
  prompts: {
    interview: string;
    plan: string;
    critic: (planParsed: Record<string, unknown>) => string;
    refine: (
      planParsed: Record<string, unknown>,
      criticParsed: CriticDecisionPayload,
    ) => string;
    present: (planParsed: Record<string, unknown>) => string;
  };
  /** LlmInvoke per role. Mockable in tests. */
  invokes: {
    interview: LlmInvoke;
    plan: LlmInvoke;
    critic: LlmInvoke;
    refine: LlmInvoke;
    present: LlmInvoke;
  };
  /** Cap Critic↔Refiner loops to avoid runaway saga. Default 2. */
  maxRefineLoops?: number;
};

export type TopicInitSagaResult = {
  saga: SagaInstance;
  status: "completed" | "awaiting_user" | "failed";
  awaitingQuestions?: string[];
  /** Final parsed payloads keyed by role. Only populated on success / partial. */
  artifacts: {
    interview?: Record<string, unknown>;
    plan?: Record<string, unknown>;
    critic?: CriticDecisionPayload;
    refinedPlan?: Record<string, unknown>;
    presentation?: Record<string, unknown>;
  };
  /** Number of Critic↔Refiner loops actually executed (0 means accept on first review). */
  refineLoops: number;
  /** Set when maxRefineLoops was hit and we forced acceptance. */
  forcedAccept?: boolean;
};

export const DEFAULT_MAX_REFINE_LOOPS = 2;

function asInterviewerDecision(value: unknown): InterviewerDecisionPayload {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const out: InterviewerDecisionPayload = {};
  if (Array.isArray(v.needsUserInput)) {
    out.needsUserInput = v.needsUserInput.filter((q): q is string => typeof q === "string" && q.trim().length > 0);
  }
  if (v.collectedInfo && typeof v.collectedInfo === "object") {
    out.collectedInfo = v.collectedInfo as Record<string, unknown>;
  }
  return out;
}

function asCriticDecision(value: unknown): CriticDecisionPayload {
  if (!value || typeof value !== "object") {
    return { verdict: "needs_refinement", notes: "critic returned non-object payload" };
  }
  const v = value as Record<string, unknown>;
  const verdict =
    v.verdict === "accept" || v.verdict === "needs_refinement" || v.verdict === "reject"
      ? v.verdict
      : "needs_refinement";
  return {
    verdict,
    notes: typeof v.notes === "string" ? v.notes : undefined,
  };
}

async function runRole(input: {
  topicId: string;
  sagaInstanceId: string;
  role: "interviewer" | "planner" | "critic" | "refiner" | "presenter";
  prompt: string;
  invoke: LlmInvoke;
}): Promise<Record<string, unknown> | undefined> {
  const run = createAgentRun({
    topicId: input.topicId,
    sagaInstanceId: input.sagaInstanceId,
    role: input.role,
  });
  const result = await executeAgentRun({
    agentRunId: run.id,
    prompt: input.prompt,
    context: { role: input.role, sagaInstanceId: input.sagaInstanceId },
    invoke: input.invoke,
  });
  return result.parsed;
}

/**
 * Run the full Topic Init Saga end-to-end.
 *
 * Caller is responsible for:
 *  - createSagaInstance({ topicId, type: "topic_init" }) before calling
 *  - Persisting `result.artifacts.presentation` to Topic / Goal storage layer
 *
 * On `awaiting_user`, caller should surface awaitingQuestions to the user and
 * later resume by calling runTopicInitSaga again with updated prompts.
 */
export async function runTopicInitSaga(
  input: TopicInitSagaInput,
): Promise<TopicInitSagaResult> {
  const maxRefineLoops = input.maxRefineLoops ?? DEFAULT_MAX_REFINE_LOOPS;
  const artifacts: TopicInitSagaResult["artifacts"] = {};

  // --- 1. Interviewer ---
  try {
    advanceSaga({ sagaInstanceId: input.sagaInstanceId, toStep: "interview" });
    const run = createAgentRun({
      topicId: input.topicId,
      sagaInstanceId: input.sagaInstanceId,
      role: "interviewer",
    });
    const result = await executeAgentRun({
      agentRunId: run.id,
      prompt: input.prompts.interview,
      context: { role: "interviewer", sagaInstanceId: input.sagaInstanceId },
      invoke: input.invokes.interview,
    });
    const interviewerDecision = asInterviewerDecision(result.parsed);
    artifacts.interview = result.parsed ?? {};

    if (interviewerDecision.needsUserInput && interviewerDecision.needsUserInput.length > 0) {
      const saga = markAwaitingUser(input.sagaInstanceId, {
        agentRunId: run.id,
        questions: interviewerDecision.needsUserInput,
      });
      return {
        saga: saga ?? mustFindSaga(input.sagaInstanceId),
        status: "awaiting_user",
        awaitingQuestions: interviewerDecision.needsUserInput,
        artifacts,
        refineLoops: 0,
      };
    }
  } catch (error) {
    // Note: executeAgentRun has already appended an `error` event to this run
    // and marked the agent run as failed. We deliberately pass `undefined` for
    // agentRunId to failSaga to avoid emitting a duplicate `error` event on
    // the same agent_run (mirrors Planner/Critic/Refiner/Presenter handling).
    return failSaga(input.sagaInstanceId, undefined, error, artifacts, 0);
  }

  // --- 2. Planner ---
  try {
    advanceSaga({ sagaInstanceId: input.sagaInstanceId, toStep: "plan" });
    artifacts.plan = await runRole({
      topicId: input.topicId,
      sagaInstanceId: input.sagaInstanceId,
      role: "planner",
      prompt: input.prompts.plan,
      invoke: input.invokes.plan,
    });
  } catch (error) {
    return failSaga(input.sagaInstanceId, undefined, error, artifacts, 0);
  }

  // --- 3-4. Critic↔Refiner loop ---
  let refineLoops = 0;
  let forcedAccept = false;
  let currentPlan = artifacts.plan ?? {};
  let criticDecision: CriticDecisionPayload = { verdict: "needs_refinement" };

  while (refineLoops <= maxRefineLoops) {
    try {
      advanceSaga({ sagaInstanceId: input.sagaInstanceId, toStep: "critic" });
      const criticParsed = await runRole({
        topicId: input.topicId,
        sagaInstanceId: input.sagaInstanceId,
        role: "critic",
        prompt: input.prompts.critic(currentPlan),
        invoke: input.invokes.critic,
      });
      criticDecision = asCriticDecision(criticParsed);
      artifacts.critic = criticDecision;
    } catch (error) {
      return failSaga(input.sagaInstanceId, undefined, error, artifacts, refineLoops);
    }

    if (criticDecision.verdict === "accept") break;

    if (refineLoops >= maxRefineLoops) {
      // Force-accept after exhausting Refiner budget — log forced_accept and break.
      forcedAccept = true;
      break;
    }

    try {
      advanceSaga({ sagaInstanceId: input.sagaInstanceId, toStep: "refine" });
      const refined = await runRole({
        topicId: input.topicId,
        sagaInstanceId: input.sagaInstanceId,
        role: "refiner",
        prompt: input.prompts.refine(currentPlan, criticDecision),
        invoke: input.invokes.refine,
      });
      // Refiner may return either a full new plan or be a no-op (e.g. PR9b stub).
      // Treat empty / undefined as "keep current plan".
      if (refined && Object.keys(refined).length > 0) {
        currentPlan = refined;
        artifacts.refinedPlan = refined;
      }
    } catch (error) {
      return failSaga(input.sagaInstanceId, undefined, error, artifacts, refineLoops);
    }

    refineLoops += 1;
  }

  // --- 5. Presenter ---
  try {
    advanceSaga({ sagaInstanceId: input.sagaInstanceId, toStep: "present" });
    artifacts.presentation = await runRole({
      topicId: input.topicId,
      sagaInstanceId: input.sagaInstanceId,
      role: "presenter",
      prompt: input.prompts.present(currentPlan),
      invoke: input.invokes.present,
    });
  } catch (error) {
    return failSaga(input.sagaInstanceId, undefined, error, artifacts, refineLoops);
  }

  const completed = markCompleted(input.sagaInstanceId);
  return {
    saga: completed ?? mustFindSaga(input.sagaInstanceId),
    status: "completed",
    artifacts,
    refineLoops,
    forcedAccept,
  };
}

function failSaga(
  sagaInstanceId: string,
  agentRunId: string | undefined,
  error: unknown,
  artifacts: TopicInitSagaResult["artifacts"],
  refineLoops: number,
): TopicInitSagaResult {
  const message = error instanceof Error ? error.message : String(error);
  const saga = markFailed(sagaInstanceId, { agentRunId, message });
  return {
    saga: saga ?? mustFindSaga(sagaInstanceId),
    status: "failed",
    artifacts,
    refineLoops,
  };
}

function mustFindSaga(id: string): SagaInstance {
  const saga = findSagaInstanceById(id);
  if (!saga) throw new Error(`topicInitSaga: saga ${id} not found`);
  return saga;
}
