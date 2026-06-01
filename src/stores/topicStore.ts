"use client";

/**
 * Topic Store — PR7 阶段最小骨架（alias 重导出）。
 *
 * 设计意图：
 *   - 在 P0/P1 阶段先把命名通道打通，便于上层组件逐步迁移到 useTopicStore；
 *   - 底层 state 仍由 useGoalStore 持有，PR9-10 真正切到 Topic/Thread 后再
 *     把 state shape 从 goals[] 迁到 topics[] 并反向重导出 useGoalStore。
 *
 * Plan ref: §3.2.4。
 */

export {
  useGoalStore as useTopicStore,
  selectVisibleGoals as selectVisibleTopics,
  getGoalById as getTopicById,
  getTaskById,
} from "./goalStore";

export type {
  PendingTaskCreateOverlay,
  PendingSubGoalCreateOverlay as PendingThreadCreateOverlay,
  PendingTaskUpdateOverlay,
  PendingTaskDeleteOverlay,
  PendingGoalWorkflowOverlay as PendingTopicWorkflowOverlay,
  PendingConversationGoalDeleteOverlay as PendingConversationTopicDeleteOverlay,
} from "./goalStore";
