/**
 * ThreadRunner.tick 编排核心 — 计划 §3.4.2。
 *
 * 设计要点：
 *  - 本模块只负责**纯编排**：构造 prompt → 调 invoke → parse → 计算 next state，
 *    所有 IO（写 conversation_messages / inbox / 派发 task / 持久化 thread）
 *    都通过 callbacks 注入，便于单测与未来在 PR12+ 接入真实仓库。
 *  - 与 [threadRunnerPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/thread/threadRunnerPrompt.ts)
 *    + [threadTickOutputSchema.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/thread/threadTickOutputSchema.ts)
 *    形成单 prompt 决策层闭环。
 *  - silentCount / failureCount / nextTickAt 的状态机演进遵循 §9.3 问题 12 +
 *    §3.4.5。
 */

import { computeNextTickAt } from "@/lib/taskTriggerTime";
import {
  readCadenceHistoryFromMemory,
  tuneLoopCadence,
  writeCadenceHistoryToMemory,
} from "@/lib/server/governance/cadenceTuner";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { Task, TaskInstance } from "@/types/kiki";
import {
  THREAD_FAILURE_PAUSE_THRESHOLD,
  type Thread,
  type ThreadLoopInterval,
  type ThreadStatus,
  type ThreadTickAction,
  type ThreadTickOutput,
  type Topic,
} from "@/types/topic";

import { buildThreadRunnerDecisionPrompt } from "./threadRunnerPrompt";
import {
  ThreadTickOutputValidationError,
  parseThreadTickOutput,
} from "./threadTickOutputSchema";

// ---------------------------------------------------------------------------
// 输入 / 输出契约
// ---------------------------------------------------------------------------

export type ThreadTickContext = {
  topic: Topic;
  thread: Thread;
  /** 当前 Thread 下的 Task 列表，用于治理增/改/删。 */
  currentTasks?: Task[];
  /** 由调用方注入的最近 7 天 Task 实例（已按 thread_id 过滤）。 */
  recentTaskInstances: TaskInstance[];
  /** 上一轮 tick 输出快照，可选；用于让模型判断是否继续推进。 */
  lastTickOutput?: ThreadTickOutput;
  /** 当前时刻；测试可注入。 */
  now: Date;
};

/**
 * Tick 后的 thread 演进结果（仅 patch，不直接覆写）。
 *
 * 调用方负责：
 *  - 用 patch 调用 thread repo update 时携带 baseRevision = thread.revision；
 *  - 用 commitOutput 中的 actions 调度真实的 dispatch_task / post_message。
 */
export type ThreadTickPatch = {
  status: ThreadStatus;
  loopInterval?: ThreadLoopInterval;
  lastTickAt: string;
  nextTickAt?: string;
  memory: Record<string, unknown>;
  silentCount: number;
  failureCount: number;
};

export type ThreadTickResult =
  | {
      ok: true;
      patch: ThreadTickPatch;
      output: ThreadTickOutput;
      /** 若 failureCount 跨过阈值导致状态变 paused，记录原因供 UI/事件消费。 */
      pauseReason?: "failure_threshold";
    }
  | {
      ok: false;
      patch: ThreadTickPatch;
      /** 失败时仍返回 patch（仅累计 failureCount + 状态切换），由调用方持久化。 */
      error: ThreadTickFailure;
      pauseReason?: "failure_threshold";
    };

export type ThreadTickFailure =
  | { kind: "invoke_error"; error: unknown }
  | { kind: "validation_error"; error: ThreadTickOutputValidationError };

export type RunThreadTickInput = {
  ctx: ThreadTickContext;
  /** 注入实际 LLM 调用（PR9c 的 createClaudeJsonInvoke 工厂产物）。 */
  invoke: LlmInvoke;
  /** agent_runs.id；由调用方在 invoke 之前 createAgentRun 得到。 */
  agentRunId: string;
};

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 执行一次 ThreadRunner tick。
 *
 * 该函数**不**写入任何持久化层；调用方根据返回的 patch + actions 自行：
 *  - update threads 表（携带 baseRevision = thread.revision）；
 *  - 把 actions 派发出去（合并 conversation_messages + inbox 的双写逻辑）；
 *  - 把 ThreadTickOutput 写入 agent_events.thread.tick.output。
 */
