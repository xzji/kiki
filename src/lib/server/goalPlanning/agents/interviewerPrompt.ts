/**
 * PR9b 角色锚点：Interviewer（信息收集 / 澄清）
 *
 * Topic 初始化 Saga 中的第 1 阶段，负责从用户原始输入中识别缺失信息、
 * 生成澄清问题并整理为结构化摘要。当前 prompt 实现仍位于
 * src/lib/server/goalPlanning.ts，此处仅作为命名空间锚点 re-export。
 *
 * PR9c 引入 topicInitSaga 时直接从此模块 import，
 * 主文件 goalPlanning.ts 内部的实现位置 PR10/PR11 再决定是否迁入。
 */
export {
  buildGoalClarificationPrompt,
  buildGoalFollowUpQuestionsPrompt,
  buildCollectedInfoSummaryPrompt,
} from "@/lib/server/goalPlanning/promptBuilders";
