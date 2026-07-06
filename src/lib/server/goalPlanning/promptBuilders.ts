/**
 * Topic Init Saga 共享 Prompt 构造器。
 *
 * 这些 builder 由 Topic Saga 的角色锚点（agents/interviewerPrompt.ts /
 * plannerPrompt.ts / presenterPrompt.ts）与规划回归 spec 复用。它们原先与已下线的
 * legacy Goal 规划命令共处于 goalPlanning.ts；随 Goal 命令移除，这里独立成模块，
 * 不再依赖任何 legacy 编排或 checkpoint 逻辑。
 */
import type { EasterEggSettings } from "@/lib/goalSystemConfig";
import type { CollectedInfoSummary, GoalAnalysis, GoalDeliveryContract } from "@/types/kiki";

export type GoalInfoCollectionHistoryItem = {
  questions: string[];
  answer?: string;
};

type CollectedInfoSummaryPayload = CollectedInfoSummary;

type DecompositionPayload = {
  goalAnalysis: GoalAnalysis;
  deliveryContract?: GoalDeliveryContract;
  subGoals: Array<{
    id: number;
    name: string;
    description: string;
    why?: string;
    priority: "critical" | "high" | "medium" | "low";
    dependencies: number[];
    estimatedDurationMinutes?: number;
    successCriteria: Array<{
      description: string;
      type: "milestone" | "deliverable" | "condition";
    }>;
  }>;
  executionOrder: string;
  risks: string[];
  reasoning: string;
};

export function isLoopV2PlannerEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.KIKI_LOOP_V2_PLANNER === "1" || env.KIKI_LOOP_V2_PLANNER === "true";
}

function loopV2PlannerInstructions() {
  if (!isLoopV2PlannerEnabled()) return "";
  return `

## Loop v2 输出增强（KIKI_LOOP_V2_PLANNER）
- 顶层必须输出 topicLoop，表示 Topic 元规划治理节拍；优先使用 structured TriggerSpec，例如 {"kind":"weekly"}、{"kind":"cron","expr":"0 9 * * 1","timezone":"Asia/Shanghai"}。
- Thread.reviewInterval 允许继续使用旧词表，也允许输出 cron/phased TriggerSpec 对象；phased 适合市场窗口、工作日窗口等阶段性治理。
- Task 必须在保留 triggerRule 的同时尽量输出 triggerSpec；triggerSpec 支持 cron、interval、phased、event、composed。
- triggerRule 作为旧版自然语言兜底，不要省略；triggerSpec 是机器可调度字段。

TriggerSpec 示例：
- 每日 09:00：{"kind":"cron","expr":"0 9 * * *","timezone":"Asia/Shanghai"}
- 每 15 分钟：{"kind":"interval","value":15,"unit":"m","everyMs":900000}
- 美股交易窗口：{"kind":"phased","timezone":"America/New_York","phases":[{"id":"market","start":"09:30","end":"16:00","daysOfWeek":[1,2,3,4,5],"trigger":{"kind":"interval","value":15,"unit":"m","everyMs":900000}}]}
- 任务完成事件：{"kind":"event","sources":["task_completed"]}`;
}

function loopV2PlannerSchemaFields() {
  if (!isLoopV2PlannerEnabled()) {
    return {
      topLevel: "",
      reviewInterval: `"reviewInterval": "one_shot|daily|weekly|hourly|realtime",`,
      taskTriggerSpec: "",
    };
  }
  return {
    topLevel: `  "topicLoop": { "kind": "weekly" },\n`,
    reviewInterval: `"reviewInterval": "one_shot|daily|weekly|hourly|realtime 或 TriggerSpec 对象（cron/phased/interval）",`,
    taskTriggerSpec: `          "triggerSpec": { "kind": "cron", "expr": "0 9 * * *", "timezone": "Asia/Shanghai" },\n`,
  };
}

