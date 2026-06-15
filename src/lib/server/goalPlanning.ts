import fs from "fs";

import type { EasterEggSettings } from "@/lib/goalSystemConfig";
import { DEFAULT_EASTER_EGG_SETTINGS, normalizeEasterEggSettings } from "@/lib/goalSystemConfig";
import { appendGoalLog } from "@/lib/server/goalTelemetry";
import {
  ensureConversationWorkspace,
  getPlanningCheckpointFilePath,
  writePlanningParseFailureSnapshot,
  writeJsonFileAtomic,
} from "@/lib/server/workspace/conversationWorkspace";
import {
  buildJsonParseCandidates,
  buildJsonRepairPrompt,
  normalizeClaudeJsonText,
  parseJsonWithCandidates,
  parseRepairedJsonText,
} from "@/lib/server/claude/jsonRepair";
import {
  recoverJsonArtifactsFromClaudeOutput,
  type RecoveredJsonArtifact,
} from "@/lib/server/claude/artifactRecovery";
import { runRuntimePromptJson, runRuntimePromptText } from "@/lib/server/runtime/runtimeTransport";
import { parseTaskDraftBatch } from "@/lib/server/goalPlanning/blockProtocol";
import { buildSingleTaskDraftRepairPrompt, buildTaskDraftPrompt } from "@/lib/server/goalPlanning/taskDraftPrompt";
import { readRelevantUserProfileMemoryForPrompt } from "@/lib/server/memory/userMemoryService";
import {
  TaskDraftBatchEmptyError,
  type TaskDraft,
  type TaskDraftBatch,
  type TaskDraftDropReason,
} from "@/lib/server/goalPlanning/taskDraftSchema";
import {
  applyDraftReview,
  buildDegradedReviewDecision,
  buildTaskDraftReviewDecisionPrompt,
  buildTaskDraftReviewPresentationPrompt,
  getReviewLowAlignmentCount,
  validateTaskReviewDecision,
  type DecompositionSubGoalContext,
  type TaskDraftReviewDecisionPayload,
} from "@/lib/server/goalPlanning/taskDraftReview";
import { compileTaskDraftsToDraftTasks } from "@/lib/server/goalPlanning/taskCompiler";
import { mergeCrossSubGoalTaskDependencies } from "@/lib/goalPlanning/taskCompiler";
import { normalizeExecutionKind, normalizeTaskResultViewKind } from "@/types/kiki";
import type { CollectedInfoSummary, GoalAnalysis, GoalBreakdownDraft, GoalDeliveryContract } from "@/types/kiki";
import { normalizeTriggerSpecWithWarnings, type TriggerSpec } from "@/types/trigger";
import type { GoalTelemetryScope } from "@/types/goalTelemetry";
import type { GoalWorkflowPhase } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

function withUserMemoryContext(userContext: Record<string, unknown>) {
  try {
    const userMemory = readRelevantUserProfileMemoryForPrompt(JSON.stringify(userContext)).content;
    if (!userMemory) return userContext;
    return {
      ...userContext,
      userMemory,
    };
  } catch {
    return userContext;
  }
}

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

type PlanPresentationPayload = {
  goalTitle: string;
  summary: string;
  deadline?: string;
  notificationStrategy: string;
};

export type DeliveryClosureAuditPayload = {
  verdict: "accept" | "needs_repair";
  missingEvidence: string[];
  insufficientThreads: Array<{
    subGoalId: number;
    reason: string;
  }>;
  repairInstruction?: string;
};

type DraftTask = GoalBreakdownDraft["subGoals"][number]["tasks"][number];
type DraftSubGoal = GoalBreakdownDraft["subGoals"][number];
type TaskPlanningSummaryItem = {
  subGoalName: string;
  taskCount: number;
  uncoveredRisks?: string[];
};

