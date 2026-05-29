import type { ExecutionKind, GoalBreakdownDraft, TaskCollaborationRequirements } from "@/types/kiki";

function mockCollaboration(_kind: ExecutionKind, description: string, expectedOutcome: string): TaskCollaborationRequirements {
  return {
    mode: "agent_autonomous",
    agentResponsibilities: [description, "自主完成并沉淀结果"],
    userResponsibilities: [],
    userInteractionType: "none",
    userInteractionTiming: "not_required",
    userFacingActionLabel: "查看结果",
    shouldNotifyUser: false,
    completionOwner: "agent",
    completionDefinition: expectedOutcome,
  };
}

export function getGoalBreakdownDraft(goalTitle: string): GoalBreakdownDraft {
  return {
    goalTitle,
    subGoals: [
      {
        id: "draft-subgoal-1",
        title: "建立系统认知与素材储备",
        tasks: [
          {
            id: "draft-task-1",
            title: "岗位画像拆解",
            description: "梳理目标岗位的职责、能力要求和代表性公司。",
            expectedOutcome: "形成一份 1 页岗位画像摘要。",
            taskType: "one_shot",
            triggerRule: "今天 20:00 触发",
            executionKind: "generic_result",
            collaboration: mockCollaboration("generic_result", "梳理目标岗位的职责、能力要求和代表性公司。", "形成一份 1 页岗位画像摘要。"),
          },
          {
            id: "draft-task-2",
            title: "案例库整理",
            description: "沉淀 5 个可复用的产品项目案例。",
            expectedOutcome: "每个案例都有 STAR 结构和关键指标。",
            taskType: "repeat",
            triggerRule: "每天 21:00 触发",
            executionKind: "generic_result",
            collaboration: mockCollaboration("generic_result", "沉淀 5 个可复用的产品项目案例。", "每个案例都有 STAR 结构和关键指标。"),
          },
          {
            id: "draft-task-3",
            title: "行业新闻跟进",
            description: "跟踪 AI Agent、Copilot、workflow 新动态。",
            expectedOutcome: "每周输出 1 页趋势摘要。",
            taskType: "repeat",
            executionMode: "monitoring",
            triggerRule: "每天 09:00 触发",
            executionKind: "generic_result",
            collaboration: mockCollaboration("generic_result", "跟踪 AI Agent、Copilot、workflow 新动态。", "每周输出 1 页趋势摘要。"),
          },
        ],
      },
      {
        id: "draft-subgoal-2",
        title: "完成表达训练与投递执行",
        tasks: [
          {
            id: "draft-task-4",
            title: "模拟面试",
            description: "围绕项目经历做 20 分钟口述演练。",
            expectedOutcome: "形成一版更紧凑的口语表达脚本。",
            taskType: "repeat",
            triggerRule: "每天 11:00 触发",
            executionKind: "generic_result",
            collaboration: mockCollaboration("generic_result", "围绕项目经历做 20 分钟口述演练。", "形成一版更紧凑的口语表达脚本。"),
          },
          {
            id: "draft-task-5",
            title: "邮件草稿审阅",
            description: "检查投递邮件、跟进邮件和感谢信。",
            expectedOutcome: "输出 3 封可直接发送的邮件。",
            taskType: "repeat",
            triggerRule: "每天 18:00 触发",
            executionKind: "generic_result",
            collaboration: mockCollaboration("generic_result", "检查投递邮件、跟进邮件和感谢信。", "输出 3 封可直接发送的邮件。"),
          },
          {
            id: "draft-task-6",
            title: "投递节奏确认",
            description: "和 KiKi 一起决定本周要投递的公司清单。",
            expectedOutcome: "确认 5 家优先公司。",
            taskType: "one_shot",
            triggerRule: "明天 10:00 触发",
            executionKind: "generic_result",
            collaboration: mockCollaboration("generic_result", "和 KiKi 一起决定本周要投递的公司清单。", "确认 5 家优先公司。"),
          },
        ],
      },
    ],
  };
}
