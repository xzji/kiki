/**
 * PR9b 角色占位：Refiner（基于 Critic 决策修正 Planner 草稿）
 *
 * Topic 初始化 Saga 中的第 4 阶段。当前主流程仍由 applyDraftReview
 * （确定性过滤）兜底；真正的 LLM Refiner 将在 PR9c topicInitSaga 中引入：
 * - 输入：Planner 原始草稿 + Critic decision payload + 被剔除任务的理由
 * - 输出：修正后的 TaskDraft[] 或 SubGoal 调整建议
 * - 约束：
 *   1. 仅修正决策层，不输出展示文案
 *   2. payload ≤ 8KB（与命令服务保持一致）
 *   3. 输出失败时降级为 applyDraftReview 的确定性结果
 *
 * 因目前没有现成 prompt 实现，此文件保留为占位。
 * PR9c 引入 saga 时新增 buildTaskDraftRefinerPrompt 函数。
 */
export {};