type GoalPlanningCheckpoint = {
  version: 2;
  goalText: string;
  status: "running" | "completed" | "failed" | "partial";
  stage: "collecting_info" | "decomposing" | "generating_tasks" | "reviewing_tasks" | "presenting_plan";
  requestId?: string;
  collectedInfo?: string;
  collectedInfoSummary?: CollectedInfoSummaryPayload;
  userContext?: Record<string, unknown>;
  decomposition?: DecompositionPayload;
  completedSubGoals: DraftSubGoal[];
  taskPlanningSummary: TaskPlanningSummaryItem[];
  reviewSummary: string[];
  reviewRisks: string[];
  nextSubGoalIndex: number;
  activeSubGoal?: {
    index: number;
    generatedDrafts?: TaskDraftBatch;
  };
  subGoalTaskGeneration?: Array<{
    subGoalId: number;
    subGoalName: string;
    status: "ok" | "task_generation_failed";
    taskCount?: number;
    failedTaskIndices?: number[];
    recoveredTaskCount?: number;
    droppedReasons?: TaskDraftDropReason[];
    lastError?: string;
    lastRawSnapshot?: string;
    updatedAt: string;
  }>;
  partialFailure?: {
    failedSubGoalIds: number[];
    recoverable: boolean;
    message: string;
  };
  presentation?: PlanPresentationPayload;
  draft?: GoalBreakdownDraft;
  interrupted?: boolean;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type GoalPlanningCheckpointStatus = {
  available: boolean;
  goalText?: string;
  status?: GoalPlanningCheckpoint["status"];
  stage?: GoalPlanningCheckpoint["stage"];
  completedSubGoalCount?: number;
  totalSubGoalCount?: number;
  nextSubGoalIndex?: number;
  updatedAt?: string;
  hasCollectedInfo?: boolean;
  failedTaskCount?: number;
  recoveredTaskCount?: number;
  schemaVersion?: number;
  discarded?: boolean;
};

const JSON_NO_TOOL_INSTRUCTION =
  "重要约束：禁止调用任何工具（Write/Edit/MultiEdit/Bash/WebSearch/WebFetch/Task 等），所有业务结果必须写在最终 JSON 回答里。";

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

class ClaudeJsonParseError extends Error {
  snapshotPath?: string;
  rootCause?: unknown;

  constructor(message: string, input: { snapshotPath?: string; rootCause?: unknown }) {
    super(message);
    this.name = "ClaudeJsonParseError";
    this.snapshotPath = input.snapshotPath;
    this.rootCause = input.rootCause;
  }
}

function getClaudeJsonParseSnapshotPath(error: unknown) {
  return error instanceof ClaudeJsonParseError ? error.snapshotPath : undefined;
}

function formatTimingDetails(input: Record<string, string | number | boolean | undefined>) {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function createEmptyCheckpoint(input: {
  goalText: string;
  collectedInfo?: string;
  requestId?: string;
}): GoalPlanningCheckpoint {
  const now = new Date().toISOString();
  return {
    version: 2,
    goalText: input.goalText,
    status: "running",
    stage: "collecting_info",
    requestId: input.requestId,
    collectedInfo: input.collectedInfo,
    completedSubGoals: [],
    taskPlanningSummary: [],
    reviewSummary: [],
    reviewRisks: [],
    nextSubGoalIndex: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function upsertSubGoalTaskGenerationStatus(
  checkpoint: GoalPlanningCheckpoint,
  entry: NonNullable<GoalPlanningCheckpoint["subGoalTaskGeneration"]>[number],
) {
  const existing = checkpoint.subGoalTaskGeneration ?? [];
  const next = existing.filter((item) => item.subGoalId !== entry.subGoalId);
  next.push(entry);
  next.sort((a, b) => a.subGoalId - b.subGoalId);
  return next;
}

function getFailedSubGoalIds(checkpoint: GoalPlanningCheckpoint) {
  return (checkpoint.subGoalTaskGeneration ?? [])
    .filter((item) => item.status === "task_generation_failed")
    .map((item) => item.subGoalId);
}

function getCheckpointPath(conversationId?: string) {
  if (!conversationId) return null;
  ensureConversationWorkspace(conversationId);
  return getPlanningCheckpointFilePath(conversationId);
}

function readGoalPlanningCheckpoint(conversationId?: string) {
  const filePath = getCheckpointPath(conversationId);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isObject(raw) || raw.version !== 2 || typeof raw.goalText !== "string") return null;
    if (!Array.isArray(raw.completedSubGoals)) return null;
    if (!Array.isArray(raw.taskPlanningSummary)) return null;
    if (!Array.isArray(raw.reviewSummary)) return null;
    if (!Array.isArray(raw.reviewRisks)) return null;
    return raw as GoalPlanningCheckpoint;
  } catch {
    return null;
  }
}

export function getGoalPlanningCheckpointStatus(conversationId?: string): GoalPlanningCheckpointStatus {
  const checkpoint = readGoalPlanningCheckpoint(conversationId);
  if (!checkpoint || checkpoint.status === "completed") {
    const filePath = getCheckpointPath(conversationId);
    if (filePath && fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        if (isObject(raw) && typeof raw.version === "number" && raw.version !== 2) {
          return { available: false, schemaVersion: raw.version, discarded: true };
        }
      } catch {
        // Invalid checkpoint is treated as unavailable.
      }
    }
    return { available: false };
  }
  const taskGeneration = checkpoint.subGoalTaskGeneration ?? [];
  return {
    available: true,
    goalText: checkpoint.goalText,
    status: checkpoint.status,
    stage: checkpoint.stage,
    completedSubGoalCount: checkpoint.completedSubGoals.length,
    totalSubGoalCount: checkpoint.decomposition?.subGoals.length ?? checkpoint.completedSubGoals.length,
    nextSubGoalIndex: checkpoint.nextSubGoalIndex,
    updatedAt: checkpoint.updatedAt,
    hasCollectedInfo: Boolean(checkpoint.collectedInfo?.trim()),
    failedTaskCount: taskGeneration.reduce((sum, item) => sum + (item.failedTaskIndices?.length ?? 0), 0),
    recoveredTaskCount: taskGeneration.reduce((sum, item) => sum + (item.recoveredTaskCount ?? 0), 0),
    schemaVersion: checkpoint.version,
  };
}

export function getGoalPlanningCheckpointForResume(conversationId?: string) {
  const checkpoint = readGoalPlanningCheckpoint(conversationId);
  if (!checkpoint || checkpoint.status === "completed") return null;
  return {
    goalText: checkpoint.goalText,
    collectedInfo: checkpoint.collectedInfo,
    status: checkpoint.status,
    stage: checkpoint.stage,
    completedSubGoalCount: checkpoint.completedSubGoals.length,
    totalSubGoalCount: checkpoint.decomposition?.subGoals.length ?? checkpoint.completedSubGoals.length,
    nextSubGoalIndex: checkpoint.nextSubGoalIndex,
    updatedAt: checkpoint.updatedAt,
  };
}

function writeGoalPlanningCheckpoint(conversationId: string | undefined, checkpoint: GoalPlanningCheckpoint) {
  const filePath = getCheckpointPath(conversationId);
  if (!filePath) return;
  writeJsonFileAtomic(filePath, {
    ...checkpoint,
    updatedAt: new Date().toISOString(),
  });
}

function clearGoalPlanningCheckpoint(conversationId?: string) {
  const filePath = getCheckpointPath(conversationId);
  if (!filePath || !fs.existsSync(filePath)) return;
  fs.rmSync(filePath, { force: true });
}

function isCheckpointCompatible(
  checkpoint: GoalPlanningCheckpoint | null,
  input: {
    goalText: string;
    collectedInfo?: string;
  },
): checkpoint is GoalPlanningCheckpoint {
  if (!checkpoint || checkpoint.status === "completed") return false;
  return checkpoint.goalText.trim() === input.goalText.trim() && (checkpoint.collectedInfo ?? "") === (input.collectedInfo ?? "");
}

function emitCheckpointResumeProgress(input: {
  checkpoint: GoalPlanningCheckpoint;
  onProgress?: GoalStageProgressHandler;
}) {
  const completedCount = input.checkpoint.completedSubGoals.length;
  const totalCount = input.checkpoint.decomposition?.subGoals.length;
  const suffix = totalCount ? `${completedCount}/${totalCount}` : String(completedCount);
  if (input.checkpoint.activeSubGoal?.generatedDrafts) {
    const subGoal = input.checkpoint.decomposition?.subGoals[input.checkpoint.activeSubGoal.index];
    input.onProgress?.({
      phase: "reviewing_tasks",
      message: `已读取 checkpoint，将继续 review 子目标 ${input.checkpoint.activeSubGoal.index + 1}/${totalCount ?? "?"}：${subGoal?.name ?? "未命名子目标"}`,
    });
    return;
  }
  input.onProgress?.({
    phase: input.checkpoint.decomposition ? "generating_tasks" : input.checkpoint.stage,
    message: `已读取 checkpoint，将从已完成子目标 ${suffix} 后继续规划。`,
  });
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
  const startedAt = Date.now();
  const effectivePrompt = `${JSON_NO_TOOL_INSTRUCTION}\n\n${input.prompt}`;
  const promptChars = effectivePrompt.length;
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

  try {
    const result = await runRuntimePromptJson({
      prompt: effectivePrompt,
      runtimeEnv: input.runtimeEnv,
      cwd,
      conversationId: input.conversationId,
      filePolicy: input.runtimeEnv.filePolicy,
      channelPolicy: { mode: "readonly_json" },
      abortSignal: input.signal,
      abortMessage: input.abortMessage,
      failureMessage: input.failureMessage,
      traceContext: input.context,
    });
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
          outputChars: result.raw.length,
        }),
      });
      // #endregion
    }
    return result.raw;
  } catch (error) {
    if (input.context) {
      // #region debug-point goal-planning-latency-claude-error
      appendGoalLog({
        requestId: input.context.requestId,
        scope: input.context.scope,
        level: error instanceof DOMException && error.name === "AbortError" ? "warn" : "error",
        phase: input.context.phase,
        message:
          error instanceof DOMException && error.name === "AbortError"
            ? `Claude 执行被中断：${input.context.stepLabel}`
            : `Claude 执行异常：${input.context.stepLabel}`,
        details: error instanceof Error ? error.message : input.failureMessage,
      });
      // #endregion
    }
    throw error;
  }
}

async function runClaudeText(input: {
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
  const startedAt = Date.now();
  const effectivePrompt = `重要约束：禁止调用任何工具（Write/Edit/MultiEdit/Bash/WebSearch/WebFetch/Task 等），所有业务结果必须直接写在最终回答文本里。\n\n${input.prompt}`;
  const promptChars = effectivePrompt.length;
  if (input.context) {
    appendGoalLog({
      requestId: input.context.requestId,
      scope: input.context.scope,
      level: "info",
      phase: input.context.phase,
      message: `Claude 开始执行：${input.context.stepLabel}`,
      details: formatTimingDetails({ promptChars, cwd }),
    });
  }

  try {
    const result = await runRuntimePromptText({
      prompt: effectivePrompt,
      runtimeEnv: input.runtimeEnv,
      cwd,
      conversationId: input.conversationId,
      filePolicy: input.runtimeEnv.filePolicy,
      channelPolicy: { mode: "readonly_json" },
      abortSignal: input.signal,
      abortMessage: input.abortMessage,
      failureMessage: input.failureMessage,
      traceContext: input.context,
    });
    if (input.context) {
      appendGoalLog({
        requestId: input.context.requestId,
        scope: input.context.scope,
        level: "info",
        phase: input.context.phase,
        message: `Claude 执行完成：${input.context.stepLabel}`,
        details: formatTimingDetails({
          elapsedMs: Date.now() - startedAt,
          promptChars,
          outputChars: result.raw.length,
        }),
      });
    }
    return result.raw;
  } catch (error) {
    if (input.context) {
      appendGoalLog({
        requestId: input.context.requestId,
        scope: input.context.scope,
        level: error instanceof DOMException && error.name === "AbortError" ? "warn" : "error",
        phase: input.context.phase,
        message:
          error instanceof DOMException && error.name === "AbortError"
            ? `Claude 执行被中断：${input.context.stepLabel}`
            : `Claude 执行异常：${input.context.stepLabel}`,
        details: error instanceof Error ? error.message : input.failureMessage,
      });
    }
    throw error;
  }
}

async function repairMalformedJsonWithClaude(input: {
  runtimeEnv: RuntimeEnvironment;
  malformedJson: string;
  conversationId?: string;
  signal?: AbortSignal;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildJsonRepairPrompt(input.malformedJson),
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "JSON 修复已中断",
    failureMessage: "Claude CLI JSON 修复失败",
  });

  return normalizeClaudeJsonText(stdout);
}

function isJsonSyntaxLikeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (error instanceof SyntaxError) return true;
  return /Unexpected token|Unexpected end|unterminated|JSON|position \d+|after property name|property names must be double-quoted/i.test(message);
}

