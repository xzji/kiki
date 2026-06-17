import { appendGoalLog, beginGoalTelemetry, failGoalTelemetry, finishGoalTelemetry, updateGoalTelemetry } from "@/lib/server/goalTelemetry";
import fs from "fs";
import path from "path";
import { buildAcceptanceJudgePrompt, buildLocalValidationRepairPrompt, buildSemanticRepairPrompt } from "@/lib/server/goalTaskAcceptancePrompt";
import { buildGoalTaskRunnerPrompt } from "@/lib/server/goalTaskPrompt";
import { readSessionMemoryForPrompt } from "@/lib/server/memory/conversationMemoryService";
import { readRelevantUserProfileMemoryForPrompt } from "@/lib/server/memory/userMemoryService";
import { resolveExecutionContext } from "@/lib/server/taskExecution/contextResolver";
import { renderDependencySection } from "@/lib/server/taskExecution/contextRenderer";
import { readinessFromContext } from "@/lib/server/taskExecution/readinessAdapter";
import type { TaskExecutionContext } from "@/lib/server/taskExecution/types";
import { runMultiAgentOrchestration } from "@/lib/server/agentOrchestration/MultiAgentOrchestrator";
import { selectAgentCollaborationStrategy } from "@/lib/server/agentOrchestration/strategy";
import {
  classifyTaskRunError,
  inferInteractionRequirement,
  requiresUserConfirmationToComplete,
} from "@/lib/server/domain/taskPolicy";
import { buildJsonParseCandidates, buildJsonRepairPrompt, parseJsonWithCandidates } from "@/lib/server/claude/jsonRepair";
import { extractBalancedJsonSnippet, extractJsonObject, extractParseFailureContext } from "@/lib/server/jsonExtraction";
import { judgeTaskResult } from "@/lib/server/resultNotificationJudge";
import { buildWebAppInteractionContext } from "@/lib/server/taskResult/interactionContext";
import { normalizeFileWriteSpecs } from "@/lib/server/fileWriteSpecs";
import { normalizeInteractionRequirement as normalizeServerInteractionRequirement } from "@/lib/server/protocol/normalizeAwaitingInteraction";
import { persistExternalEmbedArtifact, persistFileArtifact, persistWebAppArtifact, toArtifactRef } from "@/lib/server/workspace/artifactStorage";
import { writeTaskParseFailureSnapshot, writeTaskPromptFile } from "@/lib/server/workspace/conversationWorkspace";
import { markdownToWorkbook } from "@/lib/spreadsheet/adapters/markdownTables";
import { XLSX_MIME } from "@/lib/spreadsheet/constants";
import { buildXlsxBuffer } from "@/lib/spreadsheet/server/buildXlsx";
import {
  buildUserConfirmationOptionsRepairPrompt,
  buildUserConfirmationOptionsPrompt,
  formatOptionLabelsWithHints,
  normalizeConfirmationOptionLabels,
  parseUserConfirmationOptions,
  type UserConfirmationOptionsContext,
  type UserConfirmationOptionsResult,
} from "@/lib/server/userConfirmationOptionsPrompt";
import {
  buildTaskReadinessCheck,
  extractUserFeedback,
  finalizeReadiness,
  type TaskReadinessCheck,
  type TaskReadinessInfoItem,
} from "@/lib/server/taskReadinessPolicy";
import {
  compileMissingFieldQuestions,
  fieldsSuggestedActions,
  normalizeMissingFieldQuestions,
  singleFieldOptions,
} from "@/lib/server/informationRequest/compileFields";
import { deriveLegacyTaskResult } from "@/lib/taskResult/legacyAdapter";
import { validateTaskResultLocally } from "@/lib/taskResult/localValidation";
import { normalizeTaskResult } from "@/lib/taskResult/parseAndRepair";
import { resolveExpectedSurfaces } from "@/lib/taskResult/surfaces";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { AgentRunPlan } from "@/types/agentOrchestration";
import { normalizeTaskResultViewKind } from "@/types/kiki";
import type {
  Goal,
  InteractionRequirement,
  MissingFieldQuestion,
  SubGoal,
  Task,
  TaskInstance,
  TaskResultViewKind,
  TaskRunArtifact,
  TaskRunErrorCategory,
} from "@/types/kiki";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { Artifact, ArtifactRef } from "@/types/artifact";
import type { RuntimeEnvironment } from "@/types/runtime";
import type { AcceptanceReport, LocalValidationReport, TaskAcceptanceRuntimeState } from "@/types/taskAcceptance";
import type { ResultBlock, TaskResult } from "@/types/taskResult";

import { streamClaudeCli } from "./claudeCli";
import { getRuntimeJobByRequestId } from "./repositories/runtimeJobsRepository";
import { updateGoalRuntimeJobExecution } from "@/lib/server/services/goalRuntimeService";
import { appendGuardedEvent } from "@/lib/server/agentRuntime/agentExecutor";
import { createAgentRun, updateAgentRun } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { upsertAgentSnapshot } from "@/lib/server/repositories/agentRuntime/agentSnapshotsRepository";
import type { AgentEventType } from "@/types/agentRuntime";

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
  executionContext?: TaskExecutionContext;
  agentRunId?: string;
  signal?: AbortSignal;
  /** 流式进展事件回调，用于上层（ProcessSupervisor）重置空闲超时判定。 */
  onProgressPing?: (kind: string) => void;
  /** Claude CLI spawn 成功后回传 pid，供上层绑定 OS 进程做生命周期管理。 */
  onSpawn?: (pid: number) => void;
};

/**
 * runGoalTask 的结构化终态。云端经 Tunnel 下发的 goal task 在本机执行完后，
 * 需要把真实终态（含 awaiting_user 的 blocker / result）回传给服务端，
 * 否则服务端只能看到 ok:true 而误判为 completed（"瘦回执" bug）。
 */
export type GoalTaskOutcome = {
  status: "completed" | "failed" | "awaiting_user";
  blocker?: ExecutionBlocker | null;
  trajectory?: ExecutionTrajectoryStep[];
  result?: Record<string, unknown> | null;
  error?: string;
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

function readTaskRunnerMemoryContext(conversationId: string) {
  try {
    return {
      userMemory: readRelevantUserProfileMemoryForPrompt(conversationId).content,
      sessionMemory: readSessionMemoryForPrompt(conversationId),
    };
  } catch {
    return { userMemory: "", sessionMemory: "" };
  }
}

function normalizeParsedAwaitingResult<T extends ParsedTaskRunnerResult>(result: T): T {
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

type WebAppSpec = {
  title: string;
  description?: string;
  html: string;
  initialState?: Record<string, unknown>;
  networkPolicy?: "offline" | "internet";
};

type ExternalEmbedSpec = {
  title: string;
  description?: string;
  url: string;
  provider?: "youtube" | "generic";
};

function getGoalTaskRuntimeJobId(input: RunGoalTaskInput) {
  return `job-${input.instance.id}`;
}

function appendGoalTaskAgentEvent(
  input: Pick<RunGoalTaskInput, "agentRunId" | "requestId" | "goal" | "subGoal" | "task" | "instance">,
  type: AgentEventType,
  payload: Record<string, unknown>,
) {
  if (!input.agentRunId) return;
  appendGuardedEvent({
    agentRunId: input.agentRunId,
    type,
    payload: {
      requestId: input.requestId,
      goalId: input.goal.id,
      threadId: input.subGoal.id,
      taskId: input.task.id,
      instanceId: input.instance.id,
      ...payload,
    },
  });
}

function createGoalTaskAgentRun(input: RunGoalTaskInput) {
  const run = createAgentRun({
    topicId: input.goal.id,
    threadId: input.subGoal.id,
    taskId: input.task.id,
    runtimeJobId: getGoalTaskRuntimeJobId(input),
    role: "goal_task",
    status: "running",
    idempotencyKey: `goal-task:${input.requestId}`,
  });
  updateAgentRun({ id: run.id, status: "running" });
  return run.id;
}

function finishGoalTaskAgentRun(agentRunId: string | undefined, status: "completed" | "failed") {
  if (!agentRunId) return;
  const run = updateAgentRun({
    id: agentRunId,
    status,
    finishedAt: new Date().toISOString(),
  });
  if (!run) return;
  upsertAgentSnapshot({
    agentRunId,
    lastEventSeq: run.lastEventSeq,
    state: {
      status,
      finishedAt: run.finishedAt,
    },
  });
}

type RawTaskRunnerPayload = {
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

type TaskRunAttemptResult = ParsedTaskRunnerResult & {
  trajectory: ExecutionTrajectoryStep[];
  rawOutput: string;
  localValidationReport?: LocalValidationReport;
  acceptanceReport?: AcceptanceReport;
  acceptanceRuntime?: TaskAcceptanceRuntimeState;
};

function normalizeStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function uniqueStrings(items: Array<string | undefined>) {
  return Array.from(new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))));
}

const FINAL_PROTOCOL_JSON_KEYS = [
  "summary",
  "final_message",
  "interaction_requirement",
  "task_result",
  "deliverable_check",
  "structured_output",
];

function looksLikeFinalProtocolJsonFragment(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const matchedProtocolKeyCount = FINAL_PROTOCOL_JSON_KEYS.filter((key) => trimmed.includes(`"${key}"`)).length;
  if (matchedProtocolKeyCount < 2) return false;
  const jsonKeyMatches = trimmed.match(/"[^"]+"\s*:/g) ?? [];
  return trimmed.startsWith("{") || jsonKeyMatches.length >= 4;
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
  const dependencyContextText = input.executionContext ? renderDependencySection(input.executionContext) : "";
  const baseReadiness = buildTaskReadinessCheck({
    ...input,
    instance: {
      ...input.instance,
      intro: [input.instance.intro, dependencyContextText].filter(Boolean).join("\n"),
    },
  });
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
  const hasUserMissing = readiness.missingUserInfo.some((item) => item.source === "user");
  return {
    schemaVersion: 1,
    taskId: input.task.id,
    instanceId: input.instance.id,
    title: hasUserMissing ? "需要补充信息后继续" : "执行前置条件未满足",
    status: "pending_user",
    blocks: [
      {
        kind: "callout",
        tone: "warn",
        text: hasUserMissing
          ? "当前任务缺少用户才能提供的必要信息，KiKi 已暂停执行，没有生成基于猜测的方案。"
          : "当前任务的执行前置条件尚未满足，KiKi 已暂停执行，等待上游任务或配置问题处理完成。",
      },
      { kind: "heading", level: 2, text: hasUserMissing ? "缺失的必要信息" : "未满足的前置条件" },
      { kind: "list", ordered: false, items: missingLabels },
      {
        kind: "key_value",
        entries: readiness.items.map((item) => ({
          label: item.label,
          value: `${item.status === "missing_user" && item.source === "user" ? "缺失，需用户提供" : item.status === "agent_retrievable" ? "Agent 可自行获取" : "前置条件未满足"}：${item.reason}`,
          emphasis: item.status === "missing_user",
        })),
      },
    ],
    meta: {
      producedAt: readiness.generatedAt,
      role: "pending_user_placeholder",
    },
  };
}

