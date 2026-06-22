import { normalizeConfirmationOptionLabels } from "@/lib/server/userConfirmationOptionsPrompt";
import {
  compileMissingFieldQuestions,
  fieldsSuggestedActions,
  singleFieldOptions,
} from "@/lib/server/informationRequest/compileFields";
import { normalizeTaskResultViewKind } from "@/types/kiki";
import type { InteractionRequirement, Task, TaskInstance } from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";
import type { DeliverableCheck, ParsedTaskRunnerResult } from "./taskRunnerTypes";
import {
  applyInteractionOptionsToSingleMissingReadiness,
  buildFallbackDeliverableCheck,
  buildReadinessFromUserBlockers,
  isTaskReadinessCheck,
  textForUserInputDetection,
  uniqueStrings,
} from "./taskRunnerShared";

/**
 * awaitingUserResolver —— 等待用户解析器。
 *
 * 职责：判定一个任务执行结果"是否要把用户挡下来、挡成什么样"。三个入口：
 *   - resolveAwaitingUser(ctx, result)：对一个已解析的结果做归一
 *     （吸收重复 resume 确认、把"缺用户上下文"转成 blocker）。
 *   - coerceMissingUserContextBlocker(ctx, result)：只做"缺用户上下文 → blocker"
 *     的强制转换，不做 resume 自动解决。验收路径（buildNeedsUserFromAcceptance）
 *     已自行构造好 provide_context，只需要 coerce 这一步，不能被 resume 自动解决
 *     抢先吞掉——故独立成入口，与 resolveAwaitingUser 区分。
 *   - buildAwaitingConfirmationFromRaw(ctx, rawOutput)：当 Agent 返回非结构化
 *     确认卡片时，从原始输出构造一个 awaiting 结果。
 *
 * 内部封装 5 个互递归函数 + 判定 helper，接口面只暴露上述三个语义明确的入口。
 * ctx 收窄为 { task, instance, resumeContext }——这三个字段就是这簇对 input
 * 的全部真实依赖（原 RunGoalTaskInput 14 字段只用 3）。
 */
export type AwaitingUserContext = {
  task: Task;
  instance: TaskInstance;
  resumeContext?: string;
};

/**
 * 从任意带 task/instance/resumeContext 的对象投影出 awaiting ctx。
 * 让 repair / acceptance / 顶层调用方共用一条窄构造,无须各自重复字面量。
 */
export function awaitingCtxFrom(source: { task: Task; instance: TaskInstance; resumeContext?: string }): AwaitingUserContext {
  return {
    task: source.task,
    instance: source.instance,
    resumeContext: source.resumeContext,
  };
}

function looksLikeMissingUserContext(result: ParsedTaskRunnerResult) {
  if (!result.awaitingUser) return false;
  const requirement = result.interactionRequirement;
  if (requirement.type === "provide_context" || requirement.type === "answer") return true;
  if (requirement.type === "confirm" && requirement.timing === "after_agent_output") return false;
  const text = textForUserInputDetection(result);
  return /需要用户|请用户|用户确认|用户补充|补充.*信息|提供.*信息|缺少.*信息|确认.*城市|出发城市|出发地|目的地|预算|偏好|账号|登录|授权|选择|作答/.test(text);
}

function shouldAutoResolveRepeatedResumeConfirmation(ctx: AwaitingUserContext, result: ParsedTaskRunnerResult) {
  if (!ctx.resumeContext || !/用户对上一次阻塞点的决定：确认继续/.test(ctx.resumeContext)) return false;
  if (!result.awaitingUser || result.interactionRequirement.timing !== "after_agent_output") return false;
  if (result.interactionRequirement.type !== "confirm" && result.interactionRequirement.type !== "provide_context") return false;
  // 非结构化兜底刚生成的 awaiting 不属于"重复的 resume 确认"——它是 Agent 这一轮新产出的候选方案,
  // 不能被前一轮的"确认继续" resume 自动吞掉。否则用户根本看不到新方案(同 Q12 的姐妹边界)。
  if ((result.structuredOutput as Record<string, unknown> | null)?.recoveredFromUnstructuredConfirmation) return false;
  const text = [
    result.awaitingReason,
    result.interactionRequirement.reason,
    result.interactionRequirement.question,
    ...(result.deliverableCheck?.missingDeliverables ?? []),
  ].filter(Boolean).join("\n");
  return /确认|是否符合|是否满意|选择|行程安排/.test(text);
}

