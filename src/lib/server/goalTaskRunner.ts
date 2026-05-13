import { appendGoalLog, beginGoalTelemetry, failGoalTelemetry, finishGoalTelemetry, updateGoalTelemetry } from "@/lib/server/goalTelemetry";
import { buildAcceptanceJudgePrompt, buildLocalValidationRepairPrompt, buildSemanticRepairPrompt } from "@/lib/server/goalTaskAcceptancePrompt";
import { buildGoalTaskRunnerPrompt } from "@/lib/server/goalTaskPrompt";
import { ensureTaskWorkspace, writeTaskPromptFile } from "@/lib/server/workspace/conversationWorkspace";
import { buildTaskContextPack } from "@/lib/server/workspace/contextPack";
import { judgeTaskResult } from "@/lib/server/resultNotificationJudge";
import { deriveLegacyTaskResult } from "@/lib/taskResult/legacyAdapter";
import { validateTaskResultLocally } from "@/lib/taskResult/localValidation";
import { normalizeTaskResult } from "@/lib/taskResult/parseAndRepair";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type {
  Goal,
  InteractionRequirement,
  SubGoal,
  Task,
  TaskInstance,
  TaskResultViewKind,
  TaskRunArtifact,
  TaskRunErrorCategory,
} from "@/types/kiki";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { RuntimeEnvironment } from "@/types/runtime";
import type { AcceptanceReport, LocalValidationReport, TaskAcceptanceRuntimeState } from "@/types/taskAcceptance";
import type { TaskResult } from "@/types/taskResult";

import { streamClaudeCli } from "./claudeCli";
import { getRuntimeJobByRequestId, updateRuntimeJobExecution } from "./repositories/runtimeJobsRepository";

type RunGoalTaskInput = {
  requestId: string;
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
  conversationWorkspaceDir?: string;
  taskWorkspaceDir?: string;
  resumeContext?: string;
  initialTrajectory?: ExecutionTrajectoryStep[];
};

type DeliverableCheckStatus = "passed" | "failed" | "unknown";

type DeliverableCheck = {
  matched: boolean;
  confidence: "high" | "medium" | "low";
  deliveredArtifacts: string[];
  missingDeliverables: string[];
  criteriaResults: Array<{
    criterion: string;
    status: DeliverableCheckStatus;
    evidence?: string;
  }>;
  gapReason?: string;
};

type ParsedTaskRunnerResult = {
  summary: string;
  finalMessage: string;
  resultViewKind: TaskResultViewKind;
  awaitingUser: boolean;
  awaitingReason?: string;
  suggestedActions?: string[];
  artifacts: TaskRunArtifact[];
  taskResult: TaskResult | null;
  deliverableCheck: DeliverableCheck | null;
  interactionRequirement: InteractionRequirement;
  blocker: ExecutionBlocker | null;
  structuredOutput: Record<string, unknown> | null;
};

type TaskRunAttemptResult = ParsedTaskRunnerResult & {
  trajectory: ExecutionTrajectoryStep[];
  rawOutput: string;
  localValidationReport?: LocalValidationReport;
  acceptanceReport?: AcceptanceReport;
  acceptanceRuntime?: TaskAcceptanceRuntimeState;
};

type TaskReadinessInfoStatus = "available" | "missing_user" | "agent_retrievable" | "not_required";

type TaskReadinessInfoItem = {
  id: string;
  label: string;
  description: string;
  source: "user" | "agent" | "system";
  status: TaskReadinessInfoStatus;
  reason: string;
  value?: string;
  options?: string[];
};

type TaskReadinessCheck = {
  status: "ready" | "blocked";
  generatedAt: string;
  summary: string;
  items: TaskReadinessInfoItem[];
  missingUserInfo: TaskReadinessInfoItem[];
  agentRetrievableInfo: TaskReadinessInfoItem[];
  availableInfo: TaskReadinessInfoItem[];
};

function extractJsonObject(raw: string) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("任务执行结果不是合法 JSON");
  }
  return raw.slice(start, end + 1);
}

function classifyTaskRunError(error: unknown): TaskRunErrorCategory {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|中断|cancel/i.test(message)) return "aborted";
  if (/permission|权限|accept/i.test(message)) return "permission";
  if (/network|fetch|ECONN|timed out|timeout|socket/i.test(message)) return "transient_network";
  if (/spawn|ENOENT|启动失败|cli/i.test(message)) return "transient_cli";
  if (/json|parse|格式|schema/i.test(message)) return "logic";
  return "unknown";
}

function normalizeStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function uniqueStrings(items: Array<string | undefined>) {
  return Array.from(new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))));
}

function taskExecutionText(input: RunGoalTaskInput) {
  return [
    input.goal.title,
    input.goal.summary,
    input.subGoal.title,
    input.task.title,
    input.task.description,
    input.task.executionObjective,
    input.task.expectedOutcome,
    input.task.expectedResult?.description,
    input.task.expectedResult?.completionCriteria,
    input.task.triggerRule,
    input.instance.intro,
    input.resumeContext,
  ].filter(Boolean).join("\n");
}

function extractUserFeedback(input: RunGoalTaskInput) {
  const match = input.resumeContext?.match(/用户反馈：([\s\S]+)/);
  const feedback = match?.[1]?.trim();
  if (!feedback) return "";
  if (/^(补充缺失信息|补充具体信息|补充约束或偏好|说明暂时无法提供|确认继续)$/.test(feedback)) return "";
  return feedback;
}

function hasExplicitDepartureCity(input: RunGoalTaskInput, text: string) {
  if (extractUserFeedback(input)) return true;
  return /出发城市[:：]\s*[\u4e00-\u9fa5A-Za-z]{2,20}|出发地[:：]\s*[\u4e00-\u9fa5A-Za-z]{2,20}|从[\u4e00-\u9fa5A-Za-z]{2,20}(?:出发|飞)|[\u4e00-\u9fa5A-Za-z]{2,20}出发/.test(text);
}

function hasDateValue(text: string) {
  return /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|(?:明天|后天|下周|本周|周[一二三四五六日天])/.test(text);
}

function hasBudgetValue(input: RunGoalTaskInput, text: string) {
  if (/\d+\s*(元|块|人民币|rmb|¥)/i.test(text)) return true;
  // 用户已表态「不限制 / 无预算 / 任意预算 / 不设上限 / 按性价比 / 暂不限制」等口径，均视为已提供。
  if (/(暂不|暂时不|不|无|无需|无需要|没有|不设).{0,4}(限制|预算|上限|要求)/.test(text)) return true;
  if (/(任意|任何|无|没有).{0,4}预算/.test(text)) return true;
  if (/(性价比|按.{0,4}性价比|性价比.{0,4}优先)/.test(text)) return true;
  // 在用户反馈中明确填写了"预算"字段，无论文本是否命中数字，都视为用户已表态。
  const feedback = extractUserFeedback(input);
  if (feedback && /预算/.test(feedback)) return true;
  return false;
}

function buildTaskReadinessCheck(input: RunGoalTaskInput): TaskReadinessCheck {
  const text = taskExecutionText(input);
  const items: TaskReadinessInfoItem[] = [];
  const addItem = (item: TaskReadinessInfoItem) => {
    if (!items.some((entry) => entry.id === item.id)) items.push(item);
  };

  if (/航班|机票|飞往|往返|出发城市|出发地|从哪个城市|哪里出发/.test(text)) {
    const userFeedback = extractUserFeedback(input);
    const available = hasExplicitDepartureCity(input, text);
    addItem({
      id: "departure_city",
      label: "出发城市",
      description: "查询航班和价格必须先知道用户从哪个城市出发。",
      source: "user",
      status: available ? "available" : "missing_user",
      reason: available ? "已在任务上下文或用户反馈中找到出发城市。" : "这是用户个人行程信息，Agent 不能自行猜测或默认选择。",
      value: userFeedback || undefined,
      options: ["上海", "广州", "北京", "深圳", "其他城市"],
    });
    addItem({
      id: "flight_inventory",
      label: "航班时刻与价格",
      description: "可在具备出发城市、目的地和日期后由 Agent 查询。",
      source: "agent",
      status: "agent_retrievable",
      reason: "属于公开或可检索信息，不需要用户手动提供。",
    });
  }

  if (/出发日期|返回日期|往返日期|旅行日期|行程时间/.test(text)) {
    addItem({
      id: "travel_dates",
      label: "出行日期",
      description: "查询交通、住宿或行程安排需要明确日期范围。",
      source: "user",
      status: hasDateValue(text) ? "available" : "missing_user",
      reason: hasDateValue(text) ? "已在任务上下文中找到日期。" : "日期属于用户行程约束，缺失时不能默认假设。",
      options: ["补充出发日期", "补充返回日期", "补充完整日期范围"],
    });
  }

  if (/预算|价格上限|费用上限|人均|总价/.test(text)) {
    const budgetAvailable = hasBudgetValue(input, text);
    addItem({
      id: "budget_constraint",
      label: "预算约束",
      description: "涉及筛选或推荐时需要知道预算边界。",
      source: "user",
      status: budgetAvailable ? "available" : "missing_user",
      reason: budgetAvailable ? "已在任务上下文或用户反馈中找到预算信息。" : "预算是用户偏好，Agent 不能自行假设。",
      options: ["补充预算上限", "暂不限制预算", "按性价比优先"],
    });
  }

  return finalizeReadiness(items);
}