async function buildReadinessBlockedResult(input: RunGoalTaskInput, readiness: TaskReadinessCheck): Promise<ParsedTaskRunnerResult> {
  const firstMissing = readiness.missingUserInfo[0];
  const hasUserMissing = readiness.missingUserInfo.some((item) => item.source === "user");
  const question =
    !hasUserMissing
      ? readiness.summary
      : readiness.missingUserInfo.length === 1
      ? `请补充${firstMissing.label}，KiKi 才能继续执行「${input.task.title.replace(/^任务\d+：/, "")}」。`
      : `请补充以下必要信息：${readiness.missingUserInfo.map((item) => item.label).join("、")}。`;
  const shouldGenerateOptions = readiness.missingUserInfo.some((item) => item.source === "user");
  const readinessWithOptions = shouldGenerateOptions
    ? await generateOptionsForReadinessItems(input, readiness, question)
    : readiness;
  const fields = compileMissingFieldQuestions({ readiness: readinessWithOptions, fallbackQuestion: question });
  const options = singleFieldOptions(fields);
  const suggestedActions = fieldsSuggestedActions(fields);
  const taskResult = buildReadinessBlockedTaskResult(input, readinessWithOptions);
  const interactionRequirement: InteractionRequirement = {
    type: hasUserMissing ? "provide_context" : "deliverable_gap",
    timing: "before_execution",
    reason: readiness.summary,
    question: fields.length === 1 ? "" : question,
    options,
    fields,
    suggestedActions,
    shouldNotifyUser: true,
  };
  const deliverableCheck = buildFallbackDeliverableCheck(input, readiness.summary);
  return {
    summary: hasUserMissing ? "需要你补充关键信息后才能继续执行。" : "任务执行前置条件未满足。",
    finalMessage: readiness.summary,
    resultViewKind: normalizeTaskResultViewKind(input.task.resultViewKind ?? input.task.executionKind),
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
      taskReadiness: readinessWithOptions,
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

function isNonBlockingInformationFeedback(input: RunGoalTaskInput, requirement: InteractionRequirement, taskResult: TaskResult | null) {
  return (
    input.task.expectedResult?.type === "information" &&
    requirement.type === "confirm" &&
    requirement.timing === "after_agent_output" &&
    taskResult?.status === "done" &&
    !requiresUserConfirmationToComplete(input.task, { includeUserCompletionOwner: true })
  );
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
  const requirement = result.interactionRequirement;
  if (requirement.type === "provide_context" || requirement.type === "answer") return true;
  if (requirement.type === "confirm" && requirement.timing === "after_agent_output") return false;
  const text = textForUserInputDetection(result);
  return /需要用户|请用户|用户确认|用户补充|补充.*信息|提供.*信息|缺少.*信息|确认.*城市|出发城市|出发地|目的地|预算|偏好|账号|登录|授权|选择|作答/.test(text);
}

function truncateForLog(value: string, limit = 2000) {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function formatCollaborationSummary(task: Task) {
  const collaboration = task.collaboration;
  if (!collaboration) return "未声明协作要求";
  return [
    `协作模式：${collaboration.mode}`,
    `Agent 负责：${collaboration.agentResponsibilities.join("；") || "完成任务并交付结果"}`,
    `用户负责：${collaboration.userResponsibilities.join("；") || "无需用户参与"}`,
    `用户介入类型：${collaboration.userInteractionType}`,
    `用户介入时机：${collaboration.userInteractionTiming}`,
    `用户动作文案：${collaboration.userFacingActionLabel}`,
    `完成定义：${collaboration.completionDefinition}`,
  ].join("\n");
}

function buildOptionGenerationContext(input: RunGoalTaskInput, options: {
  question: string;
  missingItems: TaskReadinessInfoItem[];
  seedOptions?: string[];
}): UserConfirmationOptionsContext {
  return {
    question: options.question,
    goalTitle: input.goal.title,
    goalSummary: input.goal.summary,
    subGoalTitle: input.subGoal.title,
    taskTitle: input.task.title,
    taskDescription: input.task.description,
    executionObjective: input.task.executionObjective,
    expectedOutcome: input.task.expectedOutcome,
    expectedResultDescription: input.task.expectedResult?.description,
    completionCriteria: input.task.expectedResult?.completionCriteria,
    collaborationSummary: formatCollaborationSummary(input.task),
    missingItems: options.missingItems.map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      reason: item.reason,
      inputKind: item.inputKind,
    })),
    resumeContext: input.resumeContext,
    seedOptions: normalizeConfirmationOptionLabels(options.seedOptions ?? []),
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

function isTaskReadinessCheck(value: unknown): value is TaskReadinessCheck {
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

function normalizeFieldAnswerOptions(values: string[]) {
  return normalizeConfirmationOptionLabels(values.filter((option) => !isActionLikeConfirmationOption(option)));
}

function asksForDestinationCities(text: string) {
  return /(游览|目的地|城市组合|选定城市|计划.*城市|哪些城市)/.test(text);
}

function optionsLookLikeDepartureCities(options: string[]) {
  return options.length > 0 && options.every((option) => /出发|出发地|从.+飞|航班/.test(option));
}

function chooseReadinessOptions(input: {
  item: TaskReadinessInfoItem;
  question: string;
  seedOptions: string[];
  generatedOptions: string[];
}) {
  const itemTextValues = new Set([input.item.label, input.item.description, input.item.reason].map((value) => value.trim()).filter(Boolean));
  const seedOptions = normalizeFieldAnswerOptions(input.seedOptions.filter((option) => !itemTextValues.has(option.trim())));
  if (seedOptions.length > 0) return seedOptions;

  const contextText = [input.question, input.item.label, input.item.description, input.item.reason].filter(Boolean).join("\n");
  if (asksForDestinationCities(contextText) && optionsLookLikeDepartureCities(input.generatedOptions)) return [];
  return input.generatedOptions;
}

function refreshReadinessCollections(items: TaskReadinessInfoItem[], generatedAt: string, summary: string): TaskReadinessCheck {
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

async function runOptionGenerationPrompt(input: RunGoalTaskInput, context: UserConfirmationOptionsContext): Promise<UserConfirmationOptionsResult | null> {
  let raw = "";
  try {
    raw = await runClaudePrompt(input, buildUserConfirmationOptionsPrompt(context), "readonly");
    const result = parseUserConfirmationOptions(raw);
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_task_execute",
      level: "info",
      phase: "executing",
      message: "用户候选项提示词生成成功",
      details: JSON.stringify({
        missingItemCount: context.missingItems.length,
        optionCounts: result.items.map((item) => ({ id: item.id, count: item.options.length })),
      }),
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
    });
    return result;
  } catch (error) {
    const firstError = error instanceof Error ? error.message : String(error);
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_task_execute",
      level: "warn",
      phase: "executing",
      message: "用户候选项提示词生成失败，准备重试",
      details: JSON.stringify({ error: firstError, rawOutput: truncateForLog(raw) }),
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
    });
    let repairRaw = "";
    try {
      repairRaw = await runClaudePrompt(
        input,
        buildUserConfirmationOptionsRepairPrompt({
          context,
          rawOutput: truncateForLog(raw),
          errorSummary: firstError,
        }),
        "readonly",
      );
      return parseUserConfirmationOptions(repairRaw);
    } catch (repairError) {
      appendGoalLog({
        requestId: input.requestId,
        scope: "goal_task_execute",
        level: "warn",
        phase: "executing",
        message: "用户候选项生成重试失败，将仅展示自定义输入",
        details: JSON.stringify({
          error: repairError instanceof Error ? repairError.message : String(repairError),
          rawOutput: truncateForLog(repairRaw),
        }),
        goalId: input.goal.id,
        taskId: input.task.id,
        taskInstanceId: input.instance.id,
      });
      return null;
    }
  }
}

function generatedOptionsForItem(result: UserConfirmationOptionsResult | null, item: TaskReadinessInfoItem) {
  if (!result) return [];
  const matchedItem = result.items.find((entry) => entry.id === item.id) ?? result.items.find((entry) => entry.label === item.label);
  if (!matchedItem) return [];
  return formatOptionLabelsWithHints({ question: result.question, items: [matchedItem] }, matchedItem.id);
}

function generatedOptionMetaForItem(result: UserConfirmationOptionsResult | null, item: TaskReadinessInfoItem) {
  return result?.items.find((entry) => entry.id === item.id) ?? result?.items.find((entry) => entry.label === item.label);
}

function applyGeneratedOptionsToReadiness(
  readiness: TaskReadinessCheck,
  result: UserConfirmationOptionsResult | null,
  optionsContext: { question: string; seedOptions?: string[] },
): TaskReadinessCheck {
  const items = readiness.items.map((item) => {
    if (item.status !== "missing_user" || item.source !== "user") return item;
    const generatedMeta = generatedOptionMetaForItem(result, item);
    const generatedOptions = generatedOptionsForItem(result, item);
    const inputKind = generatedMeta?.inputKind ?? item.inputKind;
    return {
      ...item,
      options:
        inputKind === "image" || inputKind === "file"
          ? []
          : chooseReadinessOptions({
              item,
              question: optionsContext.question,
              seedOptions: readiness.missingUserInfo.length === 1 ? optionsContext.seedOptions ?? [] : [],
              generatedOptions,
            }),
      optionQuestion: generatedMeta?.question,
      inputPlaceholder: generatedMeta?.inputPlaceholder,
      inputKind,
    };
  });
  return refreshReadinessCollections(items, readiness.generatedAt, readiness.summary);
}