export function buildGoalClarificationPrompt(goalText: string, conversationContext?: string) {
  return `你是 KiKi 的目标澄清助手。用户刚发起一个长期目标，请先判断为了生成可靠规划，最需要补充哪些背景信息。

用户目标：
${goalText}

${conversationContext ? `会话上下文：\n${conversationContext}\n` : ""}
要求：
1. 只能输出严格 JSON，不要包含 Markdown、代码块或额外解释。
2. 生成 1-3 个澄清问题，问题必须具体、自然、便于用户一次性回答。
3. 优先询问：成功标准、当前基础/资源、截止时间/频率、重要约束。
4. 如果目标已经非常明确，也至少问 1 个确认关键约束的问题。

JSON schema：
{
  "questions": [
    "你希望这个目标最终达到什么可衡量的结果？",
    "你目前的基础和每周可投入时间大概是多少？"
  ]
}`;
}

export function buildGoalFollowUpQuestionsPrompt(input: {
  goalText: string;
  conversationContext?: string;
  history: GoalInfoCollectionHistoryItem[];
  answeredRounds: number;
  minRounds: number;
  maxRounds: number;
}) {
  return `你是 KiKi 的目标信息收集助手。系统已通过代码规则决定：当前还需要继续收集一轮信息。你的唯一任务是结合目标和已收集信息，提出下一轮最有价值的补充问题。

目标：
${input.goalText}

已完成回答轮数：${input.answeredRounds}
最小信息收集轮数：${input.minRounds}
最大信息收集轮数：${input.maxRounds}

历史问答：
${JSON.stringify(input.history, null, 2)}

${input.conversationContext ? `会话上下文：\n${input.conversationContext}\n` : ""}
要求：
1. 只能输出严格 JSON，不要包含 Markdown、代码块或额外解释。
2. 只生成下一轮 1-3 个补充问题，不要判断是否可以进入规划。
3. 问题必须基于“目标 + 历史问答”中仍缺失或不清楚的信息，避免重复询问已经回答过的内容。
4. 优先补齐：成功标准、时间线、资源/投入、关键约束、主要风险、用户偏好。
5. 问题必须具体、自然、便于用户一次性回答。

JSON schema：
{
  "questions": [
    "结合已有回答后，下一轮最需要补充的问题"
  ]
}`;
}

export function buildCollectedInfoSummaryPrompt(
  goalText: string,
  collectedInfo: string,
  conversationContext?: string,
) {
  return `你正在为一个长程目标系统整理用户背景信息。请把用户补充的内容整理为结构化摘要，便于后续子目标拆解和任务规划。

目标：
${goalText}

用户补充信息：
${collectedInfo}

${conversationContext ? `会话上下文：\n${conversationContext}\n` : ""}
要求：
1. 只能输出严格 JSON，不要包含 Markdown、代码块或额外解释。
2. 尽量提炼为可执行规划所需的关键信息。
3. 如果用户没有提供某部分信息，对应字段可以留空字符串。

JSON schema：
{
  "goalDetails": "更具体的目标描述",
  "timeline": "时间限制、截止时间、频率要求",
  "resources": "可投入时间、预算、工具、人力、基础条件",
  "constraints": "约束、限制、不能接受的条件",
  "challenges": "当前障碍、风险、薄弱点",
  "preferences": "用户偏好、优先级、风格要求",
  "summary": "2-3 句中文摘要"
}`;
}