function classifyClaudeJsonFailure(errorMessage: string, lastError: unknown) {
  const detail = lastError instanceof Error ? lastError.message.trim() : String(lastError ?? "").trim();
  const build = (reason: string) => ({
    userMessage: `${errorMessage}：${reason}`,
    logMessage: detail || reason,
  });
  if (isJsonSyntaxLikeError(lastError)) {
    return build("Claude 输出不是合法 JSON，可能混入了解释文字、代码块，或缺少逗号/引号。");
  }
  if (/缺少 reviewResults/i.test(detail)) return build("Claude 输出缺少 reviewResults 字段，无法完成任务 review。");
  if (/不是 JSON 对象/i.test(detail)) return build("Claude 输出不是系统要求的 JSON 对象结构。");
  if (/缺少 questions/i.test(detail)) return build("Claude 输出缺少 questions 字段，无法生成澄清问题。");
  if (/缺少 subGoals/i.test(detail)) return build("Claude 输出缺少 subGoals 字段，无法完成目标拆解。");
  if (/缺少 goalTitle/i.test(detail)) return build("Claude 输出缺少 goalTitle，无法生成完整规划。");
  if (/缺少 title 或 tasks/i.test(detail)) return build("Claude 输出的子目标结构不完整，缺少标题或任务列表。");
  if (detail) return build(`Claude 输出结构不符合系统要求（${detail}）。`);
  return { userMessage: errorMessage, logMessage: errorMessage };
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
  const primary = normalizeClaudeJsonText(input.raw);
  const artifactCandidates = recoverJsonArtifactsFromClaudeOutput({
    conversationId: input.conversationId,
    outputText: primary,
  });
  const attempt = parseJsonWithCandidates(
    [
      ...buildJsonParseCandidates(primary),
      ...artifactCandidates.map((artifact) => ({ label: artifact.label, value: artifact.value })),
    ],
    input.validator,
  );
  let repairedForLog = "";
  let repairedCandidateForLog = "";
  let recoveredArtifact: RecoveredJsonArtifact | undefined;

  if (attempt.ok) {
    recoveredArtifact = artifactCandidates.find((artifact) => artifact.label === attempt.strategy);
    if (input.context) {
      appendGoalLog({
        requestId: input.context.requestId,
        scope: input.context.scope,
        level: "info",
        phase: input.context.phase,
        message: `JSON 解析命中：${input.context.stepLabel}`,
        details: formatTimingDetails({
          strategy: attempt.strategy,
          elapsedMs: Date.now() - parseStartedAt,
          rawChars: primary.length,
          recoveredFromArtifact: Boolean(recoveredArtifact),
        }),
      });
    }
    return attempt.parsed;
  }

  let lastError: unknown = attempt.error;
  try {
    if (input.context) {
      appendGoalLog({
        requestId: input.context.requestId,
        scope: input.context.scope,
        level: "warn",
        phase: input.context.phase,
        message: `JSON 解析进入 Claude 修复：${input.context.stepLabel}`,
        details: formatTimingDetails({ elapsedMs: Date.now() - parseStartedAt, rawChars: primary.length }),
      });
    }
    const repaired = await repairMalformedJsonWithClaude({
      runtimeEnv: input.runtimeEnv,
      malformedJson: primary,
      conversationId: input.conversationId,
      signal: input.signal,
    });
    repairedForLog = repaired;
    const repairedAttempt = parseRepairedJsonText(repaired, input.validator);
    repairedCandidateForLog = repairedAttempt.candidateForLog;
    if (!repairedAttempt.ok) {
      throw repairedAttempt.error instanceof Error ? repairedAttempt.error : new Error(input.errorMessage);
    }
    if (input.context) {
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
    }
    return repairedAttempt.parsed;
  } catch (error) {
    lastError = error;
  }

  const classifiedFailure = classifyClaudeJsonFailure(input.errorMessage, lastError);
  const parseFailureSnapshot = input.conversationId
    ? writePlanningParseFailureSnapshot({
        conversationId: input.conversationId,
        requestId: input.context?.requestId,
        phase: input.context?.phase,
        stepLabel: input.context?.stepLabel,
        errorMessage: classifiedFailure.userMessage,
        rawOutput: input.raw,
        repairedOutput: repairedForLog || undefined,
        repairedCandidate: repairedCandidateForLog || undefined,
        artifactCandidates: artifactCandidates.map((artifact) => artifact.relativePath),
        recoveredArtifactPath: recoveredArtifact?.relativePath,
      })
    : null;

  if (input.context) {
    appendGoalLog({
      requestId: input.context.requestId,
      scope: input.context.scope,
      level: "error",
      phase: input.context.phase,
      message: `JSON 解析失败：${input.context.stepLabel}`,
      details: [
        `error: ${classifiedFailure.logMessage}`,
        `rawChars: ${primary.length}`,
        parseFailureSnapshot ? `snapshot: ${parseFailureSnapshot.relativePath}` : "",
        "",
        "## raw output",
        "```json",
        primary,
        "```",
        repairedForLog ? ["", "## repaired output", "```json", repairedForLog, "```"].join("\n") : "",
        repairedCandidateForLog ? ["", "## repaired candidate", "```json", repairedCandidateForLog, "```"].join("\n") : "",
      ].filter(Boolean).join("\n"),
    });
  }
  throw new ClaudeJsonParseError(classifiedFailure.userMessage, {
    snapshotPath: parseFailureSnapshot?.relativePath,
    rootCause: lastError,
  });
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

  const deliveryContract =
    normalizeGoalDeliveryContract(goalAnalysis.deliveryContract) ??
    normalizeGoalDeliveryContract(value.deliveryContract);

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
      deliveryContract,
    },
    deliveryContract,
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

function normalizeDeadline(value: string): string | undefined {
  // §9.5 问题 18：禁止虚构兜底日期。无法解析时返回 undefined，由调用方按需处理（保留可选语义）。
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed;
  const dateMatch = trimmed.match(/\d{4}-\d{2}-\d{2}/);
  if (dateMatch) return `${dateMatch[0]}T23:59:59+08:00`;
  return undefined;
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeGoalDeliveryContract(value: unknown): GoalDeliveryContract | undefined {
  if (!isObject(value)) return undefined;
  const finalDeliverable =
    typeof value.finalDeliverable === "string" ? value.finalDeliverable.trim() : "";
  const doneEvidence = extractStringArray(value.doneEvidence);
  if (!finalDeliverable || doneEvidence.length === 0) return undefined;
  const nonCompletionExamples = extractStringArray(value.nonCompletionExamples);
  return {
    finalDeliverable,
    doneEvidence,
    nonCompletionExamples: nonCompletionExamples.length > 0 ? nonCompletionExamples : undefined,
  };
}

function inferDraftCollaboration(task: DraftTask): NonNullable<DraftTask["collaboration"]> {
  const userInteractionType =
    task.expectedResult?.type === "decision" || task.expectedResult?.type === "confirmation" ? "confirm" : "none";
  const mode = userInteractionType === "confirm" ? "agent_with_user_confirmation" : "agent_autonomous";
  return {
    mode,
    agentResponsibilities: [task.description],
    userResponsibilities: userInteractionType === "confirm" ? ["确认结果或提出修改建议"] : [],
    userInteractionType,
    userInteractionTiming: userInteractionType === "confirm" ? "after_agent_output" : "not_required",
    userFacingActionLabel: userInteractionType === "confirm" ? "确认或提出修改建议" : "查看结果",
    shouldNotifyUser: userInteractionType !== "none",
    completionOwner: "agent",
    completionDefinition: task.expectedResult?.completionCriteria || task.expectedOutcome,
  };
}

function dedupeStrings(items: Array<string | undefined>) {
  return Array.from(new Set(items.map((item) => item?.trim()).filter(Boolean) as string[]));
}

function dedupeNumbers(items: number[]) {
  return Array.from(new Set(items));
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
  const userContext = withUserMemoryContext(input.userContext);
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildDecomposePrompt({ ...input, userContext }),
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
  const parseContext = {
    requestId: input.requestId,
    scope: "goal_plan" as GoalTelemetryScope,
    phase: "decomposing" as GoalWorkflowPhase,
    stepLabel: "拆解子目标",
  };
  try {
    return await parseClaudeJson({
      raw: stdout,
      validator: validateDecomposition,
      errorMessage: "Claude 子目标拆解 JSON 解析失败",
      runtimeEnv: input.runtimeEnv,
      conversationId: input.conversationId,
      signal: input.signal,
      context: parseContext,
    });
  } catch (error) {
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_plan",
      level: "warn",
      phase: "decomposing",
      message: "子目标拆解解析失败，尝试按拆解 schema 语义修复",
      details: error instanceof Error ? error.message : "未知解析错误",
    });
    const normalizedStdout = await runClaudeJson({
      runtimeEnv: input.runtimeEnv,
      prompt: buildDecompositionNormalizationPrompt({
        goalTitle: input.goalTitle,
        goalDescription: input.goalDescription,
        userContext,
        config: input.config,
        rawOutput: normalizeClaudeJsonText(stdout),
      }),
      conversationId: input.conversationId,
      signal: input.signal,
      abortMessage: "子目标拆解修复已中断",
      failureMessage: "Claude CLI 子目标拆解修复失败",
      context: {
        requestId: input.requestId,
        scope: "goal_plan",
        phase: "decomposing",
        stepLabel: "修复拆解子目标",
      },
    });
    return parseClaudeJson({
      raw: normalizedStdout,
      validator: validateDecomposition,
      errorMessage: "Claude 子目标拆解 JSON 语义修复失败",
      runtimeEnv: input.runtimeEnv,
      conversationId: input.conversationId,
      signal: input.signal,
      context: {
        requestId: input.requestId,
        scope: "goal_plan",
        phase: "decomposing",
        stepLabel: "修复拆解子目标",
      },
    });
  }
}

