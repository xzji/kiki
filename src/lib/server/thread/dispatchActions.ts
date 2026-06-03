/**
 * ThreadTickAction 派发器 — 计划 §3.3.4 + §6.7.2。
 *
 * 设计要点：
 *  - 本模块负责把 `parseThreadTickOutput` 已校验的 actions 翻译成对外副作用：
 *    1. dispatch_task → 调用方提供的 dispatchTask 回调
 *    2. update_task / cancel_task → 调用方提供的 Task 治理回调
 *    3. post_message → 调用方提供的 sendThreadMessage 回调（双写
 *       conversation_messages + inbox 由回调内部完成；本模块只负责调度顺序）
 *    3. silent → 不产生对外副作用，仅返回 silent.reason 摘要
 *  - 严格"先派发 task → 再发消息"的顺序，保证消息中可以引用刚派发的 taskId。
 *  - 任一 action 失败不会终止后续 action；统一在 errors[] 中收集，由调用方写
 *    agent_events.thread.tick.dispatch_partial_failure。
 *  - 全部为纯并发安全：传入的 callbacks 自行加锁；本模块不持有任何状态。
 */

import type { TaskDraft } from "@/lib/server/goalPlanning/taskDraftSchema";
import type { Task } from "@/types/kiki";
import type {
  ThreadTickAction,
  ThreadTickOutput,
  ThreadTickPostMessageSeverity,
} from "@/types/topic";

// ---------------------------------------------------------------------------
// callback 契约
// ---------------------------------------------------------------------------

export type DispatchTaskRequest = {
  topicId: string;
  threadId: string;
  reason: string;
  taskDraft: TaskDraft;
  /** @deprecated Task 频率由 taskDraft 推断；保留为旧调用点兼容。 */
  taskType?: Task["taskType"];
};

export type DispatchTaskCallback = (request: DispatchTaskRequest) => Promise<{
  taskId: string;
  /** 调用方写 task_instances 后回填的初始 instanceId（可选）。 */
  instanceId?: string;
}>;

export type UpdateTaskRequest = {
  topicId: string;
  threadId: string;
  taskId: string;
  reason: string;
  patch: Partial<TaskDraft>;
  currentTask: Task;
};

export type UpdateTaskCallback = (request: UpdateTaskRequest) => Promise<{
  taskId: string;
}>;

export type CancelTaskRequest = {
  topicId: string;
  threadId: string;
  taskId: string;
  reason: string;
};

export type CancelTaskCallback = (request: CancelTaskRequest) => Promise<{
  taskId: string;
}>;

export type SendThreadMessageRequest = {
  topicId: string;
  threadId: string;
  text: string;
  severity: ThreadTickPostMessageSeverity;
};

export type SendThreadMessageCallback = (request: SendThreadMessageRequest) => Promise<{
  conversationMessageId: string;
  inboxItemId?: string;
}>;

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

export type DispatchThreadActionsInput = {
  topicId: string;
  threadId: string;
  output: ThreadTickOutput;
  callbacks: {
    dispatchTask: DispatchTaskCallback;
    updateTask?: UpdateTaskCallback;
    cancelTask?: CancelTaskCallback;
    sendThreadMessage: SendThreadMessageCallback;
  };
  currentTasks?: Task[];
};

export type DispatchedTaskRecord = {
  taskId: string;
  instanceId?: string;
  draft: TaskDraft;
  reason: string;
};

export type SentMessageRecord = {
  conversationMessageId: string;
  inboxItemId?: string;
  text: string;
  severity: ThreadTickPostMessageSeverity;
};

export type UpdatedTaskRecord = {
  taskId: string;
  patch: Partial<TaskDraft>;
  reason: string;
};

export type CancelledTaskRecord = {
  taskId: string;
  reason: string;
};

export type SilentReasonRecord = {
  reason: string;
};

export type DispatchActionError = {
  index: number;
  kind: ThreadTickAction["kind"];
  error: unknown;
};

export type DispatchThreadActionsResult = {
  dispatchedTasks: DispatchedTaskRecord[];
  updatedTasks: UpdatedTaskRecord[];
  cancelledTasks: CancelledTaskRecord[];
  sentMessages: SentMessageRecord[];
  silentReasons: SilentReasonRecord[];
  errors: DispatchActionError[];
};

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 派发已校验的 ThreadTickOutput.actions。
 *
 * 顺序约束：
 *  1. 全部 dispatch_task（按数组顺序）
 *  2. 全部 update_task
 *  3. 全部 cancel_task
 *  4. 全部 post_message
 *  5. silent 仅累计 reason
 *
 * 若某条 dispatch_task / post_message 抛错，记录到 errors[]，继续推进；
 * 调用方根据 errors.length 决定是否累计 ThreadRunner.failureCount。
 */