function finalizeReadiness(items: TaskReadinessInfoItem[]): TaskReadinessCheck {
  const missingUserInfo = items.filter((item) => item.status === "missing_user" && item.source === "user");
  const agentRetrievableInfo = items.filter((item) => item.status === "agent_retrievable");
  const availableInfo = items.filter((item) => item.status === "available");
  return {
    status: missingUserInfo.length ? "blocked" : "ready",
    generatedAt: new Date().toISOString(),
    summary: missingUserInfo.length
      ? `缺少 ${missingUserInfo.map((item) => item.label).join("、")}，需要用户补充后才能执行。`
      : "执行当前任务所需的用户侧关键信息已具备。",
    items,
    missingUserInfo,
    agentRetrievableInfo,
    availableInfo,
  };
}

type ReadinessJudgeVerdict = {
  fieldId: string;
  decision: "available" | "missing_user";
  reason: string;
};

async function judgeMissingFieldsWithClaude(
  input: RunGoalTaskInput,
  candidates: TaskReadinessInfoItem[],
  feedback: string,
): Promise<ReadinessJudgeVerdict[]> {
  if (!candidates.length || !feedback) return [];
  const fieldsBlock = candidates
    .map((item) => `- id: ${item.id}\n  label: ${item.label}\n  说明: ${item.description}`)
    .join("\n");
  const judgePrompt = [
    "你是一个只读的字段判定器。请基于「用户反馈」判断下列字段是否已经被用户表态过。",
    "判定规则：",
    "1. 用户给出明确数值、地点、日期 → available。",
    "2. 用户明确表示『不限制 / 不设上限 / 任意 / 由你判断 / 按性价比 / 没有要求』等口径，等同于已表态 → available。",
    "3. 用户没有提到该字段，或仅说『不知道 / 帮我看看 / 你来决定具体要选什么』而没有授权你自行选择 → missing_user。",
    "4. 用户授权你做决定（如『你来定 / 你判断 / 推荐就好 / 任意』）→ available。",
    "",
    "字段清单：",
    fieldsBlock,
    "",
    "用户反馈原文：",
    feedback,
    "",
    "请只返回严格 JSON，不要任何解释：",
    `{ "verdicts": [ { "fieldId": "<id>", "decision": "available" | "missing_user", "reason": "<不超过30字>" } ] }`,
  ].join("\n");
  let raw = "";
  try {
    raw = await runClaudePrompt(input, judgePrompt, "readonly");
  } catch (error) {
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_task_execute",
      level: "warn",
      phase: "executing",
      message: "Readiness 语义判定调用失败，回退到规则判定",
      details: error instanceof Error ? error.message : String(error),
      eventType: "readiness_semantic_judge",
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
    });
    return [];
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { verdicts?: ReadinessJudgeVerdict[] };
    const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
    return verdicts.filter(
      (v): v is ReadinessJudgeVerdict =>
        !!v && typeof v.fieldId === "string" && (v.decision === "available" || v.decision === "missing_user"),
    );
  } catch {
    return [];
  }
}

async function buildTaskReadinessCheckWithJudge(input: RunGoalTaskInput): Promise<TaskReadinessCheck> {
  const baseReadiness = buildTaskReadinessCheck(input);
  const feedback = extractUserFeedback(input);
  const ruleMissing = baseReadiness.items.filter(
    (item) => item.status === "missing_user" && item.source === "user",
  );
  // 规则未判 missing 或用户没有反馈，直接走规则结论，零额外成本。
  if (!ruleMissing.length || !feedback) return baseReadiness;

  const verdicts = await judgeMissingFieldsWithClaude(input, ruleMissing, feedback);
  if (!verdicts.length) return baseReadiness;

  const verdictMap = new Map(verdicts.map((v) => [v.fieldId, v]));
  const adjustedItems = baseReadiness.items.map((item) => {
    const verdict = verdictMap.get(item.id);
    if (!verdict || verdict.decision !== "available") return item;
    return {
      ...item,
      status: "available" as const,
      reason: `用户反馈已覆盖该字段：${verdict.reason}`,
      value: feedback,
    };
  });

  const upgraded = ruleMissing
    .filter((item) => verdictMap.get(item.id)?.decision === "available")
    .map((item) => item.id);
  appendGoalLog({
    requestId: input.requestId,
    scope: "goal_task_execute",
    level: upgraded.length ? "info" : "warn",
    phase: "executing",
    message: upgraded.length
      ? `Readiness 语义判定放行字段：${upgraded.join(", ")}`
      : "Readiness 语义判定未放行任何字段，仍判定为缺失",
    details: JSON.stringify({ feedback, verdicts }),
    eventType: "readiness_semantic_judge",
    goalId: input.goal.id,
    taskId: input.task.id,
    taskInstanceId: input.instance.id,
  });
  updateGoalTelemetry({
    requestId: input.requestId,
    scope: "goal_task_execute",
    phase: "executing",
    message: "Readiness 语义判定完成",
    goalId: input.goal.id,
    taskId: input.task.id,
    taskInstanceId: input.instance.id,
    summary: upgraded.length ? `放行字段：${upgraded.join(", ")}` : "未放行字段",
  });
  return finalizeReadiness(adjustedItems);
}

function buildReadinessBlockedTaskResult(input: RunGoalTaskInput, readiness: TaskReadinessCheck): TaskResult {
  const missingLabels = readiness.missingUserInfo.map((item) => item.label);
  return {
    schemaVersion: 1,
    taskId: input.task.id,
    instanceId: input.instance.id,
    title: "需要补充信息后继续",
    status: "pending_user",
    blocks: [
      { kind: "callout", tone: "warn", text: "当前任务缺少用户才能提供的必要信息，KiKi 已暂停执行，没有生成基于猜测的方案。" },
      { kind: "heading", level: 2, text: "缺失的必要信息" },
      { kind: "list", ordered: false, items: missingLabels },
      {
        kind: "key_value",
        entries: readiness.items.map((item) => ({
          label: item.label,
          value: `${item.status === "missing_user" ? "缺失，需用户提供" : item.status === "agent_retrievable" ? "Agent 可自行获取" : "已具备"}：${item.reason}`,
          emphasis: item.status === "missing_user",
        })),
      },
    ],
    meta: {
      producedAt: readiness.generatedAt,
    },
  };
}

function buildReadinessBlockedResult(input: RunGoalTaskInput, readiness: TaskReadinessCheck): ParsedTaskRunnerResult {
  const firstMissing = readiness.missingUserInfo[0];
  const question =
    readiness.missingUserInfo.length === 1
      ? `请补充${firstMissing.label}，KiKi 才能继续执行「${input.task.title.replace(/^任务\d+：/, "")}」。`
      : `请补充以下必要信息：${readiness.missingUserInfo.map((item) => item.label).join("、")}。`;
  const options = uniqueStrings(readiness.missingUserInfo.flatMap((item) => item.options ?? [])).slice(0, 5);
  const suggestedActions = uniqueStrings([...options, "填写其他信息"]).slice(0, 6);
  const taskResult = buildReadinessBlockedTaskResult(input, readiness);
  const interactionRequirement: InteractionRequirement = {
    type: "provide_context",
    timing: "before_execution",
    reason: readiness.summary,
    question,
    options: options.length ? options : ["补充具体信息", "补充约束或偏好", "说明暂时无法提供"],
    suggestedActions,
    shouldNotifyUser: true,
  };
  const deliverableCheck = buildFallbackDeliverableCheck(input, readiness.summary);
  return {
    summary: "需要你补充关键信息后才能继续执行。",
    finalMessage: readiness.summary,
    resultViewKind: input.task.resultViewKind ?? input.task.executionKind ?? "generic_result",
    awaitingUser: true,
    awaitingReason: readiness.summary,
    suggestedActions,
    artifacts: [],
    taskResult,
    deliverableCheck: {
      ...deliverableCheck,
      confidence: "high",
      missingDeliverables: readiness.missingUserInfo.map((item) => item.label),
      gapReason: readiness.summary,
    },
    interactionRequirement,
    blocker: null,
    structuredOutput: {
      taskReadiness: readiness,
      taskResult,
      interactionRequirement,
    },
  };
}