async function repairSingleTaskDraftWithClaude(input: {
  goalTitle: string;
  subGoalName: string;
  rawBlock: string;
  missingFields: string[];
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  requestId?: string;
  subGoalIndex?: number;
  totalSubGoals?: number;
}): Promise<TaskDraft | null> {
  const stdout = await runClaudeText({
    runtimeEnv: input.runtimeEnv,
    prompt: buildSingleTaskDraftRepairPrompt(input),
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "任务草稿修复已中断",
    failureMessage: "Claude CLI 任务草稿修复失败",
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "generating_tasks",
      stepLabel: `修复子目标 ${input.subGoalIndex ?? "?"}/${input.totalSubGoals ?? "?"} 的单个任务草稿：${input.subGoalName}`,
    },
  });
  try {
    return parseTaskDraftBatch(stdout).tasks[0] ?? null;
  } catch {
    return null;
  }
}

function buildTaskDraftPromptDependencyContext(input: {
  decomposition: DecompositionPayload;
  completedSubGoals: DraftSubGoal[];
  subGoalIndex: number;
}) {
  const currentSubGoal = input.decomposition.subGoals[input.subGoalIndex];
  const dependencyIds = new Set(currentSubGoal?.dependencies ?? []);
  const previousSubGoals = input.decomposition.subGoals.slice(0, input.subGoalIndex).map((subGoal) => ({
    id: subGoal.id,
    name: subGoal.name,
    description: subGoal.description,
    dependencies: subGoal.dependencies,
    successCriteria: subGoal.successCriteria.map((criterion) => criterion.description),
  }));
  const currentSubGoalDependencies = input.decomposition.subGoals
    .filter((subGoal) => dependencyIds.has(subGoal.id))
    .map((subGoal) => ({
      id: subGoal.id,
      name: subGoal.name,
      description: subGoal.description,
      successCriteria: subGoal.successCriteria.map((criterion) => criterion.description),
    }));
  const previousKeyTasks = input.completedSubGoals.flatMap((subGoal) =>
    subGoal.tasks
      .filter((task) => task.taskType === "one_shot" && task.executionMode !== "monitoring")
      .map((task) => ({
        subGoalId: subGoal.id,
        subGoalName: subGoal.title,
        id: task.id,
        title: task.title,
        expectedOutcome: task.expectedOutcome,
      })),
  );
  return {
    previousSubGoals,
    currentSubGoalDependencies,
    previousKeyTasks,
  };
}

async function generateTaskDraftBatchForSubGoalWithClaude(input: {
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
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  requestId?: string;
  subGoalIndex?: number;
  totalSubGoals?: number;
}): Promise<TaskDraftBatch> {
  const userContext = withUserMemoryContext(input.userContext);
  const stdout = await runClaudeText({
    runtimeEnv: input.runtimeEnv,
    prompt: buildTaskDraftPrompt({ ...input, userContext }),
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "任务草稿生成已中断",
    failureMessage: "Claude CLI 任务草稿生成失败",
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "generating_tasks",
      stepLabel: `为子目标 ${input.subGoalIndex ?? "?"}/${input.totalSubGoals ?? "?"} 生成任务草稿：${input.subGoalName}`,
    },
  });
  let batch: TaskDraftBatch;
  try {
    batch = parseTaskDraftBatch(stdout);
  } catch (error) {
    const snapshot = input.conversationId
      ? writePlanningParseFailureSnapshot({
          conversationId: input.conversationId,
          requestId: input.requestId,
          phase: "generating_tasks",
          stepLabel: "draft_parse",
          errorMessage: error instanceof Error ? error.message : "任务草稿解析失败",
          rawOutput: stdout,
          stage: "draft_parse",
        })
      : undefined;
    throw new ClaudeJsonParseError("Claude 任务草稿 Block 解析失败", {
      snapshotPath: snapshot?.relativePath,
      rootCause: error,
    });
  }

  const recovered: TaskDraft[] = [];
  for (const reason of batch.droppedReasons ?? []) {
    if (!reason.rawBlock) continue;
    const repaired = await repairSingleTaskDraftWithClaude({
      goalTitle: input.goalTitle,
      subGoalName: input.subGoalName,
      rawBlock: reason.rawBlock,
      missingFields: reason.missingFields,
      runtimeEnv: input.runtimeEnv,
      conversationId: input.conversationId,
      signal: input.signal,
      requestId: input.requestId,
      subGoalIndex: input.subGoalIndex,
      totalSubGoals: input.totalSubGoals,
    });
    if (repaired) recovered.push(repaired);
  }

  const remainingDroppedReasons = (batch.droppedReasons ?? []).filter((reason) => !recovered.some((draft) => draft.index === reason.index));
  const finalTasks = [...batch.tasks, ...recovered];
  if (finalTasks.length === 0) {
    throw new TaskDraftBatchEmptyError("任务草稿全部不可用", remainingDroppedReasons);
  }

  return {
    ...batch,
    tasks: finalTasks,
    droppedReasons: remainingDroppedReasons,
    droppedTaskIndices: (batch.droppedTaskIndices ?? []).filter((index) => !recovered.some((draft) => draft.index === index)),
    recoveredTaskCount: recovered.length,
  } as TaskDraftBatch & { recoveredTaskCount: number };
}

async function reviewTaskDraftsWithClaude(input: {
  goalTitle: string;
  subGoalTitle: string;
  goalDescription: string;
  drafts: TaskDraft[];
  deliveryContract?: GoalDeliveryContract;
  isFinalSubGoal?: boolean;
  subGoalSuccessCriteria?: string[];
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  requestId?: string;
  subGoalIndex?: number;
  totalSubGoals?: number;
}): Promise<TaskDraftReviewDecisionPayload> {
  const stepLabel = `Review 子目标 ${input.subGoalIndex ?? "?"}/${input.totalSubGoals ?? "?"} 的任务草稿：${input.subGoalTitle}`;
  const traceContext: ClaudeRunContext = {
    requestId: input.requestId,
    scope: "goal_plan",
    phase: "reviewing_tasks",
    stepLabel,
  };
  // rawStdout 提升到 try 外层，保证 catch 内 snapshot 能拿到真实模型 stdout（含截断尾部）
  let rawStdout = "";
  try {
    rawStdout = await runClaudeJson({
      runtimeEnv: input.runtimeEnv,
      prompt: buildTaskDraftReviewDecisionPrompt(input),
      conversationId: input.conversationId,
      signal: input.signal,
      abortMessage: "任务 review 已中断",
      failureMessage: "Claude CLI 任务草稿 review 失败",
      context: traceContext,
    });
    const primary = normalizeClaudeJsonText(rawStdout);
    const attempt = parseJsonWithCandidates(buildJsonParseCandidates(primary), validateTaskReviewDecision);
    if (!attempt.ok) {
      throw attempt.error instanceof Error
        ? attempt.error
        : new Error("Claude 任务草稿 review 决策层解析失败");
    }
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_plan",
      level: "info",
      phase: "reviewing_tasks",
      message: `Review 决策层解析命中：${stepLabel}`,
      details: formatTimingDetails({
        strategy: attempt.strategy,
        rawChars: primary.length,
        results: attempt.parsed.results.length,
      }),
    });
    return attempt.parsed;
  } catch (error) {
    // Abort 错误直接抛出，不走降级路径
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    // 区分 CLI 失败 vs 解析失败：CLI 失败时 rawStdout 为空，runClaudeJson 内部已写过 error 日志
    const cliFailed = !rawStdout;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const truncatedError = errorMessage.length > 500 ? `${errorMessage.slice(0, 500)}…` : errorMessage;
    if (cliFailed) {
      // CLI 失败：runClaudeJson 已记录详细 error 日志，此处仅追加"已降级"摘要避免重复
      appendGoalLog({
        requestId: input.requestId,
        scope: "goal_plan",
        level: "warn",
        phase: "reviewing_tasks",
        message: `Review 决策层 CLI 失败，已使用保守降级（默认全部对齐）：${stepLabel}`,
      });
    } else {
      // 解析失败：CLI 返回了 stdout 但 JSON 解析/校验失败，写完整 warn 含错误细节
      appendGoalLog({
        requestId: input.requestId,
        scope: "goal_plan",
        level: "warn",
        phase: "reviewing_tasks",
        message: `Review 决策层解析失败，已使用保守降级（默认全部对齐）：${stepLabel}`,
        details: `error: ${truncatedError}`,
      });
    }
    if (input.conversationId) {
      try {
        writePlanningParseFailureSnapshot({
          conversationId: input.conversationId,
          requestId: input.requestId,
          phase: "reviewing_tasks",
          stage: "review",
          stepLabel,
          errorMessage: truncatedError,
          // 解析失败时拿真实 stdout（含截断尾部，便于排查 token 截断）；CLI 失败时无 stdout，写错误信息以保证字段非空
          rawOutput: rawStdout || errorMessage,
        });
      } catch {
        // snapshot 写入失败不影响降级
      }
    }
    return buildDegradedReviewDecision(input.drafts);
  }
}

