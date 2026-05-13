import { spawn } from "child_process";

import type { EasterEggSettings } from "@/lib/goalSystemConfig";
import { DEFAULT_EASTER_EGG_SETTINGS, normalizeEasterEggSettings } from "@/lib/goalSystemConfig";
import { appendGoalLog } from "@/lib/server/goalTelemetry";
import { ensureConversationWorkspace } from "@/lib/server/workspace/conversationWorkspace";
import type { CollectedInfoSummary, GoalAnalysis, GoalBreakdownDraft, TaskExpectedResult } from "@/types/kiki";
import type { GoalTelemetryScope } from "@/types/goalTelemetry";
import type { GoalWorkflowPhase } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

import { buildClaudeEnv } from "./claudeEnv";
import { resolveCliPath } from "./runtimeEnvValidation";

type ClaudeJsonPayload = {
  result?: string;
  message?: {
    content?: Array<{
      text?: string;
    }>;
  };
};

export type GoalClarificationQuestions = {
  questions: string[];
};

export type GoalInfoCollectionHistoryItem = {
  questions: string[];
  answer?: string;
};

export type GoalInfoCollectionTurnDecision = {
  status: "continue" | "complete";
  assistantMessage: string;
  questions?: string[];
  summary?: CollectedInfoSummary;
};

type CollectedInfoSummaryPayload = CollectedInfoSummary;

