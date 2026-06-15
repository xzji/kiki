import type { EasterEggSettings } from "@/lib/goalSystemConfig";
import type { GoalDeliveryContract } from "@/types/kiki";

type TaskDraftPromptInput = {
  goalTitle: string;
  goalDescription: string;
  userContext: Record<string, unknown>;
  subGoalName: string;
  subGoalDescription: string;
  successCriteria: string[];
  previousSubGoals?: Array<{
    id: number;
    name: string;
    description: string;
    dependencies: number[];
    successCriteria: string[];
  }>;
  currentSubGoalDependencies?: Array<{
    id: number;
    name: string;
    description: string;
    successCriteria: string[];
  }>;
  previousKeyTasks?: Array<{
    subGoalId: string;
    subGoalName: string;
    id: string;
    title: string;
    expectedOutcome: string;
  }>;
  deliveryContract?: GoalDeliveryContract;
  isFinalSubGoal?: boolean;
  config: EasterEggSettings;
  subGoalIndex?: number;
  totalSubGoals?: number;
};

export function buildTaskDraftPrompt(input: TaskDraftPromptInput) {
  const dependencyContext = {
    previousSubGoals: input.previousSubGoals ?? [],
    currentSubGoalDependencies: input.currentSubGoalDependencies ?? [],
    previousKeyTasks: input.previousKeyTasks ?? [],
  };
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

依赖上下文：
${JSON.stringify(dependencyContext, null, 2)}

目标交付契约：
${JSON.stringify(input.deliveryContract ?? {}, null, 2)}

任务数量建议：${input.config.minTasksPerSubGoal}-${input.config.maxTasksPerSubGoal} 个，覆盖子目标成功标准，不要拆得过碎。
priority 只能是 critical/high/medium/low。
user-involvement mode 只能是 none/confirm/answer/collaborate。

必填用户输入规则（<required-inputs>，可选字段）：
- 仅列出「任务执行前必须由用户提供、且 Agent 无法自行检索或推断」的关键信息（如出发城市、出行日期、预算、护照信息、个人偏好等）。
- 不要列出 Agent 可以自行搜索、计算或从已有上下文得到的信息。
- 如果用户上下文中已经提供了某字段，仍可列出，并在 satisfied 中描述「何种内容算已满足」，便于后续判定是否还需追问。
- 如果任务无需任何用户额外输入，请省略整个 <required-inputs> 块。
- 每行一个字段，形如：\`- id: 英文短标识 | label: 中文字段名 | question: 向用户提问的话术 | options: 选项1,选项2 | satisfied: 何种内容算已满足\`；其中 options 与 satisfied 可选。

交付闭环规则：
- 任务不是随意待办清单，而是让当前子目标可自然完成的最小闭环路径。
- 准备任务：沉淀信息、方案、设计、选型、素材、脚本等。
- 构建任务：把前序产出变成用户可使用、可检查、可体验或可交付的结果。
- 验收任务：验证结果是否满足目标交付契约和子目标成功标准。
- 生成任务前必须自检：
  1. 当前子目标最终要沉淀什么结果？
  2. 哪些任务只是准备工作？
  3. 哪个任务负责把准备工作转化为可验收结果？
  4. 哪个任务负责验证结果满足子目标成功标准？
  5. ${input.isFinalSubGoal ? "这是最后一个子目标，全部任务完成后必须足以证明目标交付契约已满足。" : "如果当前子目标承担交付责任，全部任务完成后必须足以证明该子目标已完成。"}
- 如果当前子目标承担交付责任，不能只包含准备任务。
- 如果所有任务完成后仍无法证明子目标完成，必须补充构建或验收任务。
- 不得把关键交付缺口留给“后续再说”。

跨任务依赖规则：
- <dependencies> 不是展示字段；它会被后续编译为真实执行依赖。下游任务启动前，必须先满足这里列出的上游关键产出。
- 如果某个任务消费了信息收集、概念确认、用户偏好确认、方案选择、设计决策、接口/范围约定等前置任务的产出，必须在 <dependencies> 中引用这些前置任务。
- 当前子目标若依赖 previousSubGoals 或 currentSubGoalDependencies 中的板块，请优先从 previousKeyTasks 中选择相关 one-shot 关键产出任务作为依赖，并使用其 id 或 title 原样引用。
- 当前子目标内部的依赖可引用任务 index 或 title；跨子目标依赖只能引用依赖上下文里已有的 previousKeyTasks，不要虚构上游任务。
- repeat/monitoring/巡检类任务默认不是阶段推进 blocker，不要把它们列为依赖；只有当任务目标明确要求等待某个周期性监控结论时，才显式引用。

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
<required-inputs>
- id: target_candidates | label: 候选人名单 | question: 请提供当前在面试流程中的候选人名单 | satisfied: 出现至少一名候选人姓名或编号
</required-inputs>
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