async function generateOptionsForReadinessItems(input: RunGoalTaskInput, readiness: TaskReadinessCheck, question: string, seedOptions: string[] = []) {
  const result = await runOptionGenerationPrompt(
    input,
    buildOptionGenerationContext(input, {
      question,
      missingItems: readiness.missingUserInfo,
      seedOptions,
    }),
  );
  return applyGeneratedOptionsToReadiness(readiness, result, { question, seedOptions });
}

function fieldNeedsGeneratedOptions(field: MissingFieldQuestion) {
  if (field.inputKind === "image" || field.inputKind === "file") return false;
  return (field.options?.length ?? 0) < 3;
}

function readinessItemFromField(field: MissingFieldQuestion): TaskReadinessInfoItem {
  return {
    id: field.id,
    label: field.label,
    description: field.description || field.question || field.label,
    source: field.source,
    status: "missing_user",
    reason: field.description || field.question || field.label,
    options: field.options,
    optionQuestion: field.question,
    inputPlaceholder: field.inputPlaceholder,
    inputKind: field.inputKind,
  };
}

async function enrichAwaitingUserFieldOptions(
  input: RunGoalTaskInput,
  result: ParsedTaskRunnerResult,
): Promise<ParsedTaskRunnerResult> {
  if (!result.awaitingUser || !result.interactionRequirement.fields?.length) return result;
  const fields = result.interactionRequirement.fields;
  const fieldsToGenerate = fields.filter(fieldNeedsGeneratedOptions);
  if (!fieldsToGenerate.length) return result;

  const generated = await runOptionGenerationPrompt(
    input,
    buildOptionGenerationContext(input, {
      question: result.interactionRequirement.question || result.awaitingReason || result.interactionRequirement.reason,
      missingItems: fieldsToGenerate.map(readinessItemFromField),
      seedOptions: result.interactionRequirement.options ?? [],
    }),
  );
  if (!generated) return result;

  const nextFields = fields.map((field) => {
    if (!fieldNeedsGeneratedOptions(field)) return field;
    const generatedMeta = generatedOptionMetaForItem(generated, readinessItemFromField(field));
    const generatedOptions = generatedOptionsForItem(generated, readinessItemFromField(field));
    const inputKind = generatedMeta?.inputKind ?? field.inputKind;
    const options = uniqueStrings([
      ...(field.options ?? []),
      ...generatedOptions,
    ]).slice(0, 3);
    if (inputKind === "image" || inputKind === "file") {
      return {
        ...field,
        question: generatedMeta?.question || field.question,
        options: [],
        inputPlaceholder: generatedMeta?.inputPlaceholder || field.inputPlaceholder,
        inputKind,
      };
    }
    if (!options.length) return field;
    return {
      ...field,
      question: generatedMeta?.question || field.question,
      options,
      inputPlaceholder: generatedMeta?.inputPlaceholder || field.inputPlaceholder,
      inputKind,
    };
  });
  const nextOptions = singleFieldOptions(nextFields);
  const nextRequirement: InteractionRequirement = {
    ...result.interactionRequirement,
    fields: nextFields,
    options: nextOptions,
    suggestedActions: fieldsSuggestedActions(nextFields),
  };
  return {
    ...result,
    suggestedActions: nextRequirement.suggestedActions,
    interactionRequirement: nextRequirement,
    structuredOutput: {
      ...(result.structuredOutput ?? {}),
      interactionRequirement: nextRequirement,
    },
  };
}

function applyInteractionOptionsToSingleMissingReadiness(
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

function shouldAutoResolveRepeatedResumeConfirmation(input: RunGoalTaskInput, result: ParsedTaskRunnerResult) {
  if (!input.resumeContext || !/用户对上一次阻塞点的决定：确认继续/.test(input.resumeContext)) return false;
  if (!result.awaitingUser || result.interactionRequirement.timing !== "after_agent_output") return false;
  if (result.interactionRequirement.type !== "confirm" && result.interactionRequirement.type !== "provide_context") return false;
  const text = [
    result.awaitingReason,
    result.interactionRequirement.reason,
    result.interactionRequirement.question,
    ...(result.deliverableCheck?.missingDeliverables ?? []),
  ].filter(Boolean).join("\n");
  return /确认|是否符合|是否满意|选择|行程安排/.test(text);
}

function resolveRepeatedResumeConfirmation(input: RunGoalTaskInput, result: ParsedTaskRunnerResult): ParsedTaskRunnerResult {
  if (!shouldAutoResolveRepeatedResumeConfirmation(input, result)) return result;
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
      role: "pending_user_placeholder",
    },
  };
}