function normalizeDeliverableCheck(value: unknown): DeliverableCheck | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    matched?: unknown;
    confidence?: unknown;
    delivered_artifacts?: unknown;
    deliveredArtifacts?: unknown;
    missing_deliverables?: unknown;
    missingDeliverables?: unknown;
    criteria_results?: unknown;
    criteriaResults?: unknown;
    gap_reason?: unknown;
    gapReason?: unknown;
  };
  const confidence = raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low" ? raw.confidence : "low";
  const rawCriteria = Array.isArray(raw.criteria_results)
    ? raw.criteria_results
    : Array.isArray(raw.criteriaResults)
      ? raw.criteriaResults
      : [];
  const criteriaResults = rawCriteria
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const status: DeliverableCheckStatus =
        item.status === "passed" || item.status === "failed" || item.status === "unknown" ? item.status : "unknown";
      return {
        criterion: typeof item.criterion === "string" && item.criterion.trim() ? item.criterion.trim() : "未命名验收标准",
        status,
        evidence: typeof item.evidence === "string" ? item.evidence.trim() : undefined,
      };
    });

  return {
    matched: raw.matched === true,
    confidence,
    deliveredArtifacts: normalizeStringList(raw.delivered_artifacts ?? raw.deliveredArtifacts),
    missingDeliverables: normalizeStringList(raw.missing_deliverables ?? raw.missingDeliverables),
    criteriaResults,
    gapReason: typeof raw.gap_reason === "string" ? raw.gap_reason.trim() : typeof raw.gapReason === "string" ? raw.gapReason.trim() : undefined,
  };
}

function normalizeInteractionRequirement(
  value: unknown,
  fallback?: Partial<InteractionRequirement>,
): InteractionRequirement {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawType = raw.type ?? fallback?.type;
  const type =
    rawType === "confirm" ||
    rawType === "answer" ||
    rawType === "provide_context" ||
    rawType === "perform_offline_action" ||
    rawType === "deliverable_gap" ||
    rawType === "agent_revision_required"
      ? rawType
      : "none";
  const rawTiming = raw.timing ?? fallback?.timing;
  const timing =
    rawTiming === "before_execution" ||
    rawTiming === "during_execution" ||
    rawTiming === "after_agent_output" ||
    rawTiming === "core_task_step"
      ? rawTiming
      : type === "none"
        ? "not_required"
        : type === "answer" || type === "perform_offline_action"
          ? "core_task_step"
          : "after_agent_output";
  const suggestedActions = Array.isArray(raw.suggested_actions)
    ? normalizeStringList(raw.suggested_actions)
    : Array.isArray(raw.suggestedActions)
      ? normalizeStringList(raw.suggestedActions)
      : fallback?.suggestedActions;

  return {
    type,
    timing,
    reason:
      typeof raw.reason === "string" && raw.reason.trim()
        ? raw.reason.trim()
        : fallback?.reason || "",
    question: typeof raw.question === "string" && raw.question.trim() ? raw.question.trim() : fallback?.question,
    options: Array.isArray(raw.options) ? normalizeStringList(raw.options) : fallback?.options,
    suggestedActions,
    shouldNotifyUser:
      typeof raw.should_notify_user === "boolean"
        ? raw.should_notify_user
        : typeof raw.shouldNotifyUser === "boolean"
          ? raw.shouldNotifyUser
          : fallback?.shouldNotifyUser ?? (type === "confirm" || type === "answer" || type === "provide_context" || type === "perform_offline_action"),
  };
}

function textForUserInputDetection(result: ParsedTaskRunnerResult) {
  return [
    result.summary,
    result.finalMessage,
    result.awaitingReason,
    result.interactionRequirement.reason,
    result.interactionRequirement.question,
    ...(result.suggestedActions ?? []),
    ...(result.deliverableCheck?.missingDeliverables ?? []),
    result.deliverableCheck?.gapReason,
  ].filter(Boolean).join("\n");
}

function looksLikeMissingUserContext(result: ParsedTaskRunnerResult) {
  if (!result.awaitingUser) return false;
  if (result.interactionRequirement.type === "provide_context" || result.interactionRequirement.type === "answer") return true;
  const text = textForUserInputDetection(result);
  return /需要用户|请用户|用户确认|用户补充|补充.*信息|提供.*信息|缺少.*信息|确认.*城市|出发城市|出发地|目的地|预算|偏好|账号|登录|授权|选择|作答/.test(text);
}

function extractExampleOptions(text: string) {
  const matches = Array.from(text.matchAll(/(?:如|例如|比如|包含|包括)[:：]?\s*([^\n。；;，,]+(?:[\/、，,][^\n。；;，,]+){1,6})/g));
  const options = matches.flatMap((match) => match[1].split(/[\/、，,]/).map((item) => item.trim()));
  return uniqueStrings(options)
    .filter((item) => item.length >= 2 && item.length <= 16)
    .slice(0, 5);
}

const GENERIC_CONTEXT_OPTIONS = new Set(["补充具体信息", "补充缺失信息", "补充约束或偏好", "说明暂时无法提供", "填写其他信息"]);

function normalizeSuggestedContextOptions(values: string[]) {
  const options = uniqueStrings(values)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 24);
  const specificOptions = options.filter((item) => !GENERIC_CONTEXT_OPTIONS.has(item));
  return (specificOptions.length ? specificOptions : options).slice(0, 3);
}

function inferContextOptionsFromText(text: string) {
  const normalized = text.replace(/\s+/g, "");
  if (/住宿区域.*酒店类型|酒店类型.*住宿区域|住宿偏好|住在哪|住哪片|酒店区域/.test(normalized)) {
    return ["海滩区 + 度假酒店", "市中心 + 高性价比酒店", "度假区/珍珠岛 + 一站式酒店"];
  }
  if (/住宿区域|酒店区域|住在哪|住哪片/.test(normalized)) {
    return ["海滩区", "市中心", "度假区/珍珠岛"];
  }
  if (/酒店类型|酒店档次|酒店偏好|酒店星级|房型偏好/.test(normalized)) {
    return ["高性价比经济型", "舒适型四星", "度假型五星/海景"];
  }
  if (/预算|费用|价格/.test(normalized)) {
    return ["控制预算", "舒适优先", "高性价比优先"];
  }
  if (/出发城市|出发地|从哪里出发/.test(normalized)) {
    return ["上海", "广州", "北京"];
  }
  if (/出发日期|返回日期|往返日期|旅行日期|行程时间/.test(normalized)) {
    return ["补充出发日期", "补充返回日期", "补充完整日期范围"];
  }
  return [];
}

function defaultContextOptions(result: ParsedTaskRunnerResult) {
  const text = textForUserInputDetection(result);
  const exampleOptions = extractExampleOptions(text);
  const inferredOptions = inferContextOptionsFromText(text);
  const options = normalizeSuggestedContextOptions([...exampleOptions, ...inferredOptions]);
  if (options.length >= 2) return options;
  return ["补充具体信息", "补充约束或偏好", "说明暂时无法提供"];
}

function normalizeBlockerLabel(value: string, index: number) {
  return value
    .replace(/^请(补充|确认|选择|提供)/, "")
    .replace(/[。；;：:，,].*$/, "")
    .trim()
    .slice(0, 24) || `待补充信息 ${index + 1}`;
}

function buildReadinessFromUserBlockers(blockers: string[], summary: string): TaskReadinessCheck | null {
  const uniqueBlockers = uniqueStrings(blockers);
  if (!uniqueBlockers.length) return null;
  const items = uniqueBlockers.map((blocker, index) => ({
    id: `user_blocker_${index + 1}`,
    label: normalizeBlockerLabel(blocker, index),
    description: blocker,
    source: "user" as const,
    status: "missing_user" as const,
    reason: blocker,
    options: (() => {
      const options = normalizeSuggestedContextOptions(
        inferContextOptionsFromText(`${normalizeBlockerLabel(blocker, index)}\n${blocker}`),
      );
      return options.length ? options : ["补充具体信息", "补充约束或偏好", "说明暂时无法提供"];
    })(),
  }));
  return {
    status: "blocked",
    generatedAt: new Date().toISOString(),
    summary: summary || `缺少 ${items.map((item) => item.label).join("、")}，需要用户一次性补充后才能执行。`,
    items,
    missingUserInfo: items,
    agentRetrievableInfo: [],
    availableInfo: [],
  };
}

function buildPendingUserTaskResult(input: RunGoalTaskInput, result: ParsedTaskRunnerResult): TaskResult {
  const question = result.interactionRequirement.question || result.awaitingReason || "请补充完成任务所需的关键信息。";
  const missing = result.deliverableCheck?.missingDeliverables?.length
    ? result.deliverableCheck.missingDeliverables
    : [question];
  return {
    schemaVersion: 1,
    taskId: input.task.id,
    instanceId: input.instance.id,
    title: "需要补充信息后继续",
    status: "pending_user",
    blocks: [
      { kind: "callout", tone: "warn", text: "当前缺少用户才能提供的关键信息，KiKi 已暂停执行，未生成基于猜测的方案。" },
      { kind: "heading", level: 2, text: "需要你补充" },
      { kind: "paragraph", text: question },
      { kind: "list", ordered: false, items: missing },
    ],
    meta: {
      producedAt: new Date().toISOString(),
    },
  };
}