const TASK_REVIEW_EXPLANATION_TIMEOUT_MS = 30_000;

/**
 * 异步展示层：根据决策层结果生成 plain markdown 解释，**仅做 fire-and-forget 启动**。
 * 失败/超时/abort 都不抛出，仅写 warn 日志，确保不影响主链路。
 * 与主流程共享 abort signal；自身另叠加 30s 超时保护。
 */
async function generateTaskReviewExplanation(input: {
  goalTitle: string;
  subGoalTitle: string;
  goalDescription: string;
  drafts: TaskDraft[];
  decision: TaskDraftReviewDecisionPayload;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  requestId?: string;
  subGoalIndex?: number;
  totalSubGoals?: number;
}): Promise<string | null> {
  if (input.decision._degraded) {
    // 降级路径下决策本身已是兜底，跳过展示层避免无意义 LLM 调用
    return null;
  }
  const stepLabel = `Review 展示层 子目标 ${input.subGoalIndex ?? "?"}/${input.totalSubGoals ?? "?"}：${input.subGoalTitle}`;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), TASK_REVIEW_EXPLANATION_TIMEOUT_MS);
  const onParentAbort = () => timeoutController.abort();
  if (input.signal) {
    if (input.signal.aborted) {
      timeoutController.abort();
    } else {
      input.signal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  try {
    const text = await runClaudeText({
      runtimeEnv: input.runtimeEnv,
      prompt: buildTaskDraftReviewPresentationPrompt({
        goalTitle: input.goalTitle,
        subGoalTitle: input.subGoalTitle,
        goalDescription: input.goalDescription,
        drafts: input.drafts,
        decision: input.decision,
      }),
      conversationId: input.conversationId,
      signal: timeoutController.signal,
      abortMessage: "任务 review 展示层已中断",
      failureMessage: "任务 review 展示层文本生成失败",
      context: {
        requestId: input.requestId,
        scope: "goal_plan",
        phase: "reviewing_tasks",
        stepLabel,
      },
    });
    return text || null;
  } catch {
    // runClaudeText 内部已写 error/warn 日志（含 abort/timeout/failure 细节），此处仅追加"已忽略"摘要避免重复
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_plan",
      level: "warn",
      phase: "reviewing_tasks",
      message: `Review 展示层失败/超时/已中断，已忽略（不影响主链路）：${stepLabel}`,
    });
    return null;
  } finally {
    clearTimeout(timer);
    if (input.signal) {
      input.signal.removeEventListener("abort", onParentAbort);
    }
  }
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

export function buildDeliveryClosureAuditPrompt(input: {
  goalText: string;
  decomposition: DecompositionPayload;
  subGoals: DraftSubGoal[];
}) {
  const contract = input.decomposition.goalAnalysis.deliveryContract ?? input.decomposition.deliveryContract;
  const compactThreads = input.subGoals.map((subGoal, index) => ({
    subGoalId: input.decomposition.subGoals[index]?.id ?? index + 1,
    title: subGoal.title,
    successCriteria: subGoal.successCriteria ?? [],
    tasks: subGoal.tasks.map((task) => ({
      title: task.title,
      objective: task.description,
      deliverable: task.expectedOutcome,
      taskType: task.taskType,
      triggerRule: task.triggerRule,
      dependencies: task.dependencies ?? [],
    })),
  }));
  return `你是目标规划的全局交付闭环审计器。只能输出严格 JSON 对象，不要输出 Markdown、解释或代码块。

审计目标：判断这些任务全部完成后，是否有足够证据证明目标交付契约已达成。
不要判断任务是否“相关”，要判断是否形成可验收闭环。
如果计划只包含准备产物、方案、骨架、说明，但缺少把它们转成可验收结果的任务，必须 needs_repair。
不得按领域关键词判断；只能按 finalDeliverable、doneEvidence、nonCompletionExamples 与任务交付物之间的逻辑关系判断。

原始目标：${input.goalText}
核心意图：${input.decomposition.goalAnalysis.coreIntent}
成功状态：${input.decomposition.goalAnalysis.successState}
目标交付契约：
${JSON.stringify(contract ?? {}, null, 2)}

线程与任务：
${JSON.stringify(compactThreads, null, 2)}

输出 JSON schema：
{
  "verdict": "accept|needs_repair",
  "missingEvidence": ["缺少的完成证据"],
  "insufficientThreads": [
    { "subGoalId": 1, "reason": "该板块缺少构建或验收任务" }
  ],
  "repairInstruction": "如果需要修复，说明应该补什么任务；否则省略"
}`;
}

export function validateDeliveryClosureAudit(value: unknown): DeliveryClosureAuditPayload {
  if (!isObject(value)) {
    throw new Error("交付闭环审计结果不是 JSON 对象");
  }
  const insufficientThreads = Array.isArray(value.insufficientThreads)
    ? value.insufficientThreads.filter(isObject).map((item) => ({
        subGoalId: typeof item.subGoalId === "number" ? item.subGoalId : 0,
        reason: typeof item.reason === "string" ? item.reason.trim() : "",
      })).filter((item) => item.subGoalId > 0 && item.reason)
    : [];
  const missingEvidence = extractStringArray(value.missingEvidence);
  const verdict =
    value.verdict === "accept" && missingEvidence.length === 0 && insufficientThreads.length === 0
      ? "accept"
      : "needs_repair";
  return {
    verdict,
    missingEvidence,
    insufficientThreads,
    repairInstruction: typeof value.repairInstruction === "string" && value.repairInstruction.trim()
      ? value.repairInstruction.trim()
      : undefined,
  };
}

async function auditDeliveryClosureWithClaude(input: {
  goalText: string;
  decomposition: DecompositionPayload;
  subGoals: DraftSubGoal[];
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  requestId?: string;
}) {
  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt: buildDeliveryClosureAuditPrompt(input),
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "交付闭环审计已中断",
    failureMessage: "Claude CLI 交付闭环审计失败",
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "reviewing_tasks",
      stepLabel: "全局交付闭环审计",
    },
  });
  return parseClaudeJson({
    raw: stdout,
    validator: validateDeliveryClosureAudit,
    errorMessage: "Claude 交付闭环审计 JSON 解析失败",
    runtimeEnv: input.runtimeEnv,
    conversationId: input.conversationId,
    signal: input.signal,
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "reviewing_tasks",
      stepLabel: "全局交付闭环审计",
    },
  });
}

function buildDeliveryClosureRepairPrompt(input: {
  goalText: string;
  decomposition: DecompositionPayload;
  targetSubGoal: DraftSubGoal;
  audit: DeliveryClosureAuditPayload;
}) {
  const contract = input.decomposition.goalAnalysis.deliveryContract ?? input.decomposition.deliveryContract;
  return `只能输出 Block 协议，不允许 JSON / Markdown / 解释文字。
所有标签必须出现在行首，标签外不要输出任何文字。

你正在修复目标规划的全局交付闭环缺口。请只为指定子目标追加 1-3 个任务。
新增任务必须补齐构建或验收缺口，不要重复已有任务，不要输出泛泛建议。
默认使用 one_shot；只有缺口本身确实是持续监测时才使用 cadence/repeat。

原始目标：${input.goalText}
目标交付契约：
${JSON.stringify(contract ?? {}, null, 2)}

目标子目标：
${JSON.stringify({
  title: input.targetSubGoal.title,
  description: input.targetSubGoal.description,
  successCriteria: input.targetSubGoal.successCriteria,
  existingTasks: input.targetSubGoal.tasks.map((task) => ({
    title: task.title,
    objective: task.description,
    deliverable: task.expectedOutcome,
  })),
}, null, 2)}

审计缺口：
${JSON.stringify(input.audit, null, 2)}

输出格式：
<task index="1">
<title>
任务标题
</title>
<objective>
任务目标、执行边界和必要上下文
</objective>
<deliverable>
完成后应沉淀的可验收结果
</deliverable>
<acceptance>
- 验收标准 1
- 验收标准 2
</acceptance>
<user-involvement mode="none" />
<dependencies></dependencies>
<priority>high</priority>
<duration-minutes>90</duration-minutes>
</task>`;
}

function selectDeliveryRepairTarget(input: {
  decomposition: DecompositionPayload;
  subGoals: DraftSubGoal[];
  audit: DeliveryClosureAuditPayload;
}) {
  const preferred = input.audit.insufficientThreads[0]?.subGoalId;
  const preferredIndex =
    preferred === undefined
      ? -1
      : input.decomposition.subGoals.findIndex((subGoal) => subGoal.id === preferred);
  if (preferredIndex >= 0 && input.subGoals[preferredIndex]) return preferredIndex;
  return Math.max(0, input.subGoals.length - 1);
}

