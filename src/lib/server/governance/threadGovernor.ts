/**
 * ThreadGovernor — 计划 §3.4.4（旧名 ThreadLoopWorker）。
 *
 * 设计要点：
 *  - 每帧调用 `runThreadLoopFrame`（治理层守护进程的循环体）：
 *    1. 收集所有 active topic 下的 active thread（由 callback 注入）；
 *    2. 用 `governance/threadScheduler.ts` 筛出 due 列表；
 *    3. 顺序处理每个 due thread：
 *       - 由调用方为每次 tick 创建独立 agent_run（通过 prepareAgentRun 注入）；
 *       - 调 `runThreadTick`（server/thread/threadRunner.ts）得到 patch + output；
 *       - 用 dispatchThreadActions 派发 actions；
 *       - 用 persistThreadPatch 写回 thread 状态（携带 baseRevision 乐观锁）；
 *       - 用 recordTickOutcome 写 agent_events.thread.tick.*。
 *  - 一次循环内单 thread 失败不影响其它 thread；统一收集到 result.failures。
 *  - 真实守护进程（setInterval / cron）由 governance/threadGovernanceRunner.ts 接入；
 *    本模块仅承担"一帧调度"的纯编排，便于注入虚拟时钟做单测。
 */

import { dispatchThreadActions, type DispatchThreadActionsResult } from "./dispatchActions";
import type {
  DispatchTaskCallback,
  CancelTaskCallback,
  SendThreadMessageCallback,
  UpdateTaskCallback,
} from "./dispatchActions";
import { selectDueThreads, type DueThread } from "./threadScheduler";
import { pushGovernanceChangeNotification } from "@/lib/server/governance/governanceChangeNotifications";
import { runThreadTick, type ThreadTickResult } from "@/lib/server/thread/threadRunner";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { Task, TaskInstance } from "@/types/kiki";
import type { Thread, Topic } from "@/types/topic";

// ---------------------------------------------------------------------------
// callback 契约
// ---------------------------------------------------------------------------

/** 收集本帧所有候选 (topic, thread) 对；调用方负责按 status 过滤。 */
export type CollectActiveThreadsCallback = () => Promise<
  Array<{ topic: Topic; thread: Thread }>
>;

/** 收集 thread 最近 7 天 task instances（已按 thread_id 过滤）。 */
export type CollectRecentTaskInstancesCallback = (input: {
  topicId: string;
  threadId: string;
}) => Promise<TaskInstance[]>;

/** 收集 thread 当前 Task 列表，用于治理 tick 判断增/改/删。 */
export type CollectCurrentThreadTasksCallback = (input: {
  topicId: string;
  threadId: string;
}) => Promise<Task[]>;

/** 为每次 tick 准备 agent_run；调用方决定 idempotencyKey 等。 */
export type PrepareAgentRunCallback = (input: {
  topic: Topic;
  thread: Thread;
}) => Promise<{ agentRunId: string }>;

/** 持久化 ThreadRunner 返回的 patch；返回是否乐观锁冲突。 */
export type PersistThreadPatchCallback = (input: {
  topic: Topic;
  thread: Thread;
  result: ThreadTickResult;
}) => Promise<{ ok: boolean; conflict?: boolean }>;

/** 写 agent_events.thread.tick.*；包括 dispatch_partial_failure 等。 */
export type RecordTickOutcomeCallback = (input: {
  topic: Topic;
  thread: Thread;
  agentRunId: string;
  result: ThreadTickResult;
  dispatch?: DispatchThreadActionsResult;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}) => Promise<void>;

export type ThreadLoopFrameInput = {
  now: Date;
  invoke: LlmInvoke;
  callbacks: {
    collectActiveThreads: CollectActiveThreadsCallback;
    collectRecentTaskInstances: CollectRecentTaskInstancesCallback;
    collectCurrentThreadTasks?: CollectCurrentThreadTasksCallback;
    prepareAgentRun: PrepareAgentRunCallback;
    persistThreadPatch: PersistThreadPatchCallback;
    recordTickOutcome: RecordTickOutcomeCallback;
    dispatchTask: DispatchTaskCallback;
    updateTask?: UpdateTaskCallback;
    cancelTask?: CancelTaskCallback;
    sendThreadMessage: SendThreadMessageCallback;
  };
};

export type ThreadLoopFrameOutcome = {
  ticked: Array<{
    topicId: string;
    threadId: string;
    agentRunId: string;
    ok: boolean;
    /** 失败 / 异常的简要原因；成功时为 undefined。 */
    failureReason?: string;
    /** 派发汇总（仅成功 tick 才有）。 */
    dispatchedTaskCount?: number;
    updatedTaskCount?: number;
    cancelledTaskCount?: number;
    sentMessageCount?: number;
    silentCount?: number;
    /** 乐观锁冲突 → 跳过本次写回（worker 在下一帧重试）。 */
    persistConflict?: boolean;
  }>;
  /** 整体 frame 出现的异常（不针对单 thread），如 collect callback 抛错。 */
  frameErrors: unknown[];
};

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runThreadLoopFrame(
  input: ThreadLoopFrameInput,
): Promise<ThreadLoopFrameOutcome> {
  const outcome: ThreadLoopFrameOutcome = { ticked: [], frameErrors: [] };

  // 1. 收集
  let candidates: Array<{ topic: Topic; thread: Thread }>;
  try {
    candidates = await input.callbacks.collectActiveThreads();
  } catch (error) {
    outcome.frameErrors.push(error);
    return outcome;
  }

  // 2. 筛 due（仅按 thread 维度，topic.status 由调用方在 collect 阶段过滤）
  const threadById = new Map<string, { topic: Topic; thread: Thread }>();
  for (const c of candidates) threadById.set(c.thread.id, c);
  const due: DueThread[] = selectDueThreads(
    candidates.map((c) => c.thread),
    input.now,
  );

  // 3. 逐个处理
  for (const { thread } of due) {
    const pair = threadById.get(thread.id);
    if (!pair) continue; // 不应发生
    await tickOneThread(pair.topic, thread, input, outcome);
  }

  return outcome;
}