function coerceMissingUserContextBlocker(input: RunGoalTaskInput, result: ParsedTaskRunnerResult): ParsedTaskRunnerResult {
  if (!looksLikeMissingUserContext(result)) return result;
  const question = result.interactionRequirement.question || result.awaitingReason || "请补充完成任务所需的关键信息。";
  const reason = result.awaitingReason || result.interactionRequirement.reason || question;
  const readiness =
    result.structuredOutput?.taskReadiness ??
    buildReadinessFromUserBlockers(result.deliverableCheck?.missingDeliverables?.length ? result.deliverableCheck.missingDeliverables : [question], reason);
  const options = result.interactionRequirement.options?.length
    ? result.interactionRequirement.options
    : defaultContextOptions(result);
  const suggestedActions = uniqueStrings([
    ...(options ?? []),
    ...(result.suggestedActions ?? []),
    "填写其他信息",
  ]).slice(0, 5);
  const deliverableCheck = result.deliverableCheck ?? buildFallbackDeliverableCheck(input, reason);
  const normalizedDeliverableCheck: DeliverableCheck = {
    ...deliverableCheck,
    matched: false,
    confidence: "high",
    missingDeliverables: deliverableCheck.missingDeliverables.length ? deliverableCheck.missingDeliverables : [question],
    gapReason: deliverableCheck.gapReason || reason,
  };
  const interactionRequirement: InteractionRequirement = {
    ...result.interactionRequirement,
    type: "provide_context",
    timing: result.interactionRequirement.timing === "not_required" ? "before_execution" : result.interactionRequirement.timing,
    reason,
    question,
    options,
    suggestedActions,
    shouldNotifyUser: true,
  };
  const taskResult = buildPendingUserTaskResult(input, { ...result, interactionRequirement, deliverableCheck: normalizedDeliverableCheck });
  return {
    ...result,
    summary: "需要你补充关键信息后才能继续执行。",
    finalMessage: reason,
    awaitingUser: true,
    awaitingReason: reason,
    suggestedActions,
    artifacts: [],
    taskResult,
    deliverableCheck: normalizedDeliverableCheck,
    interactionRequirement,
    structuredOutput: {
      ...(result.structuredOutput ?? {}),
      ...(readiness ? { taskReadiness: readiness } : {}),
      taskResult,
      deliverableCheck: normalizedDeliverableCheck,
      interactionRequirement,
      blockedByMissingUserContext: true,
    },
  };
}

function parseTaskRunnerResult(input: RunGoalTaskInput, raw: string, fallbackKind: TaskResultViewKind): ParsedTaskRunnerResult {
  const parsed = JSON.parse(extractJsonObject(raw)) as {
    summary?: string;
    final_message?: string;
    result_view_kind?: TaskResultViewKind;
    awaiting_user?: boolean;
    awaiting_reason?: string;
    suggested_actions?: string[];
    interaction_requirement?: unknown;
    artifacts?: Array<{ label?: string; kind?: TaskRunArtifact["kind"]; content?: string; href?: string }>;
    task_result?: unknown;
    taskResult?: unknown;
    deliverable_check?: unknown;
    structured_output?: Record<string, unknown> | null;
  };
  const taskResult = normalizeTaskResult(parsed.task_result ?? parsed.taskResult, {
    taskId: input.task.id,
    instanceId: input.instance.id,
    title: input.task.expectedOutcome || input.task.title,
  });
  const legacyFromBlocks = taskResult ? deriveLegacyTaskResult(taskResult) : null;
  const suggestedActions = Array.isArray(parsed.suggested_actions)
    ? parsed.suggested_actions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;
  const legacyInteractionType = parsed.awaiting_user ? "confirm" : "none";
  const interactionRequirement = normalizeInteractionRequirement(parsed.interaction_requirement, {
    type: legacyInteractionType,
    reason: parsed.awaiting_reason?.trim() || "",
    suggestedActions,
    shouldNotifyUser: parsed.awaiting_user,
  });
  const awaitingUser =
    Boolean(parsed.awaiting_user) ||
    (interactionRequirement.type !== "none" &&
      interactionRequirement.type !== "deliverable_gap" &&
      interactionRequirement.type !== "agent_revision_required");
  return {
    summary: parsed.summary?.trim() || legacyFromBlocks?.summary || "任务执行完成。",
    finalMessage: parsed.final_message?.trim() || legacyFromBlocks?.finalMessage || parsed.summary?.trim() || "任务执行完成。",
    resultViewKind: parsed.result_view_kind || fallbackKind || "generic_result",
    awaitingUser,
    awaitingReason: parsed.awaiting_reason?.trim() || interactionRequirement.reason,
    suggestedActions,
    artifacts:
      Array.isArray(parsed.artifacts) && parsed.artifacts.length > 0
        ? parsed.artifacts
            .filter((item) => item?.label)
            .map((item, index) => ({
              id: `artifact-${index + 1}`,
              label: item.label!.trim(),
              kind: item.kind || "other",
              content: item.content,
              href: item.href,
            }))
        : legacyFromBlocks?.artifacts ?? [],
    taskResult,
    deliverableCheck: normalizeDeliverableCheck(parsed.deliverable_check),
    interactionRequirement,
    blocker: null,
    structuredOutput: {
      ...(parsed.structured_output ?? {}),
      ...(taskResult ? { taskResult } : {}),
    },
  };
}

function tryParseTaskRunnerResult(input: RunGoalTaskInput, raw: string, fallbackKind: TaskResultViewKind) {
  try {
    return {
      result: parseTaskRunnerResult(input, raw, fallbackKind),
      error: undefined,
    };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : "任务结果解析失败",
    };
  }
}

function normalizeAcceptanceReport(value: unknown): AcceptanceReport {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const verdict =
    raw.verdict === "pass" || raw.verdict === "needs_repair" || raw.verdict === "needs_user" || raw.verdict === "fail"
      ? raw.verdict
      : "needs_repair";
  const confidence = raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low" ? raw.confidence : "low";
  const stringItems = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
  const criteria = (items: unknown) =>
    Array.isArray(items)
      ? items
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => ({
            criterion: typeof item.criterion === "string" && item.criterion.trim() ? item.criterion.trim() : "未命名标准",
            evidence: typeof item.evidence === "string" ? item.evidence.trim() : "",
          }))
      : [];
  const failedCriteria = Array.isArray(raw.failedCriteria)
    ? raw.failedCriteria
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => {
          const severity: AcceptanceReport["failedCriteria"][number]["severity"] =
            item.severity === "critical" || item.severity === "major" || item.severity === "minor" ? item.severity : "major";
          return {
            criterion: typeof item.criterion === "string" && item.criterion.trim() ? item.criterion.trim() : "未命名标准",
            evidence: typeof item.evidence === "string" ? item.evidence.trim() : "",
            severity,
            repairableByAgent: item.repairableByAgent !== false,
            requiresUserInput: item.requiresUserInput === true,
          };
        })
    : [];
  const blockAssessment = raw.blockAssessment && typeof raw.blockAssessment === "object" ? raw.blockAssessment as Record<string, unknown> : {};
  const repairStrategy = raw.repairStrategy && typeof raw.repairStrategy === "object" ? raw.repairStrategy as Record<string, unknown> : {};
  const mode =
    repairStrategy.mode === "presentation_only" ||
    repairStrategy.mode === "content_gap" ||
    repairStrategy.mode === "restructure" ||
    repairStrategy.mode === "rerun_with_tools"
      ? repairStrategy.mode
      : "content_gap";

  return {
    verdict,
    confidence,
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "验收结果需要补齐。",
    hardFailures: stringItems(raw.hardFailures),
    passedCriteria: criteria(raw.passedCriteria),
    failedCriteria,
    blockAssessment: {
      keepBlocks: stringItems(blockAssessment.keepBlocks),
      rewriteBlocks: stringItems(blockAssessment.rewriteBlocks),
      missingBlocks: stringItems(blockAssessment.missingBlocks) as AcceptanceReport["blockAssessment"]["missingBlocks"],
    },
    repairStrategy: {
      mode,
      reuseExistingContent: repairStrategy.reuseExistingContent !== false,
      allowNewToolCalls: repairStrategy.allowNewToolCalls === true,
    },
    repairInstructions: stringItems(raw.repairInstructions),
    userBlockers: stringItems(raw.userBlockers),
  };
}

function parseAcceptanceReport(raw: string) {
  return normalizeAcceptanceReport(JSON.parse(extractJsonObject(raw)));
}

function buildFallbackDeliverableCheck(input: RunGoalTaskInput, reason: string): DeliverableCheck {
  const criteria = [
    input.task.expectedOutcome,
    input.task.expectedResult?.description,
    input.task.expectedResult?.completionCriteria,
  ].filter((item): item is string => Boolean(item?.trim()));

  return {
    matched: false,
    confidence: "low",
    deliveredArtifacts: [],
    missingDeliverables: [input.task.expectedOutcome],
    criteriaResults: criteria.map((criterion) => ({
      criterion,
      status: "unknown",
      evidence: reason,
    })),
    gapReason: reason,
  };
}

function shouldRetry(category: TaskRunErrorCategory, attemptCount: number) {
  if (attemptCount >= 2) return false;
  return category === "transient_cli" || category === "transient_network";
}

