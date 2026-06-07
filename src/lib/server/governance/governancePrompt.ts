import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { QuotedConversationMessageContext } from "@/types/runtime";
import { buildTaskQuoteContent } from "@/lib/taskFeedback";

function summarizeGoalTasks(goal: Goal) {
  return goal.subGoals
    .flatMap((subGoal) =>
      subGoal.tasks.map((task) => ({
        goalId: goal.id,
        subGoalId: subGoal.id,
        subGoalTitle: subGoal.title,
        taskId: task.id,
        title: task.title,
        description: task.description,
        expectedOutcome: task.expectedOutcome,
        triggerRule: task.triggerRule,
      })),
    )
    .slice(0, 50);
}

export function buildGovernanceJudgePrompt(input: {
  goal: Goal;
  subGoal?: SubGoal;
  task?: Task;
  instance?: TaskInstance;
  userMessage: string;
  quotedMessage?: QuotedConversationMessageContext | null;
}) {
  return `你是 KiKi 的会话治理意图判官。你只负责判断用户这句话是否要操作 topic/thread/task，不要执行任务本身。

只能输出严格 JSON 对象，不要 Markdown，不要解释。intent 必须是以下 10 个枚举之一：
- amend_task：用户要求修改未来任务定义/标准/频率/验收要求，例如"下次按这个要求执行"。
- rerun_current：用户要求基于当前任务结果重新生成/重跑。
- create_task：用户要求新增一个任务。
- update_task：用户要求直接修改某个任务字段，但不是强调未来标准增补。
- cancel_task：用户要求删除/取消某个任务。
- dispatch_task：用户要求立即执行/派发某个任务。P0 只识别不执行。
- pause_task：用户要求暂停/恢复某个任务。P0 只识别不执行。
- chitchat：普通闲聊、感谢、评价，不应操作任务。
- qa：围绕任务或结果提问，只需要回答，不改状态。
- clarify：确实像治理诉求，但目标/操作/修改内容不清楚，需要追问。

可修改字段白名单：
- title
- description
- expectedOutcome
- expectedResult.completionCriteria
- expectedResult.requiredBlocks
- triggerRule

JSON schema:
{
  "intent": "amend_task | rerun_current | create_task | update_task | cancel_task | dispatch_task | pause_task | chitchat | qa | clarify",
  "targetRef": { "goalId": "...", "subGoalId": "...", "taskId": "...", "instanceId": "..." } | null,
  "confidence": 0.0,
  "patch": {
    "title": "仅 create/update/amend 时可填",
    "description": "任务描述",
    "expectedOutcome": "任务交付物",
    "expectedResult": {
      "completionCriteria": "要追加/替换到完成标准的具体要求",
      "requiredBlocks": ["markdown", "list"]
    },
    "triggerRule": "触发规则"
  },
  "revisionHint": "仅 rerun_current 时填写：给执行 Agent 的具体修订要求",
  "assistantMessage": "给用户的简短说明或追问",
  "reason": "一句话判断理由"
}

目标：${input.goal.title}
目标任务列表（用于用户未显式引用任务时解析 targetRef）：
${JSON.stringify(summarizeGoalTasks(input.goal), null, 2)}

子目标：${input.subGoal?.title ?? "无"}
任务标题：${input.task?.title ?? "无"}
任务描述：${input.task?.description ?? "无"}
任务预期结果：${input.task?.expectedOutcome ?? "无"}
完成标准：${input.task?.expectedResult?.completionCriteria ?? "无"}

被引用任务结果：
${input.task && input.instance ? buildTaskQuoteContent(input.task, input.instance) : "无"}

用户发送时引用内容：
${input.quotedMessage ? `[${input.quotedMessage.roleLabel}] ${input.quotedMessage.content}` : "无"}

用户消息：
${input.userMessage}`;
}
