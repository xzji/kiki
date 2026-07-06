/**
 * PR9b 角色锚点：Planner（顶层 MECE 拆解 + 子目标→任务规划）
 *
 * Topic 初始化 Saga 中的第 2 阶段：
 * - buildDecomposePrompt：goal → subGoals 顶层 MECE 拆解
 * - buildDecompositionNormalizationPrompt：拆解结果规范化（fallback 路径）
 * - buildTaskDraftPrompt：subGoal → tasks 子层任务草稿
 *
 * 当前实现仍分散在 src/lib/server/goalPlanning.ts 与
 * src/lib/server/goalPlanning/taskDraftPrompt.ts，此处仅作为命名空间锚点。
 */
export {
  buildDecomposePrompt,
  buildDecompositionNormalizationPrompt,
} from "@/lib/server/goalPlanning/promptBuilders";
export { buildTaskDraftPrompt } from "@/lib/server/goalPlanning/taskDraftPrompt";