function detectAgentReplanning(rawOutput: string): { detected: boolean; reason: string; matched?: string } {
  if (!rawOutput) return { detected: false, reason: "" };
  const text = rawOutput.slice(0, 8000);
  const replanningKeywords = [
    "重新规划",
    "重新拆解",
    "重新制定计划",
    "重新梳理思路",
    "从零开始",
    "重新搜索",
    "整体计划如下",
    "Step 1：明确目标",
    "Plan:",
    "重新分析任务",
  ];
  for (const keyword of replanningKeywords) {
    if (text.includes(keyword)) {
      return { detected: true, reason: `Agent 输出中包含重新规划关键词「${keyword}」`, matched: keyword };
    }
  }
  return { detected: false, reason: "未检测到重新规划信号" };
}

function shouldCreateUserBlocker(interactionRequirement: InteractionRequirement) {
  return (
    interactionRequirement.type === "confirm" ||
    interactionRequirement.type === "answer" ||
    interactionRequirement.type === "provide_context" ||
    interactionRequirement.type === "perform_offline_action"
  );
}

function shouldAutoReflect(result: ParsedTaskRunnerResult) {
  return (
    result.awaitingUser &&
    (result.interactionRequirement.type === "agent_revision_required" ||
      result.interactionRequirement.type === "deliverable_gap")
  );
}

function createExecutionBlocker(input: RunGoalTaskInput, result: ParsedTaskRunnerResult, trajectory: ExecutionTrajectoryStep[]): ExecutionBlocker | null {
  if (!result.awaitingUser || !shouldCreateUserBlocker(result.interactionRequirement)) return null;
  const now = new Date().toISOString();
  return {
    executionId: input.requestId,
    taskId: input.task.id,
    instanceId: input.instance.id,
    blockedStepIndex: Math.max(trajectory.length - 1, 0),
    resumeToken: `resume-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    interactionRequirement: result.interactionRequirement,
    resumeStrategy:
      result.interactionRequirement.type === "confirm" && result.interactionRequirement.timing === "after_agent_output"
        ? "complete_on_approve"
        : "rerun_with_feedback",
    status: "waiting",
    createdAt: now,
  };
}

function createTrajectoryStep(input: Omit<ExecutionTrajectoryStep, "id" | "index" | "startedAt"> & {
  index: number;
  startedAt?: string;
}): ExecutionTrajectoryStep {
  return {
    id: `trajectory-${Date.now()}-${input.index}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: input.startedAt ?? new Date().toISOString(),
    ...input,
  };
}

function persistTrajectorySnapshot(requestId: string, trajectory: ExecutionTrajectoryStep[]) {
  const job = getRuntimeJobByRequestId(requestId);
  if (!job) return;
  updateRuntimeJobExecution(job.id, { trajectory });
}

function progressPayloadWithTrajectory(trajectory: ExecutionTrajectoryStep[], resultPayload?: Record<string, unknown> | null) {
  return {
    ...(resultPayload ?? {}),
    trajectory,
  };
}

function resolveGoalTaskWorkspace(input: RunGoalTaskInput) {
  if (input.taskWorkspaceDir) return input.taskWorkspaceDir;
  if (input.goal.conversationId) {
    return ensureTaskWorkspace({
      conversationId: input.goal.conversationId,
      taskId: input.task.id,
      instanceId: input.instance.id,
    });
  }
  throw new Error("任务缺少 conversationId，无法进入隔离 task workspace");
}

async function runClaudePrompt(input: RunGoalTaskInput, message: string, permissionMode: RuntimeEnvironment["permissionMode"]) {
  let finalMessage = "";
  await streamClaudeCli({
    message,
    workingDirectory: resolveGoalTaskWorkspace(input),
    cliPath: input.runtimeEnv.cliPath,
    permissionMode,
    claudeSessionId: undefined,
    contextPack: buildTaskContextPack({
      goal: input.goal,
      subGoal: input.subGoal,
      task: input.task,
      instance: input.instance,
      trajectory: input.initialTrajectory,
      resumeContext: input.resumeContext,
    }),
    workspacePolicy: "task",
    onEvent: (event) => {
      if (event.type === "delta" && event.text.trim()) finalMessage += event.text;
      if (event.type === "message") finalMessage = event.content;
      if (event.type === "error") throw new Error(event.message);
    },
  });
  return finalMessage;
}

function buildUnfinishedResult(input: RunGoalTaskInput, options: {
  currentResult: ParsedTaskRunnerResult | null;
  reason: string;
  localValidationReport?: LocalValidationReport;
  acceptanceReport?: AcceptanceReport;
  acceptanceRuntime: TaskAcceptanceRuntimeState;
}): ParsedTaskRunnerResult {
  const deliverableCheck = options.currentResult?.deliverableCheck ?? buildFallbackDeliverableCheck(input, options.reason);
  const interactionRequirement: InteractionRequirement = {
    type: "agent_revision_required",
    timing: "after_agent_output",
    reason: options.reason,
    suggestedActions: ["重新执行任务", "调整任务完成标准"],
    shouldNotifyUser: false,
  };
  return {
    summary: "任务未达到完成标准。",
    finalMessage: [options.currentResult?.finalMessage, options.reason].filter(Boolean).join("\n\n"),
    resultViewKind: options.currentResult?.resultViewKind ?? input.task.resultViewKind ?? input.task.executionKind ?? "generic_result",
    awaitingUser: true,
    awaitingReason: options.reason,
    suggestedActions: interactionRequirement.suggestedActions,
    artifacts: options.currentResult?.artifacts ?? [],
    taskResult: options.currentResult?.taskResult ?? null,
    deliverableCheck: {
      ...deliverableCheck,
      matched: false,
      gapReason: options.reason,
    },
    interactionRequirement,
    blocker: null,
    structuredOutput: {
      ...(options.currentResult?.structuredOutput ?? {}),
      localValidationReport: options.localValidationReport,
      acceptanceReport: options.acceptanceReport,
      acceptanceRuntime: options.acceptanceRuntime,
    },
  };
}

function buildNeedsUserFromAcceptance(input: RunGoalTaskInput, result: ParsedTaskRunnerResult, report: AcceptanceReport, runtime: TaskAcceptanceRuntimeState) {
  const userBlockers = uniqueStrings(report.userBlockers.length ? report.userBlockers : [report.summary]);
  const reason = userBlockers.length ? userBlockers.join("；") : report.summary;
  const readiness = buildReadinessFromUserBlockers(userBlockers, reason);
  const options = normalizeSuggestedContextOptions([
    ...(readiness?.missingUserInfo.flatMap((item) => item.options ?? []) ?? []),
    ...defaultContextOptions({
      ...result,
      awaitingUser: true,
      awaitingReason: reason,
      interactionRequirement: {
        ...result.interactionRequirement,
        type: "provide_context",
        timing: "after_agent_output",
        reason,
        question: userBlockers.length > 1 ? `请一次性补充以下信息：${userBlockers.map((item, index) => `${index + 1}. ${item}`).join("；")}` : reason,
      },
    }),
  ]);
  const interactionRequirement: InteractionRequirement = {
    type: "provide_context",
    timing: "after_agent_output",
    reason,
    question: userBlockers.length > 1 ? `请一次性补充以下信息：${userBlockers.map((item, index) => `${index + 1}. ${item}`).join("；")}` : reason,
    options: options.length ? options : ["补充具体信息", "补充约束或偏好", "说明暂时无法提供"],
    suggestedActions: options.length ? options : ["补充具体信息", "补充约束或偏好"],
    shouldNotifyUser: true,
  };
  return coerceMissingUserContextBlocker(input, {
    ...result,
    summary: "需要你补充信息后才能继续。",
    finalMessage: reason,
    awaitingUser: true,
    awaitingReason: reason,
    suggestedActions: interactionRequirement.suggestedActions,
    interactionRequirement,
    structuredOutput: {
      ...(result.structuredOutput ?? {}),
      ...(readiness ? { taskReadiness: readiness } : {}),
      acceptanceReport: report,
      acceptanceRuntime: runtime,
    },
  });
}

function applyAcceptedDeliverableCheck(input: RunGoalTaskInput, result: ParsedTaskRunnerResult, report: AcceptanceReport): ParsedTaskRunnerResult {
  const criteriaResults = report.passedCriteria.length
    ? report.passedCriteria.map((item) => ({
        criterion: item.criterion,
        status: "passed" as const,
        evidence: item.evidence,
      }))
    : [
        {
          criterion: input.task.expectedResult?.completionCriteria || input.task.expectedOutcome,
          status: "passed" as const,
          evidence: report.summary,
        },
      ];
  return {
    ...result,
    deliverableCheck: {
      matched: true,
      confidence: report.confidence,
      deliveredArtifacts: result.deliverableCheck?.deliveredArtifacts?.length ? result.deliverableCheck.deliveredArtifacts : ["task_result.blocks"],
      missingDeliverables: [],
      criteriaResults,
      gapReason: "",
    },
  };
}