async function tickOneThread(
  topic: Topic,
  thread: Thread,
  input: ThreadLoopFrameInput,
  outcome: ThreadLoopFrameOutcome,
): Promise<void> {
  const ticked: ThreadLoopFrameOutcome["ticked"][number] = {
    topicId: topic.id,
    threadId: thread.id,
    agentRunId: "",
    ok: false,
  };
  outcome.ticked.push(ticked);
  const tickStartedAtMs = Date.now();
  const tickStartedAt = new Date(tickStartedAtMs).toISOString();

  // 3.1 准备 agent_run
  let agentRunId: string;
  try {
    const prepared = await input.callbacks.prepareAgentRun({ topic, thread });
    agentRunId = prepared.agentRunId;
    ticked.agentRunId = agentRunId;
  } catch (error) {
    ticked.failureReason = `prepareAgentRun_failed: ${stringifyErr(error)}`;
    return;
  }

  // 3.2 拉当前 task 列表 + 最近 task instances
  let currentTasks: Task[];
  try {
    currentTasks = input.callbacks.collectCurrentThreadTasks
      ? await input.callbacks.collectCurrentThreadTasks({
          topicId: topic.id,
          threadId: thread.id,
        })
      : [];
  } catch (error) {
    ticked.failureReason = `collectTasks_failed: ${stringifyErr(error)}`;
    return;
  }

  let recentTaskInstances: TaskInstance[];
  try {
    recentTaskInstances = await input.callbacks.collectRecentTaskInstances({
      topicId: topic.id,
      threadId: thread.id,
    });
  } catch (error) {
    ticked.failureReason = `collectRecent_failed: ${stringifyErr(error)}`;
    return;
  }

  // 3.3 跑 tick
  const tickResult = await runThreadTick({
    ctx: { topic, thread, currentTasks, recentTaskInstances, now: input.now },
    invoke: input.invoke,
    agentRunId,
  });

  // 3.4 dispatch（仅成功才派发）
  let dispatch: DispatchThreadActionsResult | undefined;
  if (tickResult.ok) {
    dispatch = await dispatchThreadActions({
      topicId: topic.id,
      threadId: thread.id,
      output: tickResult.output,
      callbacks: {
        dispatchTask: input.callbacks.dispatchTask,
        updateTask: input.callbacks.updateTask,
        cancelTask: input.callbacks.cancelTask,
        sendThreadMessage: input.callbacks.sendThreadMessage,
      },
      currentTasks,
    });
  }

  // 3.5 写回 thread patch
  let persisted = false;
  try {
    const persist = await input.callbacks.persistThreadPatch({
      topic,
      thread,
      result: tickResult,
    });
    if (!persist.ok && persist.conflict) {
      ticked.persistConflict = true;
      ticked.failureReason = "persist_conflict";
    } else if (!persist.ok) {
      ticked.failureReason = "persist_failed";
    } else {
      persisted = true;
    }
  } catch (error) {
    ticked.failureReason = `persist_threw: ${stringifyErr(error)}`;
  }

  if (persisted) {
    try {
      pushGovernanceChangeNotification({
        topicId: topic.id,
        threadId: thread.id,
        dispatch,
        paused: tickResult.pauseReason === "failure_threshold",
        traceId: `governor:${agentRunId}`,
      });
    } catch (error) {
      console.warn("[governance] push governor change notification failed", error);
    }
  }

  // 3.6 记 outcome 事件
  try {
    const tickFinishedAtMs = Date.now();
    const tickFinishedAt = new Date(tickFinishedAtMs).toISOString();
    await input.callbacks.recordTickOutcome({
      topic,
      thread,
      agentRunId,
      result: tickResult,
      dispatch,
      startedAt: tickStartedAt,
      finishedAt: tickFinishedAt,
      durationMs: Math.max(0, tickFinishedAtMs - tickStartedAtMs),
    });
  } catch (error) {
    // 事件写失败不影响整体；保留原 failureReason，附加事件失败说明
    ticked.failureReason = ticked.failureReason
      ? `${ticked.failureReason}; record_event_failed: ${stringifyErr(error)}`
      : `record_event_failed: ${stringifyErr(error)}`;
  }

  // 3.7 汇总
  if (tickResult.ok) {
    ticked.ok = ticked.failureReason === undefined;
    if (dispatch) {
      ticked.dispatchedTaskCount = dispatch.dispatchedTasks.length;
      ticked.updatedTaskCount = dispatch.updatedTasks.length;
      ticked.cancelledTaskCount = dispatch.cancelledTasks.length;
      ticked.sentMessageCount = dispatch.sentMessages.length;
      ticked.silentCount = dispatch.silentReasons.length;
      if (dispatch.errors.length > 0 && !ticked.failureReason) {
        ticked.failureReason = `dispatch_partial_failure(${dispatch.errors.length})`;
      }
    }
  } else {
    ticked.ok = false;
    if (!ticked.failureReason) {
      ticked.failureReason = `tick_failed: ${tickResult.error.kind}`;
    }
  }
}

function stringifyErr(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
