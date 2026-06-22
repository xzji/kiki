import { normalizeConfirmationOptionLabels } from "@/lib/server/userConfirmationOptionsPrompt";
import type { TaskReadinessCheck, TaskReadinessInfoItem } from "@/lib/server/taskReadinessPolicy";
import { normalizeInteractionRequirement as normalizeServerInteractionRequirement } from "@/lib/server/protocol/normalizeAwaitingInteraction";
import type { Task } from "@/types/kiki";
import type { DeliverableCheck, ParsedTaskRunnerResult } from "./taskRunnerTypes";

/**
 * taskRunnerShared —— goalTaskRunner 各纯簇 / 编排层共享的内部件。
 *
 * 这些 helper 没有单一归属：awaitingUserResolver 用它们组装"缺用户上下文"的
 * blocker 与就绪字段结构，acceptance/repair 编排层也用它们做兜底 deliverable
 * 与归一化。因此单独成模块，置于最底层，让纯簇对它们的依赖显式化，
 * 而不是各自复制（会重蹈 nowIso×28 的重复反模式）或反向依赖巨石。
 */

export function uniqueStrings(items: Array<string | undefined>) {
  return Array.from(new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))));
}

/**
 * 汇总 awaiting 相关文本字段，供 looksLikeMissingUserContext（awaiting）与
 * shouldAutoReflect（编排层）做关键词判定。纯函数。
 */
export function textForUserInputDetection(result: ParsedTaskRunnerResult) {
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

/**
 * 把 awaiting 的结果归一化：补齐 interactionRequirement / blocker 在
 * structuredOutput 里的镜像，确保 awaiting 的终态结构一致。纯函数。
 */
export function normalizeParsedAwaitingResult<T extends ParsedTaskRunnerResult>(result: T): T {
  if (!result.awaitingUser) return result;
  const interactionRequirement =
    normalizeServerInteractionRequirement(result.interactionRequirement) ?? result.interactionRequirement;
  const blocker = result.blocker
    ? {
        ...result.blocker,
        interactionRequirement:
          normalizeServerInteractionRequirement(result.blocker.interactionRequirement) ??
          result.blocker.interactionRequirement,
      }
    : result.blocker;
  return {
    ...result,
    interactionRequirement,
    blocker,
    structuredOutput: {
      ...(result.structuredOutput ?? {}),
      interactionRequirement,
      ...(blocker ? { blocker } : {}),
    },
  };
}

function isTaskReadinessInfoItem(value: unknown): value is TaskReadinessInfoItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TaskReadinessInfoItem>;
  return (
    typeof item.id === "string" &&
    typeof item.label === "string" &&
    typeof item.description === "string" &&
    (item.source === "user" || item.source === "agent" || item.source === "system") &&
    (item.status === "available" ||
      item.status === "missing_user" ||
      item.status === "agent_retrievable" ||
      item.status === "not_required") &&
    typeof item.reason === "string"
  );
}

export function isTaskReadinessCheck(value: unknown): value is TaskReadinessCheck {
  if (!value || typeof value !== "object") return false;
  const readiness = value as Partial<TaskReadinessCheck>;
  return (
    (readiness.status === "ready" || readiness.status === "blocked") &&
    typeof readiness.generatedAt === "string" &&
    typeof readiness.summary === "string" &&
    Array.isArray(readiness.items) &&
    readiness.items.every(isTaskReadinessInfoItem) &&
    Array.isArray(readiness.missingUserInfo) &&
    readiness.missingUserInfo.every(isTaskReadinessInfoItem) &&
    Array.isArray(readiness.agentRetrievableInfo) &&
    readiness.agentRetrievableInfo.every(isTaskReadinessInfoItem) &&
    Array.isArray(readiness.availableInfo) &&
    readiness.availableInfo.every(isTaskReadinessInfoItem)
  );
}

function isActionLikeConfirmationOption(option: string) {
  return /^(确认继续|需要修改|重新执行任务|调整任务完成标准|让\s*KiKi\s*修改后继续|提交答案并继续|提交信息并继续|我已完成，继续执行|确认并继续)$/.test(option.trim());
}

export function normalizeFieldAnswerOptions(values: string[]) {
  return normalizeConfirmationOptionLabels(values.filter((option) => !isActionLikeConfirmationOption(option)));
}

export function refreshReadinessCollections(items: TaskReadinessInfoItem[], generatedAt: string, summary: string): TaskReadinessCheck {
  return {
    status: items.some((item) => item.status === "missing_user" && item.source === "user") ? "blocked" : "ready",
    generatedAt,
    summary,
    items,
    missingUserInfo: items.filter((item) => item.status === "missing_user" && item.source === "user"),
    agentRetrievableInfo: items.filter((item) => item.status === "agent_retrievable"),
    availableInfo: items.filter((item) => item.status === "available"),
  };
}

function normalizeBlockerLabel(value: string, index: number) {
  return value
    .replace(/^请(补充|确认|选择|提供)/, "")
    .replace(/[。；;：:，,].*$/, "")
    .trim()
    .slice(0, 24) || `待补充信息 ${index + 1}`;
}

export function buildReadinessFromUserBlockers(blockers: string[], summary: string): TaskReadinessCheck | null {
  const uniqueBlockers = uniqueStrings(blockers);
  if (!uniqueBlockers.length) return null;
  const items = uniqueBlockers.map((blocker, index) => ({
    id: `user_blocker_${index + 1}`,
    label: normalizeBlockerLabel(blocker, index),
    description: blocker,
    source: "user" as const,
    status: "missing_user" as const,
    reason: blocker,
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

export function applyInteractionOptionsToSingleMissingReadiness(
  readiness: TaskReadinessCheck | null,
  rawOptions: string[],
  question: string,
): TaskReadinessCheck | null {
  if (!readiness) return null;
  const options = normalizeFieldAnswerOptions(rawOptions);
  if (!options.length || readiness.missingUserInfo.length !== 1) return readiness;
  const missingId = readiness.missingUserInfo[0].id;
  const items = readiness.items.map((item) =>
    item.id === missingId
      ? {
          ...item,
          options,
          optionQuestion: question,
        }
      : item,
  );
  return refreshReadinessCollections(items, readiness.generatedAt, readiness.summary);
}

/**
 * 给一个尚无 deliverableCheck 的结果构造兜底 check。需要 task 的预期产出
 * 字段，故接收窄 task 而非整个 input。
 */
export function buildFallbackDeliverableCheck(task: Task, reason: string): DeliverableCheck {
  const criteria = [
    task.expectedOutcome,
    task.expectedResult?.description,
    task.expectedResult?.completionCriteria,
  ].filter((item): item is string => Boolean(item?.trim()));

  return {
    matched: false,
    confidence: "low",
    deliveredArtifacts: [],
    missingDeliverables: [task.expectedOutcome],
    criteriaResults: criteria.map((criterion) => ({
      criterion,
      status: "unknown",
      evidence: reason,
    })),
    gapReason: reason,
  };
}