async function runLocalRepairCycle(input: RunGoalTaskInput, state: {
  rawOutput: string;
  parsedResult: ParsedTaskRunnerResult | null;
  parseError?: string;
  runtime: TaskAcceptanceRuntimeState;
  appendTrajectory: (step: Omit<ExecutionTrajectoryStep, "id" | "index" | "startedAt"> & { startedAt?: string }) => ExecutionTrajectoryStep[];
}) {
  let rawOutput = state.rawOutput;
  let parsedResult = state.parsedResult;
  let parseError = state.parseError;
  let lastReport = validateTaskResultLocally({
    task: input.task,
    rawOutput,
    parsedResult,
    parseError,
  });

  for (let attempt = 1; attempt <= 2 && !lastReport.passed; attempt += 1) {
    state.runtime.localValidationReports.push(lastReport);
    state.runtime.repairAttempts.push({
      type: "local_validation",
      attempt,
      promptKind: "local_validation_repair",
      startedAt: new Date().toISOString(),
      status: "running",
      issueCodes: lastReport.issues.map((item) => item.code),
    });
    state.appendTrajectory({
      type: "system",
      status: "running",
      title: `本地校验未通过，开始第 ${attempt} 次结构修复`,
      thought: lastReport.issues.map((item) => `${item.code}: ${item.message}`).join("\n"),
    });
    const repairPrompt = buildLocalValidationRepairPrompt({
      goal: input.goal,
      subGoal: input.subGoal,
      task: input.task,
      instance: input.instance,
      rawAgentOutput: rawOutput,
      parsedResult,
      report: lastReport,
    });
    rawOutput = await runClaudePrompt(input, repairPrompt, lastReport.allowToolCalls ? input.runtimeEnv.permissionMode : "readonly");
    const parsed = tryParseTaskRunnerResult(input, rawOutput, input.task.resultViewKind ?? input.task.executionKind ?? "generic_result");
    parsedResult = parsed.result;
    parseError = parsed.error;
    lastReport = validateTaskResultLocally({
      task: input.task,
      rawOutput,
      parsedResult,
      parseError,
    });
    const runtimeAttempt = state.runtime.repairAttempts[state.runtime.repairAttempts.length - 1];
    if (runtimeAttempt) {
      runtimeAttempt.finishedAt = new Date().toISOString();
      runtimeAttempt.status = lastReport.passed ? "passed" : "failed";
    }
  }

  state.runtime.localValidationReports.push(lastReport);
  return { rawOutput, parsedResult, parseError, localValidationReport: lastReport };
}

async function completeWithAcceptance(input: RunGoalTaskInput, state: {
  rawOutput: string;
  parsedResult: ParsedTaskRunnerResult | null;
  parseError?: string;
  trajectory: ExecutionTrajectoryStep[];
  appendTrajectory: (step: Omit<ExecutionTrajectoryStep, "id" | "index" | "startedAt"> & { startedAt?: string }) => ExecutionTrajectoryStep[];
}): Promise<TaskRunAttemptResult> {
  const runtime: TaskAcceptanceRuntimeState = {
    localValidationReports: [],
    acceptanceReports: [],
    repairAttempts: [],
  };

  let local = await runLocalRepairCycle(input, { ...state, runtime });
  if (!local.localValidationReport.passed || !local.parsedResult) {
    const failed = buildUnfinishedResult(input, {
      currentResult: local.parsedResult,
      reason: "本地校验失败，任务没有产出可展示、可验收的结果。",
      localValidationReport: local.localValidationReport,
      acceptanceRuntime: runtime,
    });
    return { ...failed, rawOutput: local.rawOutput, trajectory: state.trajectory, localValidationReport: local.localValidationReport, acceptanceRuntime: runtime };
  }

  let currentResult = coerceMissingUserContextBlocker(input, local.parsedResult);
  if (currentResult.awaitingUser) {
    return {
      ...currentResult,
      rawOutput: local.rawOutput,
      trajectory: state.trajectory,
      localValidationReport: local.localValidationReport,
      acceptanceRuntime: runtime,
      structuredOutput: {
        ...(currentResult.structuredOutput ?? {}),
        localValidationReport: local.localValidationReport,
        acceptanceRuntime: runtime,
      },
    };
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    state.appendTrajectory({
      type: "system",
      status: "running",
      title: `验收员正在检查结果（第 ${attempt} 次）`,
      thought: "检查任务结果是否满足完成标准。",
    });
    const judgePrompt = buildAcceptanceJudgePrompt({
      goal: input.goal,
      subGoal: input.subGoal,
      task: input.task,
      instance: input.instance,
      localValidationReport: local.localValidationReport,
      currentResult,
    });
    const judgeRaw = await runClaudePrompt(input, judgePrompt, "readonly");
    const acceptanceReport = parseAcceptanceReport(judgeRaw);
    runtime.acceptanceReports.push(acceptanceReport);

    if (acceptanceReport.verdict === "pass") {
      const acceptedResult = applyAcceptedDeliverableCheck(input, currentResult, acceptanceReport);
      return {
        ...acceptedResult,
        rawOutput: local.rawOutput,
        trajectory: state.trajectory,
        localValidationReport: local.localValidationReport,
        acceptanceReport,
        acceptanceRuntime: runtime,
        structuredOutput: {
          ...(acceptedResult.structuredOutput ?? {}),
          deliverableCheck: acceptedResult.deliverableCheck,
          localValidationReport: local.localValidationReport,
          acceptanceReport,
          acceptanceRuntime: runtime,
        },
      };
    }

    if (acceptanceReport.verdict === "needs_user") {
      const userResult = buildNeedsUserFromAcceptance(input, currentResult, acceptanceReport, runtime);
      return { ...userResult, rawOutput: local.rawOutput, trajectory: state.trajectory, localValidationReport: local.localValidationReport, acceptanceReport, acceptanceRuntime: runtime };
    }

    if (acceptanceReport.verdict === "fail" || attempt >= 3) {
      const failed = buildUnfinishedResult(input, {
        currentResult,
        reason: acceptanceReport.summary,
        localValidationReport: local.localValidationReport,
        acceptanceReport,
        acceptanceRuntime: runtime,
      });
      return { ...failed, rawOutput: local.rawOutput, trajectory: state.trajectory, localValidationReport: local.localValidationReport, acceptanceReport, acceptanceRuntime: runtime };
    }

    runtime.repairAttempts.push({
      type: "semantic_repair",
      attempt,
      promptKind: "semantic_repair",
      startedAt: new Date().toISOString(),
      status: "running",
      verdict: acceptanceReport.verdict,
    });
    state.appendTrajectory({
      type: "system",
      status: "running",
      title: `验收未通过，开始第 ${attempt} 次内容补齐`,
      thought: acceptanceReport.repairInstructions.join("\n") || acceptanceReport.summary,
    });
    const repairPrompt = buildSemanticRepairPrompt({
      goal: input.goal,
      subGoal: input.subGoal,
      task: input.task,
      instance: input.instance,
      currentResult,
      acceptanceReport,
    });
    const repairedRaw = await runClaudePrompt(input, repairPrompt, acceptanceReport.repairStrategy.allowNewToolCalls ? input.runtimeEnv.permissionMode : "readonly");
    const repaired = tryParseTaskRunnerResult(input, repairedRaw, input.task.resultViewKind ?? input.task.executionKind ?? "generic_result");
    local = await runLocalRepairCycle(input, {
      rawOutput: repairedRaw,
      parsedResult: repaired.result,
      parseError: repaired.error,
      runtime,
      appendTrajectory: state.appendTrajectory,
    });
    const runtimeAttempt = runtime.repairAttempts.findLast((item) => item.type === "semantic_repair" && item.attempt === attempt);
    if (runtimeAttempt) {
      runtimeAttempt.finishedAt = new Date().toISOString();
      runtimeAttempt.status = local.localValidationReport.passed ? "passed" : "failed";
    }
    if (!local.localValidationReport.passed || !local.parsedResult) {
      const failed = buildUnfinishedResult(input, {
        currentResult: local.parsedResult ?? currentResult,
        reason: "内容补齐后仍未通过本地校验。",
        localValidationReport: local.localValidationReport,
        acceptanceReport,
        acceptanceRuntime: runtime,
      });
      return { ...failed, rawOutput: local.rawOutput, trajectory: state.trajectory, localValidationReport: local.localValidationReport, acceptanceReport, acceptanceRuntime: runtime };
    }
    currentResult = coerceMissingUserContextBlocker(input, local.parsedResult);
  }

  const failed = buildUnfinishedResult(input, {
    currentResult,
    reason: "多轮补齐后仍未达到完成标准。",
    localValidationReport: local.localValidationReport,
    acceptanceRuntime: runtime,
  });
  return { ...failed, rawOutput: local.rawOutput, trajectory: state.trajectory, localValidationReport: local.localValidationReport, acceptanceRuntime: runtime };
}