export async function runThreadTick(input: RunThreadTickInput): Promise<ThreadTickResult> {
  const { ctx, invoke, agentRunId } = input;
  const lastTickAt = ctx.now.toISOString();

  const prompt = buildThreadRunnerDecisionPrompt({
    topic: ctx.topic,
    thread: ctx.thread,
    currentTasks: ctx.currentTasks,
    recentTaskInstances: ctx.recentTaskInstances,
    threadMemory: ctx.thread.memory,
    lastTickOutput: ctx.lastTickOutput,
    now: ctx.now,
  });

  // ---- 1. 调用 LLM ----
  let raw: { rawText: string; parsed?: Record<string, unknown> };
  try {
    raw = await invoke({
      agentRunId,
      prompt,
      context: { topicId: ctx.topic.id, threadId: ctx.thread.id },
    });
  } catch (error) {
    return buildFailureResult(ctx, lastTickAt, { kind: "invoke_error", error });
  }

  // ---- 2. 解析 + 校验输出 ----
  let output: ThreadTickOutput;
  try {
    if (raw.parsed) {
      output = parseThreadTickOutput(raw.parsed, {
        expectedThreadId: ctx.thread.id,
        terminationCondition: ctx.thread.terminationCondition,
        currentTasks: ctx.currentTasks,
      });
    } else {
      // invoke 工厂没有 parsed 时，尝试 JSON.parse 一下兜底；失败则上报。
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.rawText);
      } catch (parseError) {
        return buildFailureResult(ctx, lastTickAt, {
          kind: "validation_error",
          error: new ThreadTickOutputValidationError(
            `ThreadRunner 输出非合法 JSON：${String(parseError)}`,
            "not_object",
          ),
        });
      }
      output = parseThreadTickOutput(parsed, {
        expectedThreadId: ctx.thread.id,
        terminationCondition: ctx.thread.terminationCondition,
        currentTasks: ctx.currentTasks,
      });
    }
  } catch (error) {
    if (error instanceof ThreadTickOutputValidationError) {
      return buildFailureResult(ctx, lastTickAt, { kind: "validation_error", error });
    }
    // 不应到这里；按未知错误处理。
    return buildFailureResult(ctx, lastTickAt, { kind: "invoke_error", error });
  }

  // ---- 3. 计算 patch ----
  const isAllSilent =
    output.actions.length > 0 && output.actions.every((a) => a.kind === "silent");
  const shouldArchive = output.actions.some((a) => a.kind === "archive_thread");
  const memoryAfter = mergeMemory(ctx.thread.memory, output.memoryDelta);
  const silentCount = isAllSilent ? ctx.thread.silentCount + 1 : 0;
  const cadence = tuneLoopCadence({
    entityKind: "thread",
    currentLoop: ctx.thread.loopTrigger ?? ctx.thread.loopInterval,
    deadline: ctx.topic.deadline,
    silentCount,
    hasImportantOutput: hasImportantOutput(output),
    now: ctx.now,
    history: readCadenceHistoryFromMemory(memoryAfter),
  });
  const memoryWithCadenceHistory = cadence.appendedHistory
    ? writeCadenceHistoryToMemory(memoryAfter, cadence.history)
    : memoryAfter;
  const nextTickAt = computeNextTickAtIso(
    {
      ...ctx.thread,
      loopInterval: cadence.loop,
      lastTickAt,
    },
    ctx.now,
  );

  return {
    ok: true,
    patch: {
      status: shouldArchive ? "archived" : ctx.thread.status,
      ...(cadence.changed ? { loopInterval: cadence.loop } : {}),
      lastTickAt,
      nextTickAt: shouldArchive ? undefined : nextTickAt,
      memory: memoryWithCadenceHistory,
      silentCount,
      failureCount: 0, // 成功一次即重置
    },
    output,
  };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function buildFailureResult(
  ctx: ThreadTickContext,
  lastTickAt: string,
  failure: ThreadTickFailure,
): Extract<ThreadTickResult, { ok: false }> {
  const failureCount = ctx.thread.failureCount + 1;
  const reachedThreshold = failureCount >= THREAD_FAILURE_PAUSE_THRESHOLD;
  const status: ThreadStatus = reachedThreshold ? "paused" : ctx.thread.status;
  const cadence = tuneLoopCadence({
    entityKind: "thread",
    currentLoop: ctx.thread.loopTrigger ?? ctx.thread.loopInterval,
    deadline: ctx.topic.deadline,
    silentCount: ctx.thread.silentCount,
    now: ctx.now,
    history: readCadenceHistoryFromMemory(ctx.thread.memory),
  });
  const memoryWithCadenceHistory = cadence.appendedHistory
    ? writeCadenceHistoryToMemory(ctx.thread.memory, cadence.history)
    : ctx.thread.memory;
  const nextTickAt = reachedThreshold
    ? undefined // paused 后清空 nextTickAt，恢复时由调用方重新计算
    : computeNextTickAtIso({ ...ctx.thread, loopInterval: cadence.loop, lastTickAt }, ctx.now);

  return {
    ok: false,
    patch: {
      status,
      ...(!reachedThreshold && cadence.changed ? { loopInterval: cadence.loop } : {}),
      lastTickAt,
      nextTickAt,
      memory: memoryWithCadenceHistory, // 失败不写 memoryDelta，但允许 cadence history
      silentCount: ctx.thread.silentCount, // 失败不计 silent
      failureCount,
    },
    error: failure,
    ...(reachedThreshold ? { pauseReason: "failure_threshold" as const } : {}),
  };
}

