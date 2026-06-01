/**
 * PR8 thin re-export：mocks/topics → mocks/goals。
 *
 * 在 PR9-10 完成 Topic/Thread 业务字段切换前，Topic 命名空间复用
 * 现有 Goal mock 数据，避免双份维护。等 Topic 模型字段稳定后，
 * 由 PR16 反向：mocks/goals.ts re-export mocks/topics.ts，最终删除 goals。
 */
export {
  initialGoals as initialTopics,
  buildGoalFromDraft as buildTopicFromDraft,
  createGeneratedInstance,
  INITIAL_NOW,
} from "@/mocks/goals";
