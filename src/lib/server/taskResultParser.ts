import { buildJsonParseCandidates, parseJsonWithCandidates } from "@/lib/server/claude/jsonRepair";
import { extractBalancedJsonSnippet, extractParseFailureContext } from "@/lib/server/jsonExtraction";
import { writeTaskParseFailureSnapshot } from "@/lib/server/workspace/conversationWorkspace";
import { deriveLegacyTaskResult } from "@/lib/taskResult/legacyAdapter";
import { sanitizeTaskResultOutput } from "@/lib/taskResult/outputSanitizer";
import { normalizeTaskResult } from "@/lib/taskResult/parseAndRepair";
import { resolveExpectedSurfaces } from "@/lib/taskResult/surfaces";
import { normalizeFileWriteSpecs } from "@/lib/server/fileWriteSpecs";
import { normalizeTaskResultViewKind } from "@/types/kiki";
import type { Task, TaskInstance, TaskResultViewKind } from "@/types/kiki";
import type { ParsedTaskRunnerResult } from "./taskRunnerTypes";
import {
  isNonBlockingInformationFeedback,
  normalizeDeliverableCheck,
  normalizeExternalEmbedSpec,
  normalizeInteractionRequirement,
  normalizeWebAppSpec,
  type RawTaskRunnerPayload,
} from "./taskResultNormalizers";
import { uniqueStrings } from "./taskRunnerShared";

/**
 * taskResultParser —— 解析驱动：把 Claude 任务的原始 JSON 输出解析成
 * ParsedTaskRunnerResult。字段级归一化委托给 taskResultNormalizers。
 *
 * ctx 收窄为 { task, instance, conversationWorkspaceDir?, taskWorkspaceDir?,
 * requestId }——这是 parse 链对 input 的全部真实依赖（原 RunGoalTaskInput 14
 * 字段只用这几个，且 buildTaskParseError 写失败快照需要 workspace 目录）。
 */
export type TaskParserContext = {
  task: Task;
  instance: TaskInstance;
  conversationWorkspaceDir?: string;
  taskWorkspaceDir?: string;
  requestId: string;
};

/**
 * 从任意带这些字段的对象投影出 parser ctx。让 repair / executeOnce / 顶层
 * 共用一条窄构造,无须各自重复字面量。
 */
export function taskParserCtxFrom(source: {
  task: Task;
  instance: TaskInstance;
  conversationWorkspaceDir?: string;
  taskWorkspaceDir?: string;
  requestId: string;
}): TaskParserContext {
  return {
    task: source.task,
    instance: source.instance,
    conversationWorkspaceDir: source.conversationWorkspaceDir,
    taskWorkspaceDir: source.taskWorkspaceDir,
    requestId: source.requestId,
  };
}

function validateTaskRunnerPayload(value: unknown): RawTaskRunnerPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("任务执行结果不是 JSON 对象");
  }
  const payload = value as Record<string, unknown>;
  const hasProtocolSignal = [
    "summary",
    "final_message",
    "result_view_kind",
    "interaction_requirement",
    "artifacts",
    "files",
    "webapp",
    "external_embed",
    "task_result",
    "taskResult",
    "deliverable_check",
  ].some((key) => key in payload);
  if (!hasProtocolSignal) {
    throw new Error("JSON 对象不包含任务结果协议字段");
  }
  return value as RawTaskRunnerPayload;
}

function parseTaskRunnerPayload(raw: string) {
  const candidates = buildJsonParseCandidates(raw);
  const attempt = parseJsonWithCandidates(candidates, validateTaskRunnerPayload);
  if (attempt.ok) {
    return {
      parsed: attempt.parsed,
      strategy: attempt.strategy,
    };
  }
  const message = attempt.error instanceof Error ? attempt.error.message : String(attempt.error ?? "未知解析错误");
  throw new Error(`任务结果 JSON 解析失败：${message}`);
}