export function buildDecomposePrompt(input: {
  goalTitle: string;
  goalDescription: string;
  userContext: Record<string, unknown>;
  config: EasterEggSettings;
}) {
  const loopV2 = loopV2PlannerSchemaFields();
  return `# Role
你是一位通用规划编排器，负责把用户诉求拆成 Topic 下的 Thread 板块，并生成可闭环交付的初始 Task 主干路径。
你不能把用户诉求强行套进固定模式；必须基于诉求本身，用正交属性描述每个板块的治理节拍、终止条件和初始执行单元。

# Context
## Thread / Task 职责
- Thread = 需求的维度、阶段或板块，是组织上下文和治理 Task 集合的容器。
- Thread 的 reviewInterval 只是低频治理 review 节拍，不是执行频率。
- Task = 真正执行单元，必须自带 taskType 和 triggerRule/cadence/triggerCondition。
- Task 集合应覆盖从当前状态到目标成功状态的最小主干闭环路径。
- 后续 ThreadRunner tick 可以细化、调整、补救，但初始计划不得把关键交付缺口留给后续。

# Instructions
## 重要输出约束
- 只能输出一个严格合法的 JSON 对象。
- 不要输出 Markdown、标题、解释、代码块、emoji 或任何 JSON 之外的文字。
- 不要先展示思考过程，所有分析都必须写入 JSON 字段。

## 拆解前思考
在拆解前，请先思考：
1. 这个目标的核心意图是什么？
2. 成功达成后的状态是什么样的？
3. 有哪些隐含的假设和前提条件？
4. 这个诉求需要一次性推进、阶段性推进，还是长期关注？
5. 哪些维度/阶段/板块彼此 MECE，且每个板块下可以有不同频率的 Task？
6. 用户最终要拿到什么交付物？
7. 什么证据能证明目标完成？
8. 哪些结果只是准备工作，不能单独算完成？

## Thread 拆解原则
1. 板块 MECE：Thread 之间按维度/阶段/板块拆分，尽量互不重叠且覆盖核心意图。
2. 数量克制：Thread 数量建议 ${input.config.minSubGoals}-${Math.min(input.config.maxSubGoals, 5)} 个，最多 5 个。
3. 不按执行频率拆 Thread：同一 Thread 下允许 daily/hourly/one_shot 等不同频率 Task 并存。
4. reviewInterval 只表示治理兜底 review 节拍：monitoring 通常 weekly，风险板块可 daily，阶段性目标可 one_shot。
5. terminationCondition 描述板块什么时候可自然结束；长期关注可留空字符串。
6. subGoals[].dependencies 不是展示字段：它表示下游板块启动前必须满足的上游关键产出。只有当当前板块确实需要等待前序板块的信息收集、概念确认、方案选择、设计决策或核心交付结果时才填写依赖。
7. dependencies 只能引用上游子目标 id，不要引用后续板块；持续关注/repeat/monitoring 板块默认不是阶段推进 blocker，除非当前板块明确需要等待它产出的监控结论。

## 初始 Task 主干原则
1. 每个 Thread 的 tasks 不是随意待办清单，而是让该 Thread 可自然完成的最小闭环路径。
2. 明确允许 tasks=[]：仅适用于真正需要等待外部事件或长期观察的 Thread；如果 Thread 承担一次性交付责任，不得为空。
3. 持续关注/巡检类 Task 用 taskType="repeat"，并填写 cadence 或 triggerRule。
4. 一次性分析/交付类 Task 用 taskType="one_shot"，triggerRule 可写 "立即触发" 或明确条件。
5. 事件触发类需求降级为周期巡检 Task：用 repeat + 合适 cadence，并在 description/objective 里写清判断条件。
6. 如果某个 Thread 承担将准备产出转化为最终结果的责任，tasks 必须包含构建或验收类执行单元，不能只包含方案、选型、说明、骨架等准备产物。
7. 整个 Topic 的所有初始 tasks 完成后，必须能证明 goalAnalysis.successState 与 deliveryContract 已满足。
8. tasks[].dependencies 是真实执行依赖：如果某个任务必须等待同一 Thread 或上游 Thread 的任务产出，必须填写被依赖任务的 id 或 title；不要只把前置关系写进 triggerRule 文案。
9. triggerRule 描述“什么时候尝试触发”，dependencies 描述“必须先完成哪些任务”；两者都需要时必须同时填写。
10. tasks[].requiredUserInputs（可选）：仅列出任务执行前必须由用户提供、且 Agent 无法自行检索或推断的关键信息（如出发城市、出行日期、预算、护照信息、个人偏好）。Agent 能自行搜索或推断的信息不要列。无需用户输入时省略该字段或写 []。可用 satisfiedHint 描述“何种内容算已满足”，便于后续判定是否还需追问。
${loopV2PlannerInstructions()}

## 边界处理
- 避免过度拆解导致管理成本过高。
- 避免拆解不足导致 Thread 过于庞大。
- 对于模糊目标，优先以 assumptions 标注，并用低成本种子 Task 获取信息。
- 不要为了满足数量要求制造空洞任务。

# Goal Information
目标: ${input.goalTitle}
描述: ${input.goalDescription}
用户背景信息:
${JSON.stringify(input.userContext, null, 2)}

# Output Format
请严格按照以下 JSON 格式返回，确保所有必填字段完整。回复必须以 { 开头，以 } 结尾：
{
  "goalAnalysis": {
    "coreIntent": "核心意图：一句话概括目标的本质",
    "successState": "成功状态：描述达成后的理想状态",
    "assumptions": ["假设1：隐含的前提条件", "假设2：..."],
    "deliveryContract": {
      "finalDeliverable": "用户最终要拿到的主交付物",
      "doneEvidence": ["可证明目标完成的证据"],
      "nonCompletionExamples": ["只是准备工作、不能单独算完成的产物"]
    }
  },
${loopV2.topLevel}  "subGoals": [
    {
      "id": 1,
      "name": "Thread/板块名称（简洁有力）",
      "description": "本板块 intent：包含治理边界、关注对象和判断原则",
      ${loopV2.reviewInterval}
      "terminationCondition": "本板块何时可结束；长期关注可为空字符串",
      "why": "必要性说明：为什么需要这个板块",
      "priority": "critical|high|medium|low",
      "dependencies": [],
      "estimatedDurationMinutes": 480,
      "successCriteria": [
        { "description": "完成标准1", "type": "milestone" },
        { "description": "完成标准2", "type": "deliverable" }
      ],
      "tasks": [
        {
          "id": "1-1",
          "title": "初始种子 Task 标题",
          "description": "任务目标、执行边界和必要上下文",
          "expectedOutcome": "完成后应沉淀的结果",
          "taskType": "repeat|one_shot",
          "triggerRule": "立即触发|每天 09:00|每周一|每小时|满足条件：...",
${loopV2.taskTriggerSpec}          "cadence": "可选：自然语言频率，例如 每天 09:00",
          "triggerCondition": "可选：条件型任务的判断条件",
          "dependencies": ["可选：必须先完成的任务 id 或 title；无依赖则 []"],
          "executionKind": "generic_result",
          "requiredUserInputs": [{ "id": "英文短标识", "label": "中文字段名", "question": "向用户提问的话术", "options": ["可选项1", "可选项2"], "satisfiedHint": "可选：何种内容算已满足" }]
        }
      ]
    }
  ],
  "executionOrder": "执行顺序建议：说明子目标的推荐执行顺序和理由",
  "risks": ["风险点1：可能的问题和应对策略", "风险点2：..."],
  "reasoning": "拆解理由：整体拆解思路和关键考量"
}`;
}