export async function dispatchThreadActions(
  input: DispatchThreadActionsInput,
): Promise<DispatchThreadActionsResult> {
  const { topicId, threadId, output, callbacks } = input;
  const currentTaskById = new Map((input.currentTasks ?? []).map((task) => [task.id, task]));
  const result: DispatchThreadActionsResult = {
    dispatchedTasks: [],
    updatedTasks: [],
    cancelledTasks: [],
    sentMessages: [],
    silentReasons: [],
    errors: [],
  };

  // 计划 §3.3.4 第 7 条：所有 dispatch_task / post_message 已在 schema 阶段
  // 校验 threadId 与当前 thread 一致；这里再做一次断言，防御调用方传错。
  for (let i = 0; i < output.actions.length; i += 1) {
    const action = output.actions[i]!;
    if (action.kind !== "silent" && action.threadId !== threadId) {
      result.errors.push({
        index: i,
        kind: action.kind,
        error: new Error(
          `dispatchThreadActions: action.threadId(${action.threadId}) ≠ ctx.threadId(${threadId})`,
        ),
      });
    }
  }
  if (result.errors.length > 0) {
    // 仍按"尽力派发"语义继续，但已收集错误
  }

  // ---- 1. dispatch_task ----
  for (let i = 0; i < output.actions.length; i += 1) {
    const action = output.actions[i]!;
    if (action.kind !== "dispatch_task") continue;
    if (action.threadId !== threadId) continue; // 防御
    try {
      const dispatched = await callbacks.dispatchTask({
        topicId,
        threadId,
        reason: action.reason,
        taskDraft: action.taskDraft,
      });
      result.dispatchedTasks.push({
        taskId: dispatched.taskId,
        instanceId: dispatched.instanceId,
        draft: action.taskDraft,
        reason: action.reason,
      });
    } catch (error) {
      result.errors.push({ index: i, kind: action.kind, error });
    }
  }

  // ---- 2. update_task ----
  for (let i = 0; i < output.actions.length; i += 1) {
    const action = output.actions[i]!;
    if (action.kind !== "update_task") continue;
    if (action.threadId !== threadId) continue;
    try {
      const currentTask = currentTaskById.get(action.taskId);
      if (!currentTask) {
        throw new Error(`dispatchThreadActions: task ${action.taskId} not found in current thread`);
      }
      if (!callbacks.updateTask) {
        throw new Error("dispatchThreadActions: updateTask callback required for update_task");
      }
      const updated = await callbacks.updateTask({
        topicId,
        threadId,
        taskId: action.taskId,
        reason: action.reason,
        patch: action.patch,
        currentTask,
      });
      result.updatedTasks.push({
        taskId: updated.taskId,
        patch: action.patch,
        reason: action.reason,
      });
    } catch (error) {
      result.errors.push({ index: i, kind: action.kind, error });
    }
  }

  // ---- 3. cancel_task ----
  for (let i = 0; i < output.actions.length; i += 1) {
    const action = output.actions[i]!;
    if (action.kind !== "cancel_task") continue;
    if (action.threadId !== threadId) continue;
    try {
      if (!currentTaskById.has(action.taskId)) {
        throw new Error(`dispatchThreadActions: task ${action.taskId} not found in current thread`);
      }
      if (!callbacks.cancelTask) {
        throw new Error("dispatchThreadActions: cancelTask callback required for cancel_task");
      }
      const cancelled = await callbacks.cancelTask({
        topicId,
        threadId,
        taskId: action.taskId,
        reason: action.reason,
      });
      result.cancelledTasks.push({
        taskId: cancelled.taskId,
        reason: action.reason,
      });
    } catch (error) {
      result.errors.push({ index: i, kind: action.kind, error });
    }
  }

  // ---- 4. post_message ----
  for (let i = 0; i < output.actions.length; i += 1) {
    const action = output.actions[i]!;
    if (action.kind !== "post_message") continue;
    if (action.threadId !== threadId) continue;
    try {
      const sent = await callbacks.sendThreadMessage({
        topicId,
        threadId,
        text: action.text,
        severity: action.severity,
      });
      result.sentMessages.push({
        conversationMessageId: sent.conversationMessageId,
        inboxItemId: sent.inboxItemId,
        text: action.text,
        severity: action.severity,
      });
    } catch (error) {
      result.errors.push({ index: i, kind: action.kind, error });
    }
  }

  // ---- 5. silent ----
  for (const action of output.actions) {
    if (action.kind === "silent") {
      result.silentReasons.push({ reason: action.reason });
    }
  }

  return result;
}