async function repairDeliveryClosureWithClaude(input: {
  goalText: string;
  decomposition: DecompositionPayload;
  subGoals: DraftSubGoal[];
  audit: DeliveryClosureAuditPayload;
  taskIdBatchSeed: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  requestId?: string;
}) {
  const targetIndex = selectDeliveryRepairTarget(input);
  const targetSubGoal = input.subGoals[targetIndex];
  if (!targetSubGoal) return { subGoals: input.subGoals, warnings: ["交付闭环修复失败：未找到可修复的子目标。"] };
  const stdout = await runClaudeText({
    runtimeEnv: input.runtimeEnv,
    prompt: buildDeliveryClosureRepairPrompt({
      goalText: input.goalText,
      decomposition: input.decomposition,
      targetSubGoal,
      audit: input.audit,
    }),
    conversationId: input.conversationId,
    signal: input.signal,
    abortMessage: "交付闭环修复已中断",
    failureMessage: "Claude CLI 交付闭环修复失败",
    context: {
      requestId: input.requestId,
      scope: "goal_plan",
      phase: "reviewing_tasks",
      stepLabel: `交付闭环修复：${targetSubGoal.title}`,
    },
  });
  const batch = parseTaskDraftBatch(stdout);
  if (batch.tasks.length === 0) {
    throw new TaskDraftBatchEmptyError("交付闭环修复未生成可用任务", batch.droppedReasons ?? []);
  }
  const subGoalContext: DecompositionSubGoalContext = {
    id: input.decomposition.subGoals[targetIndex]?.id ?? targetIndex + 1,
    name: targetSubGoal.title,
    description: targetSubGoal.description ?? targetSubGoal.title,
    priority: targetSubGoal.priority,
    criteria: targetSubGoal.successCriteria ?? [],
  };
  const compiled = compileTaskDraftsToDraftTasks({
    drafts: batch.tasks,
    subGoalContext,
    taskIdBatchSeed: input.taskIdBatchSeed,
    subGoalDraftId: targetSubGoal.id,
    subGoalIndex: targetIndex + 1,
    taskIndexOffset: targetSubGoal.tasks.length,
  });
  const nextSubGoals = input.subGoals.slice();
  nextSubGoals[targetIndex] = {
    ...targetSubGoal,
    tasks: [...targetSubGoal.tasks, ...compiled.tasks],
  };
  return {
    subGoals: nextSubGoals,
    warnings: compiled.warnings.map((warning) => `交付闭环修复：${warning.message}`),
    targetTitle: targetSubGoal.title,
    addedTaskCount: compiled.tasks.length,
  };
}

async function auditAndRepairDeliveryClosure(input: {
  goalText: string;
  decomposition: DecompositionPayload;
  subGoals: DraftSubGoal[];
  taskIdBatchSeed: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  signal?: AbortSignal;
  requestId?: string;
}) {
  try {
    const audit = await auditDeliveryClosureWithClaude(input);
    if (audit.verdict === "accept") {
      return { subGoals: input.subGoals, reviewSummary: ["全局交付闭环审计：已通过。"], reviewRisks: [] };
    }

    const repair = await repairDeliveryClosureWithClaude({ ...input, audit });
    const repairedAudit = await auditDeliveryClosureWithClaude({ ...input, subGoals: repair.subGoals });
    const baseSummary = [
      `全局交付闭环审计：发现缺口并已追加 ${repair.addedTaskCount ?? 0} 个任务到「${repair.targetTitle ?? "目标板块"}」。`,
      ...repair.warnings,
    ];
    if (repairedAudit.verdict === "accept") {
      return { subGoals: repair.subGoals, reviewSummary: [...baseSummary, "全局交付闭环复审：已通过。"], reviewRisks: [] };
    }
    return {
      subGoals: repair.subGoals,
      reviewSummary: [...baseSummary, "全局交付闭环复审：仍存在缺口，已记录为规划风险。"],
      reviewRisks: [
        ...repairedAudit.missingEvidence.map((item) => `交付闭环缺口：${item}`),
        ...repairedAudit.insufficientThreads.map((item) => `交付闭环缺口：子目标 ${item.subGoalId} ${item.reason}`),
      ],
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    const message = error instanceof Error ? error.message : "未知错误";
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_plan",
      level: "warn",
      phase: "reviewing_tasks",
      message: "全局交付闭环审计失败，已记录为规划风险并继续生成计划。",
      details: message,
    });
    return {
      subGoals: input.subGoals,
      reviewSummary: ["全局交付闭环审计未完成，已记录为规划风险。"],
      reviewRisks: [`全局交付闭环审计未完成：${message}`],
    };
  }
}

