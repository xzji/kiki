/**
 * PR9b 角色锚点：Presenter（最终展示摘要）
 *
 * Topic 初始化 Saga 中的第 5 阶段：基于已完成的 Interviewer 信息摘要、
 * Planner 拆解结果与任务规划概况，生成前端展示用的 goalTitle / summary /
 * notificationStrategy / deadline（可选）。
 *
 * §9.5 问题 18 硬约束：deadline 缺失时必须保持 undefined，
 * 严禁使用虚构截止日期常量兜底（PR9a 已清理）。
 *
 * 当前实现仍位于 src/lib/server/goalPlanning.ts，此处仅作为
 * Topic 初始化 Saga 的命名空间锚点 re-export。
 */
export { buildPlanPresentationPrompt } from "@/lib/server/goalPlanning";