export function buildDecompositionNormalizationPrompt(input: {
  goalTitle: string;
  goalDescription: string;
  userContext: Record<string, unknown>;
  rawOutput: string;
  config: EasterEggSettings;
}) {
  const loopV2 = loopV2PlannerSchemaFields();
  return `你是目标拆解 JSON 规范化助手。下面的“原始输出”可能是 Markdown、自然语言或不合法 JSON。

你的任务：把原始输出转换为严格合法的 JSON 对象，并符合指定 schema。

硬性要求：
1. 只能输出 JSON，不要输出 Markdown、解释、代码块或额外文字。
2. 回复必须以 { 开头，以 } 结尾。
3. 尽量保留原始输出中的拆解语义；如果原始输出缺少字段，请基于目标信息合理补齐。
4. subGoals 表示 Thread 板块，数量建议 ${input.config.minSubGoals}-${Math.min(input.config.maxSubGoals, 5)} 个，最多 5 个。
5. priority 只能是 critical、high、medium、low。
6. successCriteria[].type 只能是 milestone、deliverable、condition。
7. dependencies 必须是数字数组，引用前置子目标 id；无依赖则 []。dependencies 是真实执行依赖，表示下游板块启动前必须满足上游关键产出，不是展示字段。
8. 只有当前板块确实需要等待前序板块的信息收集、概念确认、方案选择、设计决策或核心交付结果时才保留依赖；repeat/monitoring 板块默认不是阶段推进 blocker，除非被显式需要。
9. 保留每个 Thread 的 reviewInterval、terminationCondition 和 tasks[]；tasks 可以为空数组，不要补占位任务。
10. goalAnalysis.deliveryContract 必须描述最终交付物、完成证据、以及不能单独算完成的中间产物；如果原始输出缺少，请基于目标信息补齐。
11. tasks 应覆盖从当前状态到目标成功状态的最小主干闭环路径，不得把关键交付缺口留给后续。
12. tasks[].dependencies 是真实执行依赖；如果 triggerRule 或任务语义包含“X 完成后/确认后/锁定后/交付后/反馈后”，必须把 X 对应任务的 id 或 title 写入 dependencies。
13. 保留原始输出中的 tasks[].requiredUserInputs；它表示任务执行前必须由用户提供、Agent 无法自行检索的关键信息。如果原始输出没有该信息，不要凭空捏造，省略即可。
${loopV2PlannerInstructions()}

目标信息：
${JSON.stringify({
  goalTitle: input.goalTitle,
  goalDescription: input.goalDescription,
  userContext: input.userContext,
}, null, 2)}

必须输出的 JSON schema：
{
  "goalAnalysis": {
    "coreIntent": "核心意图",
    "successState": "成功状态",
    "assumptions": ["假设1"],
    "deliveryContract": {
      "finalDeliverable": "用户最终要拿到的主交付物",
      "doneEvidence": ["可证明目标完成的证据"],
      "nonCompletionExamples": ["只是准备工作、不能单独算完成的产物"]
    }
  },
${loopV2.topLevel}  "subGoals": [
    {
      "id": 1,
      "name": "Thread/板块名称",
      "description": "本板块 intent",
      ${loopV2.reviewInterval}
      "terminationCondition": "终止条件；长期关注可为空字符串",
      "why": "必要性说明",
      "priority": "critical",
      "dependencies": [],
      "estimatedDurationMinutes": 480,
      "successCriteria": [
        { "description": "完成标准", "type": "milestone" }
      ],
      "tasks": [
        {
          "id": "1-1",
          "title": "初始种子 Task 标题",
          "description": "任务描述",
          "expectedOutcome": "交付结果",
          "taskType": "repeat|one_shot",
          "triggerRule": "立即触发|每天 09:00|每周一|每小时|满足条件：...",
${loopV2.taskTriggerSpec}          "dependencies": ["可选：必须先完成的任务 id 或 title；无依赖则 []"],
          "executionKind": "generic_result",
          "requiredUserInputs": [{ "id": "英文短标识", "label": "中文字段名", "question": "向用户提问的话术", "options": ["可选项1", "可选项2"], "satisfiedHint": "可选：何种内容算已满足" }]
        }
      ]
    }
  ],
  "executionOrder": "执行顺序建议",
  "risks": ["风险点"],
  "reasoning": "拆解理由"
}

原始输出：
${input.rawOutput}`;
}

