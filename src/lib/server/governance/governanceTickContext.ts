/**
 * governanceTickContext — Thread tick 上下文的权威 builder。
 *
 * 治理链路有 4 个地方需要"thread tick 当前数据"：
 *  1. 入队（governanceTickSnapshot.buildThreadSnapshot）：构造 payload.snapshot
 *  2. 本地 governor（threadGovernor + threadGovernorCallbacks 收集 currentTasks/recentTaskInstances）
 *  3. 远端 daemon（governanceTickLocalExecutor 从 snapshot 反序列化）
 *  4. apply 阶段（applyThreadTickResult 在 caller 未提供 currentTasks 时 fallback）
 *
 * 之前 4 处各调一套 envelope API，命名 / 错误处理 / 字段补齐策略各不同。
 * 本模块把"获取一份完整 ThreadTickContext"做成单一入口，让"添加一个新字段"
 * 是 1 处改动而不是 4 处。
 *
 * 数据来源仍是 envelope（goals projection），所以这是 *统一接口*，不是新的数据源。
 */

import type { Task, TaskInstance } from "@/types/kiki";
import { listRecentByThreadId } from "@/lib/server/repositories/taskInstancesRepository";
import { readTopicsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { goalsSnapshotThreadTaskView } from "@/lib/server/services/threadTaskView";
import type { Thread, Topic } from "@/types/topic";

/**
 * Thread tick 必备的"当前数据"集合。
 *
 * 与 `ThreadTickContext`（threadRunner）的区别：本类型只含数据（topic/thread/tasks/instances），
 * 不含 now / lastTickOutput；caller 自己组装 ThreadTickContext。
 */
export type ThreadTickContextData = {
  topic: Topic;
  thread: Thread;
  currentTasks: Task[];
  recentTaskInstances: TaskInstance[];
};

export type BuildThreadTickContextResult =
  | { ok: true; data: ThreadTickContextData }
  | { ok: false; reason: "topic_not_found" | "thread_not_found" };

function logContext(message: string, fields: Record<string, unknown>) {
  console.info("[governance_tick_context]", message, fields);
}

/**
 * 从 envelope 当前态构造一份 ThreadTickContextData。
 *
 * 找不到 topic / thread 返回 ok=false（不抛错，让 caller 决定降级策略）。
 * IO 层抛错（如 listRecentByThreadId）则按 swallowing 处理：返回空数组，
 * 治理 prompt 至少有 topic + thread + currentTasks，不会因为 instance 列表
 * IO 故障让整轮治理跑空。
 */
export function buildThreadTickContext(input: {
  topicId: string;
  threadId: string;
}): BuildThreadTickContextResult {
  const topics = readTopicsSnapshot([]);
  const topic = topics.find((item) => item.id === input.topicId);
  if (!topic) {
    return { ok: false, reason: "topic_not_found" };
  }
  const thread = topic.threads.find((item) => item.id === input.threadId);
  if (!thread) {
    return { ok: false, reason: "thread_not_found" };
  }

  let currentTasks: Task[] = [];
  try {
    currentTasks = goalsSnapshotThreadTaskView.listByThread({
      topicId: topic.id,
      threadId: thread.id,
    });
  } catch (error) {
    logContext("listByThread failed; using empty currentTasks", {
      topicId: input.topicId,
      threadId: input.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let recentTaskInstances: TaskInstance[] = [];
  try {
    recentTaskInstances = listRecentByThreadId(thread.id, { limit: 12, sinceDays: 7 });
  } catch (error) {
    logContext("listRecentByThreadId failed; using empty recentTaskInstances", {
      threadId: input.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    ok: true,
    data: {
      topic,
      thread,
      currentTasks,
      recentTaskInstances,
    },
  };
}