function validateGoalDraft(value: GoalBreakdownDraft): GoalBreakdownDraft {
  if (!value.goalTitle || typeof value.goalTitle !== "string") {
    throw new Error("规划缺少 goalTitle");
  }
  if (!Array.isArray(value.subGoals) || value.subGoals.length === 0) {
    throw new Error("规划缺少 subGoals");
  }
  const plannerWarnings: string[] = [];
  const readTrigger = (input: unknown, path: string): TriggerSpec | undefined => {
    if (input === null || input === undefined || (typeof input === "string" && !input.trim())) return undefined;
    const result = normalizeTriggerSpecWithWarnings(input as Parameters<typeof normalizeTriggerSpecWithWarnings>[0], { path });
    if (result.trigger) return result.trigger;
    if (result.warnings.length > 0) {
      plannerWarnings.push(`planner warning: ${path} 包含非法 TriggerSpec，已记录并尝试走 legacy fallback。`);
    }
    return undefined;
  };
  const deliveryContract = value.deliveryContract ?? value.goalAnalysis?.deliveryContract;
  value.deliveryContract = deliveryContract;
  if (value.goalAnalysis && deliveryContract && !value.goalAnalysis.deliveryContract) {
    value.goalAnalysis = { ...value.goalAnalysis, deliveryContract };
  }
  value.topicLoop = readTrigger(value.topicLoop, "topicLoop") ?? value.topicLoop;
  for (const subGoal of value.subGoals) {
    if (!subGoal.title || !Array.isArray(subGoal.tasks) || subGoal.tasks.length === 0) {
      throw new Error("规划中的子目标缺少 title 或 tasks");
    }
    subGoal.reviewTrigger =
      readTrigger(subGoal.reviewTrigger, `${subGoal.title}.reviewTrigger`) ??
      readTrigger(subGoal.reviewInterval, `${subGoal.title}.reviewInterval`) ??
      subGoal.reviewTrigger;
    for (const task of subGoal.tasks) {
      if (!task.title || !task.description || !task.expectedOutcome || !task.triggerRule) {
        throw new Error("规划中的任务字段不完整");
      }
      task.triggerSpec =
        readTrigger(task.triggerSpec, `${subGoal.title}.${task.title}.triggerSpec`) ??
        readTrigger(task.trigger, `${subGoal.title}.${task.title}.trigger`) ??
        task.triggerSpec;
      task.trigger = task.triggerSpec ?? readTrigger(task.trigger, `${subGoal.title}.${task.title}.trigger`) ?? task.trigger;
      task.executionKind = normalizeExecutionKind(task.executionKind);
      task.resultViewKind = normalizeTaskResultViewKind(task.resultViewKind ?? task.executionKind);
      task.executionStrategy = task.executionStrategy ?? "agent_autonomous";
      task.executionObjective = task.executionObjective ?? task.description;
      task.autoRunDisabled = task.autoRunDisabled ?? false;
      task.requiresConfirmation =
        task.requiresConfirmation ?? (task.expectedResult?.type === "decision" || task.expectedResult?.type === "confirmation");
      task.collaboration = task.collaboration ?? inferDraftCollaboration(task);
    }
  }
  if (plannerWarnings.length > 0) {
    value.reviewSummary = [...(value.reviewSummary ?? []), ...plannerWarnings];
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
  resumeFromCheckpoint?: boolean;
  signal?: AbortSignal;
  requestId?: string;
  onProgress?: GoalStageProgressHandler;
}): Promise<GoalBreakdownDraft> {
  const planStartedAt = Date.now();
  const taskIdBatchSeed = planStartedAt.toString(36);
  const config = normalizeEasterEggSettings(input.config ?? DEFAULT_EASTER_EGG_SETTINGS);
  const restoredCheckpoint = input.resumeFromCheckpoint
    ? readGoalPlanningCheckpoint(input.conversationId)
    : null;
  let checkpoint = isCheckpointCompatible(restoredCheckpoint, input)
    ? restoredCheckpoint
    : createEmptyCheckpoint({
        goalText: input.goalText,
        collectedInfo: input.collectedInfo,
        requestId: input.requestId,
      });

  if (input.resumeFromCheckpoint && isCheckpointCompatible(restoredCheckpoint, input)) {
    emitCheckpointResumeProgress({ checkpoint, onProgress: input.onProgress });
    checkpoint = {
      ...checkpoint,
      status: "running",
      requestId: input.requestId,
    };
  } else {
    clearGoalPlanningCheckpoint(input.conversationId);
  }
  writeGoalPlanningCheckpoint(input.conversationId, checkpoint);

  try {
    let collectedInfoSummary = checkpoint.collectedInfoSummary;
    if (!collectedInfoSummary) {
      input.onProgress?.({
        phase: "collecting_info",
        message: "正在整理背景信息...",
      });
      checkpoint = {
        ...checkpoint,
        status: "running",
        stage: "collecting_info",
      };
      writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
      const collectedInfoStartedAt = Date.now();
      collectedInfoSummary = input.collectedInfo?.trim()
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
      checkpoint = {
        ...checkpoint,
        collectedInfoSummary,
      };
      writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
    }

    const userContext = checkpoint.userContext ?? {
      goalText: input.goalText,
      goalDetails: collectedInfoSummary.goalDetails,
      timeline: collectedInfoSummary.timeline,
      resources: collectedInfoSummary.resources,
      constraints: collectedInfoSummary.constraints,
      challenges: collectedInfoSummary.challenges,
      preferences: collectedInfoSummary.preferences,
      summary: collectedInfoSummary.summary,
    };
    checkpoint = {
      ...checkpoint,
      userContext,
    };
    writeGoalPlanningCheckpoint(input.conversationId, checkpoint);

    let decomposition = checkpoint.decomposition;
    if (!decomposition) {
      input.onProgress?.({
        phase: "decomposing",
        message: "正在拆解子目标...",
      });
      checkpoint = {
        ...checkpoint,
        stage: "decomposing",
      };
      writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
      const decompositionStartedAt = Date.now();
      decomposition = await decomposeGoalWithClaude({
        goalTitle: input.goalText,
        goalDescription: collectedInfoSummary.goalDetails || collectedInfoSummary.summary || input.goalText,
        userContext,
        config,
        runtimeEnv: input.runtimeEnv,
        conversationId: input.conversationId,
        signal: input.signal,
        requestId: input.requestId,
      });
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
      checkpoint = {
        ...checkpoint,
        decomposition,
        nextSubGoalIndex: 0,
      };
      writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
    }

    const totalSubGoals = decomposition.subGoals.length;
    const taskPlanningSummary: TaskPlanningSummaryItem[] = [...checkpoint.taskPlanningSummary];
    const subGoals: GoalBreakdownDraft["subGoals"] = [...checkpoint.completedSubGoals];
    const reviewSummary: string[] = [...checkpoint.reviewSummary];
    const reviewRisks: string[] = [...checkpoint.reviewRisks];

    for (let subGoalIndex = checkpoint.nextSubGoalIndex; subGoalIndex < decomposition.subGoals.length; subGoalIndex += 1) {
      const subGoal = decomposition.subGoals[subGoalIndex];
      const subGoalStartedAt = Date.now();
      let generatedDrafts = checkpoint.activeSubGoal?.index === subGoalIndex
        ? checkpoint.activeSubGoal.generatedDrafts
        : undefined;

      if (generatedDrafts) {
        input.onProgress?.({
          phase: "reviewing_tasks",
          message: `复用 checkpoint 中子目标 ${subGoalIndex + 1}/${totalSubGoals} 的已生成任务草稿：${subGoal.name}`,
        });
      } else {
        input.onProgress?.({
          phase: "generating_tasks",
          message: `正在为子目标 ${subGoalIndex + 1}/${totalSubGoals} 生成任务：${subGoal.name}`,
        });
        checkpoint = {
          ...checkpoint,
          stage: "generating_tasks",
          activeSubGoal: { index: subGoalIndex },
        };
        writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
        try {
          generatedDrafts = await generateTaskDraftBatchForSubGoalWithClaude({
            goalTitle: input.goalText,
            goalDescription: collectedInfoSummary.goalDetails || collectedInfoSummary.summary || input.goalText,
            userContext,
            subGoalName: subGoal.name,
            subGoalDescription: subGoal.description,
            successCriteria: subGoal.successCriteria.map(
              (criterion: DecompositionPayload["subGoals"][number]["successCriteria"][number]) => criterion.description,
            ),
            deliveryContract: decomposition.goalAnalysis.deliveryContract ?? decomposition.deliveryContract,
            isFinalSubGoal: subGoalIndex === totalSubGoals - 1,
            ...buildTaskDraftPromptDependencyContext({
              decomposition,
              completedSubGoals: subGoals,
              subGoalIndex,
            }),
            config,
            runtimeEnv: input.runtimeEnv,
            conversationId: input.conversationId,
            signal: input.signal,
            requestId: input.requestId,
            subGoalIndex: subGoalIndex + 1,
            totalSubGoals,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "任务草稿生成失败";
          const recoverable = true;
          const failedSubGoalIds = dedupeNumbers([
            ...getFailedSubGoalIds(checkpoint),
            subGoal.id,
          ]);
          checkpoint = {
            ...checkpoint,
            status: "partial",
            stage: "generating_tasks",
            nextSubGoalIndex: subGoalIndex,
            activeSubGoal: { index: subGoalIndex },
            subGoalTaskGeneration: upsertSubGoalTaskGenerationStatus(checkpoint, {
              subGoalId: subGoal.id,
              subGoalName: subGoal.name,
              status: "task_generation_failed",
              taskCount: 0,
              lastError: errorMessage,
              lastRawSnapshot: getClaudeJsonParseSnapshotPath(error),
              droppedReasons: error instanceof TaskDraftBatchEmptyError ? error.droppedReasons : undefined,
              updatedAt: new Date().toISOString(),
            }),
            partialFailure: {
              failedSubGoalIds,
              recoverable,
              message: `子目标 ${subGoalIndex + 1}/${totalSubGoals}「${subGoal.name}」任务生成失败，已保留前序规划进度，可从该子目标继续修复。`,
            },
            lastError: errorMessage,
          };
          writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
          throw error;
        }
        checkpoint = {
          ...checkpoint,
          status: "running",
          partialFailure: undefined,
          activeSubGoal: {
            index: subGoalIndex,
              generatedDrafts,
          },
        };
        writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
      }

      const subGoalDraftId = `draft-subgoal-${subGoal.id}`;
      let review: TaskDraftReviewDecisionPayload;
      let compiled: ReturnType<typeof compileTaskDraftsToDraftTasks>;
      let tasks: GoalBreakdownDraft["subGoals"][number]["tasks"];
      try {
        input.onProgress?.({
          phase: "reviewing_tasks",
          message: `正在 review 子目标 ${subGoalIndex + 1}/${totalSubGoals}：${subGoal.name}`,
        });
        checkpoint = {
          ...checkpoint,
          stage: "reviewing_tasks",
          activeSubGoal: {
            index: subGoalIndex,
            generatedDrafts,
          },
        };
        writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
        review = await reviewTaskDraftsWithClaude({
          goalTitle: input.goalText,
          subGoalTitle: subGoal.name,
          goalDescription: collectedInfoSummary.goalDetails || collectedInfoSummary.summary || input.goalText,
          drafts: generatedDrafts.tasks,
          deliveryContract: decomposition.goalAnalysis.deliveryContract ?? decomposition.deliveryContract,
          isFinalSubGoal: subGoalIndex === totalSubGoals - 1,
          subGoalSuccessCriteria: subGoal.successCriteria.map(
            (criterion: DecompositionPayload["subGoals"][number]["successCriteria"][number]) => criterion.description,
          ),
          runtimeEnv: input.runtimeEnv,
          conversationId: input.conversationId,
          signal: input.signal,
          requestId: input.requestId,
          subGoalIndex: subGoalIndex + 1,
          totalSubGoals,
        });

        const reviewedDrafts = applyDraftReview(generatedDrafts.tasks, review);
        // §3.2.6 + §8.5：异步展示层，仅启动 + 写 trace，不阻塞主链路
        void generateTaskReviewExplanation({
          goalTitle: input.goalText,
          subGoalTitle: subGoal.name,
          goalDescription: collectedInfoSummary.goalDetails || collectedInfoSummary.summary || input.goalText,
          drafts: generatedDrafts.tasks,
          decision: review,
          runtimeEnv: input.runtimeEnv,
          conversationId: input.conversationId,
          signal: input.signal,
          requestId: input.requestId,
          subGoalIndex: subGoalIndex + 1,
          totalSubGoals,
        }).catch(() => {
          // 双保险：generateTaskReviewExplanation 内部已 catch，此处仅防御 unhandled rejection
        });
        const subGoalContext: DecompositionSubGoalContext = {
          id: subGoal.id,
          name: subGoal.name,
          description: subGoal.description,
          priority: subGoal.priority,
          criteria: subGoal.successCriteria.map(
            (criterion: DecompositionPayload["subGoals"][number]["successCriteria"][number]) => criterion.description,
          ),
        };
        compiled = compileTaskDraftsToDraftTasks({
          drafts: reviewedDrafts,
          subGoalContext,
          taskIdBatchSeed,
          subGoalDraftId,
          subGoalIndex: subGoalIndex + 1,
        });
        tasks = compiled.tasks;
        if (tasks.length === 0) {
          throw new Error(`子目标「${subGoal.name}」没有可用任务草稿`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "任务草稿 review 或编译失败";
        const failedSubGoalIds = dedupeNumbers([
          ...getFailedSubGoalIds(checkpoint),
          subGoal.id,
        ]);
        checkpoint = {
          ...checkpoint,
          status: "partial",
          stage: "reviewing_tasks",
          nextSubGoalIndex: subGoalIndex,
          activeSubGoal: {
            index: subGoalIndex,
            generatedDrafts,
          },
          subGoalTaskGeneration: upsertSubGoalTaskGenerationStatus(checkpoint, {
            subGoalId: subGoal.id,
            subGoalName: subGoal.name,
            status: "task_generation_failed",
            taskCount: 0,
            failedTaskIndices: generatedDrafts.droppedTaskIndices,
            recoveredTaskCount: generatedDrafts.recoveredTaskCount,
            droppedReasons: generatedDrafts.droppedReasons,
            lastError: errorMessage,
            lastRawSnapshot: getClaudeJsonParseSnapshotPath(error),
            updatedAt: new Date().toISOString(),
          }),
          partialFailure: {
            failedSubGoalIds,
            recoverable: true,
            message: `子目标 ${subGoalIndex + 1}/${totalSubGoals}「${subGoal.name}」任务 review 或编译失败，已保留任务草稿，可从该子目标继续修复。`,
          },
          lastError: errorMessage,
        };
        writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
        throw error;
      }
      const uncoveredRisks = generatedDrafts.risks ?? [];
      const lowAlignmentCount = getReviewLowAlignmentCount(review);

      if (generatedDrafts.coverageNotes?.length) {
        reviewSummary.push(`${subGoal.name}：${generatedDrafts.coverageNotes.join("；")}`);
      }
      if (lowAlignmentCount > 0) {
        reviewSummary.push(`${subGoal.name}：已根据 review 调整 ${lowAlignmentCount} 个任务。`);
      }
      if (compiled.warnings.length > 0) {
        reviewSummary.push(`${subGoal.name}：编译时记录 ${compiled.warnings.length} 个非阻断提示。`);
      }
      reviewRisks.push(...uncoveredRisks);

      taskPlanningSummary.push({
        subGoalName: subGoal.name,
        taskCount: tasks.length,
        uncoveredRisks,
      });

      subGoals.push({
        id: subGoalDraftId,
        title: subGoal.name,
        description: subGoal.description,
        why: subGoal.why,
        priority: subGoal.priority,
        dependencies: subGoal.dependencies.map((dependency: number) => `draft-subgoal-${dependency}`),
        estimatedDurationMinutes: subGoal.estimatedDurationMinutes,
        successCriteria: subGoal.successCriteria.map(
          (criterion: DecompositionPayload["subGoals"][number]["successCriteria"][number]) => criterion.description,
        ),
        tasks,
      });

      appendGoalLog({
        requestId: input.requestId,
        scope: "goal_plan",
        level: "info",
        phase: "reviewing_tasks",
        message: `阶段耗时：子目标 ${subGoalIndex + 1}/${totalSubGoals}`,
        details: formatTimingDetails({
          subGoalName: subGoal.name,
          elapsedMs: Date.now() - subGoalStartedAt,
          generatedTaskCount: generatedDrafts.tasks.length,
          finalTaskCount: tasks.length,
          uncoveredRiskCount: uncoveredRisks.length,
          resumedFromCheckpoint: Boolean(checkpoint.activeSubGoal?.generatedDrafts),
        }),
      });
      appendGoalLog({
        requestId: input.requestId,
        scope: "goal_plan",
        level: "info",
        phase: "reviewing_tasks",
        message: "task_draft_stats",
        details: formatTimingDetails({
          requested: generatedDrafts.rawBlocks?.length ?? generatedDrafts.tasks.length,
          parsed: generatedDrafts.tasks.length,
          repaired: generatedDrafts.recoveredTaskCount ?? 0,
          dropped: generatedDrafts.droppedTaskIndices?.length ?? 0,
          reviewMisaligned: lowAlignmentCount,
        }),
      });

      checkpoint = {
        ...checkpoint,
        status: "running",
        stage: "generating_tasks",
        completedSubGoals: subGoals,
        taskPlanningSummary,
        reviewSummary,
        reviewRisks,
        nextSubGoalIndex: subGoalIndex + 1,
        activeSubGoal: undefined,
        partialFailure: undefined,
        subGoalTaskGeneration: upsertSubGoalTaskGenerationStatus(checkpoint, {
          subGoalId: subGoal.id,
          subGoalName: subGoal.name,
          status: "ok",
          taskCount: tasks.length,
          failedTaskIndices: generatedDrafts.droppedTaskIndices,
          recoveredTaskCount: generatedDrafts.recoveredTaskCount,
          droppedReasons: generatedDrafts.droppedReasons,
          updatedAt: new Date().toISOString(),
        }),
      };
      writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
    }

    const closureReview = await auditAndRepairDeliveryClosure({
      goalText: input.goalText,
      decomposition,
      subGoals,
      taskIdBatchSeed,
      runtimeEnv: input.runtimeEnv,
      conversationId: input.conversationId,
      signal: input.signal,
      requestId: input.requestId,
    });
    subGoals.splice(0, subGoals.length, ...closureReview.subGoals);
    reviewSummary.push(...closureReview.reviewSummary);
    reviewRisks.push(...closureReview.reviewRisks);
    taskPlanningSummary.splice(
      0,
      taskPlanningSummary.length,
      ...subGoals.map((subGoal) => ({
        subGoalName: subGoal.title,
        taskCount: subGoal.tasks.length,
        uncoveredRisks: [],
      })),
    );
    checkpoint = {
      ...checkpoint,
      completedSubGoals: subGoals,
      taskPlanningSummary,
      reviewSummary,
      reviewRisks,
    };
    writeGoalPlanningCheckpoint(input.conversationId, checkpoint);

    input.onProgress?.({
      phase: "reviewing_tasks",
      message: "正在汇总规划结果...",
    });
    checkpoint = {
      ...checkpoint,
      stage: "presenting_plan",
    };
    writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
    const presentationStartedAt = Date.now();
    const presentation = checkpoint.presentation ?? await buildPlanPresentationWithClaude({
      goalText: input.goalText,
      collectedInfoSummary,
      decomposition,
      taskPlanningSummary,
      runtimeEnv: input.runtimeEnv,
      conversationId: input.conversationId,
      signal: input.signal,
      requestId: input.requestId,
    });
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

    const dependencyMerge = mergeCrossSubGoalTaskDependencies({ subGoals });
    const dependencyReviewSummary =
      dependencyMerge.warnings.length > 0
        ? [
            `跨板块依赖归并记录 ${dependencyMerge.warnings.length} 个非阻断提示。`,
            ...dependencyMerge.warnings.map((warning) => `跨板块依赖归并：${warning.message}`),
          ]
        : [];

    const draft = validateGoalDraft({
      goalTitle: presentation.goalTitle,
      summary: presentation.summary,
      deadline: presentation.deadline || normalizeDeadline(collectedInfoSummary.timeline || ""),
      goalAnalysis: decomposition.goalAnalysis,
      deliveryContract: decomposition.goalAnalysis.deliveryContract ?? decomposition.deliveryContract,
      collectedInfoSummary,
      assumptions: dedupeStrings(decomposition.goalAnalysis.assumptions ?? []),
      risks: dedupeStrings([...decomposition.risks, ...reviewRisks]),
      reasoning: decomposition.reasoning,
      executionOrder: decomposition.executionOrder,
      reviewSummary: [...reviewSummary, ...dependencyReviewSummary],
      notificationStrategy: presentation.notificationStrategy,
      subGoals: dependencyMerge.subGoals,
    });
    checkpoint = {
      ...checkpoint,
      status: "completed",
      presentation,
      draft,
    };
    writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
    return draft;
  } catch (error) {
    const keepPartial = checkpoint.status === "partial" && checkpoint.partialFailure?.recoverable;
    checkpoint = {
      ...checkpoint,
      status: keepPartial ? "partial" : "failed",
      interrupted: error instanceof DOMException && error.name === "AbortError",
      lastError: error instanceof Error ? error.message : "目标规划生成失败",
    };
    writeGoalPlanningCheckpoint(input.conversationId, checkpoint);
    throw error;
  }
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
