import { appendGoalLog, beginGoalTelemetry, failGoalTelemetry, finishGoalTelemetry, updateGoalTelemetry } from "@/lib/server/goalTelemetry";
import { buildGoalTaskRunnerPrompt } from "@/lib/server/goalTaskPrompt";
import { judgeTaskResult } from "@/lib/server/resultNotificationJudge";
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
import type { RuntimeEnvironment } from "@/types/runtime";

import { streamClaudeCli } from "./claudeCli";

type RunGoalTaskInput = {
  requestId: string;
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
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
  deliverableCheck: DeliverableCheck | null;
  interactionRequirement: InteractionRequirement;
  structuredOutput: Record<string, unknown> | null;
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
      const status =
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

function parseTaskRunnerResult(raw: string, fallbackKind: TaskResultViewKind): ParsedTaskRunnerResult {
  const parsed = JSON.parse(extractJsonObject(raw)) as {
    summary?: string;
    final_message?: string;
    result_view_kind?: TaskResultViewKind;
    awaiting_user?: boolean;
    awaiting_reason?: string;
    suggested_actions?: string[];
    interaction_requirement?: unknown;
    artifacts?: Array<{ label?: string; kind?: TaskRunArtifact["kind"]; content?: string; href?: string }>;
    deliverable_check?: unknown;
    structured_output?: Record<string, unknown> | null;
  };
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
    summary: parsed.summary?.trim() || "任务执行完成。",
    finalMessage: parsed.final_message?.trim() || parsed.summary?.trim() || "任务执行完成。",
    resultViewKind: parsed.result_view_kind || fallbackKind || "generic_result",
    awaitingUser,
    awaitingReason: parsed.awaiting_reason?.trim() || interactionRequirement.reason,
    suggestedActions,
    artifacts: Array.isArray(parsed.artifacts)
      ? parsed.artifacts
          .filter((item) => item?.label)
          .map((item, index) => ({
            id: `artifact-${index + 1}`,
            label: item.label!.trim(),
            kind: item.kind || "other",
            content: item.content,
            href: item.href,
          }))
      : [],
    deliverableCheck: normalizeDeliverableCheck(parsed.deliverable_check),
    interactionRequirement,
    structuredOutput: parsed.structured_output ?? null,
  };
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

function hasUsablePrimaryArtifact(result: ParsedTaskRunnerResult) {
  const primaryArtifact = result.artifacts[0];
  if (!primaryArtifact) return false;
  return Boolean(primaryArtifact.href || primaryArtifact.content?.trim());
}

function enforceDeliverableContract(input: RunGoalTaskInput, result: ParsedTaskRunnerResult): ParsedTaskRunnerResult {
  const issues: string[] = [];
  const deliverableCheck =
    result.deliverableCheck ??
    buildFallbackDeliverableCheck(input, "Agent 未返回 deliverable_check，无法确认产物是否满足任务契约。");

  if (!result.deliverableCheck) {
    issues.push("Agent 未返回交付物验收结果。");
  }
  if (!deliverableCheck.matched) {
    issues.push(deliverableCheck.gapReason || "主交付物未通过任务契约验收。");
  }
  if (deliverableCheck.missingDeliverables.length > 0) {
    issues.push(`缺少交付物：${deliverableCheck.missingDeliverables.join("、")}`);
  }
  const failedCriteria = deliverableCheck.criteriaResults.filter((item) => item.status === "failed");
  if (failedCriteria.length > 0) {
    issues.push(`未通过验收标准：${failedCriteria.map((item) => item.criterion).join("、")}`);
  }
  if (!result.awaitingUser && !hasUsablePrimaryArtifact(result)) {
    issues.push("缺少 artifacts[0] 主交付物，不能只用摘要或最终说明替代产物。");
  }

  if (issues.length === 0 || result.awaitingUser) {
    return {
      ...result,
      deliverableCheck,
      structuredOutput: {
        ...(result.structuredOutput ?? {}),
        deliverableCheck,
        interactionRequirement: result.interactionRequirement,
      },
    };
  }

  const awaitingReason = [
    "任务产物尚未满足预期交付物，已暂停标记完成。",
    ...Array.from(new Set(issues)),
  ].join("\n");

  return {
    ...result,
    summary: "任务产物未通过交付物验收。",
    finalMessage: [result.finalMessage, awaitingReason].filter(Boolean).join("\n\n"),
    awaitingUser: true,
    awaitingReason,
    suggestedActions: [
      "让 Agent 根据缺口继续补齐主交付物",
      "补充任务上下文或调整预期交付物",
      ...(result.suggestedActions ?? []),
    ],
    deliverableCheck,
    interactionRequirement,
    structuredOutput: {
      ...(result.structuredOutput ?? {}),
      deliverableCheck,
      interactionRequirement,
      taskContract: {
        expectedOutcome: input.task.expectedOutcome,
        expectedResult: input.task.expectedResult ?? null,
        executionObjective: input.task.executionObjective ?? input.task.description,
      },
    },
  };
}

function shouldRetry(category: TaskRunErrorCategory, attemptCount: number) {
  if (attemptCount >= 2) return false;
  return category === "transient_cli" || category === "transient_network";
}

async function executeOnce(input: RunGoalTaskInput & { attemptCount: number }) {
  let finalMessage = "";
  let lastStatus: "checking" | "running" | "completed" | null = null;
  updateGoalTelemetry({
    requestId: input.requestId,
    scope: "goal_task_execute",
    phase: "executing",
    message: `开始第 ${input.attemptCount} 次执行`,
    goalId: input.goal.id,
    taskId: input.task.id,
    taskInstanceId: input.instance.id,
    attemptCount: input.attemptCount,
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

  await streamClaudeCli({
    message: buildGoalTaskRunnerPrompt(input),
    workingDirectory: input.task.recommendedWorkingDirectory || input.runtimeEnv.workingDirectory,
    cliPath: input.runtimeEnv.cliPath,
    permissionMode: input.runtimeEnv.permissionMode,
    claudeSessionId: undefined,
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
        });
      }
      if (event.type === "tool_call") {
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
        throw new Error(event.message);
      }
    },
  });

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

  const parsedResult = parseTaskRunnerResult(finalMessage, input.task.resultViewKind ?? input.task.executionKind ?? "generic_result");
  return enforceDeliverableContract(input, parsedResult);
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

  let attemptCount = 1;
  while (attemptCount <= 2) {
    try {
      const result = await executeOnce({ ...input, attemptCount });
      const notificationDecision = judgeTaskResult({
        goal: input.goal,
        subGoal: input.subGoal,
        task: input.task,
        instance: input.instance,
        result,
      });
      const resultPayload = {
        resultViewKind: result.resultViewKind,
        awaitingUser: result.awaitingUser,
        awaitingReason: result.awaitingReason,
        suggestedActions: result.suggestedActions,
        artifacts: result.artifacts,
        deliverableCheck: result.deliverableCheck,
        interactionRequirement: result.interactionRequirement,
        structuredOutput: result.structuredOutput,
        finalMessage: result.finalMessage,
        notificationDecision,
      } satisfies Record<string, unknown>;
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
