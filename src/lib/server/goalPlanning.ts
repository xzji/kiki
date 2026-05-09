import { spawn } from "child_process";

import type { EasterEggSettings } from "@/lib/goalSystemConfig";
import { DEFAULT_EASTER_EGG_SETTINGS, normalizeEasterEggSettings } from "@/lib/goalSystemConfig";
import type { CollectedInfoSummary, GoalAnalysis, GoalBreakdownDraft } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

import { buildClaudeEnv } from "./claudeEnv";
import { normalizeWorkingDirectory, resolveCliPath } from "./runtimeEnvValidation";

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
      completion_criteria?: string;
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
] as const;

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

function buildGoalInfoCollectionDecisionPrompt(input: {
  goalText: string;
  conversationContext?: string;
  history: GoalInfoCollectionHistoryItem[];
  answeredRounds: number;
  minRounds: number;
  maxRounds: number;
}) {
  return `你是 KiKi 长程目标系统中的信息收集 orchestrator。你的职责是判断：现有信息是否已经足够进入目标规划；如果还不够，就继续追问 1-3 个高价值问题。

目标：
${input.goalText}

已进行轮数：${input.answeredRounds}
至少收集轮数：${input.minRounds}
最多收集轮数：${input.maxRounds}

历史问答：
${JSON.stringify(input.history, null, 2)}

${input.conversationContext ? `会话上下文：\n${input.conversationContext}\n` : ""}
判断原则：
1. 优先补齐成功标准、时间线、资源/投入、关键约束、主要风险、用户偏好。
2. 如果信息已经足够支撑可靠规划，返回 complete。
3. 如果还缺少关键背景，且未达到最大轮数，返回 continue，并只追问最关键的 1-3 个问题。
4. 如果已经达到最大轮数，即使信息仍有不确定，也应总结当前已知信息并返回 complete。
5. 问题必须自然、具体、方便用户一次性回答，避免重复追问。

只能输出严格 JSON，不要包含 Markdown、代码块或额外解释。

JSON schema：
{
  "status": "continue | complete",
  "assistantMessage": "给用户看的自然中文说明。continue 时说明为什么还需要补充；complete 时说明信息已经足够、将进入规划。",
  "questions": ["仅在 continue 时返回 1-3 个问题"],
  "summary": {
    "goalDetails": "更具体的目标描述",
    "timeline": "时间限制、截止时间、频率要求",
    "resources": "可投入时间、预算、工具、人力、基础条件",
    "constraints": "约束、限制、不能接受的条件",
    "challenges": "当前障碍、风险、薄弱点",
    "preferences": "用户偏好、优先级、风格要求",
    "summary": "2-3 句中文摘要"
  }
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
      "execution_kind": "freeform_chat",
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
        "completion_criteria": "完成判定标准"
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
  signal?: AbortSignal;
  abortMessage: string;
  failureMessage: string;
}) {
  const cwd = normalizeWorkingDirectory(input.runtimeEnv.workingDirectory);
  const cliPath = await resolveCliPath(input.runtimeEnv.cliPath);
  return new Promise<string>((resolve, reject) => {
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
      reject(error);
    });

    child.on("close", (code) => {
      input.signal?.removeEventListener("abort", abort);
      if (aborted) return;
      if (code !== 0) {
        reject(new Error(errorOutput.trim() || input.failureMessage));
        return;
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
    .trim();
}

async function repairMalformedJsonWithClaude(input: {
  runtimeEnv: RuntimeEnvironment;
  malformedJson: string;
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
  signal?: AbortSignal;
}) {
  const primary = stripJsonFences(extractTextFromPayload(input.raw));
  const candidates = [
    primary,
    extractBalancedJsonSnippet(primary),
    repairCommonJsonIssues(primary),
    repairCommonJsonIssues(extractBalancedJsonSnippet(primary)),
  ];

  let lastError: unknown = null;

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return input.validator(JSON.parse(candidate) as unknown);
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const repaired = await repairMalformedJsonWithClaude({
      runtimeEnv: input.runtimeEnv,
      malformedJson: primary,
      signal: input.signal,
    });
    return input.validator(JSON.parse(repairCommonJsonIssues(extractBalancedJsonSnippet(repaired))) as unknown);
  } catch (error) {
    lastError = error;
  }

  throw new Error(lastError instanceof Error ? lastError.message : input.errorMessage);
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

function validateGoalInfoCollectionDecision(value: unknown): GoalInfoCollectionTurnDecision {
  if (!isObject(value)) {
    throw new Error("Claude 返回的信息收集结果不是 JSON 对象");
  }
  const status = value.status === "complete" ? "complete" : "continue";
  const assistantMessage =
    typeof value.assistantMessage === "string" && value.assistantMessage.trim()
      ? value.assistantMessage.trim()
      : status === "complete"
        ? "收到，信息已经足够，我现在开始生成目标规划。"
        : "我还需要再确认几个关键点，才能把目标规划得更准。";
  const summary = isObject(value.summary) ? validateCollectedInfoSummary(value.summary) : undefined;
  const questions = Array.isArray(value.questions)
    ? value.questions
        .filter((question): question is string => typeof question === "string")
        .map((question) => question.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];

  if (status === "continue" && questions.length === 0) {
    throw new Error("信息收集结果要求继续追问，但缺少 questions");
  }

  return {
    status,
    assistantMessage,
    questions: status === "continue" ? questions : undefined,
    summary,
  };
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
        type:
          expectedOutput.type === "deliverable" ||
          expectedOutput.type === "decision" ||
          expectedOutput.type === "action" ||
          expectedOutput.type === "confirmation"
            ? expectedOutput.type
            : "information",
        description: expectedDescription,
        format:
          expectedOutput.format === "json" ||
          expectedOutput.format === "markdown" ||
          expectedOutput.format === "table" ||
          expectedOutput.format === "code" ||
          expectedOutput.format === "other"
            ? expectedOutput.format
            : "text",
        completion_criteria:
          typeof expectedOutput.completion_criteria === "string"
            ? expectedOutput.completion_criteria.trim()
            : undefined,
      },
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

function inferExecutionKind(task: TaskGenerationPayload["tasks"][number]): DraftTask["executionKind"] {
  if (task.execution_kind && allowedExecutionKinds.includes(task.execution_kind as DraftTask["executionKind"])) {
    return task.execution_kind as DraftTask["executionKind"];
  }
  if (task.execution_mode === "monitoring") return "reading_digest";
  if (task.execution_mode === "interactive") return "confirm_action";
  if (task.expected_output.type === "deliverable" && task.expected_output.format === "markdown") {
    return "draft_review";
  }
  if (task.expected_output.type === "decision" || task.expected_output.type === "confirmation") {
    return "confirm_action";
  }
  return "freeform_chat";
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
  conversationContext?: string;
  signal?: AbortSignal;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildCollectedInfoSummaryPrompt(input.goalText, input.collectedInfo, input.conversationContext),
    signal: input.signal,
    abortMessage: "目标信息整理已中断",
    failureMessage: "Claude CLI 信息摘要生成失败",
  });
  return parseClaudeJson({
    raw: stdout,
    validator: validateCollectedInfoSummary,
    errorMessage: "Claude 信息摘要 JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    signal: input.signal,
  });
}

async function decomposeGoalWithClaude(input: {
  goalTitle: string;
  goalDescription: string;
  userContext: Record<string, unknown>;
  config: EasterEggSettings;
  runtimeEnv: RuntimeEnvironment;
  signal?: AbortSignal;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildDecomposePrompt(input),
    signal: input.signal,
    abortMessage: "子目标拆解已中断",
    failureMessage: "Claude CLI 子目标拆解失败",
  });
  return parseClaudeJson({
    raw: stdout,
    validator: validateDecomposition,
    errorMessage: "Claude 子目标拆解 JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    signal: input.signal,
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
  signal?: AbortSignal;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildTaskGenerationPrompt(input),
    signal: input.signal,
    abortMessage: "任务生成已中断",
    failureMessage: "Claude CLI 任务生成失败",
  });
  return parseClaudeJson({
    raw: stdout,
    validator: validateTaskGeneration,
    errorMessage: "Claude 任务生成 JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    signal: input.signal,
  });
}

async function reviewTasksWithClaude(input: {
  goalTitle: string;
  subGoalTitle: string;
  goalDescription: string;
  tasksJson: string;
  runtimeEnv: RuntimeEnvironment;
  signal?: AbortSignal;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildTaskReviewPrompt(input),
    signal: input.signal,
    abortMessage: "任务 review 已中断",
    failureMessage: "Claude CLI 任务 review 失败",
  });
  return parseClaudeJson({
    raw: stdout,
    validator: validateTaskReview,
    errorMessage: "Claude 任务 review JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    signal: input.signal,
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
  signal?: AbortSignal;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildPlanPresentationPrompt(input),
    signal: input.signal,
    abortMessage: "计划摘要生成已中断",
    failureMessage: "Claude CLI 计划摘要生成失败",
  });
  return parseClaudeJson({
    raw: stdout,
    validator: validatePlanPresentation,
    errorMessage: "Claude 计划摘要 JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    signal: input.signal,
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
      const normalizedTask: DraftTask = {
        id: `draft-task-${index + 1}`,
        title: task.title,
        description: task.description,
        expectedOutcome: task.expected_output.description,
        taskType: inferTaskType(task),
        triggerRule: inferTriggerRule(task),
        executionKind: inferExecutionKind(task),
        priority: effectivePriority,
        dependencies: task.dependencies,
        executionMode: task.execution_mode,
        executionCycle: task.execution_cycle,
        expectedResult: {
          type: task.expected_output.type,
          description: task.expected_output.description,
          format: task.expected_output.format,
          completionCriteria: task.expected_output.completion_criteria,
        },
      };
      return normalizedTask;
    })
    .filter((task): task is DraftTask => Boolean(task));

  if (normalized.length > 0) return normalized;

  const firstTask = tasks[0];
  return [
    {
      id: "draft-task-1",
      title: firstTask.title,
      description: firstTask.description,
      expectedOutcome: firstTask.expected_output.description,
      taskType: inferTaskType(firstTask),
      triggerRule: inferTriggerRule(firstTask),
      executionKind: inferExecutionKind(firstTask),
      priority: firstTask.priority,
      dependencies: firstTask.dependencies,
      executionMode: firstTask.execution_mode,
      executionCycle: firstTask.execution_cycle,
      expectedResult: {
        type: firstTask.expected_output.type,
        description: firstTask.expected_output.description,
        format: firstTask.expected_output.format,
        completionCriteria: firstTask.expected_output.completion_criteria,
      },
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
        task.executionKind = "freeform_chat";
      }
    }
  }
  return value;
}

export async function generateGoalPlanWithClaude(input: {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
  conversationContext?: string;
  collectedInfo?: string;
  signal?: AbortSignal;
}): Promise<GoalBreakdownDraft> {
  const config = normalizeEasterEggSettings(input.config ?? DEFAULT_EASTER_EGG_SETTINGS);
  const collectedInfoSummary = input.collectedInfo?.trim()
    ? await summarizeCollectedInfoWithClaude({
        goalText: input.goalText,
        collectedInfo: input.collectedInfo,
        runtimeEnv: input.runtimeEnv,
        conversationContext: input.conversationContext,
        signal: input.signal,
      })
    : buildFallbackCollectedInfoSummary(input.goalText, input.collectedInfo);

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

  const decomposition = await decomposeGoalWithClaude({
    goalTitle: input.goalText,
    goalDescription: collectedInfoSummary.goalDetails || collectedInfoSummary.summary || input.goalText,
    userContext,
    config,
    runtimeEnv: input.runtimeEnv,
    signal: input.signal,
  });

  const taskPlanningSummary: Array<{
    subGoalName: string;
    taskCount: number;
    uncoveredRisks?: string[];
  }> = [];

  const subGoals: GoalBreakdownDraft["subGoals"] = [];
  const reviewSummary: string[] = [];
  const reviewRisks: string[] = [];

  for (const subGoal of decomposition.subGoals) {
    const generatedTasks = await generateTasksForSubGoalWithClaude({
      goalTitle: input.goalText,
      goalDescription: collectedInfoSummary.goalDetails || collectedInfoSummary.summary || input.goalText,
      userContext,
      subGoalName: subGoal.name,
      subGoalDescription: subGoal.description,
      successCriteria: subGoal.successCriteria.map((criterion) => criterion.description),
      config,
      runtimeEnv: input.runtimeEnv,
      signal: input.signal,
    });

    const review = await reviewTasksWithClaude({
      goalTitle: input.goalText,
      subGoalTitle: subGoal.name,
      goalDescription: collectedInfoSummary.goalDetails || collectedInfoSummary.summary || input.goalText,
      tasksJson: JSON.stringify(generatedTasks.tasks, null, 2),
      runtimeEnv: input.runtimeEnv,
      signal: input.signal,
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
      priority: subGoal.priority,
      dependencies: subGoal.dependencies.map((dependency) => `draft-subgoal-${dependency}`),
      successCriteria: subGoal.successCriteria.map((criterion) => criterion.description),
      tasks,
    });
  }

  const presentation = await buildPlanPresentationWithClaude({
    goalText: input.goalText,
    collectedInfoSummary,
    decomposition,
    taskPlanningSummary,
    runtimeEnv: input.runtimeEnv,
    signal: input.signal,
  });

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
  conversationContext?: string;
  signal?: AbortSignal;
}): Promise<GoalClarificationQuestions> {
  const prompt = buildGoalClarificationPrompt(input.goalText, input.conversationContext);
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt,
    signal: input.signal,
    abortMessage: "目标信息收集已中断",
    failureMessage: "Claude CLI 澄清问题生成失败",
  });

  return parseClaudeJson({
    raw: stdout,
    validator: validateClarificationQuestions,
    errorMessage: "Claude 澄清问题 JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    signal: input.signal,
  });
}

function buildCollectedInfoTranscript(history: GoalInfoCollectionHistoryItem[]) {
  return history
    .map((round, index) => {
      const questionLines = round.questions.map((question, questionIndex) => `${questionIndex + 1}. ${question}`);
      return [`第 ${index + 1} 轮澄清问题：`, ...questionLines, "", "用户回答：", round.answer?.trim() || ""] .join("\n");
    })
    .join("\n\n");
}

export async function advanceGoalInfoCollectionWithClaude(input: {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
  conversationContext?: string;
  history: GoalInfoCollectionHistoryItem[];
  minRounds?: number;
  maxRounds?: number;
  signal?: AbortSignal;
}): Promise<GoalInfoCollectionTurnDecision> {
  const answeredRounds = input.history.filter((item) => item.answer?.trim()).length;
  const config = normalizeEasterEggSettings(input.config ?? DEFAULT_EASTER_EGG_SETTINGS);
  const minRounds = input.minRounds ?? config.minInfoCollectionRounds;
  const maxRounds = input.maxRounds ?? config.maxInfoCollectionRounds;

  if (answeredRounds === 0) {
    const initial = await generateGoalClarificationQuestionsWithClaude({
      goalText: input.goalText,
      runtimeEnv: input.runtimeEnv,
      config,
      conversationContext: input.conversationContext,
      signal: input.signal,
    });
    return {
      status: "continue",
      assistantMessage: "为了把这个目标规划得更准，我先确认几个关键信息：",
      questions: initial.questions,
    };
  }

  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildGoalInfoCollectionDecisionPrompt({
      goalText: input.goalText,
      conversationContext: input.conversationContext,
      history: input.history,
      answeredRounds,
      minRounds,
      maxRounds,
    }),
    signal: input.signal,
    abortMessage: "目标信息收集已中断",
    failureMessage: "Claude CLI 信息收集判断失败",
  });

  const decision = await parseClaudeJson({
    raw: stdout,
    validator: validateGoalInfoCollectionDecision,
    errorMessage: "Claude 信息收集判断 JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    signal: input.signal,
  });

  if (decision.status === "complete" && !decision.summary) {
    const transcript = buildCollectedInfoTranscript(input.history);
    const summary = await summarizeCollectedInfoWithClaude({
      goalText: input.goalText,
      collectedInfo: transcript,
      runtimeEnv: input.runtimeEnv,
      conversationContext: input.conversationContext,
      signal: input.signal,
    });
    return {
      ...decision,
      summary,
    };
  }

  return decision;
}