export function buildPlanPresentationPrompt(input: {
  goalText: string;
  collectedInfoSummary: CollectedInfoSummaryPayload;
  decomposition: DecompositionPayload;
  taskPlanningSummary: Array<{
    subGoalName: string;
    taskCount: number;
    uncoveredRisks?: string[];
  }>;
}) {
  return `你正在为 KiKi 的目标规划 UI 生成最终展示摘要。请基于已经完成的收集信息、子目标拆解和任务规划结果，输出一份适合前端展示的计划头部信息。

原始目标：
${input.goalText}

信息摘要：
${JSON.stringify(input.collectedInfoSummary, null, 2)}

子目标拆解：
${JSON.stringify(input.decomposition, null, 2)}

任务规划概况：
${JSON.stringify(input.taskPlanningSummary, null, 2)}

要求：
1. 只能输出严格 JSON，不要包含 Markdown、代码块或额外解释。
2. goalTitle 适合在对话卡片和目标页展示，简洁但明确。
3. summary 用 2-3 句概括整体推进思路。
4. deadline 必须是 ISO 字符串；如果用户没有明确给出截止时间，请省略 deadline 字段（不要使用任何虚构的兜底日期）。
5. notificationStrategy 描述后续提醒与推进策略，贴近长期任务系统。

JSON schema：
{
  "goalTitle": "适合展示的目标标题",
  "summary": "2-3 句摘要",
  "deadline": "可选；如确定则给 ISO 字符串，否则省略此字段",
  "notificationStrategy": "后续提醒与推进策略"
}`;
}