async function executeOnce(input: RunGoalTaskInput & { attemptCount: number }) {
  let finalMessage = "";
  let lastStatus: "checking" | "running" | "completed" | null = null;
  const trajectory: ExecutionTrajectoryStep[] = [...(input.initialTrajectory ?? [])];
  const isResumeRun = Boolean(input.resumeContext) || (input.initialTrajectory?.length ?? 0) > 0;
  const previousToolSignatures = new Set(
    (input.initialTrajectory ?? [])
      .filter((step) => step.type === "tool_call" && step.toolCall)
      .map((step) => `${step.toolCall?.name ?? ""}::${JSON.stringify(step.toolCall?.input ?? null)}`),
  );
  let resumeNewToolCallCount = 0;
  let resumeDuplicateToolCallCount = 0;
  const appendTrajectory = (step: Omit<ExecutionTrajectoryStep, "id" | "index" | "startedAt"> & { startedAt?: string }) => {
    trajectory.push(createTrajectoryStep({ ...step, index: trajectory.length }));
    persistTrajectorySnapshot(input.requestId, trajectory);
    return trajectory;
  };
  appendTrajectory({
    type: "system",
    status: "running",
    title: input.resumeContext ? `开始第 ${input.attemptCount} 轮反思补齐` : `开始第 ${input.attemptCount} 次执行`,
    thought: [input.resumeContext ? "带入上一轮反思上下文继续执行。" : undefined, `任务：${input.task.title}`].filter(Boolean).join("\n"),
  });
  if (isResumeRun) {
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_task_execute",
      level: "info",
      phase: "executing",
      message: "进入恢复执行模式（增量续跑）",
      details: `前序轨迹步数=${input.initialTrajectory?.length ?? 0}，前序工具调用数=${previousToolSignatures.size}，resumeContext=${input.resumeContext ? "有" : "无"}`,
      eventType: "resume_mode_started",
      status: "running",
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
    });
    updateGoalTelemetry({
      requestId: input.requestId,
      scope: "goal_task_execute",
      phase: "executing",
      message: "进入恢复执行模式（增量续跑）",
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
      attemptCount: input.attemptCount,
      resultPayload: {
        ...progressPayloadWithTrajectory(trajectory),
        resumeMode: {
          enabled: true,
          previousTrajectorySteps: input.initialTrajectory?.length ?? 0,
          previousToolCallCount: previousToolSignatures.size,
          hasResumeContext: Boolean(input.resumeContext),
        },
      },
    });
  }
  updateGoalTelemetry({
    requestId: input.requestId,
    scope: "goal_task_execute",
    phase: "executing",
    message: input.resumeContext ? `开始第 ${input.attemptCount} 轮反思补齐` : `开始第 ${input.attemptCount} 次执行`,
    goalId: input.goal.id,
    taskId: input.task.id,
    taskInstanceId: input.instance.id,
    attemptCount: input.attemptCount,
    resultPayload: progressPayloadWithTrajectory(trajectory),
  });
  appendGoalLog({
    requestId: input.requestId,
    scope: "goal_task_execute",
    level: "info",
    phase: "executing",
    message: "Claude Runner 已启动",
    eventType: "tool_call_started",
    toolName: "Claude CLI",
    status: "running",
    goalId: input.goal.id,
    taskId: input.task.id,
    taskInstanceId: input.instance.id,
  });

  const runnerPrompt = buildGoalTaskRunnerPrompt({ ...input, initialTrajectory: input.initialTrajectory });
  if (input.goal.conversationId) {
    writeTaskPromptFile({
      conversationId: input.goal.conversationId,
      taskId: input.task.id,
      instanceId: input.instance.id,
      content: runnerPrompt,
    });
  }

  await streamClaudeCli({
    message: runnerPrompt,
    workingDirectory: resolveGoalTaskWorkspace(input),
    cliPath: input.runtimeEnv.cliPath,
    permissionMode: input.runtimeEnv.permissionMode,
    claudeSessionId: undefined,
    contextPack: buildTaskContextPack({
      goal: input.goal,
      subGoal: input.subGoal,
      task: input.task,
      instance: input.instance,
      trajectory,
      resumeContext: input.resumeContext,
    }),
    workspacePolicy: "task",
    onEvent: (event) => {
      if (event.type === "delta" && event.text.trim()) {
        finalMessage += event.text;
      }
      if (event.type === "message") {
        finalMessage = event.content;
      }
      if (event.type === "status") {
        if (event.status === lastStatus) return;
        lastStatus = event.status;
        updateGoalTelemetry({
          requestId: input.requestId,
          scope: "goal_task_execute",
          phase: event.status === "completed" ? "reviewing" : "executing",
          message:
            event.status === "completed"
              ? "Agent 已生成最终结果"
              : event.status === "checking"
                ? "正在准备执行环境"
                : "Agent 已开始调用工具",
          goalId: input.goal.id,
          taskId: input.task.id,
          taskInstanceId: input.instance.id,
          attemptCount: input.attemptCount,
          resultPayload: progressPayloadWithTrajectory(trajectory),
        });
      }
      if (event.type === "tool_call") {
        if (isResumeRun) {
          const signature = `${event.toolName}::${JSON.stringify(event.input ?? null)}`;
          if (previousToolSignatures.has(signature)) {
            resumeDuplicateToolCallCount += 1;
            appendGoalLog({
              requestId: input.requestId,
              scope: "goal_task_execute",
              level: "warn",
              phase: "executing",
              message: `恢复执行中检测到重复工具调用：${event.toolName}`,
              details: event.summary,
              eventType: "resume_duplicate_tool_call",
              toolName: event.toolName,
              status: "running",
              goalId: input.goal.id,
              taskId: input.task.id,
              taskInstanceId: input.instance.id,
            });
          } else {
            resumeNewToolCallCount += 1;
            previousToolSignatures.add(signature);
          }
        }
        appendTrajectory({
          type: "tool_call",
          status: "running",
          title: event.summary,
          toolCall: {
            name: event.toolName,
            input: event.input,
            summary: event.summary,
          },
        });
        appendGoalLog({
          requestId: input.requestId,
          scope: "goal_task_execute",
          level: "info",
          phase: "executing",
          message: event.summary,
          eventType: "tool_call_started",
          toolName: event.toolName,
          status: "running",
          goalId: input.goal.id,
          taskId: input.task.id,
          taskInstanceId: input.instance.id,
        });
      }
      if (event.type === "error") {
        appendTrajectory({
          type: "error",
          status: "failed",
          title: event.message,
          toolResult: {
            ok: false,
            error: event.message,
          },
          endedAt: new Date().toISOString(),
        });
        throw new Error(event.message);
      }
    },
  });

  appendTrajectory({
    type: "assistant",
    status: "completed",
    title: "Agent 已返回最终消息",
    thought: finalMessage.slice(0, 2000),
    endedAt: new Date().toISOString(),
  });

  if (isResumeRun) {
    const replanningSignal = detectAgentReplanning(finalMessage);
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_task_execute",
      level: replanningSignal.detected || resumeDuplicateToolCallCount > 0 ? "warn" : "info",
      phase: "reviewing",
      message: replanningSignal.detected
        ? `恢复执行中检测到 Agent 似乎在重新规划：${replanningSignal.reason}`
        : "恢复执行完成（增量续跑统计）",
      details: `重复工具调用=${resumeDuplicateToolCallCount}，新增工具调用=${resumeNewToolCallCount}，replanningDetected=${replanningSignal.detected}${replanningSignal.matched ? `，命中关键词=${replanningSignal.matched}` : ""}`,
      eventType: replanningSignal.detected ? "resume_replanning_detected" : "resume_mode_started",
      status: "running",
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
    });
    updateGoalTelemetry({
      requestId: input.requestId,
      scope: "goal_task_execute",
      phase: "reviewing",
      message: replanningSignal.detected
        ? "恢复执行中检测到重新规划信号"
        : "恢复执行：增量续跑指标已记录",
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
      attemptCount: input.attemptCount,
      resultPayload: {
        ...progressPayloadWithTrajectory(trajectory),
        resumeMode: {
          enabled: true,
          duplicateToolCalls: resumeDuplicateToolCallCount,
          newToolCalls: resumeNewToolCallCount,
          replanningDetected: replanningSignal.detected,
          replanningReason: replanningSignal.reason,
        },
      },
    });
  }

  appendGoalLog({
    requestId: input.requestId,
    scope: "goal_task_execute",
    level: "info",
    phase: "reviewing",
    message: "Claude Runner 已返回结果",
    eventType: "tool_call_finished",
    toolName: "Claude CLI",
    status: "completed",
    goalId: input.goal.id,
    taskId: input.task.id,
    taskInstanceId: input.instance.id,
  });

  const parsed = tryParseTaskRunnerResult(input, finalMessage, input.task.resultViewKind ?? input.task.executionKind ?? "generic_result");
  const result = await completeWithAcceptance(input, {
    rawOutput: finalMessage,
    parsedResult: parsed.result,
    parseError: parsed.error,
    trajectory,
    appendTrajectory,
  });
  appendTrajectory({
    type: result.awaitingUser ? "approval" : "result",
    status: result.awaitingUser ? "awaiting_user" : "completed",
    title: result.summary,
    thought: result.finalMessage.slice(0, 2000),
    endedAt: new Date().toISOString(),
  });
  const blocker = createExecutionBlocker(input, result, trajectory);
  if (blocker) {
    updateRuntimeJobExecution(`job-${input.instance.id}`, { blocker, status: "awaiting_user" });
  }
  return {
    ...result,
    blocker,
    structuredOutput: {
      ...(result.structuredOutput ?? {}),
      ...(blocker ? { blocker } : {}),
    },
    trajectory,
  };
}