export function parseTaskRunnerResult(ctx: TaskParserContext, raw: string, fallbackKind: TaskResultViewKind): ParsedTaskRunnerResult {
  const { parsed } = parseTaskRunnerPayload(raw);
  const parsedFiles = normalizeFileWriteSpecs(parsed.files);
  const parsedWebApp = normalizeWebAppSpec(parsed.webapp);
  const parsedExternalEmbed = normalizeExternalEmbedSpec(parsed.external_embed);
  const normalizedTaskResult = normalizeTaskResult(parsed.task_result ?? parsed.taskResult, {
    taskId: ctx.task.id,
    instanceId: ctx.instance.id,
    title: ctx.task.expectedOutcome || ctx.task.title,
  });
  const expectedSurfaces = resolveExpectedSurfaces(ctx.task.expectedResult);
  const expectsWebApp = ctx.task.expectedResult?.interactiveSurface?.kind === "webapp" || Boolean(parsedWebApp) || Boolean(parsedExternalEmbed);
  const parsedSummary = parsed.summary?.trim();
  const parsedFinalMessage = parsed.final_message?.trim();
  const rawTaskResult =
    normalizedTaskResult ||
    (expectedSurfaces.includes("interactive") && expectsWebApp && (parsedWebApp || parsedExternalEmbed)
      ? {
          schemaVersion: 1 as const,
          taskId: ctx.task.id,
          instanceId: ctx.instance.id,
          title: parsedWebApp?.title || parsedExternalEmbed?.title || ctx.task.expectedOutcome || ctx.task.title,
          status: "done" as const,
          blocks: [],
          meta: {
            producedAt: new Date().toISOString(),
            surfaces: ["interactive" as const],
            interactiveSurfaceKind: "webapp" as const,
            primaryFormat: "html" as const,
            exportableFormats: ctx.task.expectedResult?.exportableFormats,
          },
        }
      : null) ||
    (expectedSurfaces.includes("files") && parsedFiles.length > 0
      ? {
          schemaVersion: 1 as const,
          taskId: ctx.task.id,
          instanceId: ctx.instance.id,
          title: ctx.task.expectedOutcome || ctx.task.title,
          status: "done" as const,
          blocks: [],
          meta: {
            producedAt: new Date().toISOString(),
            surfaces: ["files" as const],
            fileSurfaceRequired: true,
            primaryFormat: ctx.task.expectedResult?.primaryFormat,
            exportableFormats: ctx.task.expectedResult?.exportableFormats,
          },
        }
      : null);
  const taskResult = rawTaskResult
    ? sanitizeTaskResultOutput(rawTaskResult, {
        outerTexts: [
          parsedSummary,
          parsedFinalMessage,
          ctx.instance.intro,
          `用户手动发起执行“${ctx.task.title.replace(/^任务\d+：/, "")}”。`,
        ],
      })
    : null;
  const legacyFromBlocks = taskResult ? deriveLegacyTaskResult(taskResult) : null;
  let suggestedActions = Array.isArray(parsed.suggested_actions)
    ? parsed.suggested_actions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;
  const legacyInteractionType = parsed.awaiting_user ? "confirm" : "none";
  let interactionRequirement = normalizeInteractionRequirement(parsed.interaction_requirement, {
    type: legacyInteractionType,
    reason: parsed.awaiting_reason?.trim() || "",
    suggestedActions,
    shouldNotifyUser: parsed.awaiting_user,
  });
  const isFeedbackOnly = isNonBlockingInformationFeedback(ctx.task, interactionRequirement, taskResult);
  if (isFeedbackOnly) {
    suggestedActions = uniqueStrings([
      ...(suggestedActions ?? []),
      ...(interactionRequirement.options ?? []),
      ...(interactionRequirement.suggestedActions ?? []),
    ]);
    interactionRequirement = {
      type: "none",
      timing: "not_required",
      reason: "",
      question: "",
      options: [],
      suggestedActions,
      shouldNotifyUser: false,
    };
  }
  const awaitingUser =
    !isFeedbackOnly &&
    Boolean(parsed.awaiting_user) ||
    (!isFeedbackOnly &&
      interactionRequirement.type !== "none" &&
      interactionRequirement.type !== "deliverable_gap" &&
      interactionRequirement.type !== "agent_revision_required");
  return {
    summary: parsedSummary || legacyFromBlocks?.summary || "任务执行完成。",
    finalMessage: parsedFinalMessage || legacyFromBlocks?.finalMessage || parsedSummary || "任务执行完成。",
    resultViewKind: normalizeTaskResultViewKind(parsed.result_view_kind ?? fallbackKind),
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
      ...(isFeedbackOnly
        ? {
            followUpSuggestion: {
              reason: parsed.awaiting_reason?.trim() || normalizeInteractionRequirement(parsed.interaction_requirement).reason,
              question: normalizeInteractionRequirement(parsed.interaction_requirement).question,
              options: normalizeInteractionRequirement(parsed.interaction_requirement).options ?? [],
            },
          }
        : {}),
    },
  };
}

export function buildParseCandidateDiagnostics(raw: string) {
  return buildJsonParseCandidates(raw).map((candidate) => {
    try {
      validateTaskRunnerPayload(JSON.parse(candidate.value));
      return {
        label: candidate.label,
        value: candidate.value,
      };
    } catch (error) {
      return {
        label: candidate.label,
        value: candidate.value,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function buildTaskParseError(ctx: TaskParserContext, raw: string, error: unknown) {
  const context = extractParseFailureContext(raw, error);
  let snapshotPath = "";
  if (ctx.conversationWorkspaceDir && ctx.taskWorkspaceDir) {
    try {
      const snapshot = writeTaskParseFailureSnapshot({
        workspaceDir: ctx.conversationWorkspaceDir,
        taskWorkspaceDir: ctx.taskWorkspaceDir,
        requestId: ctx.requestId,
        taskId: ctx.task.id,
        instanceId: ctx.instance.id,
        errorMessage: context.message,
        rawOutput: raw,
        balancedSnippet: extractBalancedJsonSnippet(raw),
        contextExcerpt: context.excerpt,
        parseCandidates: buildParseCandidateDiagnostics(raw),
      });
      snapshotPath = snapshot.relativePath;
    } catch {
      snapshotPath = "";
    }
  }
  return [context.formatted, snapshotPath ? `快照: ${snapshotPath}` : ""].filter(Boolean).join("\n");
}

export function tryParseTaskRunnerResult(ctx: TaskParserContext, raw: string, fallbackKind: TaskResultViewKind) {
  try {
    return {
      result: parseTaskRunnerResult(ctx, raw, fallbackKind),
      error: undefined,
    };
  } catch (error) {
    return {
      result: null,
      error: buildTaskParseError(ctx, raw, error),
    };
  }
}