function resolveRepeatedResumeConfirmation(ctx: AwaitingUserContext, result: ParsedTaskRunnerResult): ParsedTaskRunnerResult {
  if (!shouldAutoResolveRepeatedResumeConfirmation(ctx, result)) return result;
  const missingDeliverables =
    result.deliverableCheck?.missingDeliverables.filter((item) => !/用户确认|确认选择|确认行程|用户选择|行程安排是否符合/.test(item)) ?? [];
  const deliverableCheck = result.deliverableCheck
    ? {
        ...result.deliverableCheck,
        matched: missingDeliverables.length === 0 ? true : result.deliverableCheck.matched,
        missingDeliverables,
        gapReason: missingDeliverables.length === 0 ? "" : result.deliverableCheck.gapReason,
      }
    : result.deliverableCheck;
  const interactionRequirement: InteractionRequirement = {
    type: "none",
    timing: "not_required",
    reason: "",
    question: "",
    options: [],
    suggestedActions: [],
    shouldNotifyUser: false,
  };
  const taskResult = result.taskResult
    ? {
        ...result.taskResult,
        status: result.taskResult.status === "pending_user" || result.taskResult.status === "blocked" ? "done" : result.taskResult.status,
      }
    : result.taskResult;
  return {
    ...result,
    summary: result.summary || "已吸收用户确认并完成任务。",
    awaitingUser: false,
    awaitingReason: "",
    interactionRequirement,
    taskResult,
    deliverableCheck,
    blocker: null,
    structuredOutput: {
      ...(result.structuredOutput ?? {}),
      interactionRequirement,
      ...(taskResult ? { taskResult } : {}),
      ...(deliverableCheck ? { deliverableCheck } : {}),
      autoResolvedRepeatedResumeConfirmation: true,
    },
  };
}

function buildPendingUserTaskResult(ctx: AwaitingUserContext, result: ParsedTaskRunnerResult): TaskResult {
  const question = result.interactionRequirement.question || result.awaitingReason || "请补充完成任务所需的关键信息。";
  const missing = result.deliverableCheck?.missingDeliverables?.length
    ? result.deliverableCheck.missingDeliverables
    : [question];
  return {
    schemaVersion: 1,
    taskId: ctx.task.id,
    instanceId: ctx.instance.id,
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
      role: "pending_user_placeholder",
    },
  };
}

export function coerceMissingUserContextBlocker(ctx: AwaitingUserContext, result: ParsedTaskRunnerResult): ParsedTaskRunnerResult {
  if (!looksLikeMissingUserContext(result)) return result;
  const question = result.interactionRequirement.question || result.awaitingReason || "请补充完成任务所需的关键信息。";
  const reason = result.awaitingReason || result.interactionRequirement.reason || question;
  const rawOptions = result.interactionRequirement.options?.length
    ? normalizeConfirmationOptionLabels(result.interactionRequirement.options)
    : [];
  const existingReadiness = isTaskReadinessCheck(result.structuredOutput?.taskReadiness) ? result.structuredOutput.taskReadiness : null;
  const baseReadiness =
    existingReadiness ??
    buildReadinessFromUserBlockers(result.deliverableCheck?.missingDeliverables?.length ? result.deliverableCheck.missingDeliverables : [question], reason);
  const readiness = applyInteractionOptionsToSingleMissingReadiness(baseReadiness, rawOptions, question);
  const fields = compileMissingFieldQuestions({
    readiness,
    fields: result.interactionRequirement.fields,
    options: rawOptions,
    fallbackQuestion: question,
  });
  const options = fields.length ? singleFieldOptions(fields) : rawOptions;
  const suggestedActions = uniqueStrings([
    ...(fields.length ? fieldsSuggestedActions(fields) : options),
    ...(result.suggestedActions ?? []),
  ]).slice(0, 5);
  const deliverableCheck = result.deliverableCheck ?? buildFallbackDeliverableCheck(ctx.task, reason);
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
    question: fields.length === 1 ? "" : question,
    options,
    fields,
    suggestedActions,
    shouldNotifyUser: true,
  };
  const taskResult = buildPendingUserTaskResult(ctx, { ...result, interactionRequirement, deliverableCheck: normalizedDeliverableCheck });
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

