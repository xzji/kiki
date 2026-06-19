/**
 * threadGovernorCallbacks — 把 PR14 仓库层绑定为 runThreadLoopFrame 的 7 callback（PR14.6 + 计划 §12.3.2）。
 *
 * 设计：
 *  - 本模块**只做装配**：纯 IO 不带业务逻辑；测试可不依赖此模块（纯函数层
 *    threadGovernor.spec.ts 直接 mock callback）。
 *  - 装配点严格遵循 §12.3.2 表格。
 *  - sendThreadMessage 双写约束：
 *      - 用同 traceId（= frameStartedAt + index）确保 conversation_messages 与
 *        inbox 两端 ID 可联合追溯；
 *      - 任一端写入抛错由 dispatchActions 的 errors[] 收集，不在此处吞错。
 */

import {
  findThreadById,
  listThreadsByTopicStatus,
  updateThread,
  ThreadRevisionMismatchError,
} from "@/lib/server/repositories/threadsRepository";
import { appendInboxMessage } from "@/lib/server/repositories/inboxRepository";
import { appendThreadMessage } from "@/lib/server/repositories/conversationMessagesRepository";
import { createAgentRun } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { dispatchTaskFromThread } from "@/lib/server/services/dispatchTaskFromThread";
import {
  cancelTaskFromThread,
  updateTaskFromThread,
} from "@/lib/server/services/dispatchTaskFromThread";
import { readTopicsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { buildThreadTickContext } from "@/lib/server/governance/governanceTickContext";
import { buildThreadActionDetails } from "@/lib/server/governance/governanceActionPresentation";
import {
  recordEntity as recordLoopEntity,
  type LoopTickPhase,
} from "@/lib/server/observability/loopTickLog";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type {
  CollectActiveThreadsCallback,
  CollectCurrentThreadTasksCallback,
  CollectRecentTaskInstancesCallback,
  PrepareAgentRunCallback,
  PersistThreadPatchCallback,
  RecordTickOutcomeCallback,
} from "@/lib/server/governance/threadGovernor";
import type {
  DispatchTaskCallback,
  CancelTaskCallback,
  SendThreadMessageCallback,
  UpdateTaskCallback,
} from "@/lib/server/governance/dispatchActions";

// ---------------------------------------------------------------------------
// 1. collectActiveThreads — 读 topics envelope，过滤 active topic + active thread
// ---------------------------------------------------------------------------
export const collectActiveThreads: CollectActiveThreadsCallback = async () => {
  const topics = readTopicsSnapshot([]);
  const result: Awaited<ReturnType<CollectActiveThreadsCallback>> = [];
  for (const topic of topics) {
    if (topic.status !== "active") continue;
    if (!Array.isArray(topic.threads)) continue;
    for (const thread of topic.threads) {
      if (thread.status !== "active") continue;
      result.push({ topic, thread });
    }
  }
  return result;
};

// 备选实现：通过仓库 list — 当 topic-only 上下文足够时使用。
export const collectActiveThreadsFromRepo: CollectActiveThreadsCallback = async () => {
  const topics = readTopicsSnapshot([]);
  const activeTopics = new Map(
    topics.filter((t) => t.status === "active").map((t) => [t.id, t]),
  );
  const result: Awaited<ReturnType<CollectActiveThreadsCallback>> = [];
  for (const thread of listThreadsByTopicStatus("active")) {
    if (thread.status !== "active") continue;
    const topic = activeTopics.get(thread.topicId);
    if (!topic) continue;
    result.push({ topic, thread });
  }
  return result;
};

// ---------------------------------------------------------------------------
// 2. collectRecentTaskInstances
//
// §candidate-3 P5：实现走统一 buildThreadTickContext，让 in-process / cloud
// 两条路径的"thread tick 数据获取"是同一个入口。callback 接口保留，
// 仅作为 governor 编排的注入点；底层实现已收敛。
// ---------------------------------------------------------------------------
export const collectRecentTaskInstances: CollectRecentTaskInstancesCallback = async ({
  topicId,
  threadId,
}) => {
  const ctx = buildThreadTickContext({ topicId, threadId });
  return ctx.ok ? ctx.data.recentTaskInstances : [];
};

export const collectCurrentThreadTasks: CollectCurrentThreadTasksCallback = async ({
  topicId,
  threadId,
}) => {
  const ctx = buildThreadTickContext({ topicId, threadId });
  return ctx.ok ? ctx.data.currentTasks : [];
};

// ---------------------------------------------------------------------------
// 3. prepareAgentRun — 每帧每 thread 独立 agent_run，幂等键含 frameStartedAt
// ---------------------------------------------------------------------------
export function buildPrepareAgentRun(frameStartedAt: Date): PrepareAgentRunCallback {
  return async ({ topic, thread }) => {
    const idempotencyKey = `thread-tick-${thread.id}-${frameStartedAt.toISOString()}`;
    const run = createAgentRun({
      topicId: topic.id,
      threadId: thread.id,
      role: "thread_runner",
      idempotencyKey,
      startedAt: frameStartedAt.toISOString(),
    });
    return { agentRunId: run.id };
  };
}

// ---------------------------------------------------------------------------
// 4. persistThreadPatch — 乐观锁失败 ⇒ conflict=true（worker 下帧重试）
// ---------------------------------------------------------------------------
export const persistThreadPatch: PersistThreadPatchCallback = async ({ thread, result }) => {
  try {
    updateThread(
      thread.id,
      {
        loopInterval: result.patch.loopInterval,
        status: result.patch.status,
        lastTickAt: result.patch.lastTickAt,
        nextTickAt: result.patch.nextTickAt,
        memory: result.patch.memory,
        silentCount: result.patch.silentCount,
        failureCount: result.patch.failureCount,
        // §candidate-1 P0：与 cloud 路径对齐，infraFailureCount 也写回
        ...(result.patch.infraFailureCount !== undefined
          ? { infraFailureCount: result.patch.infraFailureCount }
          : {}),
      },
      thread.revision,
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof ThreadRevisionMismatchError) {
      return { ok: false, conflict: true };
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// 5. recordTickOutcome — 写 loop.thread.tick.* + legacy thread.tick.* 双写
// ---------------------------------------------------------------------------
export const recordTickOutcome: RecordTickOutcomeCallback = async ({
  topic,
  thread,
  agentRunId,
  result,
  dispatch,
  startedAt,
  finishedAt,
  durationMs,
}) => {
  let phase: LoopTickPhase;
  if (!result.ok) phase = "failed";
  else if (dispatch && dispatch.errors.length > 0) phase = "dispatch_partial_failure";
  else phase = "completed";

  // §candidate-1 P0：与 cloud 路径对齐，加 actionDetails 让 UI 卡片可消费
  const actionDetails = result.ok
    ? buildThreadActionDetails({ output: result.output, dispatch })
    : [];

  recordLoopEntity({
    kind: "thread",
    entityId: thread.id,
    parentId: topic.id,
    agentRunId,
    startedAt,
    finishedAt,
    durationMs,
    ok: result.ok,
    phase,
    failureReason: result.ok
      ? dispatch && dispatch.errors.length > 0
        ? `dispatch_partial_failure(${dispatch.errors.length})`
        : undefined
      : result.error.kind,
    errorKind: result.ok ? undefined : result.error.kind,
    dispatchedTaskCount: dispatch?.dispatchedTasks.length ?? 0,
    updatedTaskCount: dispatch?.updatedTasks.length ?? 0,
    cancelledTaskCount: dispatch?.cancelledTasks.length ?? 0,
    sentMessageCount: dispatch?.sentMessages.length ?? 0,
    silentCount: dispatch?.silentReasons.length ?? 0,
    assessment: result.ok ? result.output.assessment : undefined,
    confidence: result.ok ? result.output.confidence : undefined,
    pauseReason: !result.ok && result.pauseReason === "failure_threshold" ? "failure_threshold" : undefined,
    failureCount: result.patch.failureCount,
    actionDetails,
  });

  // §candidate-1 P2：pause 走双通道——inbox 卡片（高可见，由本 callback 负责）
  // + 会话流治理消息（由 governor 调 pushGovernanceChangeNotification 负责，
  // 共享同一 traceId=`governor:${agentRunId}`，便于审计追溯）。
  if (!result.ok && result.pauseReason === "failure_threshold") {
    appendInboxMessage({
      topicId: topic.id,
      threadId: thread.id,
      text: `线程「${thread.title}」连续失败 ${result.patch.failureCount} 次，已自动暂停。`,
      severity: "warning",
      source: "thread_paused",
      traceId: `governor:${agentRunId}`,
    });
  }
};

// ---------------------------------------------------------------------------
// 6. dispatchTask — 调用 dispatchTaskFromThread；idempotencyKey 含 frame 与 task draft 标记
// ---------------------------------------------------------------------------
export function buildDispatchTask(frameStartedAt: Date, invoke?: LlmInvoke): DispatchTaskCallback {
  let counter = 0;
  return async (request) => {
    counter += 1;
    const idempotencyKey = `dispatch-task:${request.threadId}:${frameStartedAt.toISOString()}:${counter}`;
    return dispatchTaskFromThread(request, { idempotencyKey, invoke });
  };
}

export function buildUpdateTask(frameStartedAt: Date): UpdateTaskCallback {
  let counter = 0;
  return async (request) => {
    counter += 1;
    const idempotencyKey = `update-task:${request.threadId}:${request.taskId}:${frameStartedAt.toISOString()}:${counter}`;
    return updateTaskFromThread(request, { idempotencyKey });
  };
}

export function buildCancelTask(frameStartedAt: Date): CancelTaskCallback {
  let counter = 0;
  return async (request) => {
    counter += 1;
    const idempotencyKey = `cancel-task:${request.threadId}:${request.taskId}:${frameStartedAt.toISOString()}:${counter}`;
    return cancelTaskFromThread(request, { idempotencyKey });
  };
}

// ---------------------------------------------------------------------------
// 7. sendThreadMessage — 双写 conversation_messages + inbox（同 traceId）
// ---------------------------------------------------------------------------
export function buildSendThreadMessage(frameStartedAt: Date): SendThreadMessageCallback {
  let counter = 0;
  return async (request) => {
    counter += 1;
    const traceId = `${frameStartedAt.toISOString()}-${counter}`;
    // 先写 conversation 文本；失败抛错（dispatchActions 收集到 errors[]，inbox 不写）
    const conv = appendThreadMessage({
      topicId: request.topicId,
      threadId: request.threadId,
      text: request.text,
      severity: request.severity,
      traceId,
    });
    // 再写 inbox 投影；失败也抛错，但 conversation 已写入（业务上视为"消息可见、未读未点亮"）
    const inbox = appendInboxMessage({
      topicId: request.topicId,
      threadId: request.threadId,
      text: request.text,
      severity: request.severity,
      source: "thread_tick",
      traceId,
    });
    return {
      conversationMessageId: conv.conversationMessageId,
      inboxItemId: inbox.inboxMessageId,
    };
  };
}

// ---------------------------------------------------------------------------
// 一站式装配：返回 frame callback 集合 + invoke
// ---------------------------------------------------------------------------
export type ThreadLoopFrameCallbacks = {
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

export function buildThreadLoopFrameCallbacks(frameStartedAt: Date, invoke?: LlmInvoke): ThreadLoopFrameCallbacks {
  return {
    collectActiveThreads,
    collectRecentTaskInstances,
    collectCurrentThreadTasks,
    prepareAgentRun: buildPrepareAgentRun(frameStartedAt),
    persistThreadPatch,
    recordTickOutcome,
    dispatchTask: buildDispatchTask(frameStartedAt, invoke),
    updateTask: buildUpdateTask(frameStartedAt),
    cancelTask: buildCancelTask(frameStartedAt),
    sendThreadMessage: buildSendThreadMessage(frameStartedAt),
  };
}

// 暴露 findThreadById 仅作为外部诊断，不参与 frame loop。
export { findThreadById };
