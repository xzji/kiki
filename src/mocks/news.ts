import type { Article } from "@/types/kiki";

export const newsArticles: Article[] = [
  {
    id: "news-1",
    title: "OpenAI 发布新一代多智能体协作框架",
    source: "AI Daily",
    summary: "多 Agent 调度与价值裁决成为产品设计热点。",
    body: "OpenAI 在今天的开发者活动中展示了一套面向企业场景的多智能体协作框架。该框架强调任务分解、计划回退、价值门控与用户确认节点，特别适合需要长期目标推进的产品。文章指出，未来的产品形态不再是单轮问答，而是持续执行和阶段汇报。对 KiKi 这类目标驱动型自主 Agent 来说，重点在于如何把后台复杂推理压缩成对用户可感知的少量高价值反馈。",
  },
  {
    id: "news-2",
    title: "Anthropic 强调可控执行与 Human-in-the-loop",
    source: "Frontier Weekly",
    summary: "Agent 产品开始从“能做事”转向“何时打断用户更合适”。",
    body: "Anthropic 最新访谈提到，高质量 Agent 体验的关键不是无条件自动化，而是选择正确的时机向用户发起确认。团队内部将这称为 Human-in-the-loop gating。对于需要长期追踪目标的系统来说，是否打断用户、以什么格式打断用户、展示多少推理细节，都会直接影响信任与效率。",
  },
  {
    id: "news-3",
    title: "AI 产品经理岗位开始重视“执行编排能力”",
    source: "PM Now",
    summary: "招聘要求里出现 workflow design、tool orchestration 等新关键词。",
    body: "多家 AI 创业公司在最新 JD 中，把 workflow design、tool orchestration、agent UX 作为核心能力要求。相比传统 PM 更重功能定义，AI PM 需要理解模型边界、工具编排、价值裁决链路与失败兜底设计。文章建议求职者准备一到两个真实的 Agent 产品原型来展示自己对新交互范式的理解。",
  },
];