/**
 * 对一个已解析的结果做 awaiting 归一：先吸收重复的 resume 确认，
 * 再把"缺用户上下文"的结果转成带字段/blocker 的结构。纯函数。
 */
export function resolveAwaitingUser(ctx: AwaitingUserContext, result: ParsedTaskRunnerResult): ParsedTaskRunnerResult {
  return resolveRepeatedResumeConfirmation(ctx, coerceMissingUserContextBlocker(ctx, result));
}

/**
 * 当 Agent 返回非结构化的确认卡片内容时，从原始输出构造一个 awaiting 结果。
 * 调用方在 runLocalRepairCycle 里识别到此类输出后兜底走此入口。纯函数。
 */
export function buildAwaitingConfirmationFromRaw(ctx: AwaitingUserContext, rawOutput: string): ParsedTaskRunnerResult {
  const options: string[] = [];
  const question =
    ctx.task.collaboration?.userFacingActionLabel ||
    `请确认「${ctx.task.title}」采用哪个方案？`;
  const reason = "Agent 已产出候选方案/分析内容，需要你确认选择后继续后续任务。";
  const finalMessage = rawOutput.trim();
  const interactionRequirement: InteractionRequirement = {
    type: "confirm",
    timing: "after_agent_output",
    reason,
    question,
    options,
    suggestedActions: [],
    shouldNotifyUser: true,
  };
  const taskResult: TaskResult = {
    schemaVersion: 1,
    taskId: ctx.task.id,
    instanceId: ctx.instance.id,
    title: ctx.task.expectedOutcome || ctx.task.title,
    status: "pending_user",
    blocks: [
      { kind: "heading", text: ctx.task.title, level: 2 },
      { kind: "markdown", content: finalMessage },
      {
        kind: "decision",
        question,
        options: options.map((label, index) => ({
          id: `option-${index + 1}`,
          label,
          recommended: index === 0,
        })),
      },
      { kind: "callout", tone: "info", text: reason },
    ],
    meta: {
      producedAt: new Date().toISOString(),
      presentation: "visual_report",
      primaryFormat: "structured_blocks",
      exportableFormats: ["markdown"],
      role: "agent_deliverable",
    },
  };
  const deliverableCheck: DeliverableCheck = {
    matched: false,
    confidence: "medium",
    deliveredArtifacts: ["候选方案/分析内容"],
    missingDeliverables: ["用户确认选择"],
    criteriaResults: [
      {
        criterion: ctx.task.expectedResult?.completionCriteria || ctx.task.expectedOutcome,
        status: "unknown",
        evidence: "Agent 已产出候选内容，但协作要求要求用户确认后才能继续。",
      },
    ],
    gapReason: reason,
  };
  return {
    summary: "已产出候选方案，等待用户确认。",
    finalMessage,
    resultViewKind: normalizeTaskResultViewKind(ctx.task.resultViewKind ?? ctx.task.executionKind),
    awaitingUser: true,
    awaitingReason: reason,
    suggestedActions: [],
    artifacts: [],
    taskResult,
    deliverableCheck,
    interactionRequirement,
    blocker: null,
    structuredOutput: {
      taskResult,
      deliverableCheck,
      interactionRequirement,
      recoveredFromUnstructuredConfirmation: true,
    },
  };
}
