import { normalizeFileWriteSpecs } from "@/lib/server/fileWriteSpecs";
import { extractJsonObject } from "@/lib/server/jsonExtraction";
import { inferInteractionRequirement, requiresUserConfirmationToComplete } from "@/lib/server/domain/taskPolicy";
import { normalizeMissingFieldQuestions } from "@/lib/server/informationRequest/compileFields";
import type {
  InteractionRequirement,
  Task,
  TaskResultViewKind,
  TaskRunArtifact,
} from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";
import type { DeliverableCheck, DeliverableCheckStatus } from "./taskRunnerTypes";

/**
 * taskResultNormalizers —— 把 Claude 任务输出里各种"形状不一"的字段规整成标准类型。
 *
 * 与 taskResultParser（raw JSON → ParsedTaskRunnerResult 的解析驱动）分开：
 * 这里只做字段级归一化（deliverable check / interaction requirement / webapp /
 * external embed / file specs），都是纯函数，可各自单独喂数据测试。
 */

export type WebAppSpec = {
  title: string;
  description?: string;
  html: string;
  initialState?: Record<string, unknown>;
  networkPolicy?: "offline" | "internet";
};

export type ExternalEmbedSpec = {
  title: string;
  description?: string;
  url: string;
  provider?: "youtube" | "generic";
};

function normalizeStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

export function normalizeDeliverableCheck(value: unknown): DeliverableCheck | null {
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

export function normalizeInteractionRequirement(
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
      : undefined;
  const suggestedActions = Array.isArray(raw.suggested_actions)
    ? normalizeStringList(raw.suggested_actions)
    : Array.isArray(raw.suggestedActions)
      ? normalizeStringList(raw.suggestedActions)
      : fallback?.suggestedActions;
  const fields = Array.isArray(raw.fields)
    ? normalizeMissingFieldQuestions(raw.fields)
    : Array.isArray(raw.field_questions)
      ? normalizeMissingFieldQuestions(raw.field_questions)
      : fallback?.fields;
  const requirement = inferInteractionRequirement({
    interactionType: type,
    timing,
    reason:
      typeof raw.reason === "string" && raw.reason.trim()
        ? raw.reason.trim()
        : fallback?.reason || "",
    question: typeof raw.question === "string" && raw.question.trim() ? raw.question.trim() : fallback?.question,
    options: Array.isArray(raw.options) ? normalizeStringList(raw.options) : fallback?.options,
    fields,
    suggestedActions,
    shouldNotifyUser:
      typeof raw.should_notify_user === "boolean"
        ? raw.should_notify_user
        : typeof raw.shouldNotifyUser === "boolean"
          ? raw.shouldNotifyUser
          : undefined,
    fallbackShouldNotifyUser: fallback?.shouldNotifyUser,
  });

  return {
    ...requirement,
  };
}

/**
 * 判定一次"等待确认"是否其实只是非阻塞的信息反馈（information 类任务、
 * 已 done、且任务本身不需用户确认即可完成）。parseTaskRunnerResult 用它
 * 决定是否把 awaiting 抹平。接收窄 task。
 */
export function isNonBlockingInformationFeedback(task: Task, requirement: InteractionRequirement, taskResult: TaskResult | null) {
  return (
    task.expectedResult?.type === "information" &&
    requirement.type === "confirm" &&
    requirement.timing === "after_agent_output" &&
    taskResult?.status === "done" &&
    !requiresUserConfirmationToComplete(task, { includeUserCompletionOwner: true })
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeWebAppSpec(value: unknown): WebAppSpec | null {
  if (!isPlainRecord(value)) return null;
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : "可执行小应用";
  const description = typeof value.description === "string" && value.description.trim() ? value.description.trim() : undefined;
  const html = typeof value.html === "string" ? value.html.trim() : "";
  if (!html) return null;
  const initialState = isPlainRecord(value.initialState) ? value.initialState : undefined;
  const networkPolicy = value.networkPolicy === "internet" ? "internet" : "offline";
  return { title, description, html, initialState, networkPolicy };
}

export function normalizeExternalEmbedSpec(value: unknown): ExternalEmbedSpec | null {
  if (!isPlainRecord(value)) return null;
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : "外部嵌入";
  const description = typeof value.description === "string" && value.description.trim() ? value.description.trim() : undefined;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!url) return null;
  const provider = value.provider === "youtube" ? "youtube" : value.provider === "generic" ? "generic" : undefined;
  return { title, description, url, provider };
}

export function extractFileWriteSpecs(raw: string) {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as { files?: unknown };
    return normalizeFileWriteSpecs(parsed.files);
  } catch {
    return [];
  }
}

export function extractWebAppSpec(raw: string) {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as { webapp?: unknown };
    return normalizeWebAppSpec(parsed.webapp);
  } catch {
    return null;
  }
}

export function extractExternalEmbedSpec(raw: string) {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as { external_embed?: unknown };
    return normalizeExternalEmbedSpec(parsed.external_embed);
  } catch {
    return null;
  }
}

// 下列类型仅被 taskResultParser 使用，但与归一化机器同处一文件以集中"输出形状"知识。
// parser 会从这里 import。
export type RawTaskRunnerPayload = {
  summary?: string;
  final_message?: string;
  result_view_kind?: TaskResultViewKind;
  awaiting_user?: boolean;
  awaiting_reason?: string;
  suggested_actions?: string[];
  interaction_requirement?: unknown;
  artifacts?: Array<{ label?: string; kind?: TaskRunArtifact["kind"]; content?: string; href?: string }>;
  files?: unknown;
  webapp?: unknown;
  external_embed?: unknown;
  task_result?: unknown;
  taskResult?: unknown;
  deliverable_check?: unknown;
  structured_output?: Record<string, unknown> | null;
};
