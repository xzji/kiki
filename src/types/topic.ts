/**
 * Topic / Thread 领域类型 — Topic 拆解方案 v8 + 计划 v1 §3.2.1。
 *
 * 设计要点：
 *  - Topic 是非量化、持续关注的容器；deadline / completionCriteria 仅在用户
 *    显式给出时填写，缺失不构成缺陷（详见 §9.5 问题 17）。
 *  - Thread 是 Topic 下的维度/阶段/板块容器；loopInterval 仅决定治理 review 节拍，
 *    不代表 Task 执行频率。
 *  - silentCount / failureCount 分别承载“无产出告警”与“连续失败暂停”两种语义
 *    （详见 §9.3 问题 12）。
 *  - revision 字段配合 sqlite 乐观锁，所有命令式 API 都需 baseRevision。
 */

import type { TaskDraft } from "@/lib/server/goalPlanning/taskDraftSchema";
import type { GoalDeliveryContract } from "@/types/kiki";
import type { TriggerSpec } from "@/types/trigger";

export type LegacyThreadLoopInterval =
  | "realtime"
  | "hourly"
  | "daily"
  | "weekly"
  | { kind: "cron"; expr: string }
  | "one_shot";

export type ThreadLoopInterval = LegacyThreadLoopInterval | TriggerSpec;

export type ThreadStatus = "active" | "paused" | "archived";

export type TopicStatus = "collecting_info" | "active" | "paused" | "archived";

export type TopicPhase = "idle" | "running" | "completed" | "failed" | "dispatch_partial_failure";

export const DEFAULT_TOPIC_LOOP: TriggerSpec = { kind: "daily" };

export type Thread = {
  id: string;
  topicId: string;
  title: string;
  intent: string;
  /**
   * Thread 治理 review 节拍；不是执行频率。
   * Task 执行频率由各自 taskType + triggerRule 自持。
   */
  loopInterval: ThreadLoopInterval;
  loopTrigger?: TriggerSpec;
  /** 板块终止条件；monitoring 类 Thread 可留空表示无自然终止。 */
  terminationCondition?: string;
  status: ThreadStatus;
  lastTickAt?: string;
  nextTickAt?: string;
  /** Thread 共享 memory 池；payload ≤ 8KB（与 agent_events inline 限制对齐）。 */
  memory: Record<string, unknown>;
  /** 连续无产出次数（silent 累计），仅用于 UI 提示，不直接影响状态。 */
  silentCount: number;
  /** 连续 tick 失败次数，达 5 自动 paused（§9.3 问题 12）。 */
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type Topic = {
  id: string;
  conversationId?: string;
  title: string;
  summary: string;
  /** Topic 元规划 loop 节拍；不是 Task 执行频率。 */
  loop: TriggerSpec;
  /** 最近一次 Topic governance tick 的状态阶段。 */
  phase: TopicPhase;
  lastTickAt?: string;
  nextTickAt?: string;
  /** 连续无产出次数（silent 累计），仅用于调度/cadence 信号。 */
  silentCount: number;
  /** 连续 tick 失败次数。 */
  failureCount: number;
  /** 可选 — 仅当用户显式给出时填写。 */
  deadline?: string;
  /** 可选 — 仅当用户显式给出时填写。 */
  completionCriteria?: string;
  deliveryContract?: GoalDeliveryContract;
  threads: Thread[];
  status: TopicStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

/** Thread 数量上限（项目硬约束）。 */
export const TOPIC_MAX_THREADS = 5;

/** silent 自适应阈值表（§9.3 问题 12）。 */
export const THREAD_SILENT_ALERT_THRESHOLDS: Record<
  Exclude<LegacyThreadLoopInterval, { kind: "cron"; expr: string }>,
  number | null
> = {
  realtime: 24 * 7,
  hourly: 24 * 7,
  daily: 7 * 4,
  weekly: 4,
  one_shot: null,
};

/** failureCount ≥ 此值时 Thread 自动 paused。 */
export const THREAD_FAILURE_PAUSE_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// ThreadRunner tick 输出契约（计划 §3.3.4）
// ---------------------------------------------------------------------------

/** post_message 严重级别（与现有 inbox severity 取值对齐）。 */
export type ThreadTickPostMessageSeverity = "info" | "warning" | "important";

/** ThreadRunner 对本轮治理判断的置信度。 */
export type ThreadTickConfidence = "high" | "medium" | "low";

/**
 * Thread tick 单次输出的动作契约。
 *
 * 多类动作可叠加，仅当无结构性动作 / post_message 时才允许 silent。
 * 设计要点（计划 §3.3.4）：
 *  - dispatch_task：派发新 Task，threadId 必填，Task 自带频率
 *  - update_task / cancel_task：治理本 Thread 下既有 Task 集合
 *  - archive_thread：Thread 满足终止条件后归档本板块
 *  - post_message：固定双写 conversation_messages + inbox，text ≤ 500 字
 *  - silent：仅累计 thread.silentCount，不写任何对外通道
 */
export type ThreadTickAction =
  | {
      kind: "dispatch_task";
      threadId: string;
      taskDraft: TaskDraft;
      reason: string;
    }
  | {
      kind: "update_task";
      threadId: string;
      taskId: string;
      patch: Partial<TaskDraft>;
      reason: string;
    }
  | {
      kind: "cancel_task";
      threadId: string;
      taskId: string;
      reason: string;
    }
  | {
      kind: "archive_thread";
      threadId: string;
      reason: string;
    }
  | {
      kind: "post_message";
      threadId: string;
      text: string;
      severity: ThreadTickPostMessageSeverity;
    }
  | {
      kind: "silent";
      reason: string;
    };

/**
 * Thread tick 完整输出。
 *
 * memoryDelta 会被 ThreadRunner 浅合并写回 thread.memory（payload ≤ 8KB 硬约束）。
 */
export type ThreadTickOutput = {
  assessment: string;
  confidence: ThreadTickConfidence;
  actions: ThreadTickAction[];
  memoryDelta?: Record<string, unknown>;
};

/** post_message.text 长度上限（计划 §6.7.2）。 */
export const THREAD_TICK_POST_MESSAGE_TEXT_LIMIT = 500;