function coerceMissingUserContextBlocker(input: RunGoalTaskInput, result: ParsedTaskRunnerResult): ParsedTaskRunnerResult {
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
    question: fields.length === 1 ? "" : question,
    options,
    fields,
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

function parseTaskRunnerResult(input: RunGoalTaskInput, raw: string, fallbackKind: TaskResultViewKind): ParsedTaskRunnerResult {
  const { parsed } = parseTaskRunnerPayload(raw);
  const parsedFiles = normalizeFileWriteSpecs(parsed.files);
  const parsedWebApp = normalizeWebAppSpec(parsed.webapp);
  const parsedExternalEmbed = normalizeExternalEmbedSpec(parsed.external_embed);
  const normalizedTaskResult = normalizeTaskResult(parsed.task_result ?? parsed.taskResult, {
    taskId: input.task.id,
    instanceId: input.instance.id,
    title: input.task.expectedOutcome || input.task.title,
  });
  const expectedSurfaces = resolveExpectedSurfaces(input.task.expectedResult);
  const expectsWebApp = input.task.expectedResult?.interactiveSurface?.kind === "webapp" || Boolean(parsedWebApp) || Boolean(parsedExternalEmbed);
  const taskResult =
    normalizedTaskResult ||
    (expectedSurfaces.includes("interactive") && expectsWebApp && (parsedWebApp || parsedExternalEmbed)
      ? {
          schemaVersion: 1 as const,
          taskId: input.task.id,
          instanceId: input.instance.id,
          title: parsedWebApp?.title || parsedExternalEmbed?.title || input.task.expectedOutcome || input.task.title,
          status: "done" as const,
          blocks: [],
          meta: {
            producedAt: new Date().toISOString(),
            surfaces: ["interactive" as const],
            interactiveSurfaceKind: "webapp" as const,
            primaryFormat: "html" as const,
            exportableFormats: input.task.expectedResult?.exportableFormats,
          },
        }
      : null) ||
    (expectedSurfaces.includes("files") && parsedFiles.length > 0
      ? {
          schemaVersion: 1 as const,
          taskId: input.task.id,
          instanceId: input.instance.id,
          title: input.task.expectedOutcome || input.task.title,
          status: "done" as const,
          blocks: [],
          meta: {
            producedAt: new Date().toISOString(),
            surfaces: ["files" as const],
            fileSurfaceRequired: true,
            primaryFormat: input.task.expectedResult?.primaryFormat,
            exportableFormats: input.task.expectedResult?.exportableFormats,
          },
        }
      : null);
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
  const isFeedbackOnly = isNonBlockingInformationFeedback(input, interactionRequirement, taskResult);
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
    summary: parsed.summary?.trim() || legacyFromBlocks?.summary || "任务执行完成。",
    finalMessage: parsed.final_message?.trim() || legacyFromBlocks?.finalMessage || parsed.summary?.trim() || "任务执行完成。",
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

function buildParseCandidateDiagnostics(raw: string) {
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

function buildTaskParseError(input: RunGoalTaskInput, raw: string, error: unknown) {
  const context = extractParseFailureContext(raw, error);
  let snapshotPath = "";
  if (input.conversationWorkspaceDir && input.taskWorkspaceDir) {
    try {
      const snapshot = writeTaskParseFailureSnapshot({
        workspaceDir: input.conversationWorkspaceDir,
        taskWorkspaceDir: input.taskWorkspaceDir,
        requestId: input.requestId,
        taskId: input.task.id,
        instanceId: input.instance.id,
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

function tryParseTaskRunnerResult(input: RunGoalTaskInput, raw: string, fallbackKind: TaskResultViewKind) {
  try {
    return {
      result: parseTaskRunnerResult(input, raw, fallbackKind),
      error: undefined,
    };
  } catch (error) {
    return {
      result: null,
      error: buildTaskParseError(input, raw, error),
    };
  }
}

function extractFileWriteSpecs(raw: string) {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as { files?: unknown };
    return normalizeFileWriteSpecs(parsed.files);
  } catch {
    return [];
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeWebAppSpec(value: unknown): WebAppSpec | null {
  if (!isPlainRecord(value)) return null;
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : "可执行小应用";
  const description = typeof value.description === "string" && value.description.trim() ? value.description.trim() : undefined;
  const html = typeof value.html === "string" ? value.html.trim() : "";
  if (!html) return null;
  const initialState = isPlainRecord(value.initialState) ? value.initialState : undefined;
  const networkPolicy = value.networkPolicy === "internet" ? "internet" : "offline";
  return { title, description, html, initialState, networkPolicy };
}

function normalizeExternalEmbedSpec(value: unknown): ExternalEmbedSpec | null {
  if (!isPlainRecord(value)) return null;
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : "外部嵌入";
  const description = typeof value.description === "string" && value.description.trim() ? value.description.trim() : undefined;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!url) return null;
  const provider = value.provider === "youtube" ? "youtube" : value.provider === "generic" ? "generic" : undefined;
  return { title, description, url, provider };
}

function extractWebAppSpec(raw: string) {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as { webapp?: unknown };
    return normalizeWebAppSpec(parsed.webapp);
  } catch {
    return null;
  }
}

function extractExternalEmbedSpec(raw: string) {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as { external_embed?: unknown };
    return normalizeExternalEmbedSpec(parsed.external_embed);
  } catch {
    return null;
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

function shouldCompleteOnApprove(result: ParsedTaskRunnerResult) {
  if (result.interactionRequirement.type !== "confirm" || result.interactionRequirement.timing !== "after_agent_output") {
    return false;
  }

  const text = textForUserInputDetection(result);
  const asksForFinalization =
    /确认.*(生成|输出|定稿|最终|执行|继续|按此|满意|修改)|提出修改|修改建议|是否满意|节奏安排|候选|草案|方案.*确认|审核/.test(text);
  if (asksForFinalization) return false;

  const deliveredFinalResult = result.deliverableCheck?.matched === true && result.taskResult?.status === "done";
  const explicitlyReceiptOnly = /确认(已读|收到|完成|归档)|无需.*继续|不需要.*继续|仅需.*确认/.test(text);
  return deliveredFinalResult && explicitlyReceiptOnly;
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
    resumeStrategy: shouldCompleteOnApprove(result) ? "complete_on_approve" : "rerun_with_feedback",
    status: "waiting",
    createdAt: now,
  };
}

function createToolPermissionExecutionBlocker(input: RunGoalTaskInput, request: {
  requestId: string;
  runtimeEnvId: string;
  toolName: string;
  suggestedRule: string;
}, trajectoryLength: number): ExecutionBlocker {
  const now = new Date().toISOString();
  return {
    kind: "tool_permission",
    executionId: input.requestId,
    taskId: input.task.id,
    instanceId: input.instance.id,
    blockedStepIndex: Math.max(trajectoryLength - 1, 0),
    resumeToken: request.requestId,
    interactionRequirement: {
      type: "confirm",
      timing: "during_execution",
      reason: `Claude 请求使用工具 ${request.toolName}，需要用户授权后继续执行。`,
      question: `是否允许工具 ${request.toolName} 运行？`,
      suggestedActions: ["本次允许", "本会话内始终允许", "始终允许并写入 Runtime 策略", "拒绝"],
      shouldNotifyUser: true,
    },
    resumeStrategy: "rerun_with_feedback",
    status: "waiting",
    createdAt: now,
    toolPermission: {
      requestId: request.requestId,
      runtimeEnvId: request.runtimeEnvId,
      toolName: request.toolName,
      suggestedRule: request.suggestedRule,
    },
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
  updateGoalRuntimeJobExecution(job.id, { trajectory });
}

function progressPayloadWithTrajectory(trajectory: ExecutionTrajectoryStep[], resultPayload?: Record<string, unknown> | null) {
  return {
    ...(resultPayload ?? {}),
    trajectory,
  };
}

function attachAgentRunPlan<T extends ParsedTaskRunnerResult>(result: T, agentRunPlan: AgentRunPlan | null): T {
  if (!agentRunPlan) return result;
  const qualityIssues = agentRunPlan.review?.issues.map((issue) => issue.message) ?? [];
  return {
    ...result,
    taskResult: result.taskResult
      ? {
          ...result.taskResult,
          meta: {
            ...result.taskResult.meta,
            agentRunPlan,
            qualityReview: agentRunPlan.review
              ? {
                  passed: agentRunPlan.review.passed,
                  issues: qualityIssues,
                  reviewerRole: "reviewer",
                }
              : undefined,
          },
        }
      : result.taskResult,
    structuredOutput: {
      ...(result.structuredOutput ?? {}),
      agentRunPlan,
      ...(agentRunPlan.review ? { qualityReview: agentRunPlan.review } : {}),
    },
  };
}

type AppendTrajectoryFn = (
  step: Omit<ExecutionTrajectoryStep, "id" | "index" | "startedAt"> & { startedAt?: string },
) => ExecutionTrajectoryStep[];

/**
 * webapp 与 external_embed 两种交互产物落盘的逻辑逐行同构：running 轨迹 → persist → toArtifactRef →
 * 合并 taskResult.artifactRefs/meta（追加 interactive surface）→ 同步 structuredOutput.artifactRefs →
 * completed 轨迹。此 helper 收敛公共流程，差异（具体 persist 调用与轨迹文案）由调用方注入。
 * 直接原地写入 result.taskResult / result.structuredOutput，与原内联逻辑等价。
 */
function applyInteractiveArtifactResult(options: {
  result: TaskRunAttemptResult;
  appendTrajectory: AppendTrajectoryFn;
  runningTitle: string;
  completedTitle: string;
  thought: string;
  persist: () => Artifact;
}) {
  const { result, appendTrajectory, runningTitle, completedTitle, thought, persist } = options;
  if (!result.taskResult) return;
  appendTrajectory({
    type: "system",
    status: "running",
    title: runningTitle,
    thought,
  });
  const artifactRef = toArtifactRef(persist());
  result.taskResult = {
    ...result.taskResult,
    artifactRefs: [...(result.taskResult.artifactRefs ?? []), artifactRef],
    meta: {
      ...result.taskResult.meta,
      surfaces: Array.from(new Set([...(result.taskResult.meta.surfaces ?? []), "interactive" as const])),
      interactiveSurfaceKind: "webapp",
    },
  };
  result.structuredOutput = {
    ...(result.structuredOutput ?? {}),
    artifactRefs: result.taskResult.artifactRefs,
  };
  appendTrajectory({
    type: "system",
    status: "completed",
    title: completedTitle,
    thought,
    endedAt: new Date().toISOString(),
  });
}

async function runClaudePromptWithFallback(input: RunGoalTaskInput, message: string, permissionMode: RuntimeEnvironment["permissionMode"]) {
  let finalMessage = "";
  let fallbackMessage = "";
  const workingDirectory = input.taskWorkspaceDir || input.task.recommendedWorkingDirectory || input.runtimeEnv.workingDirectory;
  appendGoalTaskAgentEvent(input, "llm.request", {
    phase: "goal_task_auxiliary_prompt",
    permissionMode,
    workingDirectory,
    prompt: message,
  });
  try {
    await streamClaudeCli({
      message,
      workingDirectory,
      cliPath: input.runtimeEnv.cliPath,
      permissionMode,
      runtimeKind: input.runtimeEnv.runtimeKind,
      runtimeEnvId: input.runtimeEnv.id,
      filePolicy: input.runtimeEnv.filePolicy,
      channelPolicy: { mode: "task" },
      conversationId: input.goal.conversationId,
      taskInstanceId: input.instance.id,
      taskId: input.task.id,
      agentRunId: input.agentRunId,
      resumeSessionId: undefined,
      signal: input.signal,
      onSpawn: input.onSpawn,
      onEvent: (event) => {
        input.onProgressPing?.(event.type);
        if (event.type === "message") {
          finalMessage = event.content;
          fallbackMessage = event.fallbackContent ?? "";
        }
        if (event.type === "tool_call") {
          appendGoalTaskAgentEvent(input, "tool_call", {
            phase: "goal_task_auxiliary_prompt",
            toolName: event.toolName,
            input: event.input,
            summary: event.summary,
          });
        }
        if (event.type === "tool_permission_request") {
          const blocker = createToolPermissionExecutionBlocker(input, event, 0);
          updateGoalRuntimeJobExecution(`job-${input.instance.id}`, {
            status: "awaiting_user",
            blocker,
          });
          updateGoalTelemetry({
            requestId: input.requestId,
            scope: "goal_task_execute",
            phase: "executing",
            message: `等待工具授权：${event.toolName}`,
            goalId: input.goal.id,
            taskId: input.task.id,
            taskInstanceId: input.instance.id,
            resultPayload: {
              runtimeJobStatus: "awaiting_user",
              blocker,
            },
          });
          appendGoalTaskAgentEvent(input, "awaiting_user", {
            phase: "goal_task_auxiliary_prompt",
            kind: "tool_permission.requested",
            requestId: event.requestId,
            runtimeEnvId: event.runtimeEnvId,
            toolName: event.toolName,
            suggestedRule: event.suggestedRule,
          });
          appendGoalLog({
            requestId: input.requestId,
            scope: "goal_task_execute",
            level: "info",
            phase: "executing",
            message: `等待工具授权：${event.toolName}`,
            eventType: "await_user",
            toolName: event.toolName,
            status: "awaiting_user",
            goalId: input.goal.id,
            taskId: input.task.id,
            taskInstanceId: input.instance.id,
          });
        }
        if (event.type === "tool_permission_resolved") {
          updateGoalRuntimeJobExecution(`job-${input.instance.id}`, {
            status: "running",
            blocker: null,
          });
          updateGoalTelemetry({
            requestId: input.requestId,
            scope: "goal_task_execute",
            phase: "executing",
            message: event.decision === "allow" ? "工具授权已允许，继续执行" : "工具授权已拒绝，继续执行替代路径",
            goalId: input.goal.id,
            taskId: input.task.id,
            taskInstanceId: input.instance.id,
            resultPayload: {
              runtimeJobStatus: "running",
              blocker: null,
            },
          });
          appendGoalTaskAgentEvent(input, "log", {
            phase: "goal_task_auxiliary_prompt",
            kind: "tool_permission.resolved",
            requestId: event.requestId,
            decision: event.decision,
            scope: event.scope,
            rule: event.rule,
          });
        }
        if (event.type === "error") throw new Error(event.message);
      },
    });
  } catch (error) {
    appendGoalTaskAgentEvent(input, "error", {
      phase: "goal_task_auxiliary_prompt",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  if (!finalMessage.trim()) {
    const message = "Claude CLI 未返回 result.result，无法提取最终任务结果。";
    appendGoalTaskAgentEvent(input, "error", {
      phase: "goal_task_auxiliary_prompt",
      message,
      fallbackText: fallbackMessage,
    });
    throw new Error(message);
  }
  appendGoalTaskAgentEvent(input, "llm.response", {
    phase: "goal_task_auxiliary_prompt",
    rawText: finalMessage,
    fallbackText: fallbackMessage,
  });
  return {
    finalMessage,
    fallbackMessage,
  };
}

async function runClaudePrompt(input: RunGoalTaskInput, message: string, permissionMode: RuntimeEnvironment["permissionMode"]) {
  const result = await runClaudePromptWithFallback(input, message, permissionMode);
  return result.finalMessage;
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
    resultViewKind: normalizeTaskResultViewKind(
      options.currentResult?.resultViewKind ?? input.task.resultViewKind ?? input.task.executionKind,
    ),
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

const SYSTEM_WORKSPACE_ARTIFACT_NAMES = new Set([
  "context.md",
  "prompt.md",
  "progress.md",
]);

function readGeneratedWorkspaceArtifacts(input: RunGoalTaskInput): TaskRunArtifact[] {
  if (!input.taskWorkspaceDir) return [];
  try {
    const entries = fs.readdirSync(input.taskWorkspaceDir, { withFileTypes: true });
    return entries
      .filter((entry) => {
        if (!entry.isFile()) return false;
        if (entry.name.startsWith(".")) return false;
        if (SYSTEM_WORKSPACE_ARTIFACT_NAMES.has(entry.name.toLowerCase())) return false;
        return /\.(md|markdown|txt|html)$/i.test(entry.name);
      })
      .slice(0, 8)
      .map((entry, index) => {
        const filePath = path.join(input.taskWorkspaceDir!, entry.name);
        const content = fs.readFileSync(filePath, "utf8");
        const extension = path.extname(entry.name).toLowerCase();
        const kind: TaskRunArtifact["kind"] =
          extension === ".md" || extension === ".markdown" ? "markdown" : extension === ".txt" ? "text" : "code";
        return {
          id: `workspace-artifact-${index + 1}`,
          label: entry.name,
          kind,
          content,
          href: filePath,
        };
      });
  } catch {
    return [];
  }
}

function buildRecoveryBlocks(input: RunGoalTaskInput, content: string): ResultBlock[] {
  const blocks: ResultBlock[] = [
    { kind: "heading", text: input.task.title, level: 2 },
    {
      kind: "callout",
      tone: "warn",
      text: "结构化 JSON 解析失败，但系统检测到任务已写入本地文件产物，已保留产物供验收和修复使用。",
    },
    { kind: "markdown", content },
  ];
  for (const kind of input.task.expectedResult?.requiredBlocks ?? []) {
    if (blocks.some((block) => block.kind === kind)) continue;
    if (kind === "key_value") {
      blocks.push({
        kind,
        entries: [
          { label: "恢复来源", value: "本地文件产物", emphasis: true },
          { label: "任务", value: input.task.title },
        ],
      });
    } else if (kind === "comparison_table") {
      blocks.push({
        kind,
        columns: ["项目", "状态"],
        rows: [
          { 项目: "本地文件产物", 状态: "已检测" },
          { 项目: "结构化 JSON", 状态: "待修复" },
        ],
      });
    } else if (kind === "list") {
      blocks.push({
        kind,
        items: ["查看已生成文件", "继续验收产物内容", "必要时重新结构化结果"],
      });
    } else if (kind === "paragraph") {
      blocks.push({ kind, text: "系统已从任务工作目录恢复文件产物，避免因 JSON 包装失败直接丢失执行结果。" });
    } else if (kind === "decision") {
      blocks.push({
        kind,
        question: "如何处理已恢复的本地文件产物？",
        options: [
          { id: "continue", label: "继续验收", recommended: true },
          { id: "retry", label: "重新执行" },
        ],
      });
    }
  }
  return blocks;
}

function buildWorkspaceArtifactRecoveryResult(input: RunGoalTaskInput, options: {
  reason: string;
  localValidationReport?: LocalValidationReport;
  acceptanceRuntime: TaskAcceptanceRuntimeState;
}): ParsedTaskRunnerResult | null {
  const artifacts = readGeneratedWorkspaceArtifacts(input);
  if (!artifacts.length) return null;
  const primaryArtifact = artifacts[0];
  const content = primaryArtifact.content?.trim() || `已生成文件：${primaryArtifact.label}`;
  const taskResult: TaskResult = {
    schemaVersion: 1,
    taskId: input.task.id,
    instanceId: input.instance.id,
    title: input.task.expectedOutcome || input.task.title,
    status: "done",
    blocks: buildRecoveryBlocks(input, content),
    meta: {
      producedAt: new Date().toISOString(),
      surfaces: ["interactive", "files"],
      presentation: "document",
      primaryFormat: primaryArtifact.kind === "markdown" ? "markdown" : "text",
      exportableFormats: input.task.expectedResult?.exportableFormats,
    },
  };
  const deliverableCheck = buildFallbackDeliverableCheck(input, options.reason);
  return {
    summary: "已恢复本地文件产物，等待系统继续验收。",
    finalMessage: "任务执行结果 JSON 未能解析，但已检测并保留本地文件产物。",
    resultViewKind: normalizeTaskResultViewKind(input.task.resultViewKind ?? input.task.executionKind),
    awaitingUser: false,
    awaitingReason: "",
    suggestedActions: ["查看已生成文件", "继续验收", "重新结构化结果"],
    artifacts,
    taskResult,
    deliverableCheck: {
      ...deliverableCheck,
      deliveredArtifacts: artifacts.map((artifact) => artifact.label),
      gapReason: options.reason,
    },
    interactionRequirement: {
      type: "none",
      timing: "not_required",
      reason: "",
      question: "",
      options: [],
      suggestedActions: [],
      shouldNotifyUser: false,
    },
    blocker: null,
    structuredOutput: {
      recoveredFromWorkspaceArtifacts: true,
      taskResult,
      artifacts,
      localValidationReport: options.localValidationReport,
      acceptanceRuntime: options.acceptanceRuntime,
    },
  };
}

async function buildNeedsUserFromAcceptance(input: RunGoalTaskInput, result: ParsedTaskRunnerResult, report: AcceptanceReport, runtime: TaskAcceptanceRuntimeState) {
  const userBlockers = uniqueStrings(report.userBlockers.length ? report.userBlockers : [report.summary]);
  const reason = userBlockers.length ? userBlockers.join("；") : report.summary;
  const readiness = buildReadinessFromUserBlockers(userBlockers, reason);
  const question = userBlockers.length > 1 ? `请一次性补充以下信息：${userBlockers.map((item, index) => `${index + 1}. ${item}`).join("；")}` : reason;
  const readinessWithOptions = readiness ? await generateOptionsForReadinessItems(input, readiness, question, userBlockers) : null;
  const fields = compileMissingFieldQuestions({ readiness: readinessWithOptions, fallbackQuestion: question });
  const options = singleFieldOptions(fields);
  const suggestedActions = fieldsSuggestedActions(fields);
  const interactionRequirement: InteractionRequirement = {
    type: "provide_context",
    timing: "after_agent_output",
    reason,
    question,
    options,
    fields,
    suggestedActions,
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
      ...(readinessWithOptions ? { taskReadiness: readinessWithOptions } : {}),
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
      deliveredArtifacts: result.deliverableCheck?.deliveredArtifacts?.length ? result.deliverableCheck.deliveredArtifacts : resolveExpectedSurfaces(input.task.expectedResult),
      missingDeliverables: [],
      criteriaResults,
      gapReason: "",
    },
  };
}

function taskRequiresAfterOutputConfirmation(task: Task) {
  return (
    task.requiresConfirmation === true ||
    (task.collaboration?.mode === "agent_with_user_confirmation" &&
      task.collaboration.userInteractionTiming === "after_agent_output" &&
      task.collaboration.userInteractionType === "confirm")
  );
}

function looksLikeUnstructuredConfirmationOutput(input: RunGoalTaskInput, rawOutput: string, parseError?: string) {
  if (!parseError || !rawOutput.trim() || !taskRequiresAfterOutputConfirmation(input.task)) return false;
  return /用户确认|请用户确认|让用户确认|等待用户|确认选择|确认签证|选择.*方案|候选方案|对比分析|推荐方案/.test(rawOutput);
}

function buildAwaitingConfirmationFromRaw(input: RunGoalTaskInput, rawOutput: string): ParsedTaskRunnerResult {
  const options: string[] = [];
  const question =
    input.task.collaboration?.userFacingActionLabel ||
    `请确认「${input.task.title}」采用哪个方案？`;
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
    taskId: input.task.id,
    instanceId: input.instance.id,
    title: input.task.expectedOutcome || input.task.title,
    status: "pending_user",
    blocks: [
      { kind: "heading", text: input.task.title, level: 2 },
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
        criterion: input.task.expectedResult?.completionCriteria || input.task.expectedOutcome,
        status: "unknown",
        evidence: "Agent 已产出候选内容，但协作要求要求用户确认后才能继续。",
      },
    ],
    gapReason: reason,
  };
  return {
    summary: "已产出候选方案，等待用户确认。",
    finalMessage,
    resultViewKind: normalizeTaskResultViewKind(input.task.resultViewKind ?? input.task.executionKind),
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
  if (!parsedResult && looksLikeUnstructuredConfirmationOutput(input, rawOutput, parseError)) {
    parsedResult = buildAwaitingConfirmationFromRaw(input, rawOutput);
    parseError = undefined;
    state.appendTrajectory({
      type: "approval",
      status: "awaiting_user",
      title: "识别到用户确认节点",
      thought: "Agent 返回了非 JSON 格式的确认卡片内容，系统已兜底转换为 awaiting_user，等待用户确认。",
    });
  }
  let lastReport = validateTaskResultLocally({
    task: input.task,
    rawOutput,
    parsedResult,
    parseError,
  });

  for (let attempt = 1; attempt <= 2 && !lastReport.passed; attempt += 1) {
    // 中止后停止本地校验修复轮次，避免无谓的 CLI 调用与副作用。
    if (input.signal?.aborted) {
      throw new Error("任务已被中止（超时或 lease 失效），停止本地修复");
    }
    const isFormatRepair = lastReport.issues.length === 1 && lastReport.issues[0]?.code === "json_parse_failed";
    state.runtime.localValidationReports.push(lastReport);
    state.runtime.repairAttempts.push({
      type: "local_validation",
      attempt,
      promptKind: isFormatRepair ? "json_character_repair" : "local_validation_repair",
      startedAt: new Date().toISOString(),
      status: "running",
      issueCodes: lastReport.issues.map((item) => item.code),
    });
    state.appendTrajectory({
      type: "system",
      status: "running",
      title: isFormatRepair ? `JSON 解析失败，开始第 ${attempt} 次字符级修复` : `本地校验未通过，开始第 ${attempt} 次结构修复`,
      thought: lastReport.issues.map((item) => `${item.code}: ${item.message}`).join("\n"),
    });
    const repairPrompt = isFormatRepair
      ? buildJsonRepairPrompt(rawOutput)
      : buildLocalValidationRepairPrompt({
          goal: input.goal,
          subGoal: input.subGoal,
          task: input.task,
          instance: input.instance,
          rawAgentOutput: rawOutput,
          parsedResult,
          report: lastReport,
        });
    const repairedOutput = await runClaudePromptWithFallback(input, repairPrompt, lastReport.allowToolCalls ? input.runtimeEnv.permissionMode : "readonly");
    rawOutput = repairedOutput.finalMessage;
    let parsed = tryParseTaskRunnerResult(input, rawOutput, normalizeTaskResultViewKind(input.task.resultViewKind ?? input.task.executionKind));
    if (!parsed.result && repairedOutput.fallbackMessage.trim()) {
      const fallbackParsed = tryParseTaskRunnerResult(
        input,
        repairedOutput.fallbackMessage,
        normalizeTaskResultViewKind(input.task.resultViewKind ?? input.task.executionKind),
      );
      if (fallbackParsed.result) {
        rawOutput = repairedOutput.fallbackMessage;
        parsed = fallbackParsed;
        state.appendTrajectory({
          type: "system",
          status: "completed",
          title: "已从修复流式事件回填结果",
          thought: "修复轮 result.result 解析失败，系统已使用 Claude stream 中聚合的 assistant 内容恢复结构化结果。",
        });
      }
    }
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
    const recovered = buildWorkspaceArtifactRecoveryResult(input, {
      reason: "本地校验失败，任务结果 JSON 未通过解析，但检测到本地文件产物。",
      localValidationReport: local.localValidationReport,
      acceptanceRuntime: runtime,
    });
    if (recovered) {
      local = {
        ...local,
        parsedResult: recovered,
        localValidationReport: validateTaskResultLocally({
          task: input.task,
          rawOutput: local.rawOutput,
          parsedResult: recovered,
        }),
      };
      if (local.localValidationReport.passed) {
        state.appendTrajectory({
          type: "system",
          status: "completed",
          title: "已从本地文件产物恢复结果",
          thought: "任务结果 JSON 解析失败，但系统检测到已写入的本地文件，并转换为可验收的结构化结果。",
        });
      }
    }
  }
  if (!local.localValidationReport.passed || !local.parsedResult) {
    const failed = buildUnfinishedResult(input, {
      currentResult: local.parsedResult,
      reason: "本地校验失败，任务没有产出可展示、可验收的结果。",
      localValidationReport: local.localValidationReport,
      acceptanceRuntime: runtime,
    });
    return { ...failed, rawOutput: local.rawOutput, trajectory: state.trajectory, localValidationReport: local.localValidationReport, acceptanceRuntime: runtime };
  }

  let currentResult = await enrichAwaitingUserFieldOptions(
    input,
    resolveRepeatedResumeConfirmation(input, coerceMissingUserContextBlocker(input, local.parsedResult)),
  );
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
    // 中止后停止后续验收 / 语义修复轮次，避免无谓的 CLI 调用与副作用。
    if (input.signal?.aborted) {
      throw new Error("任务已被中止（超时或 lease 失效），停止验收与修复");
    }
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
    appendGoalTaskAgentEvent(input, "decision", {
      phase: "goal_task_acceptance",
      attempt,
      acceptanceReport,
    });

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
      const userResult = await buildNeedsUserFromAcceptance(input, currentResult, acceptanceReport, runtime);
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
    const repairedOutput = await runClaudePromptWithFallback(input, repairPrompt, acceptanceReport.repairStrategy.allowNewToolCalls ? input.runtimeEnv.permissionMode : "readonly");
    let repairedRaw = repairedOutput.finalMessage;
    let repaired = tryParseTaskRunnerResult(input, repairedRaw, normalizeTaskResultViewKind(input.task.resultViewKind ?? input.task.executionKind));
    if (!repaired.result && repairedOutput.fallbackMessage.trim()) {
      const fallbackRepaired = tryParseTaskRunnerResult(
        input,
        repairedOutput.fallbackMessage,
        normalizeTaskResultViewKind(input.task.resultViewKind ?? input.task.executionKind),
      );
      if (fallbackRepaired.result) {
        repairedRaw = repairedOutput.fallbackMessage;
        repaired = fallbackRepaired;
        state.appendTrajectory({
          type: "system",
          status: "completed",
          title: "已从内容补齐流式事件回填结果",
          thought: "内容补齐轮 result.result 解析失败，系统已使用 Claude stream 中聚合的 assistant 内容恢复结构化结果。",
        });
      }
    }
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
    appendGoalTaskAgentEvent(input, "decision", {
      phase: "goal_task_semantic_repair",
      attempt,
      localValidationReport: local.localValidationReport,
      parseError: local.parseError,
    });
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
    currentResult = await enrichAwaitingUserFieldOptions(
      input,
      resolveRepeatedResumeConfirmation(input, coerceMissingUserContextBlocker(input, local.parsedResult)),
    );
    if (currentResult.awaitingUser) {
      return {
        ...currentResult,
        rawOutput: local.rawOutput,
        trajectory: state.trajectory,
        localValidationReport: local.localValidationReport,
        acceptanceReport,
        acceptanceRuntime: runtime,
      };
    }
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
  let fallbackFinalMessage = "";
  let pendingAssistantProcessOutput = "";
  let lastAssistantProcessFlushAt = 0;
  let assistantProcessFlushCount = 0;
  let lastStatus: "checking" | "running" | "completed" | null = null;
  const trajectory: ExecutionTrajectoryStep[] = [...(input.initialTrajectory ?? [])];
  const isResumeRun = Boolean(input.resumeContext);
  const previousToolSignatures = new Set(
    (input.initialTrajectory ?? [])
      .filter((step) => step.type === "tool_call" && step.toolCall)
      .map((step) => `${step.toolCall?.name ?? ""}::${JSON.stringify(step.toolCall?.input ?? null)}`),
  );
  let resumeNewToolCallCount = 0;
  let resumeDuplicateToolCallCount = 0;
  let agentRunPlan: AgentRunPlan | null = null;
  const appendTrajectory = (step: Omit<ExecutionTrajectoryStep, "id" | "index" | "startedAt"> & { startedAt?: string }) => {
    trajectory.push(createTrajectoryStep({ ...step, index: trajectory.length }));
    persistTrajectorySnapshot(input.requestId, trajectory);
    return trajectory;
  };
  const flushAssistantProcessOutput = (status: ExecutionTrajectoryStep["status"]) => {
    const thought = pendingAssistantProcessOutput.trim();
    if (!thought) return;
    if (looksLikeFinalProtocolJsonFragment(thought)) {
      pendingAssistantProcessOutput = "";
      lastAssistantProcessFlushAt = Date.now();
      return;
    }
    appendTrajectory({
      type: "assistant",
      status,
      title: "Agent 过程输出（非最终结果）",
      thought: thought.slice(0, 2000),
      endedAt: status === "completed" ? new Date().toISOString() : undefined,
    });
    pendingAssistantProcessOutput = "";
    lastAssistantProcessFlushAt = Date.now();
    assistantProcessFlushCount += 1;
  };
  const shouldFlushAssistantProcessOutput = () => {
    const thought = pendingAssistantProcessOutput.trim();
    if (thought.length < 30) return false;
    if (/[。！？.!?]\s*$/.test(thought)) return true;
    return thought.length >= 500;
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

  const webAppInteractionContext = buildWebAppInteractionContext({ conversationId: input.goal.conversationId });
  const executionContext =
    input.executionContext ??
    resolveExecutionContext({
      conversationId: input.goal.conversationId ?? "",
      goal: input.goal,
      subGoal: input.subGoal,
      task: input.task,
      instance: input.instance,
      requestId: input.requestId,
      resumeContext: input.resumeContext,
    });
  const agentStrategy = selectAgentCollaborationStrategy({ task: input.task, isResumeRun });
  if (agentStrategy !== "single_agent") {
    appendTrajectory({
      type: "system",
      status: "running",
      title: `启用多角色协同：${agentStrategy}`,
      thought: "KiKi 将按角色顺序执行、审阅并合成最终结果。",
    });
    const orchestration = await runMultiAgentOrchestration({
      ...input,
      context: executionContext,
      isResumeRun,
      appendTrajectory,
    });
    finalMessage = orchestration.rawOutput;
    agentRunPlan = orchestration.agentRunPlan;
    appendGoalTaskAgentEvent(input, "llm.response", {
      phase: "goal_task_multi_agent_orchestration",
      strategy: agentStrategy,
      rawText: finalMessage,
      agentRunPlan,
    });
  } else {
    const runnerPrompt = buildGoalTaskRunnerPrompt({
      context: executionContext,
      resumeContext: input.resumeContext,
      initialTrajectory: input.initialTrajectory,
      webAppInteractionContext,
      memoryContext: readTaskRunnerMemoryContext(executionContext.identity.conversationId),
    });
    const workingDirectory = input.taskWorkspaceDir || input.task.recommendedWorkingDirectory || input.runtimeEnv.workingDirectory;
    appendGoalTaskAgentEvent(input, "llm.request", {
      phase: "goal_task_main_execution",
      permissionMode: input.runtimeEnv.permissionMode,
      workingDirectory,
      prompt: runnerPrompt,
    });
    await streamClaudeCli({
      message: runnerPrompt,
      workingDirectory,
      cliPath: input.runtimeEnv.cliPath,
      permissionMode: input.runtimeEnv.permissionMode,
      runtimeKind: input.runtimeEnv.runtimeKind,
      runtimeEnvId: input.runtimeEnv.id,
      filePolicy: input.runtimeEnv.filePolicy,
      channelPolicy: { mode: "task" },
      conversationId: input.goal.conversationId,
      taskInstanceId: input.instance.id,
      taskId: input.task.id,
      agentRunId: input.agentRunId,
      resumeSessionId: undefined,
      signal: input.signal,
      onSpawn: input.onSpawn,
      onEvent: (event) => {
        input.onProgressPing?.(event.type);
        if (event.type === "delta" && event.text.trim()) {
          pendingAssistantProcessOutput += event.text;
          if (
            Date.now() - lastAssistantProcessFlushAt > 3000 &&
            assistantProcessFlushCount < 5 &&
            shouldFlushAssistantProcessOutput()
          ) {
            flushAssistantProcessOutput("running");
          }
        }
        if (event.type === "message") {
          finalMessage = event.content;
          fallbackFinalMessage = event.fallbackContent ?? "";
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
          appendGoalTaskAgentEvent(input, "tool_call", {
            phase: "goal_task_main_execution",
            toolName: event.toolName,
            input: event.input,
            summary: event.summary,
          });
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
        if (event.type === "tool_permission_request") {
          const blocker = createToolPermissionExecutionBlocker(input, event, trajectory.length);
          appendTrajectory({
            type: "system",
            status: "awaiting_user",
            title: `等待工具授权：${event.toolName}`,
            thought: `需要用户授权工具规则 ${event.suggestedRule} 后继续执行。`,
          });
          updateGoalRuntimeJobExecution(`job-${input.instance.id}`, {
            status: "awaiting_user",
            blocker,
            trajectory,
          });
          updateGoalTelemetry({
            requestId: input.requestId,
            scope: "goal_task_execute",
            phase: "executing",
            message: `等待工具授权：${event.toolName}`,
            goalId: input.goal.id,
            taskId: input.task.id,
            taskInstanceId: input.instance.id,
            resultPayload: progressPayloadWithTrajectory(trajectory, {
              runtimeJobStatus: "awaiting_user",
              blocker,
            }),
          });
          appendGoalTaskAgentEvent(input, "awaiting_user", {
            phase: "goal_task_main_execution",
            kind: "tool_permission.requested",
            requestId: event.requestId,
            runtimeEnvId: event.runtimeEnvId,
            toolName: event.toolName,
            suggestedRule: event.suggestedRule,
          });
          appendGoalLog({
            requestId: input.requestId,
            scope: "goal_task_execute",
            level: "info",
            phase: "executing",
            message: `等待工具授权：${event.toolName}`,
            eventType: "await_user",
            toolName: event.toolName,
            status: "awaiting_user",
            goalId: input.goal.id,
            taskId: input.task.id,
            taskInstanceId: input.instance.id,
          });
        }
        if (event.type === "tool_permission_resolved") {
          updateGoalRuntimeJobExecution(`job-${input.instance.id}`, {
            status: "running",
            blocker: null,
            trajectory,
          });
          updateGoalTelemetry({
            requestId: input.requestId,
            scope: "goal_task_execute",
            phase: "executing",
            message: event.decision === "allow" ? "工具授权已允许，继续执行" : "工具授权已拒绝，继续执行替代路径",
            goalId: input.goal.id,
            taskId: input.task.id,
            taskInstanceId: input.instance.id,
            resultPayload: progressPayloadWithTrajectory(trajectory, {
              runtimeJobStatus: "running",
              blocker: null,
            }),
          });
          appendGoalTaskAgentEvent(input, "log", {
            phase: "goal_task_main_execution",
            kind: "tool_permission.resolved",
            requestId: event.requestId,
            decision: event.decision,
            scope: event.scope,
            rule: event.rule,
          });
          appendTrajectory({
            type: "system",
            status: event.decision === "allow" ? "completed" : "failed",
            title: event.decision === "allow" ? "工具授权已允许" : "工具授权已拒绝",
            thought: event.rule ? `授权规则：${event.rule}` : undefined,
            endedAt: new Date().toISOString(),
          });
        }
        if (event.type === "error") {
          appendGoalTaskAgentEvent(input, "error", {
            phase: "goal_task_main_execution",
            message: event.message,
          });
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
    appendGoalTaskAgentEvent(input, "llm.response", {
      phase: "goal_task_main_execution",
      rawText: finalMessage,
      fallbackText: fallbackFinalMessage,
    });
  }

  flushAssistantProcessOutput("completed");
  if (!finalMessage.trim()) {
    throw new Error("Claude CLI 未返回 result.result，无法提取最终任务结果。");
  }
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

  let parsed = tryParseTaskRunnerResult(input, finalMessage, normalizeTaskResultViewKind(input.task.resultViewKind ?? input.task.executionKind));
  appendGoalTaskAgentEvent(input, "decision", {
    phase: "goal_task_parse",
    ok: Boolean(parsed.result),
    error: parsed.error,
    parsedResult: parsed.result,
  });
  if (!parsed.result && fallbackFinalMessage.trim()) {
    const fallbackParsed = tryParseTaskRunnerResult(
      input,
      fallbackFinalMessage,
      normalizeTaskResultViewKind(input.task.resultViewKind ?? input.task.executionKind),
    );
    if (fallbackParsed.result) {
      appendTrajectory({
        type: "system",
        status: "completed",
        title: "已从流式事件回填最终结果",
        thought: "result.result 解析失败，系统已使用 Claude stream 中聚合的 assistant 内容恢复结构化结果。",
      });
      finalMessage = fallbackFinalMessage;
      parsed = fallbackParsed;
    }
  }
  let result = await completeWithAcceptance(input, {
    rawOutput: finalMessage,
    parsedResult: parsed.result,
    parseError: parsed.error,
    trajectory,
    appendTrajectory,
  });
  result = attachAgentRunPlan(result, agentRunPlan);
  const expectedSurfaces = resolveExpectedSurfaces(input.task.expectedResult);
  const webapp = extractWebAppSpec(finalMessage);
  const externalEmbed = extractExternalEmbedSpec(finalMessage);
  const files = extractFileWriteSpecs(finalMessage);
  if (expectedSurfaces.includes("interactive") && webapp && result.taskResult) {
    const conversationId = input.goal.conversationId ?? `goal-${input.goal.id}`;
    applyInteractiveArtifactResult({
      result,
      appendTrajectory,
      runningTitle: "正在写入可执行小应用",
      completedTitle: "已生成可执行小应用",
      thought: webapp.title,
      persist: () =>
        persistWebAppArtifact({
          conversationId,
          taskId: input.task.id,
          instanceId: input.instance.id,
          runtimeJobId: `job-${input.instance.id}`,
          title: webapp.title,
          description: webapp.description || result.summary,
          html: webapp.html,
          initialState: webapp.initialState,
          networkPolicy: webapp.networkPolicy,
        }),
    });
  } else if (expectedSurfaces.includes("interactive") && externalEmbed && result.taskResult) {
    const conversationId = input.goal.conversationId ?? `goal-${input.goal.id}`;
    applyInteractiveArtifactResult({
      result,
      appendTrajectory,
      runningTitle: "正在写入外部嵌入",
      completedTitle: "已生成外部嵌入",
      thought: externalEmbed.title,
      persist: () =>
        persistExternalEmbedArtifact({
          conversationId,
          taskId: input.task.id,
          instanceId: input.instance.id,
          runtimeJobId: `job-${input.instance.id}`,
          label: externalEmbed.title,
          summary: externalEmbed.description || result.summary,
          url: externalEmbed.url,
        }),
    });
  } else if (webapp) {
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_task_execute",
      level: "warn",
      phase: "reviewing",
      message: "Agent 返回了 webapp，但当前任务未声明交互渲染区，已忽略小应用落盘",
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
    });
  } else if (externalEmbed) {
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_task_execute",
      level: "warn",
      phase: "reviewing",
      message: "Agent 返回了 external_embed，但当前任务未声明交互渲染区，已忽略外部嵌入落盘",
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
    });
  }
  if (expectedSurfaces.includes("files") && result.taskResult) {
    if (files.length > 0) {
      const conversationId = input.goal.conversationId ?? `goal-${input.goal.id}`;
      appendTrajectory({
        type: "system",
        status: "running",
        title: "正在写入文件产物",
        thought: files.map((file) => file.filename).join("、"),
      });
      const artifactRefs = files.map((file) => {
        const artifact = persistFileArtifact({
          conversationId,
          taskId: input.task.id,
          instanceId: input.instance.id,
          runtimeJobId: `job-${input.instance.id}`,
          label: file.filename,
          summary: result.summary,
          filename: file.filename,
          mime: file.mime,
          bytes: file.content,
        });
        return toArtifactRef(artifact);
      });
      const derivedXlsxRefs: ArtifactRef[] = [];
      for (const file of files) {
        if (!file.filename.toLowerCase().endsWith(".md")) continue;
        try {
          const xlsxFilename = file.filename.replace(/\.md$/i, ".xlsx");
          const workbook = markdownToWorkbook(file.content, { filename: xlsxFilename });
          if (!workbook) continue;
          appendTrajectory({
            type: "system",
            status: "running",
            title: "正在派生 Excel 副本",
            thought: xlsxFilename,
          });
          const buffer = await buildXlsxBuffer(workbook);
          const xlsxArtifact = persistFileArtifact({
            conversationId,
            taskId: input.task.id,
            instanceId: input.instance.id,
            runtimeJobId: `job-${input.instance.id}`,
            label: xlsxFilename,
            summary: "自动从 Markdown 表格派生的可编辑副本",
            filename: xlsxFilename,
            mime: XLSX_MIME,
            bytes: buffer,
          });
          derivedXlsxRefs.push(toArtifactRef(xlsxArtifact));
          appendTrajectory({
            type: "system",
            status: "completed",
            title: "已派生 Excel 副本",
            thought: xlsxFilename,
            endedAt: new Date().toISOString(),
          });
        } catch (error) {
          appendTrajectory({
            type: "system",
            status: "completed",
            title: "Excel 副本派生失败，已跳过",
            thought: error instanceof Error ? error.message : String(error),
            endedAt: new Date().toISOString(),
          });
        }
      }
      const allArtifactRefs = [...artifactRefs, ...derivedXlsxRefs];
      result.taskResult = {
        ...result.taskResult,
        artifactRefs: [...(result.taskResult.artifactRefs ?? []), ...allArtifactRefs],
      };
      result.structuredOutput = {
        ...(result.structuredOutput ?? {}),
        artifactRefs: result.taskResult.artifactRefs,
      };
      result.taskResult.meta = {
        ...result.taskResult.meta,
        surfaces: Array.from(new Set([...(result.taskResult.meta.surfaces ?? []), "files" as const])),
        fileSurfaceRequired: true,
      };
      appendTrajectory({
        type: "system",
        status: "completed",
        title: "已生成文件产物",
        thought: `已生成 ${allArtifactRefs.length} 个文件产物。`,
        endedAt: new Date().toISOString(),
      });
    }
  } else if (files.length > 0) {
    appendGoalLog({
      requestId: input.requestId,
      scope: "goal_task_execute",
      level: "warn",
      phase: "reviewing",
      message: "Agent 返回了 files，但当前任务未声明文件区域，已忽略文件落盘",
      goalId: input.goal.id,
      taskId: input.task.id,
      taskInstanceId: input.instance.id,
    });
  }
  appendTrajectory({
    type: result.awaitingUser ? "approval" : "result",
    status: result.awaitingUser ? "awaiting_user" : "completed",
    title: result.summary,
    thought: result.finalMessage.slice(0, 2000),
    endedAt: new Date().toISOString(),
  });
  const blocker = createExecutionBlocker(input, result, trajectory);
  if (blocker) {
    updateGoalRuntimeJobExecution(`job-${input.instance.id}`, { blocker });
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

export async function runGoalTask(input: RunGoalTaskInput): Promise<GoalTaskOutcome> {
  const agentRunId = input.agentRunId ?? createGoalTaskAgentRun(input);
  const tracedInput: RunGoalTaskInput = { ...input, agentRunId };
  let agentRunFinalized = false;
  const finishCurrentAgentRun = (status: "completed" | "failed") => {
    agentRunFinalized = true;
    finishGoalTaskAgentRun(agentRunId, status);
  };
  // 本任务执行链路上 telemetry / 日志的公共定位字段，避免在每个调用点重复手填。
  const telemetryContext = {
    requestId: input.requestId,
    scope: "goal_task_execute" as const,
    goalId: input.goal.id,
    taskId: input.task.id,
    taskInstanceId: input.instance.id,
  };
  appendGoalTaskAgentEvent(tracedInput, "message", {
    phase: "goal_task_started",
    runtimeJobId: getGoalTaskRuntimeJobId(tracedInput),
    taskTitle: tracedInput.task.title,
  });
  try {
  beginGoalTelemetry({
    ...telemetryContext,
    phase: "executing",
    message: `KiKi 已自动启动任务「${tracedInput.task.title.replace(/^任务\d+：/, "")}」`,
    attemptCount: 1,
  });

  const executionContext = resolveExecutionContext({
    conversationId: tracedInput.goal.conversationId ?? "",
    goal: tracedInput.goal,
    subGoal: tracedInput.subGoal,
    task: tracedInput.task,
    instance: tracedInput.instance,
    requestId: tracedInput.requestId,
    resumeContext: tracedInput.resumeContext,
  });
  const enhancedInput: RunGoalTaskInput = { ...tracedInput, executionContext };
  const contextReadiness = readinessFromContext(executionContext);
  const readiness =
    executionContext.readiness.state === "blocked"
      ? contextReadiness
      : await buildTaskReadinessCheckWithJudge(enhancedInput);
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
    const blockedResult = normalizeParsedAwaitingResult(await buildReadinessBlockedResult(enhancedInput, readiness));
    const blocker = createExecutionBlocker(enhancedInput, blockedResult, trajectory);
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
      ...telemetryContext,
      phase: "reviewing",
      message: readiness.summary,
      attemptCount: 1,
      summary: result.summary,
      resultPayload,
    });
    finishGoalTelemetry({
      ...telemetryContext,
      phase: "reviewing",
      message: "任务执行已暂停，等待用户补充必要信息",
      summary: result.summary,
      resultPayload,
    });
    appendGoalLog({
      ...telemetryContext,
      level: "info",
      phase: "reviewing",
      message: readiness.summary,
      eventType: "await_user",
      status: "awaiting_user",
    });
    if (blocker) {
      updateGoalRuntimeJobExecution(`job-${input.instance.id}`, {
        blocker,
        trajectory,
        result: resultPayload,
      });
    }
    appendGoalTaskAgentEvent(enhancedInput, "decision", {
      phase: "goal_task_blocked_before_execution",
      readiness,
      resultPayload,
    });
    finishCurrentAgentRun("completed");
    return {
      status: "awaiting_user",
      blocker,
      trajectory,
      result: resultPayload,
    };
  }

  writeTaskPromptFile({
    conversationId: executionContext.identity.conversationId,
    taskId: input.task.id,
    instanceId: input.instance.id,
    content: buildGoalTaskRunnerPrompt({
      context: executionContext,
      resumeContext: input.resumeContext,
      initialTrajectory: input.initialTrajectory,
      webAppInteractionContext: buildWebAppInteractionContext({ conversationId: executionContext.identity.conversationId }),
      memoryContext: readTaskRunnerMemoryContext(executionContext.identity.conversationId),
    }),
  });

  let attemptCount = 1;
  const maxAttempts = 2;
  while (attemptCount <= maxAttempts) {
    // 超时 / lease 失效后由上层 abort：在每次重试入口短路，避免被中止后仍发起新一轮执行。
    if (input.signal?.aborted) {
      throw new Error("任务已被中止（超时或 lease 失效），停止后续执行");
    }
    try {
      const result = normalizeParsedAwaitingResult(await executeOnce({ ...enhancedInput, attemptCount }));
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
        const errorMessage = result.awaitingReason || "任务缺少组件化产出，Agent 自动补齐后仍未满足交付物要求。";
        const failedResultPayload = {
          ...resultPayload,
          errorMessage,
          errorCategory: "logic",
        } satisfies Record<string, unknown>;
        failGoalTelemetry({
          ...telemetryContext,
          phase: "reviewing",
          message: "任务缺少组件化产出，未完成",
          error: errorMessage,
          summary: result.summary,
          resultPayload: failedResultPayload,
        });
        appendGoalLog({
          ...telemetryContext,
          level: "error",
          phase: "reviewing",
          message: "任务未产出可视化组件结果，已标记为未完成",
          details: errorMessage,
          status: "failed",
        });
        updateGoalRuntimeJobExecution(`job-${input.instance.id}`, {
          result: failedResultPayload,
          trajectory: result.trajectory,
          lastError: errorMessage,
        });
        appendGoalTaskAgentEvent(enhancedInput, "error", {
          phase: "goal_task_unresolved_revision",
          message: errorMessage,
          resultPayload: failedResultPayload,
        });
        finishCurrentAgentRun("failed");
        return {
          status: "failed",
          error: errorMessage,
          trajectory: result.trajectory,
          result: failedResultPayload,
        };
      }
      if (result.awaitingUser) {
        updateGoalTelemetry({
          ...telemetryContext,
          phase: "reviewing",
          message: result.awaitingReason || "任务需要用户参与后才能继续",
          attemptCount,
          summary: result.summary,
          resultPayload,
        });
        appendGoalLog({
          ...telemetryContext,
          level: "info",
          phase: "reviewing",
          message: result.awaitingReason || "Agent 等待用户参与",
          eventType: "await_user",
          status: "awaiting_user",
        });
      }
      finishGoalTelemetry({
        ...telemetryContext,
        phase: result.awaitingUser ? "reviewing" : "completed",
        message: result.awaitingUser ? "任务执行已暂停，等待用户参与" : "任务执行完成",
        summary: result.summary,
        resultPayload,
      });
      appendGoalLog({
        ...telemetryContext,
        level: "info",
        phase: result.awaitingUser ? "reviewing" : "completed",
        message: result.summary,
        eventType: "result_ready",
        status: result.awaitingUser ? "awaiting_user" : "completed",
      });
      appendGoalTaskAgentEvent(enhancedInput, "decision", {
        phase: result.awaitingUser ? "goal_task_awaiting_user" : "goal_task_completed",
        resultPayload,
      });
      finishCurrentAgentRun("completed");
      return {
        status: result.awaitingUser ? "awaiting_user" : "completed",
        blocker: result.blocker,
        trajectory: result.trajectory,
        result: resultPayload,
      };
    } catch (error) {
      const category = classifyTaskRunError(error);
      const errorMessage = error instanceof Error ? error.message : "任务执行失败";
      appendGoalTaskAgentEvent(enhancedInput, "error", {
        phase: "goal_task_attempt_failed",
        attemptCount,
        errorCategory: category,
        message: errorMessage,
      });
      if (shouldRetry(category, attemptCount)) {
        appendGoalLog({
          ...telemetryContext,
          level: "warn",
          phase: "executing",
          message: `执行失败，准备自动重试第 ${attemptCount + 1} 次`,
          details: errorMessage,
          eventType: "retry_scheduled",
          status: "running",
        });
        updateGoalTelemetry({
          ...telemetryContext,
          phase: "executing",
          message: `遇到瞬时错误，准备自动重试第 ${attemptCount + 1} 次`,
          details: errorMessage,
          attemptCount: attemptCount + 1,
        });
        attemptCount += 1;
        continue;
      }
      failGoalTelemetry({
        ...telemetryContext,
        phase: "error",
        message: "任务执行失败",
        error: errorMessage,
        resultPayload: {
          errorCategory: category,
          errorMessage,
        },
      });
      appendGoalLog({
        ...telemetryContext,
        level: "error",
        phase: "error",
        message: "任务执行失败",
        details: errorMessage,
        status: "failed",
      });
      finishCurrentAgentRun("failed");
      throw error;
    }
  }
  // 重试次数耗尽仍未返回（理论上不可达：成功/失败分支均已 return/throw）。
  // 显式返回 failed，保证返回类型完备，避免吞掉无回执的悬空态。
  return { status: "failed", error: "任务重试次数耗尽，未获得最终结果" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!agentRunFinalized) {
      appendGoalTaskAgentEvent(tracedInput, "error", {
        phase: "goal_task_unhandled_failure",
        message,
      });
      finishCurrentAgentRun("failed");
    }
    throw error;
  }
}