function mergeMemory(
  base: Record<string, unknown>,
  delta?: Record<string, unknown>,
): Record<string, unknown> {
  if (!delta || Object.keys(delta).length === 0) return base;
  return { ...base, ...delta };
}

function computeNextTickAtIso(thread: Thread, now: Date): string | undefined {
  const next = computeNextTickAt(thread, now);
  return next ? next.toISOString() : undefined;
}

function hasImportantOutput(output: ThreadTickOutput) {
  return output.actions.some((action) => action.kind === "post_message" && action.severity === "important");
}

// ---------------------------------------------------------------------------
// 给 worker / 派发器使用的简单分类工具
// ---------------------------------------------------------------------------

export type GroupedActions = {
  dispatch: Extract<ThreadTickAction, { kind: "dispatch_task" }>[];
  update: Extract<ThreadTickAction, { kind: "update_task" }>[];
  cancel: Extract<ThreadTickAction, { kind: "cancel_task" }>[];
  archive: Extract<ThreadTickAction, { kind: "archive_thread" }>[];
  postMessage: Extract<ThreadTickAction, { kind: "post_message" }>[];
  silent: Extract<ThreadTickAction, { kind: "silent" }>[];
};

export function groupActions(actions: ThreadTickAction[]): GroupedActions {
  const grouped: GroupedActions = {
    dispatch: [],
    update: [],
    cancel: [],
    archive: [],
    postMessage: [],
    silent: [],
  };
  for (const a of actions) {
    if (a.kind === "dispatch_task") grouped.dispatch.push(a);
    else if (a.kind === "update_task") grouped.update.push(a);
    else if (a.kind === "cancel_task") grouped.cancel.push(a);
    else if (a.kind === "archive_thread") grouped.archive.push(a);
    else if (a.kind === "post_message") grouped.postMessage.push(a);
    else grouped.silent.push(a);
  }
  return grouped;
}