type DecompositionPayload = {
  goalAnalysis: GoalAnalysis;
  subGoals: Array<{
    id: number;
    name: string;
    description: string;
    why?: string;
    priority: "critical" | "high" | "medium" | "low";
    weight?: number;
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

type TaskGenerationPayload = {
  sub_goal_analysis?: {
    core_deliverable?: string;
    work_categories?: string[];
    completion_checklist?: string[];
  };
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    execution_cycle: "once" | "recurring";
    execution_mode: "standard" | "interactive" | "monitoring" | "event_triggered";
    execution_kind?: string;
    recurrence?: string;
    trigger_condition?: string;
    hierarchy_level?: "task" | "sub_task" | "action";
    parent_id?: string;
    priority: "critical" | "high" | "medium" | "low";
    dependencies: string[];
    expected_output: {
      type: "information" | "deliverable" | "decision" | "action" | "confirmation";
      description: string;
      format: "json" | "markdown" | "table" | "text" | "code" | "other";
      presentation?: NonNullable<TaskExpectedResult["presentation"]>;
      primary_format?: NonNullable<TaskExpectedResult["primaryFormat"]>;
      exportable_formats?: NonNullable<TaskExpectedResult["exportableFormats"]>;
      required_blocks?: NonNullable<TaskExpectedResult["requiredBlocks"]>;
      completion_criteria?: string;
    };
    collaboration?: {
      mode?:
        | "agent_autonomous"
        | "agent_with_user_confirmation"
        | "agent_user_collaborative"
        | "user_primary_agent_assistive";
      agent_responsibilities?: string[];
      user_responsibilities?: string[];
      user_interaction_type?: "none" | "confirm" | "answer" | "provide_context" | "perform_offline_action";
      user_interaction_timing?:
        | "not_required"
        | "before_execution"
        | "during_execution"
        | "after_agent_output"
        | "core_task_step";
      user_facing_action_label?: string;
      should_notify_user?: boolean;
      completion_owner?: "agent" | "user" | "shared";
      completion_definition?: string;
    };
    estimated_duration_minutes?: number;
  }>;
  execution_plan?: {
    suggested_order?: string[];
    critical_path?: string[];
    total_estimated_hours?: number;
  };
  coverage_validation?: {
    is_sufficient?: boolean;
    explanation?: string;
    uncovered_risks?: string[];
  };
};

type TaskReviewPayload = {
  reviewResults: Array<{
    taskId: string;
    goalContribution: "critical" | "high" | "medium" | "low";
    subGoalContribution: "critical" | "high" | "medium" | "low";
    aligned: boolean;
    reasoning: string;
    suggestions?: string[];
  }>;
};

type PlanPresentationPayload = {
  goalTitle: string;
  summary: string;
  deadline?: string;
  notificationStrategy: string;
};

type DraftTask = GoalBreakdownDraft["subGoals"][number]["tasks"][number];

const DEFAULT_DEADLINE = "2026-06-30T23:59:59+08:00";

const allowedExecutionKinds = [
  "flashcard",
  "listening_qa",
  "reading_digest",
  "confirm_action",
  "draft_review",
  "freeform_chat",
  "generic_result",
] as const;
const allowedPresentations: NonNullable<TaskExpectedResult["presentation"]>[] = [
  "summary_card",
  "visual_report",
  "comparison_table",
  "checklist",
  "timeline",
  "document",
  "dashboard",
  "handoff_package",
];
const allowedPrimaryFormats: NonNullable<TaskExpectedResult["primaryFormat"]>[] = [
  "structured_blocks",
  "json",
  "markdown",
  "html",
  "text",
  "code",
];
const allowedExportFormats: NonNullable<TaskExpectedResult["exportableFormats"]> = ["html", "markdown", "json", "text"];
const allowedRequiredBlocks: NonNullable<TaskExpectedResult["requiredBlocks"]> = [
  "heading",
  "paragraph",
  "markdown",
  "list",
  "key_value",
  "comparison_table",
  "decision",
  "callout",
];

type GoalStageProgressHandler = (progress: {
  phase: GoalWorkflowPhase;
  message: string;
  details?: string;
}) => void;

type ClaudeRunContext = {
  requestId?: string;
  scope: GoalTelemetryScope;
  phase: GoalWorkflowPhase;
  stepLabel: string;
};

function formatTimingDetails(input: Record<string, string | number | boolean | undefined>) {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function buildGoalClarificationPrompt(goalText: string, conversationContext?: string) {
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

function buildGoalFollowUpQuestionsPrompt(input: {
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

function buildCollectedInfoSummaryPrompt(
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

function buildDecomposePrompt(input: {
  goalTitle: string;
  goalDescription: string;
  userContext: Record<string, unknown>;
  config: EasterEggSettings;
}) {
  return `# Role
你是一位资深目标规划与战略拆解专家，擅长运用 MECE 原则和逆向推演法，将复杂目标拆解为可执行、可度量的子目标。

# Context
## MECE 原则
MECE (Mutually Exclusive, Collectively Exhaustive) 要求：
- 子目标之间相互独立，无重叠
- 所有子目标完全覆盖目标范围，无遗漏

## 逆向推演法
从终态倒推，识别关键里程碑：
1. 定义成功的最终状态
2. 倒推达成终态的前置条件
3. 识别关键依赖和风险点
4. 形成可执行的阶段序列

# Instructions
## 拆解前思考
在拆解前，请先思考：
1. 这个目标的核心意图是什么？
2. 成功达成后的状态是什么样的？
3. 有哪些隐含的假设和前提条件？
4. 可能遇到哪些风险和阻碍？

## 拆解原则
1. 独立性：每个子目标应该可独立交付价值
2. 渐进性：子目标应呈现递进关系，逐步逼近最终目标
3. 可度量性：每个子目标必须有明确的完成标准
4. 依赖明确：清晰标注子目标间的依赖关系
5. 风险可见：识别可能的风险点和应对策略

## 边界处理
- 子目标数量建议 ${input.config.minSubGoals}-${input.config.maxSubGoals} 个，根据目标复杂度调整
- 避免过度拆解导致管理成本过高
- 避免拆解不足导致子目标过于庞大
- 对于模糊目标，优先明确成功标准

# Goal Information
目标: ${input.goalTitle}
描述: ${input.goalDescription}
用户背景信息:
${JSON.stringify(input.userContext, null, 2)}

# Output Format
请严格按照以下 JSON 格式返回，确保所有必填字段完整：
{
  "goalAnalysis": {
    "coreIntent": "核心意图：一句话概括目标的本质",
    "successState": "成功状态：描述达成后的理想状态",
    "assumptions": ["假设1：隐含的前提条件", "假设2：..."]
  },
  "subGoals": [
    {
      "id": 1,
      "name": "子目标名称（简洁有力）",
      "description": "详细描述：包含具体内容和边界",
      "why": "必要性说明：为什么需要这个子目标",
      "priority": "critical|high|medium|low",
      "weight": 0.25,
      "dependencies": [],
      "estimatedDurationMinutes": 480,
      "successCriteria": [
        { "description": "完成标准1", "type": "milestone" },
        { "description": "完成标准2", "type": "deliverable" }
      ]
    }
  ],
  "executionOrder": "执行顺序建议：说明子目标的推荐执行顺序和理由",
  "risks": ["风险点1：可能的问题和应对策略", "风险点2：..."],
  "reasoning": "拆解理由：整体拆解思路和关键考量"
}`;
}

function buildTaskGenerationPrompt(input: {
  goalTitle: string;
  goalDescription: string;
  userContext: Record<string, unknown>;
  subGoalName: string;
  subGoalDescription: string;
  successCriteria: string[];
  config: EasterEggSettings;
}) {
  return `请为以下子目标生成具体的执行任务。

子目标: ${input.subGoalName}
描述: ${input.subGoalDescription}
完成标准:
${input.successCriteria.length > 0 ? input.successCriteria.map((item) => `- ${item}`).join("\n") : "无明确标准"}
所属目标: ${input.goalTitle}
目标补充说明: ${input.goalDescription}
用户背景: ${JSON.stringify(input.userContext, null, 2)}

要求:
1. 每个任务应该是具体可执行的
2. 明确每个任务的预期产出
3. 任务优先级要合理
4. execution_cycle 只能是 once(执行一次) | recurring(周期执行)
5. execution_mode 只能是 standard(标准) | interactive(需用户交互) | monitoring(持续监控) | event_triggered(事件触发)
6. hierarchy_level 只能是 task | sub_task | action
7. execution_kind 只能是 ${allowedExecutionKinds.join("、")}
8. 覆盖所有关键完成标准，同时避免冗余任务
9. 每个子目标尽量生成 ${input.config.minTasksPerSubGoal}-${input.config.maxTasksPerSubGoal} 个任务，过少会导致执行不可落地，过多会导致管理成本过高
10. 必须明确每个任务的 Agent / 用户职责分工，写入 collaboration
11. 必须明确交付形式：expected_output.presentation、primary_format、exportable_formats、required_blocks 都必须填写
12. 信息类任务（type=information）默认使用 presentation=visual_report、primary_format=structured_blocks、exportable_formats 至少包含 html，避免只交付 markdown 长文
13. 对比/研究/攻略/方案类任务必须优先要求 comparison_table、callout、key_value 等 blocks，形成可视化报告

协作模式规则:
- agent_autonomous: Agent 可自主完成，用户只需知悉结果
- agent_with_user_confirmation: Agent 自主产出，但需要用户确认、采纳或提出修改建议
- agent_user_collaborative: Agent 与用户共同完成，用户作答、选择或补充是任务完成的一部分
- user_primary_agent_assistive: 用户主要完成，Agent 负责建议、提醒、检查和记录

请按 JSON 格式返回：
{
  "sub_goal_analysis": {
    "core_deliverable": "核心交付物描述",
    "work_categories": ["分类1", "分类2"],
    "completion_checklist": ["检查项1", "检查项2"]
  },
  "tasks": [
    {
      "id": "task-1",
      "title": "任务标题",
      "description": "详细描述",
      "execution_cycle": "once|recurring",
      "execution_mode": "standard|interactive|monitoring|event_triggered",
      "execution_kind": "generic_result",
      "recurrence": "周期频率描述(仅 recurring 需要)",
      "trigger_condition": "触发条件描述(仅 event_triggered 需要)",
      "hierarchy_level": "task|sub_task|action",
      "parent_id": "父任务ID(可选)",
      "priority": "critical|high|medium|low",
      "dependencies": ["依赖任务ID"],
      "expected_output": {
        "type": "information|deliverable|decision|action|confirmation",
        "description": "预期产出描述",
        "format": "json|markdown|table|text|code|other",
        "presentation": "summary_card|visual_report|comparison_table|checklist|timeline|document|dashboard|handoff_package",
        "primary_format": "structured_blocks|json|markdown|html|text|code",
        "exportable_formats": ["html", "markdown"],
        "required_blocks": ["heading", "callout", "comparison_table", "key_value"],
        "completion_criteria": "完成判定标准"
      },
      "collaboration": {
        "mode": "agent_autonomous|agent_with_user_confirmation|agent_user_collaborative|user_primary_agent_assistive",
        "agent_responsibilities": ["Agent 负责准备、分析、生成或提醒的事项"],
        "user_responsibilities": ["用户需要确认、作答、补充或线下完成的事项；如不需要则为空数组"],
        "user_interaction_type": "none|confirm|answer|provide_context|perform_offline_action",
        "user_interaction_timing": "not_required|before_execution|during_execution|after_agent_output|core_task_step",
        "user_facing_action_label": "给用户看的动作文案，例如 查看结果 / 确认结果 / 开始作答 / 补充信息",
        "should_notify_user": true,
        "completion_owner": "agent|user|shared",
        "completion_definition": "这个任务如何才算完成"
      },
      "estimated_duration_minutes": 60
    }
  ],
  "execution_plan": {
    "suggested_order": ["task-1", "task-2"],
    "critical_path": ["task-1"],
    "total_estimated_hours": 8
  },
  "coverage_validation": {
    "is_sufficient": true,
    "explanation": "覆盖度说明",
    "uncovered_risks": ["未覆盖风险1"]
  }
}`;
}

function buildTaskReviewPrompt(input: {
  goalTitle: string;
  subGoalTitle: string;
  goalDescription: string;
  tasksJson: string;
}) {
  return `请 Review 以下任务是否与目标对齐：

目标: ${input.goalTitle}
子目标: ${input.subGoalTitle}
目标描述: ${input.goalDescription}

待 Review 任务:
${input.tasksJson}

请评估每个任务：
1. 与最终目标的对齐程度（critical/high/medium/low）
2. 与子目标的对齐程度（critical/high/medium/low）
3. 是否需要调整或删除

请按 JSON 格式返回：
{
  "reviewResults": [
    {
      "taskId": "task-id",
      "goalContribution": "critical|high|medium|low",
      "subGoalContribution": "critical|high|medium|low",
      "aligned": true,
      "reasoning": "评估理由",
      "suggestions": ["建议1", "建议2"]
    }
  ]
}`;
}

function buildPlanPresentationPrompt(input: {
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
4. deadline 必须是 ISO 字符串；如果无法从信息中可靠判断，使用 ${DEFAULT_DEADLINE}。
5. notificationStrategy 描述后续提醒与推进策略，贴近长期任务系统。

JSON schema：
{
  "goalTitle": "适合展示的目标标题",
  "summary": "2-3 句摘要",
  "deadline": "${DEFAULT_DEADLINE}",
  "notificationStrategy": "后续提醒与推进策略"
}`;
}

async function runClaudeJson(input: {
  runtimeEnv: RuntimeEnvironment;
  prompt: string;
  conversationId?: string;
  workspaceDir?: string;
  signal?: AbortSignal;
  abortMessage: string;
  failureMessage: string;
  context?: ClaudeRunContext;
}) {
  const cwd = input.workspaceDir ?? (input.conversationId ? ensureConversationWorkspace(input.conversationId).workspaceDir : null);
  if (!cwd) {
    throw new Error("目标规划缺少 conversationId，无法进入隔离 conversation workspace");
  }
  const cliPath = await resolveCliPath(input.runtimeEnv.cliPath);
  return new Promise<string>((resolve, reject) => {
    const startedAt = Date.now();
    const promptChars = input.prompt.length;
    if (input.context) {
      // #region debug-point goal-planning-latency-claude-start
      appendGoalLog({
        requestId: input.context.requestId,
        scope: input.context.scope,
        level: "info",
        phase: input.context.phase,
        message: `Claude 开始执行：${input.context.stepLabel}`,
        details: formatTimingDetails({
          promptChars,
          cwd,
        }),
      });
      // #endregion
    }

    const child = spawn(cliPath, ["-p", "--output-format", "json", input.prompt], {
      cwd,
      env: buildClaudeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let errorOutput = "";
    let aborted = false;

    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      if (input.context) {
        // #region debug-point goal-planning-latency-claude-abort
        appendGoalLog({
          requestId: input.context.requestId,
          scope: input.context.scope,
          level: "warn",
          phase: input.context.phase,
          message: `Claude 执行被中断：${input.context.stepLabel}`,
        });
        // #endregion
      }
      reject(new DOMException(input.abortMessage, "AbortError"));
    };

    if (input.signal?.aborted) {
      abort();
      return;
    }

    input.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      input.signal?.removeEventListener("abort", abort);
      if (input.context) {
        // #region debug-point goal-planning-latency-claude-error
        appendGoalLog({
          requestId: input.context.requestId,
          scope: input.context.scope,
          level: "error",
          phase: input.context.phase,
          message: `Claude 执行异常：${input.context.stepLabel}`,
          details: error.message,
        });
        // #endregion
      }
      reject(error);
    });

    child.on("close", (code) => {
      input.signal?.removeEventListener("abort", abort);
      if (aborted) return;
      if (code !== 0) {
        if (input.context) {
          // #region debug-point goal-planning-latency-claude-failed
          appendGoalLog({
            requestId: input.context.requestId,
            scope: input.context.scope,
            level: "error",
            phase: input.context.phase,
            message: `Claude 执行失败：${input.context.stepLabel}`,
            details: errorOutput.trim() || input.failureMessage,
          });
          // #endregion
        }
        reject(new Error(errorOutput.trim() || input.failureMessage));
        return;
      }
      if (input.context) {
        // #region debug-point goal-planning-latency-claude-finished
        appendGoalLog({
          requestId: input.context.requestId,
          scope: input.context.scope,
          level: "info",
          phase: input.context.phase,
          message: `Claude 执行完成：${input.context.stepLabel}`,
          details: formatTimingDetails({
            elapsedMs: Date.now() - startedAt,
            promptChars,
            outputChars: output.length,
          }),
        });
        // #endregion
      }
      resolve(output);
    });
  });
}

function stripJsonFences(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractTextFromPayload(raw: string) {
  const text = raw.trim();
  if (!text) return "";

  try {
    const parsed = JSON.parse(text) as ClaudeJsonPayload;
    if (typeof parsed.result === "string") return parsed.result;
    const content = parsed.message?.content?.map((item) => item.text || "").join("");
    if (content) return content;
  } catch {
    // Fall through to raw text parsing.
  }

  return text;
}

function extractBalancedJsonSnippet(text: string) {
  const startIndex = text.search(/[\{\[]/);
  if (startIndex < 0) return text.trim();

  const opener = text[startIndex];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === opener) {
      depth += 1;
      continue;
    }
    if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1).trim();
      }
    }
  }

  return text.slice(startIndex).trim();
}

function repairCommonJsonIssues(text: string) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/(["\]\}\d])\s*\n\s*("[-_$a-zA-Z0-9\u4e00-\u9fa5]+":)/g, "$1,\n$2")
    .replace(/(["\]\}\d])\s+("[-_$a-zA-Z0-9\u4e00-\u9fa5]+":)/g, "$1, $2")
    .trim();
}

async function repairMalformedJsonWithClaude(input: {
  runtimeEnv: RuntimeEnvironment;
  malformedJson: string;
  conversationId?: string;
  signal?: AbortSignal;
}) {
  const prompt = `你是 JSON 修复助手。请把下面这段不合法或不完整的 JSON 修复为严格合法的 JSON。

要求：
1. 只能输出修复后的严格 JSON。
2. 不要输出 Markdown、解释、代码块或额外说明。
3. 尽量保留原始字段和值语义，不要擅自改写业务含义。

待修复内容：
${input.malformedJson}`;

  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt,
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "JSON 修复已中断",
    failureMessage: "Claude CLI JSON 修复失败",
  });

  return stripJsonFences(extractTextFromPayload(stdout));
}

async function parseClaudeJson<T>(input: {
  raw: string;
  validator: (value: unknown) => T;
  errorMessage: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  context?: ClaudeRunContext;
}) {
  const parseStartedAt = Date.now();
  const primary = stripJsonFences(extractTextFromPayload(input.raw));
  const candidates = [
    { label: "primary", value: primary },
    { label: "balanced", value: extractBalancedJsonSnippet(primary) },
    { label: "common_repair", value: repairCommonJsonIssues(primary) },
    { label: "balanced_common_repair", value: repairCommonJsonIssues(extractBalancedJsonSnippet(primary)) },
  ];

  let lastError: unknown = null;

  for (const candidate of candidates) {
    if (!candidate.value) continue;
    try {
      const parsed = input.validator(JSON.parse(candidate.value) as unknown);
      if (input.context) {
        // #region debug-point goal-planning-latency-parse-hit
        appendGoalLog({
          requestId: input.context.requestId,
          scope: input.context.scope,
          level: "info",
          phase: input.context.phase,
          message: `JSON 解析命中：${input.context.stepLabel}`,
          details: formatTimingDetails({
            strategy: candidate.label,
            elapsedMs: Date.now() - parseStartedAt,
            rawChars: primary.length,
          }),
        });
        // #endregion
      }
      return parsed;
    } catch (error) {
      lastError = error;
    }
  }

  try {
    if (input.context) {
      // #region debug-point goal-planning-latency-parse-repair-start
      appendGoalLog({
        requestId: input.context.requestId,
        scope: input.context.scope,
        level: "warn",
        phase: input.context.phase,
        message: `JSON 解析进入 Claude 修复：${input.context.stepLabel}`,
        details: formatTimingDetails({
          elapsedMs: Date.now() - parseStartedAt,
          rawChars: primary.length,
        }),
      });
      // #endregion
    }
    const repaired = await repairMalformedJsonWithClaude({
      runtimeEnv: input.runtimeEnv,
      malformedJson: primary,
      conversationId: input.conversationId,
      signal: input.signal,
    });
    const repairedCandidate = repairCommonJsonIssues(extractBalancedJsonSnippet(repaired));
    const parsed = input.validator(JSON.parse(repairedCandidate) as unknown);
    if (input.context) {
      // #region debug-point goal-planning-latency-parse-repair-finished
      appendGoalLog({
        requestId: input.context.requestId,
        scope: input.context.scope,
        level: "info",
        phase: input.context.phase,
        message: `JSON 修复完成：${input.context.stepLabel}`,
        details: formatTimingDetails({
          strategy: "claude_repair",
          elapsedMs: Date.now() - parseStartedAt,
          rawChars: primary.length,
          repairedChars: repaired.length,
        }),
      });
      // #endregion
    }
    return parsed;
  } catch (error) {
    lastError = error;
  }

  if (input.context) {
    appendGoalLog({
      requestId: input.context.requestId,
      scope: input.context.scope,
      level: "error",
      phase: input.context.phase,
      message: `JSON 解析失败：${input.context.stepLabel}`,
      details: lastError instanceof Error ? lastError.message : input.errorMessage,
    });
  }
  throw new Error(input.errorMessage);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateClarificationQuestions(value: unknown): GoalClarificationQuestions {
  if (!isObject(value)) {
    throw new Error("Claude 返回的澄清问题不是 JSON 对象");
  }
  const questions = value.questions;
  if (!Array.isArray(questions)) {
    throw new Error("澄清问题缺少 questions");
  }
  const validQuestions = questions
    .filter((question): question is string => typeof question === "string")
    .map((question) => question.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (validQuestions.length === 0) {
    throw new Error("澄清问题为空");
  }
  return { questions: validQuestions };
}

function validateCollectedInfoSummary(value: unknown): CollectedInfoSummaryPayload {
  if (!isObject(value)) {
    throw new Error("Claude 返回的信息摘要不是 JSON 对象");
  }
  return {
    goalDetails: typeof value.goalDetails === "string" ? value.goalDetails.trim() : "",
    timeline: typeof value.timeline === "string" ? value.timeline.trim() : "",
    resources: typeof value.resources === "string" ? value.resources.trim() : "",
    constraints: typeof value.constraints === "string" ? value.constraints.trim() : "",
    challenges: typeof value.challenges === "string" ? value.challenges.trim() : "",
    preferences: typeof value.preferences === "string" ? value.preferences.trim() : "",
    summary: typeof value.summary === "string" ? value.summary.trim() : "",
  };
}

function validateDecomposition(value: unknown): DecompositionPayload {
  if (!isObject(value)) {
    throw new Error("Claude 返回的子目标拆解不是 JSON 对象");
  }
  const goalAnalysis = isObject(value.goalAnalysis) ? value.goalAnalysis : null;
  const subGoals = Array.isArray(value.subGoals) ? value.subGoals : null;
  if (!goalAnalysis || !subGoals || subGoals.length === 0) {
    throw new Error("子目标拆解缺少 goalAnalysis 或 subGoals");
  }

  const normalizedSubGoals: DecompositionPayload["subGoals"] = [];
  for (let index = 0; index < subGoals.length; index += 1) {
    const subGoal = subGoals[index];
    if (!isObject(subGoal) || typeof subGoal.name !== "string" || !subGoal.name.trim()) {
      continue;
    }
    const successCriteria = Array.isArray(subGoal.successCriteria)
      ? subGoal.successCriteria
          .filter(isObject)
          .map((criterion) => {
            const description =
              typeof criterion.description === "string" ? criterion.description.trim() : "";
            const type: "deliverable" | "milestone" | "condition" =
              criterion.type === "deliverable" ||
              criterion.type === "condition" ||
              criterion.type === "milestone"
                ? criterion.type
                : "milestone";
            return { description, type };
          })
          .filter((criterion) => criterion.description)
      : [];
    normalizedSubGoals.push({
      id: typeof subGoal.id === "number" ? subGoal.id : index + 1,
      name: subGoal.name.trim(),
      description:
        typeof subGoal.description === "string" ? subGoal.description.trim() : subGoal.name.trim(),
      why: typeof subGoal.why === "string" ? subGoal.why.trim() : "",
      priority: normalizePriority(subGoal.priority),
      weight: typeof subGoal.weight === "number" ? subGoal.weight : undefined,
      dependencies: Array.isArray(subGoal.dependencies)
        ? subGoal.dependencies.filter((dependency): dependency is number => typeof dependency === "number")
        : [],
      estimatedDurationMinutes:
        typeof subGoal.estimatedDurationMinutes === "number"
          ? subGoal.estimatedDurationMinutes
          : undefined,
      successCriteria,
    });
  }

  if (normalizedSubGoals.length === 0) {
    throw new Error("子目标拆解为空");
  }

  return {
    goalAnalysis: {
      coreIntent:
        typeof goalAnalysis.coreIntent === "string" && goalAnalysis.coreIntent.trim()
          ? goalAnalysis.coreIntent.trim()
          : "明确目标核心意图",
      successState:
        typeof goalAnalysis.successState === "string" && goalAnalysis.successState.trim()
          ? goalAnalysis.successState.trim()
          : "达成用户期望的目标结果",
      assumptions: extractStringArray(goalAnalysis.assumptions),
    },
    subGoals: normalizedSubGoals,
    executionOrder:
      typeof value.executionOrder === "string" && value.executionOrder.trim()
        ? value.executionOrder.trim()
        : "",
    risks: extractStringArray(value.risks),
    reasoning:
      typeof value.reasoning === "string" && value.reasoning.trim()
        ? value.reasoning.trim()
        : "",
  };
}

function validateTaskGeneration(value: unknown): TaskGenerationPayload {
  if (!isObject(value) || !Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new Error("任务生成结果缺少 tasks");
  }

  const tasks: TaskGenerationPayload["tasks"] = [];
  for (let index = 0; index < value.tasks.length; index += 1) {
    const task = value.tasks[index];
    if (!isObject(task)) continue;
    const expectedOutput = isObject(task.expected_output) ? task.expected_output : null;
    if (!expectedOutput) continue;
    const title = typeof task.title === "string" ? task.title.trim() : "";
    const description = typeof task.description === "string" ? task.description.trim() : "";
    const expectedDescription =
      typeof expectedOutput.description === "string" ? expectedOutput.description.trim() : "";
    if (!title || !description || !expectedDescription) continue;
    const expectedType =
      expectedOutput.type === "deliverable" ||
      expectedOutput.type === "decision" ||
      expectedOutput.type === "action" ||
      expectedOutput.type === "confirmation"
        ? expectedOutput.type
        : "information";
    const expectedFormat =
      expectedOutput.format === "json" ||
      expectedOutput.format === "markdown" ||
      expectedOutput.format === "table" ||
      expectedOutput.format === "code" ||
      expectedOutput.format === "other"
        ? expectedOutput.format
        : "text";
    const presentation = normalizeEnumValue(
      expectedOutput.presentation,
      allowedPresentations,
      inferPresentation({ ...expectedOutput, type: expectedType, format: expectedFormat }),
    );
    tasks.push({
      id:
        typeof task.id === "string" && task.id.trim()
          ? task.id.trim()
          : `task-${index + 1}`,
      title,
      description,
      execution_cycle: task.execution_cycle === "recurring" ? "recurring" : "once",
      execution_mode:
        task.execution_mode === "interactive" ||
        task.execution_mode === "monitoring" ||
        task.execution_mode === "event_triggered"
          ? task.execution_mode
          : "standard",
      execution_kind:
        typeof task.execution_kind === "string" ? task.execution_kind.trim() : undefined,
      recurrence: typeof task.recurrence === "string" ? task.recurrence.trim() : undefined,
      trigger_condition:
        typeof task.trigger_condition === "string" ? task.trigger_condition.trim() : undefined,
      hierarchy_level:
        task.hierarchy_level === "sub_task" || task.hierarchy_level === "action"
          ? task.hierarchy_level
          : "task",
      parent_id: typeof task.parent_id === "string" ? task.parent_id.trim() : undefined,
      priority: normalizePriority(task.priority),
      dependencies: extractStringArray(task.dependencies),
      expected_output: {
        type: expectedType,
        description: expectedDescription,
        format: expectedFormat,
        presentation,
        primary_format: normalizeEnumValue(
          expectedOutput.primary_format,
          allowedPrimaryFormats,
          inferPrimaryFormat({ ...expectedOutput, format: expectedFormat }),
        ),
        exportable_formats: normalizeEnumArrayValue(
          expectedOutput.exportable_formats,
          allowedExportFormats,
          expectedType === "information" ? ["html", "markdown"] : ["markdown"],
        ),
        required_blocks: normalizeEnumArrayValue(
          expectedOutput.required_blocks,
          allowedRequiredBlocks,
          inferRequiredBlocks(presentation),
        ),
        completion_criteria:
          typeof expectedOutput.completion_criteria === "string"
            ? expectedOutput.completion_criteria.trim()
            : undefined,
      },
      collaboration: normalizeTaskCollaborationPayload(task),
      estimated_duration_minutes:
        typeof task.estimated_duration_minutes === "number"
          ? task.estimated_duration_minutes
          : undefined,
    });
  }

  if (tasks.length === 0) {
    throw new Error("任务生成结果为空");
  }

  return {
    sub_goal_analysis: isObject(value.sub_goal_analysis)
      ? {
          core_deliverable:
            typeof value.sub_goal_analysis.core_deliverable === "string"
              ? value.sub_goal_analysis.core_deliverable.trim()
              : undefined,
          work_categories: extractStringArray(value.sub_goal_analysis.work_categories),
          completion_checklist: extractStringArray(value.sub_goal_analysis.completion_checklist),
        }
      : undefined,
    tasks,
    execution_plan: isObject(value.execution_plan)
      ? {
          suggested_order: extractStringArray(value.execution_plan.suggested_order),
          critical_path: extractStringArray(value.execution_plan.critical_path),
          total_estimated_hours:
            typeof value.execution_plan.total_estimated_hours === "number"
              ? value.execution_plan.total_estimated_hours
              : undefined,
        }
      : undefined,
    coverage_validation: isObject(value.coverage_validation)
      ? {
          is_sufficient:
            typeof value.coverage_validation.is_sufficient === "boolean"
              ? value.coverage_validation.is_sufficient
              : undefined,
          explanation:
            typeof value.coverage_validation.explanation === "string"
              ? value.coverage_validation.explanation.trim()
              : undefined,
          uncovered_risks: extractStringArray(value.coverage_validation.uncovered_risks),
        }
      : undefined,
  };
}

function validateTaskReview(value: unknown): TaskReviewPayload {
  if (!isObject(value) || !Array.isArray(value.reviewResults)) {
    throw new Error("任务 review 结果缺少 reviewResults");
  }
  return {
    reviewResults: value.reviewResults
      .filter(isObject)
      .map((result) => ({
        taskId: typeof result.taskId === "string" ? result.taskId.trim() : "",
        goalContribution: normalizePriority(result.goalContribution),
        subGoalContribution: normalizePriority(result.subGoalContribution),
        aligned: Boolean(result.aligned),
        reasoning: typeof result.reasoning === "string" ? result.reasoning.trim() : "",
        suggestions: Array.isArray(result.suggestions)
          ? result.suggestions.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
          : undefined,
      }))
      .filter((result) => result.taskId),
  };
}

function validatePlanPresentation(value: unknown): PlanPresentationPayload {
  if (!isObject(value)) {
    throw new Error("计划摘要结果不是 JSON 对象");
  }
  return {
    goalTitle:
      typeof value.goalTitle === "string" && value.goalTitle.trim()
        ? value.goalTitle.trim()
        : "新的长期目标",
    summary:
      typeof value.summary === "string" && value.summary.trim()
        ? value.summary.trim()
        : "已完成目标拆解并生成执行任务。",
    deadline:
      typeof value.deadline === "string" && value.deadline.trim()
        ? normalizeDeadline(value.deadline.trim())
        : undefined,
    notificationStrategy:
      typeof value.notificationStrategy === "string" && value.notificationStrategy.trim()
        ? value.notificationStrategy.trim()
        : "按任务优先级推进，并在关键节点提醒用户确认与复盘。",
  };
}

function normalizePriority(value: unknown): "critical" | "high" | "medium" | "low" {
  if (value === "critical" || value === "high" || value === "medium") return value;
  return "low";
}

function normalizeDeadline(value: string) {
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const dateMatch = value.match(/\d{4}-\d{2}-\d{2}/);
  if (dateMatch) return `${dateMatch[0]}T23:59:59+08:00`;
  return DEFAULT_DEADLINE;
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEnumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function normalizeEnumArrayValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T[]): T[] {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .filter((item): item is T => typeof item === "string" && allowed.includes(item as T));
  return items.length ? Array.from(new Set(items)) : fallback;
}

function inferPresentation(expectedOutput: Record<string, unknown>): NonNullable<TaskExpectedResult["presentation"]> {
  if (expectedOutput.format === "table") return "comparison_table";
  if (expectedOutput.type === "information") return "visual_report";
  if (expectedOutput.type === "decision" || expectedOutput.type === "confirmation") return "summary_card";
  if (expectedOutput.type === "action") return "checklist";
  return "document";
}

function inferPrimaryFormat(expectedOutput: Record<string, unknown>): NonNullable<TaskExpectedResult["primaryFormat"]> {
  if (expectedOutput.format === "json") return "json";
  if (expectedOutput.format === "code") return "code";
  return "structured_blocks";
}

function inferRequiredBlocks(presentation: NonNullable<TaskExpectedResult["presentation"]>): NonNullable<TaskExpectedResult["requiredBlocks"]> {
  if (presentation === "visual_report") return ["heading", "callout", "comparison_table", "key_value"];
  if (presentation === "comparison_table") return ["heading", "comparison_table", "callout"];
  if (presentation === "checklist") return ["heading", "list", "callout"];
  if (presentation === "timeline") return ["heading", "list", "key_value"];
  if (presentation === "summary_card") return ["callout", "key_value"];
  return ["heading", "paragraph"];
}

function inferUserInteractionType(task: Pick<TaskGenerationPayload["tasks"][number], "execution_mode" | "expected_output" | "execution_kind">) {
  const kind = task.execution_kind;
  if (kind === "flashcard" || kind === "listening_qa" || kind === "freeform_chat") return "answer";
  if (kind === "confirm_action" || kind === "draft_review") return "confirm";
  if (task.expected_output.type === "decision" || task.expected_output.type === "confirmation") return "confirm";
  if (task.expected_output.type === "action" && task.execution_mode === "interactive") return "perform_offline_action";
  if (task.execution_mode === "interactive") return "confirm";
  return "none";
}

function inferCollaborationMode(
  interactionType: NonNullable<TaskGenerationPayload["tasks"][number]["collaboration"]>["user_interaction_type"],
) {
  if (interactionType === "answer" || interactionType === "provide_context") return "agent_user_collaborative";
  if (interactionType === "perform_offline_action") return "user_primary_agent_assistive";
  if (interactionType === "confirm") return "agent_with_user_confirmation";
  return "agent_autonomous";
}

function normalizeTaskCollaborationPayload(
  task: Record<string, unknown> & {
    execution_mode?: unknown;
    execution_kind?: unknown;
    expected_output?: unknown;
  },
): TaskGenerationPayload["tasks"][number]["collaboration"] {
  const expectedOutput = isObject(task.expected_output) ? task.expected_output : {};
  const normalizedExpectedOutputType: TaskGenerationPayload["tasks"][number]["expected_output"]["type"] =
    expectedOutput.type === "deliverable" ||
    expectedOutput.type === "decision" ||
    expectedOutput.type === "action" ||
    expectedOutput.type === "confirmation"
      ? expectedOutput.type
      : "information";
  const normalizedExecutionMode: TaskGenerationPayload["tasks"][number]["execution_mode"] =
    task.execution_mode === "interactive" ||
    task.execution_mode === "monitoring" ||
    task.execution_mode === "event_triggered"
      ? task.execution_mode
      : "standard";
  const normalizedTask = {
    execution_mode: normalizedExecutionMode,
    execution_kind: typeof task.execution_kind === "string" ? task.execution_kind.trim() : undefined,
    expected_output: {
      type: normalizedExpectedOutputType,
      description: typeof expectedOutput.description === "string" ? expectedOutput.description.trim() : "任务交付物",
      format: "text" as const,
    },
  };
  const raw = isObject(task.collaboration) ? task.collaboration : {};
  const inferredInteractionType = inferUserInteractionType(normalizedTask);
  const userInteractionType =
    raw.user_interaction_type === "confirm" ||
    raw.user_interaction_type === "answer" ||
    raw.user_interaction_type === "provide_context" ||
    raw.user_interaction_type === "perform_offline_action"
      ? raw.user_interaction_type
      : inferredInteractionType;
  const mode =
    raw.mode === "agent_with_user_confirmation" ||
    raw.mode === "agent_user_collaborative" ||
    raw.mode === "user_primary_agent_assistive" ||
    raw.mode === "agent_autonomous"
      ? raw.mode
      : inferCollaborationMode(userInteractionType);
  const userInteractionTiming =
    raw.user_interaction_timing === "before_execution" ||
    raw.user_interaction_timing === "during_execution" ||
    raw.user_interaction_timing === "after_agent_output" ||
    raw.user_interaction_timing === "core_task_step"
      ? raw.user_interaction_timing
      : userInteractionType === "none"
        ? "not_required"
        : userInteractionType === "answer" || userInteractionType === "perform_offline_action"
          ? "core_task_step"
          : "after_agent_output";
  const completionOwner =
    raw.completion_owner === "user" || raw.completion_owner === "shared" || raw.completion_owner === "agent"
      ? raw.completion_owner
      : mode === "agent_user_collaborative"
        ? "shared"
        : mode === "user_primary_agent_assistive"
          ? "user"
          : "agent";
  const defaultActionLabel =
    userInteractionType === "answer"
      ? "开始作答"
      : userInteractionType === "confirm"
        ? "确认或提出修改建议"
        : userInteractionType === "provide_context"
          ? "补充信息"
          : userInteractionType === "perform_offline_action"
            ? "记录完成情况"
            : "查看结果";

  return {
    mode,
    agent_responsibilities: extractStringArray(raw.agent_responsibilities),
    user_responsibilities: extractStringArray(raw.user_responsibilities),
    user_interaction_type: userInteractionType,
    user_interaction_timing: userInteractionTiming,
    user_facing_action_label:
      typeof raw.user_facing_action_label === "string" && raw.user_facing_action_label.trim()
        ? raw.user_facing_action_label.trim()
        : defaultActionLabel,
    should_notify_user:
      typeof raw.should_notify_user === "boolean" ? raw.should_notify_user : userInteractionType !== "none",
    completion_owner: completionOwner,
    completion_definition:
      typeof raw.completion_definition === "string" && raw.completion_definition.trim()
        ? raw.completion_definition.trim()
        : `完成「${normalizedTask.expected_output.description}」`,
  };
}

function inferExecutionKind(task: TaskGenerationPayload["tasks"][number]): DraftTask["executionKind"] {
  if (task.execution_kind && allowedExecutionKinds.includes(task.execution_kind as DraftTask["executionKind"])) {
    return task.execution_kind as DraftTask["executionKind"];
  }
  if (task.execution_mode === "monitoring") return "reading_digest";
  if (task.execution_mode === "interactive") {
    return task.expected_output.type === "deliverable" ? "draft_review" : "confirm_action";
  }
  if (task.expected_output.type === "deliverable" && task.expected_output.format === "markdown") {
    return "draft_review";
  }
  if (task.expected_output.type === "decision" || task.expected_output.type === "confirmation") {
    return "confirm_action";
  }
  return "generic_result";
}

function toDraftCollaboration(task: TaskGenerationPayload["tasks"][number]): NonNullable<DraftTask["collaboration"]> {
  const collaboration = (task.collaboration ??
    normalizeTaskCollaborationPayload(task)) as NonNullable<TaskGenerationPayload["tasks"][number]["collaboration"]>;
  return {
    mode: collaboration.mode ?? "agent_autonomous",
    agentResponsibilities: collaboration.agent_responsibilities ?? [],
    userResponsibilities: collaboration.user_responsibilities ?? [],
    userInteractionType: collaboration.user_interaction_type ?? "none",
    userInteractionTiming: collaboration.user_interaction_timing ?? "not_required",
    userFacingActionLabel: collaboration.user_facing_action_label ?? "查看结果",
    shouldNotifyUser: collaboration.should_notify_user ?? false,
    completionOwner: collaboration.completion_owner ?? "agent",
    completionDefinition: collaboration.completion_definition ?? `完成「${task.expected_output.description}」`,
  };
}

function inferDraftCollaboration(task: DraftTask): NonNullable<DraftTask["collaboration"]> {
  const userInteractionType =
    task.resultViewKind === "flashcard" || task.resultViewKind === "listening_qa" || task.resultViewKind === "freeform_chat"
      ? "answer"
      : task.resultViewKind === "confirm_action" ||
          task.resultViewKind === "draft_review" ||
          task.expectedResult?.type === "decision" ||
          task.expectedResult?.type === "confirmation"
        ? "confirm"
        : "none";
  const mode =
    userInteractionType === "answer"
      ? "agent_user_collaborative"
      : userInteractionType === "confirm"
        ? "agent_with_user_confirmation"
        : "agent_autonomous";
  return {
    mode,
    agentResponsibilities: [task.description],
    userResponsibilities:
      userInteractionType === "answer"
        ? ["完成作答或互动"]
        : userInteractionType === "confirm"
          ? ["确认结果或提出修改建议"]
          : [],
    userInteractionType,
    userInteractionTiming:
      userInteractionType === "answer" ? "core_task_step" : userInteractionType === "confirm" ? "after_agent_output" : "not_required",
    userFacingActionLabel:
      userInteractionType === "answer" ? "开始作答" : userInteractionType === "confirm" ? "确认或提出修改建议" : "查看结果",
    shouldNotifyUser: userInteractionType !== "none",
    completionOwner: userInteractionType === "answer" ? "shared" : "agent",
    completionDefinition: task.expectedResult?.completionCriteria || task.expectedOutcome,
  };
}

function inferTaskType(task: TaskGenerationPayload["tasks"][number]): DraftTask["taskType"] {
  if (task.execution_mode === "monitoring") return "monitoring";
  if (task.execution_cycle === "recurring") return "daily_repeat";
  return "one_shot";
}

function inferTriggerRule(task: TaskGenerationPayload["tasks"][number]) {
  if (task.execution_mode === "event_triggered") {
    return task.trigger_condition || "满足触发条件时执行";
  }
  if (task.execution_mode === "monitoring") {
    return task.recurrence || "每天固定时间巡检";
  }
  if (task.execution_cycle === "recurring") {
    return task.recurrence || "每周固定节奏执行";
  }
  return task.trigger_condition || "准备好后执行一次";
}

function dedupeStrings(items: Array<string | undefined>) {
  return Array.from(new Set(items.map((item) => item?.trim()).filter(Boolean) as string[]));
}

function buildFallbackCollectedInfoSummary(goalText: string, collectedInfo?: string): CollectedInfoSummaryPayload {
  return {
    goalDetails: goalText,
    timeline: "",
    resources: "",
    constraints: "",
    challenges: "",
    preferences: "",
    summary: collectedInfo?.trim() || goalText,
  };
}

async function summarizeCollectedInfoWithClaude(input: {
  goalText: string;
  collectedInfo: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  conversationContext?: string;
  signal?: AbortSignal;
  requestId?: string;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildCollectedInfoSummaryPrompt(input.goalText, input.collectedInfo, input.conversationContext),
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "目标信息整理已中断",
    failureMessage: "Claude CLI 信息摘要生成失败",
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "collecting_info",
      stepLabel: "整理背景信息",
    },
  });
  try {
    return await parseClaudeJson({
      raw: stdout,
      validator: validateCollectedInfoSummary,
      errorMessage: "Claude 信息摘要 JSON 解析失败",
      runtimeEnv: input.runtimeEnv,
      conversationId: input.conversationId,
      signal: input.signal,
      context: {
        requestId: input.requestId,
        scope: "goal_plan",
        phase: "collecting_info",
        stepLabel: "整理背景信息",
      },
    });
  } catch (error) {
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_plan",
      level: "warn",
      phase: "collecting_info",
      message: "信息摘要解析失败，已使用原始回答兜底",
      details: error instanceof Error ? error.message : "未知解析错误",
    });
    return buildFallbackCollectedInfoSummary(input.goalText, input.collectedInfo);
  }
}

async function decomposeGoalWithClaude(input: {
  goalTitle: string;
  goalDescription: string;
  userContext: Record<string, unknown>;
  config: EasterEggSettings;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  requestId?: string;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildDecomposePrompt(input),
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "子目标拆解已中断",
    failureMessage: "Claude CLI 子目标拆解失败",
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "decomposing",
      stepLabel: "拆解子目标",
    },
  });
  return parseClaudeJson({
    raw: stdout,
    validator: validateDecomposition,
    errorMessage: "Claude 子目标拆解 JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    conversationId: input.conversationId,
    signal: input.signal,
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "decomposing",
      stepLabel: "拆解子目标",
    },
  });
}

async function generateTasksForSubGoalWithClaude(input: {
  goalTitle: string;
  goalDescription: string;
  userContext: Record<string, unknown>;
  subGoalName: string;
  subGoalDescription: string;
  successCriteria: string[];
  config: EasterEggSettings;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  requestId?: string;
  subGoalIndex?: number;
  totalSubGoals?: number;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildTaskGenerationPrompt(input),
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "任务生成已中断",
    failureMessage: "Claude CLI 任务生成失败",
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "generating_tasks",
      stepLabel: `为子目标 ${input.subGoalIndex ?? "?"}/${input.totalSubGoals ?? "?"} 生成任务：${input.subGoalName}`,
    },
  });
  return parseClaudeJson({
    raw: stdout,
    validator: validateTaskGeneration,
    errorMessage: "Claude 任务生成 JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    conversationId: input.conversationId,
    signal: input.signal,
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "generating_tasks",
      stepLabel: `为子目标 ${input.subGoalIndex ?? "?"}/${input.totalSubGoals ?? "?"} 生成任务：${input.subGoalName}`,
    },
  });
}

async function reviewTasksWithClaude(input: {
  goalTitle: string;
  subGoalTitle: string;
  goalDescription: string;
  tasksJson: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  requestId?: string;
  subGoalIndex?: number;
  totalSubGoals?: number;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildTaskReviewPrompt(input),
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "任务 review 已中断",
    failureMessage: "Claude CLI 任务 review 失败",
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "reviewing_tasks",
      stepLabel: `Review 子目标 ${input.subGoalIndex ?? "?"}/${input.totalSubGoals ?? "?"}：${input.subGoalTitle}`,
    },
  });
  return parseClaudeJson({
    raw: stdout,
    validator: validateTaskReview,
    errorMessage: "Claude 任务 review JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    conversationId: input.conversationId,
    signal: input.signal,
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "reviewing_tasks",
      stepLabel: `Review 子目标 ${input.subGoalIndex ?? "?"}/${input.totalSubGoals ?? "?"}：${input.subGoalTitle}`,
    },
  });
}

async function buildPlanPresentationWithClaude(input: {
  goalText: string;
  collectedInfoSummary: CollectedInfoSummaryPayload;
  decomposition: DecompositionPayload;
  taskPlanningSummary: Array<{
    subGoalName: string;
    taskCount: number;
    uncoveredRisks?: string[];
  }>;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  requestId?: string;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildPlanPresentationPrompt(input),
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "计划摘要生成已中断",
    failureMessage: "Claude CLI 计划摘要生成失败",
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "reviewing_tasks",
      stepLabel: "生成前端展示摘要",
    },
  });
  return parseClaudeJson({
    raw: stdout,
    validator: validatePlanPresentation,
    errorMessage: "Claude 计划摘要 JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    conversationId: input.conversationId,
    signal: input.signal,
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "reviewing_tasks",
      stepLabel: "生成前端展示摘要",
    },
  });
}

function applyTaskReview(
  tasks: TaskGenerationPayload["tasks"],
  review: TaskReviewPayload,
): DraftTask[] {
  const reviewMap = new Map(review.reviewResults.map((item) => [item.taskId, item]));
  const normalized = tasks
    .map((task, index) => {
      const reviewItem = reviewMap.get(task.id);
      if (reviewItem && !reviewItem.aligned && reviewItem.goalContribution === "low") {
        return null;
      }
      const effectivePriority = reviewItem?.subGoalContribution ?? task.priority;
      const collaboration = toDraftCollaboration(task);
      const normalizedTask: DraftTask = {
        id: `draft-task-${index + 1}`,
        title: task.title,
        description: task.description,
        expectedOutcome: task.expected_output.description,
        taskType: inferTaskType(task),
        triggerRule: inferTriggerRule(task),
        executionKind: inferExecutionKind(task),
        resultViewKind: inferExecutionKind(task),
        executionStrategy:
          collaboration.mode === "agent_user_collaborative"
            ? "hybrid"
            : collaboration.mode === "user_primary_agent_assistive"
              ? "user_interactive"
              : "agent_autonomous",
        priority: effectivePriority,
        dependencies: task.dependencies,
        executionMode: task.execution_mode,
        executionCycle: task.execution_cycle,
        expectedResult: {
          type: task.expected_output.type,
          description: task.expected_output.description,
          format: task.expected_output.format,
          presentation: task.expected_output.presentation,
          primaryFormat: task.expected_output.primary_format,
          exportableFormats: task.expected_output.exportable_formats,
          requiredBlocks: task.expected_output.required_blocks,
          completionCriteria: task.expected_output.completion_criteria,
        },
        executionObjective: task.description,
        recommendedWorkingDirectory: undefined,
        autoRunDisabled: false,
        requiresConfirmation:
          collaboration.userInteractionType === "confirm" ||
          task.expected_output.type === "decision" ||
          task.expected_output.type === "confirmation",
        collaboration,
      };
      return normalizedTask;
    })
    .filter((task): task is DraftTask => Boolean(task));

  if (normalized.length > 0) return normalized;

  const firstTask = tasks[0];
  const firstCollaboration = toDraftCollaboration(firstTask);
  return [
    {
      id: "draft-task-1",
      title: firstTask.title,
      description: firstTask.description,
      expectedOutcome: firstTask.expected_output.description,
      taskType: inferTaskType(firstTask),
      triggerRule: inferTriggerRule(firstTask),
      executionKind: inferExecutionKind(firstTask),
      resultViewKind: inferExecutionKind(firstTask),
      executionStrategy:
        firstCollaboration.mode === "agent_user_collaborative"
          ? "hybrid"
          : firstCollaboration.mode === "user_primary_agent_assistive"
            ? "user_interactive"
            : "agent_autonomous",
      priority: firstTask.priority,
      dependencies: firstTask.dependencies,
      executionMode: firstTask.execution_mode,
      executionCycle: firstTask.execution_cycle,
      expectedResult: {
        type: firstTask.expected_output.type,
        description: firstTask.expected_output.description,
        format: firstTask.expected_output.format,
        presentation: firstTask.expected_output.presentation,
        primaryFormat: firstTask.expected_output.primary_format,
        exportableFormats: firstTask.expected_output.exportable_formats,
        requiredBlocks: firstTask.expected_output.required_blocks,
        completionCriteria: firstTask.expected_output.completion_criteria,
      },
      executionObjective: firstTask.description,
      recommendedWorkingDirectory: undefined,
      autoRunDisabled: false,
      requiresConfirmation:
        firstCollaboration.userInteractionType === "confirm" ||
        firstTask.expected_output.type === "decision" ||
        firstTask.expected_output.type === "confirmation",
      collaboration: firstCollaboration,
    },
  ];
}

function validateGoalDraft(value: GoalBreakdownDraft): GoalBreakdownDraft {
  if (!value.goalTitle || typeof value.goalTitle !== "string") {
    throw new Error("规划缺少 goalTitle");
  }
  if (!Array.isArray(value.subGoals) || value.subGoals.length === 0) {
    throw new Error("规划缺少 subGoals");
  }
  for (const subGoal of value.subGoals) {
    if (!subGoal.title || !Array.isArray(subGoal.tasks) || subGoal.tasks.length === 0) {
      throw new Error("规划中的子目标缺少 title 或 tasks");
    }
    for (const task of subGoal.tasks) {
      if (!task.title || !task.description || !task.expectedOutcome || !task.triggerRule) {
        throw new Error("规划中的任务字段不完整");
      }
      if (!allowedExecutionKinds.includes(task.executionKind as (typeof allowedExecutionKinds)[number])) {
        task.executionKind = "generic_result";
      }
      task.resultViewKind = task.resultViewKind ?? task.executionKind;
      task.executionStrategy = task.executionStrategy ?? "agent_autonomous";
      task.executionObjective = task.executionObjective ?? task.description;
      task.autoRunDisabled = task.autoRunDisabled ?? false;
      task.requiresConfirmation = task.requiresConfirmation ?? task.executionKind === "confirm_action";
      task.collaboration = task.collaboration ?? inferDraftCollaboration(task);
    }
  }
  return value;
}

export async function generateGoalPlanWithClaude(input: {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
  conversationId?: string;
  conversationContext?: string;
  collectedInfo?: string;
  signal?: AbortSignal;
  requestId?: string;
  onProgress?: GoalStageProgressHandler;
}): Promise<GoalBreakdownDraft> {
  const planStartedAt = Date.now();
  const config = normalizeEasterEggSettings(input.config ?? DEFAULT_EASTER_EGG_SETTINGS);
  input.onProgress?.({
    phase: "collecting_info",
    message: "正在整理背景信息...",
  });
  const collectedInfoStartedAt = Date.now();
  const collectedInfoSummary = input.collectedInfo?.trim()
    ? await summarizeCollectedInfoWithClaude({
        goalText: input.goalText,
        collectedInfo: input.collectedInfo,
        runtimeEnv: input.runtimeEnv,
        conversationId: input.conversationId,
        conversationContext: input.conversationContext,
        signal: input.signal,
        requestId: input.requestId,
      })
    : buildFallbackCollectedInfoSummary(input.goalText, input.collectedInfo);
  // #region debug-point goal-planning-latency-stage-collected-info
  appendGoalLog({
    requestId: input.requestId,
    scope: "goal_plan",
    level: "info",
    phase: "collecting_info",
    message: "阶段耗时：整理背景信息",
    details: formatTimingDetails({
      elapsedMs: Date.now() - collectedInfoStartedAt,
      usedClaude: Boolean(input.collectedInfo?.trim()),
    }),
  });
  // #endregion

  const userContext = {
    goalText: input.goalText,
    goalDetails: collectedInfoSummary.goalDetails,
    timeline: collectedInfoSummary.timeline,
    resources: collectedInfoSummary.resources,
    constraints: collectedInfoSummary.constraints,
    challenges: collectedInfoSummary.challenges,
    preferences: collectedInfoSummary.preferences,
    summary: collectedInfoSummary.summary,
  };

  input.onProgress?.({
    phase: "decomposing",
    message: "正在拆解子目标...",
  });
  const decompositionStartedAt = Date.now();
  const decomposition = await decomposeGoalWithClaude({
    goalTitle: input.goalText,
    goalDescription: collectedInfoSummary.goalDetails || collectedInfoSummary.summary || input.goalText,
    userContext,
    config,
    runtimeEnv: input.runtimeEnv,
    conversationId: input.conversationId,
    signal: input.signal,
    requestId: input.requestId,
  });
  // #region debug-point goal-planning-latency-stage-decompose
  appendGoalLog({
    requestId: input.requestId,
    scope: "goal_plan",
    level: "info",
    phase: "decomposing",
    message: "阶段耗时：拆解子目标",
    details: formatTimingDetails({
      elapsedMs: Date.now() - decompositionStartedAt,
      subGoalCount: decomposition.subGoals.length,
    }),
  });
  // #endregion

  const taskPlanningSummary: Array<{
    subGoalName: string;
    taskCount: number;
    uncoveredRisks?: string[];
  }> = [];

  const subGoals: GoalBreakdownDraft["subGoals"] = [];
  const reviewSummary: string[] = [];
  const reviewRisks: string[] = [];
  const totalSubGoals = decomposition.subGoals.length;

  for (let subGoalIndex = 0; subGoalIndex < decomposition.subGoals.length; subGoalIndex += 1) {
    const subGoal = decomposition.subGoals[subGoalIndex];
    const subGoalStartedAt = Date.now();
    input.onProgress?.({
      phase: "generating_tasks",
      message: `正在为子目标 ${subGoalIndex + 1}/${totalSubGoals} 生成任务：${subGoal.name}`,
    });
    const generatedTasks = await generateTasksForSubGoalWithClaude({
      goalTitle: input.goalText,
      goalDescription: collectedInfoSummary.goalDetails || collectedInfoSummary.summary || input.goalText,
      userContext,
      subGoalName: subGoal.name,
      subGoalDescription: subGoal.description,
      successCriteria: subGoal.successCriteria.map(
        (criterion: DecompositionPayload["subGoals"][number]["successCriteria"][number]) => criterion.description,
      ),
      config,
      runtimeEnv: input.runtimeEnv,
      conversationId: input.conversationId,
      signal: input.signal,
      requestId: input.requestId,
      subGoalIndex: subGoalIndex + 1,
      totalSubGoals,
    });

    input.onProgress?.({
      phase: "reviewing_tasks",
      message: `正在 review 子目标 ${subGoalIndex + 1}/${totalSubGoals}：${subGoal.name}`,
    });
    const review = await reviewTasksWithClaude({
      goalTitle: input.goalText,
      subGoalTitle: subGoal.name,
      goalDescription: collectedInfoSummary.goalDetails || collectedInfoSummary.summary || input.goalText,
      tasksJson: JSON.stringify(generatedTasks.tasks, null, 2),
      runtimeEnv: input.runtimeEnv,
      conversationId: input.conversationId,
      signal: input.signal,
      requestId: input.requestId,
      subGoalIndex: subGoalIndex + 1,
      totalSubGoals,
    });

    const tasks = applyTaskReview(generatedTasks.tasks, review);
    const uncoveredRisks = generatedTasks.coverage_validation?.uncovered_risks ?? [];
    const lowAlignmentCount = review.reviewResults.filter((item) => !item.aligned).length;

    if (generatedTasks.coverage_validation?.explanation) {
      reviewSummary.push(`${subGoal.name}：${generatedTasks.coverage_validation.explanation}`);
    }
    if (lowAlignmentCount > 0) {
      reviewSummary.push(`${subGoal.name}：已根据 review 调整 ${lowAlignmentCount} 个任务。`);
    }
    reviewRisks.push(...uncoveredRisks);

    taskPlanningSummary.push({
      subGoalName: subGoal.name,
      taskCount: tasks.length,
      uncoveredRisks,
    });

    subGoals.push({
      id: `draft-subgoal-${subGoal.id}`,
      title: subGoal.name,
      description: subGoal.description,
      why: subGoal.why,
      priority: subGoal.priority,
      weight: subGoal.weight,
      dependencies: subGoal.dependencies.map((dependency: number) => `draft-subgoal-${dependency}`),
      estimatedDurationMinutes: subGoal.estimatedDurationMinutes,
      successCriteria: subGoal.successCriteria.map(
        (criterion: DecompositionPayload["subGoals"][number]["successCriteria"][number]) => criterion.description,
      ),
      tasks,
    });

    // #region debug-point goal-planning-latency-stage-subgoal
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_plan",
      level: "info",
      phase: "reviewing_tasks",
      message: `阶段耗时：子目标 ${subGoalIndex + 1}/${totalSubGoals}`,
      details: formatTimingDetails({
        subGoalName: subGoal.name,
        elapsedMs: Date.now() - subGoalStartedAt,
        generatedTaskCount: generatedTasks.tasks.length,
        finalTaskCount: tasks.length,
        uncoveredRiskCount: uncoveredRisks.length,
      }),
    });
    // #endregion
  }

  input.onProgress?.({
    phase: "reviewing_tasks",
    message: "正在汇总规划结果...",
  });
  const presentationStartedAt = Date.now();
  const presentation = await buildPlanPresentationWithClaude({
    goalText: input.goalText,
    collectedInfoSummary,
    decomposition,
    taskPlanningSummary,
    runtimeEnv: input.runtimeEnv,
    conversationId: input.conversationId,
    signal: input.signal,
    requestId: input.requestId,
  });
  // #region debug-point goal-planning-latency-stage-presentation
  appendGoalLog({
    requestId: input.requestId,
    scope: "goal_plan",
    level: "info",
    phase: "reviewing_tasks",
    message: "阶段耗时：生成前端展示摘要",
    details: formatTimingDetails({
      elapsedMs: Date.now() - presentationStartedAt,
    }),
  });
  // #endregion

  // #region debug-point goal-planning-latency-stage-total
  appendGoalLog({
    requestId: input.requestId,
    scope: "goal_plan",
    level: "info",
    phase: "presenting_plan",
    message: "阶段耗时：目标规划总计",
    details: formatTimingDetails({
      elapsedMs: Date.now() - planStartedAt,
      subGoalCount: totalSubGoals,
    }),
  });
  // #endregion

  return validateGoalDraft({
    goalTitle: presentation.goalTitle,
    summary: presentation.summary,
    deadline: presentation.deadline || normalizeDeadline(collectedInfoSummary.timeline || ""),
    goalAnalysis: decomposition.goalAnalysis,
    collectedInfoSummary,
    assumptions: dedupeStrings(decomposition.goalAnalysis.assumptions ?? []),
    risks: dedupeStrings([...decomposition.risks, ...reviewRisks]),
    reasoning: decomposition.reasoning,
    executionOrder: decomposition.executionOrder,
    reviewSummary,
    notificationStrategy: presentation.notificationStrategy,
    subGoals,
  });
}

export async function generateGoalClarificationQuestionsWithClaude(input: {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
  conversationId?: string;
  conversationContext?: string;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<GoalClarificationQuestions> {
  const prompt = buildGoalClarificationPrompt(input.goalText, input.conversationContext);
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt,
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "目标信息收集已中断",
    failureMessage: "Claude CLI 澄清问题生成失败",
    context: {
      requestId: input.requestId,
      scope: "goal_collect",
      phase: "collecting_info",
      stepLabel: "生成澄清问题",
    },
  });

  try {
    return await parseClaudeJson({
      raw: stdout,
      validator: validateClarificationQuestions,
      errorMessage: "Claude 澄清问题 JSON 解析失败",
      runtimeEnv: input.runtimeEnv,
      conversationId: input.conversationId,
      signal: input.signal,
      context: {
        requestId: input.requestId,
        scope: "goal_collect",
        phase: "collecting_info",
        stepLabel: "解析澄清问题",
      },
    });
  } catch (error) {
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_collect",
      level: "warn",
      phase: "collecting_info",
      message: "澄清问题解析失败，已使用兜底问题继续",
      details: error instanceof Error ? error.message : "未知解析错误",
    });
    return {
      questions: [
        "这个目标最重要的成功标准是什么？",
        "你目前有哪些时间、预算、资源或偏好约束？",
        "有没有必须避开的风险或特别想优先体验的内容？",
      ],
    };
  }
}

function decideGoalInfoCollectionByRounds(input: {
  answeredRounds: number;
  minRounds: number;
  maxRounds: number;
}): "continue" | "complete" {
  if (input.answeredRounds >= input.maxRounds) {
    return "complete";
  }

  if (input.answeredRounds >= input.minRounds) {
    return "complete";
  }

  return "continue";
}

async function generateGoalFollowUpQuestionsWithClaude(input: {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  conversationContext?: string;
  history: GoalInfoCollectionHistoryItem[];
  answeredRounds: number;
  minRounds: number;
  maxRounds: number;
  signal?: AbortSignal;
  requestId?: string;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildGoalFollowUpQuestionsPrompt(input),
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "目标补充问题生成已中断",
    failureMessage: "Claude CLI 补充问题生成失败",
    context: {
      requestId: input.requestId,
      scope: "goal_collect",
      phase: "collecting_info",
      stepLabel: `生成第 ${input.answeredRounds + 1} 轮补充问题`,
    },
  });

  try {
    return await parseClaudeJson({
      raw: stdout,
      validator: validateClarificationQuestions,
      errorMessage: "Claude 补充问题 JSON 解析失败",
      runtimeEnv: input.runtimeEnv,
      conversationId: input.conversationId,
      signal: input.signal,
      context: {
        requestId: input.requestId,
        scope: "goal_collect",
        phase: "collecting_info",
        stepLabel: `解析第 ${input.answeredRounds + 1} 轮补充问题`,
      },
    });
  } catch (error) {
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_collect",
      level: "warn",
      phase: "collecting_info",
      message: "补充问题解析失败，已使用兜底问题继续",
      details: error instanceof Error ? error.message : "未知解析错误",
    });
    return {
      questions: [
        "基于你已经补充的信息，还有哪些关键约束、偏好或资源会影响目标规划？",
        "这个目标接下来最需要 KiKi 优先保障的结果是什么？",
      ],
    };
  }
}

export async function advanceGoalInfoCollectionWithClaude(input: {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
  conversationId?: string;
  conversationContext?: string;
  history: GoalInfoCollectionHistoryItem[];
  minRounds?: number;
  maxRounds?: number;
  signal?: AbortSignal;
  requestId?: string;
  onProgress?: GoalStageProgressHandler;
}): Promise<GoalInfoCollectionTurnDecision> {
  const answeredRounds = input.history.filter((item) => item.answer?.trim()).length;
  const config = normalizeEasterEggSettings(input.config ?? DEFAULT_EASTER_EGG_SETTINGS);
  const configuredMaxRounds = input.maxRounds ?? config.maxInfoCollectionRounds;
  const maxRounds = Math.max(1, configuredMaxRounds);
  const configuredMinRounds = input.minRounds ?? config.minInfoCollectionRounds;
  const minRounds = Math.min(Math.max(1, configuredMinRounds), maxRounds);

  if (answeredRounds === 0) {
    input.onProgress?.({
      phase: "collecting_info",
      message: "正在生成首轮澄清问题...",
    });
    const initial = await generateGoalClarificationQuestionsWithClaude({
      goalText: input.goalText,
      runtimeEnv: input.runtimeEnv,
      config,
      conversationId: input.conversationId,
      conversationContext: input.conversationContext,
      signal: input.signal,
      requestId: input.requestId,
    });
    return {
      status: "continue",
      assistantMessage: "为了把这个目标规划得更准，我先确认几个关键信息：",
      questions: initial.questions,
    };
  }

  input.onProgress?.({
    phase: "collecting_info",
    message: `正在按本地轮数规则判断第 ${answeredRounds} 轮信息收集状态...`,
  });
  const collectionDecision = decideGoalInfoCollectionByRounds({
    answeredRounds,
    minRounds,
    maxRounds,
  });
  appendGoalLog({
    requestId: input.requestId,
    scope: "goal_collect",
    level: "info",
    phase: "collecting_info",
    message: "信息收集轮数判断已使用本地规则完成",
    details: formatTimingDetails({
      answeredRounds,
      minRounds,
      maxRounds,
      status: collectionDecision,
    }),
  });

  if (collectionDecision === "complete") {
    const reachedMaxRounds = answeredRounds >= maxRounds;
    return {
      status: "complete",
      assistantMessage: reachedMaxRounds
        ? `已完成 ${answeredRounds} 轮信息收集，达到当前设置的最大轮数，我会基于现有信息开始生成目标规划。`
        : `已完成 ${answeredRounds} 轮信息收集，达到当前设置的最小轮数，我会基于现有信息开始生成目标规划。`,
    };
  }

  input.onProgress?.({
    phase: "collecting_info",
    message: `正在生成第 ${answeredRounds + 1} 轮补充问题...`,
  });
  const followUp = await generateGoalFollowUpQuestionsWithClaude({
    goalText: input.goalText,
    runtimeEnv: input.runtimeEnv,
    conversationId: input.conversationId,
    conversationContext: input.conversationContext,
    history: input.history,
    answeredRounds,
    minRounds,
    maxRounds,
    signal: input.signal,
    requestId: input.requestId,
  });
  return {
    status: "continue",
    assistantMessage: `还需要再补充一轮关键信息，完成至少 ${minRounds} 轮收集后再进入规划。`,
    questions: followUp.questions,
  };
}
