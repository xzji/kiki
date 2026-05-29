import type { EasterEggSettings } from "@/lib/goalSystemConfig";

type TaskDraftPromptInput = {
  goalTitle: string;
  goalDescription: string;
  userContext: Record<string, unknown>;
  subGoalName: string;
  subGoalDescription: string;
  successCriteria: string[];
  config: EasterEggSettings;
  subGoalIndex?: number;
  totalSubGoals?: number;
};

export function buildTaskDraftPrompt(input: TaskDraftPromptInput) {
  return `只能输出 Block 协议，不允许 JSON / Markdown / 解释文字。
所有标签必须出现在行首，标签外不要输出任何文字。
不要输出 expected_output / collaboration / required_blocks / format / presentation / executionMode / executionKind 等内部字段。
内容包含 </tag> 字面量时，用 <![CDATA[...]]> 包裹该字段内容。
cadence 必须包含具体时间/间隔（如「每周日 20:00 触发」「每 3 小时触发」），不要使用「早上/出发前/晚上」等模糊词。

你正在为 KiKi 长期目标系统生成子目标任务草稿。只描述任务语义，系统会负责确定性编译内部结构。

目标：${input.goalTitle}
目标描述：${input.goalDescription}
用户上下文：${JSON.stringify(input.userContext, null, 2)}
子目标 ${input.subGoalIndex ?? "?"}/${input.totalSubGoals ?? "?"}：${input.subGoalName}
子目标描述：${input.subGoalDescription}
成功标准：
${input.successCriteria.map((item) => `- ${item}`).join("\n")}

任务数量建议：${input.config.minTasksPerSubGoal}-${input.config.maxTasksPerSubGoal} 个，覆盖子目标成功标准，不要拆得过碎。
priority 只能是 critical/high/medium/low。
user-involvement mode 只能是 none/confirm/answer/collaborate。

正确示例：
<task index="1">
<title>
面试节奏调度与进度看板管理
</title>
<objective>
持续追踪候选人的面试推进状态，并发现阻塞风险。
</objective>
<deliverable>
每周输出一份面试进度看板和下一步行动建议。
</deliverable>
<acceptance>
- 看板含 T1/T2/T3 分层
- 标出超过 7 天未推进的候选人
- 给出下一周行动优先级
</acceptance>
<cadence>每周日 20:00 触发</cadence>
<user-involvement mode="none" />
<dependencies></dependencies>
<priority>high</priority>
<duration-minutes>90</duration-minutes>
</task>

错误示例：
❌ { "tasks": [] }
❌ 三个反引号 xml 围栏包裹整段输出
❌ 在 <task> 前后解释"下面是任务"
❌ 输出 expected_output 或 required_blocks

现在输出任务草稿：`;
}

export function buildSingleTaskDraftRepairPrompt(input: {
  goalTitle: string;
  subGoalName: string;
  rawBlock: string;
  missingFields: string[];
}) {
  return `只能输出一个 <task> Block，不允许 JSON / Markdown / 解释文字。
下面的任务草稿缺少字段：${input.missingFields.join(", ")}。
请在不改变语义的前提下补齐字段。

目标：${input.goalTitle}
子目标：${input.subGoalName}
原始 Block：
${input.rawBlock}

必须包含 title/objective/deliverable/acceptance。`;
}