export async function runGoalTask(input: RunGoalTaskInput) {
  beginGoalTelemetry({
    requestId: input.requestId,
    scope: "goal_task_execute",
    phase: "executing",
    message: `KiKi 已自动启动任务「${input.task.title.replace(/^任务\d+：/, "")}」`,
    goalId: input.goal.id,
    taskId: input.task.id,
    taskInstanceId: input.instance.id,
    attemptCount: 1,
  });

  const readiness = await buildTaskReadinessCheckWithJudge(input);
  if (readiness.status === "blocked") {
    const trajectory = [
      createTrajectoryStep({
        index: 0,
        type: "system",
        status: "completed",
        title: "执行前信息充分性检查",
        thought: readiness.summary,
        endedAt: new Date().toISOString(),
      }),
      createTrajectoryStep({
        index: 1,
        type: "approval",
        status: "awaiting_user",
        title: "缺少用户提供的信息",
        thought: readiness.missingUserInfo.map((item) => `${item.label}：${item.reason}`).join("\n"),
        endedAt: new Date().toISOString(),
      }),
    ];
    const blockedResult = buildReadinessBlockedResult(input, readiness);
    const blocker = createExecutionBlocker(input, blockedResult, trajectory);
    const result = {
      ...blockedResult,
      blocker,
      structuredOutput: {
        ...(blockedResult.structuredOutput ?? {}),
        ...(blocker ? { blocker } : {}),
      },
      trajectory,
    };
    const notificationDecision = judgeTaskResult({
      goal: input.goal,
      subGoal: input.subGoal,
      task: input.task,
      instance: input.instance,
      result,
    });
    const resultPayload = {
      resultViewKind: result.resultViewKind,
      awaitingUser: true,
      awaitingReason: result.awaitingReason,
      suggestedActions: result.suggestedActions,
      artifacts: result.artifacts,
      taskResult: result.taskResult,
      trajectory,
      deliverableCheck: result.deliverableCheck,
      interactionRequirement: result.interactionRequirement,
      blocker,
      structuredOutput: result.structuredOutput,
      finalMessage: result.finalMessage,
      notificationDecision,
    } satisfies Record<string, unknown>;
    updateGoalTelemetry({
      requestId: input.requestId,
      scope: "goal_task_execute",
      phase: "reviewing",
      message: readiness.summary,
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
      attemptCount: 1,
      summary: result.summary,
      resultPayload,
    });
    finishGoalTelemetry({
      requestId: input.requestId,
      scope: "goal_task_execute",
      phase: "reviewing",
      message: "任务执行已暂停，等待用户补充必要信息",
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
      summary: result.summary,
      resultPayload,
    });
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_task_execute",
      level: "info",
      phase: "reviewing",
      message: readiness.summary,
      eventType: "await_user",
      status: "awaiting_user",
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
    });
    if (blocker) {
      updateRuntimeJobExecution(`job-${input.instance.id}`, {
        blocker,
        status: "awaiting_user",
        trajectory,
        result: resultPayload,
      });
    }
    return;
  }

  let attemptCount = 1;
  const maxAttempts = 2;
  while (attemptCount <= maxAttempts) {
    try {
      const result = await executeOnce({ ...input, attemptCount });
      const notificationDecision = judgeTaskResult({
        goal: input.goal,
        subGoal: input.subGoal,
        task: input.task,
        instance: input.instance,
        result,
      });
      const unresolvedAgentRevision = shouldAutoReflect(result);
      const resultPayload = {
        resultViewKind: result.resultViewKind,
        awaitingUser: unresolvedAgentRevision ? false : result.awaitingUser,
        awaitingReason: result.awaitingReason,
        suggestedActions: result.suggestedActions,
        artifacts: result.artifacts,
        taskResult: result.taskResult,
        trajectory: result.trajectory,
        deliverableCheck: result.deliverableCheck,
        interactionRequirement: result.interactionRequirement,
        blocker: result.blocker,
        structuredOutput: result.structuredOutput,
        finalMessage: result.finalMessage,
        notificationDecision,
      } satisfies Record<string, unknown>;
      if (unresolvedAgentRevision) {
        const errorMessage = result.awaitingReason || "任务缺少组件化产出，Agent 自动补齐后仍未满足交付物契约。";
        failGoalTelemetry({
          requestId: input.requestId,
          scope: "goal_task_execute",
          phase: "reviewing",
          message: "任务缺少组件化产出，未完成",
          error: errorMessage,
          goalId: input.goal.id,
          taskId: input.task.id,
          taskInstanceId: input.instance.id,
          summary: result.summary,
          resultPayload,
        });
        appendGoalLog({
          requestId: input.requestId,
          scope: "goal_task_execute",
          level: "error",
          phase: "reviewing",
          message: "任务未产出可视化组件结果，已标记为未完成",
          details: errorMessage,
          status: "failed",
          goalId: input.goal.id,
          taskId: input.task.id,
          taskInstanceId: input.instance.id,
        });
        updateRuntimeJobExecution(`job-${input.instance.id}`, {
          status: "failed",
          result: resultPayload,
          trajectory: result.trajectory,
          lastError: errorMessage,
          finishedAt: new Date().toISOString(),
        });
        return;
      }
      if (result.awaitingUser) {
        updateGoalTelemetry({
          requestId: input.requestId,
          scope: "goal_task_execute",
          phase: "reviewing",
          message: result.awaitingReason || "任务需要用户参与后才能继续",
          goalId: input.goal.id,
          taskId: input.task.id,
          taskInstanceId: input.instance.id,
          attemptCount,
          summary: result.summary,
          resultPayload,
        });
        appendGoalLog({
          requestId: input.requestId,
          scope: "goal_task_execute",
          level: "info",
          phase: "reviewing",
          message: result.awaitingReason || "Agent 等待用户参与",
          eventType: "await_user",
          status: "awaiting_user",
          goalId: input.goal.id,
          taskId: input.task.id,
          taskInstanceId: input.instance.id,
        });
      }
      finishGoalTelemetry({
        requestId: input.requestId,
        scope: "goal_task_execute",
        phase: result.awaitingUser ? "reviewing" : "completed",
        message: result.awaitingUser ? "任务执行已暂停，等待用户参与" : "任务执行完成",
        goalId: input.goal.id,
        taskId: input.task.id,
        taskInstanceId: input.instance.id,
        summary: result.summary,
        resultPayload,
      });
      appendGoalLog({
        requestId: input.requestId,
        scope: "goal_task_execute",
        level: "info",
        phase: result.awaitingUser ? "reviewing" : "completed",
        message: result.summary,
        eventType: "result_ready",
        status: result.awaitingUser ? "awaiting_user" : "completed",
        goalId: input.goal.id,
        taskId: input.task.id,
        taskInstanceId: input.instance.id,
      });
      return;
    } catch (error) {
      const category = classifyTaskRunError(error);
      const errorMessage = error instanceof Error ? error.message : "任务执行失败";
      if (shouldRetry(category, attemptCount)) {
        appendGoalLog({
          requestId: input.requestId,
          scope: "goal_task_execute",
          level: "warn",
          phase: "executing",
          message: `执行失败，准备自动重试第 ${attemptCount + 1} 次`,
          details: errorMessage,
          eventType: "retry_scheduled",
          status: "running",
          goalId: input.goal.id,
          taskId: input.task.id,
          taskInstanceId: input.instance.id,
        });
        updateGoalTelemetry({
          requestId: input.requestId,
          scope: "goal_task_execute",
          phase: "executing",
          message: `遇到瞬时错误，准备自动重试第 ${attemptCount + 1} 次`,
          details: errorMessage,
          goalId: input.goal.id,
          taskId: input.task.id,
          taskInstanceId: input.instance.id,
          attemptCount: attemptCount + 1,
        });
        attemptCount += 1;
        continue;
      }
      failGoalTelemetry({
        requestId: input.requestId,
        scope: "goal_task_execute",
        phase: "error",
        message: "任务执行失败",
        error: errorMessage,
        goalId: input.goal.id,
        taskId: input.task.id,
        taskInstanceId: input.instance.id,
        resultPayload: {
          errorCategory: category,
        },
      });
      appendGoalLog({
        requestId: input.requestId,
        scope: "goal_task_execute",
        level: "error",
        phase: "error",
        message: "任务执行失败",
        details: errorMessage,
        status: "failed",
        goalId: input.goal.id,
        taskId: input.task.id,
        taskInstanceId: input.instance.id,
      });
      throw error;
    }
  }
}
