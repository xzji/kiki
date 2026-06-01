/**
 * PR9b 角色锚点：Critic（任务草稿评审 / Decision + Presentation 双层）
 *
 * Topic 初始化 Saga 中的第 3 阶段：基于 §9 决策/展示拆分硬约束，
 * Critic 输出仅含决策的精简 JSON（buildTaskDraftReviewDecisionPrompt），
 * 展示文案另起 fire-and-forget 调用（buildTaskDraftReviewPresentationPrompt）。
 *
 * 当 LLM 调用失败或被 token 截断时，buildDegradedReviewDecision
 * 提供保守降级，确保主链路不中断。
 *
 * 现有实现位于 src/lib/server/goalPlanning/taskDraftReview.ts，
 * 此处仅作为 Topic 初始化 Saga 的命名空间锚点。
 */
export {
  buildTaskDraftReviewDecisionPrompt,
  buildTaskDraftReviewPresentationPrompt,
  buildDegradedReviewDecision,
  applyDraftReview,
} from "@/lib/server/goalPlanning/taskDraftReview";
