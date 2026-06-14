import type { TopicInitSagaResult } from "@/lib/server/goalPlanning/topicInitSaga";
import { computeTaskSpecSourceRevision } from "@/lib/server/taskExecution/taskSpecRevision";
import type { GoalAnalysis, GoalBreakdownDraft, GoalDeliveryContract, TaskPriority } from "@/types/kiki";
import { normalizeTriggerSpecWithWarnings, type TriggerSpec } from "@/types/trigger";

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseRecord) : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasTriggerInput(value: unknown) {
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

function formatPlannerTriggerWarning(path: string, input: unknown) {
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  return `planner warning: ${path} 包含非法 TriggerSpec，已记录并尝试走 legacy fallback。raw=${raw}`;
}

function readTriggerSpecCandidate(
  value: unknown,
  warnings: string[],
  path: string,
): TriggerSpec | undefined {
  const result = normalizeTriggerSpecWithWarnings(value as Parameters<typeof normalizeTriggerSpecWithWarnings>[0], { path });
  if (result.trigger) return result.trigger;
  if (result.warnings.length > 0) warnings.push(formatPlannerTriggerWarning(path, value));
  return undefined;
}

function readFirstTriggerSpec(
  candidates: Array<{ value: unknown; path: string }>,
  warnings: string[],
) {
  for (const candidate of candidates) {
    if (!hasTriggerInput(candidate.value)) continue;
    const trigger = readTriggerSpecCandidate(candidate.value, warnings, candidate.path);
    if (trigger) return trigger;
  }
  return undefined;
}

function triggerSpecToRule(value: unknown) {
  const trigger = normalizeTriggerSpecWithWarnings(value as Parameters<typeof normalizeTriggerSpecWithWarnings>[0]).trigger;
  if (!trigger) return undefined;
  switch (trigger.kind) {
    case "cron":
      return trigger.timezone ? `cron:${trigger.expr} tz=${trigger.timezone}` : `cron:${trigger.expr}`;
    case "interval":
      return `interval:${trigger.value}${trigger.unit}`;
    case "phased":
      return "phased";
    case "event":
      return `event:${trigger.sources.join(",")}`;
    default:
      return trigger.kind;
  }
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePriority(value: unknown): TaskPriority | undefined {
  return value === "critical" || value === "high" || value === "medium" || value === "low" ? value : undefined;
}

function normalizeGoalAnalysis(value: unknown): GoalAnalysis | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const coreIntent = readString(record.coreIntent);
  const successState = readString(record.successState);
  const assumptions = readStringArray(record.assumptions);
  const deliveryContract = normalizeGoalDeliveryContract(record.deliveryContract);
  if (!coreIntent && !successState && assumptions.length === 0 && !deliveryContract) return undefined;
  return {
    coreIntent: coreIntent ?? "明确主题核心意图",
    successState: successState ?? "形成可持续推进的执行状态",
    assumptions,
    deliveryContract,
  };
}

function normalizeGoalDeliveryContract(value: unknown): GoalDeliveryContract | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const finalDeliverable = readString(record.finalDeliverable);
  const doneEvidence = readStringArray(record.doneEvidence);
  if (!finalDeliverable || doneEvidence.length === 0) return undefined;
  const nonCompletionExamples = readStringArray(record.nonCompletionExamples);
  return {
    finalDeliverable,
    doneEvidence,
    nonCompletionExamples: nonCompletionExamples.length > 0 ? nonCompletionExamples : undefined,
  };
}

function normalizeSuccessCriteria(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      const record = asRecord(item);
      return readString(record?.description);
    })
    .filter((item): item is string => Boolean(item));
}

function normalizeDependencies(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value
    .map((item) => {
      if (typeof item === "number" || typeof item === "string") return String(item).trim();
      return undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function normalizeTask(
  value: unknown,
  index: number,
  context: { subGoalId: string; specs?: Record<string, string>; warnings: string[] },
): GoalBreakdownDraft["subGoals"][number]["tasks"][number] {
  const record = asRecord(value) ?? {};
  const id = String(record.id ?? record.index ?? index + 1);
  const triggerSpec = readFirstTriggerSpec(
    [
      { value: record.triggerSpec, path: `subGoals.${context.subGoalId}.tasks.${id}.triggerSpec` },
      { value: record.trigger, path: `subGoals.${context.subGoalId}.tasks.${id}.trigger` },
    ],
    context.warnings,
  );
  const title = readString(record.title) ?? `任务 ${index + 1}`;
  const description = readString(record.description) ?? readString(record.objective) ?? title;
  const expectedOutcome = readString(record.expectedOutcome) ?? readString(record.deliverable) ?? description;
  const triggerRule =
    readString(record.triggerRule) ??
    triggerSpecToRule(triggerSpec) ??
    readString(record.cadence) ??
    (readString(record.triggerCondition) ? `满足条件：${readString(record.triggerCondition)}` : undefined) ??
    "手动触发";
  const taskType =
    record.taskType === "repeat" || readString(record.cadence) || readString(record.triggerCondition)
      ? "repeat"
      : "one_shot";
  const specContent = context.specs?.[`${context.subGoalId}#${id}`];
  return {
    id,
    title,
    description,
    expectedOutcome,
    taskType,
    triggerRule,
    triggerSpec,
    trigger: triggerSpec,
    executionKind: "generic_result",
    priority: normalizePriority(record.priority ?? record.priorityHint),
    taskSpec: specContent
      ? {
          content: specContent,
          generatedAt: new Date().toISOString(),
          sourceRevision: computeTaskSpecSourceRevision({
            title,
            description,
            expectedOutcome,
            taskType,
            triggerRule,
          }),
        }
      : undefined,
  };
}

function normalizeSubGoals(
  value: unknown,
  specs?: Record<string, string>,
  warnings: string[] = [],
): GoalBreakdownDraft["subGoals"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const record = asRecord(item) ?? {};
      const title =
        readString(record.title) ??
        readString(record.name) ??
        readString(record.intent) ??
        `子目标 ${index + 1}`;
      const id = String(record.id ?? index + 1);
      const description = readString(record.description) ?? readString(record.intent);
      const successCriteria = normalizeSuccessCriteria(record.successCriteria);
      const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
      const reviewTrigger = readFirstTriggerSpec(
        [
          { value: record.reviewInterval, path: `subGoals.${id}.reviewInterval` },
          { value: record.reviewTrigger, path: `subGoals.${id}.reviewTrigger` },
          { value: record.loopInterval, path: `subGoals.${id}.loopInterval` },
        ],
        warnings,
      );
      const tasks = rawTasks.map((task, taskIndex) => normalizeTask(task, taskIndex, { subGoalId: id, specs, warnings }));
      return {
        id,
        title,
        description,
        reviewInterval: readString(record.reviewInterval) ?? readString(record.loopInterval),
        reviewTrigger,
        terminationCondition: readString(record.terminationCondition),
        why: readString(record.why),
        priority: normalizePriority(record.priority),
        dependencies: normalizeDependencies(record.dependencies),
        estimatedDurationMinutes: readNumber(record.estimatedDurationMinutes),
        successCriteria,
        tasks,
      };
    })
    .filter((item) => item.title.trim().length > 0);
}

function readPlanArtifact(result: TopicInitSagaResult) {
  return asRecord(result.artifacts.refinedPlan) ?? asRecord(result.artifacts.plan);
}

export function adaptTopicInitSagaToGoalDraft(input: {
  topicText: string;
  result: TopicInitSagaResult;
}): GoalBreakdownDraft {
  if (input.result.status !== "completed") {
    throw new Error(`TopicInitSaga 尚未完成，当前状态为 ${input.result.status}`);
  }
  const plan = readPlanArtifact(input.result);
  const presentation = asRecord(input.result.artifacts.presentation);
  if (!plan) {
    throw new Error("TopicInitSaga 缺少 Planner 产物，无法生成规划草案");
  }
  if (!presentation) {
    throw new Error("TopicInitSaga 缺少 Presenter 产物，无法生成规划草案");
  }

  const plannerWarnings: string[] = [];
  const subGoals = normalizeSubGoals(plan.subGoals ?? plan.threads, input.result.artifacts.specs, plannerWarnings);
  if (subGoals.length === 0) {
    throw new Error("TopicInitSaga 未返回任何可落库的子目标/线程");
  }

  const criticNotes = readString(input.result.artifacts.critic?.notes);
  const goalAnalysis = normalizeGoalAnalysis(plan.goalAnalysis);
  const deliveryContract = goalAnalysis?.deliveryContract ?? normalizeGoalDeliveryContract(plan.deliveryContract);
  const topicLoop = readFirstTriggerSpec(
    [
      { value: plan.topicLoop, path: "topicLoop" },
      { value: plan.loop, path: "loop" },
    ],
    plannerWarnings,
  );
  const reviewSummary = [
    ...(criticNotes ? [criticNotes] : []),
    ...plannerWarnings,
  ];
  return {
    goalTitle: readString(presentation.goalTitle) ?? input.topicText,
    summary: readString(presentation.summary),
    deadline: readString(presentation.deadline),
    topicLoop,
    goalAnalysis: goalAnalysis
      ? { ...goalAnalysis, deliveryContract }
      : deliveryContract
        ? {
            coreIntent: "明确主题核心意图",
            successState: "形成可持续推进的执行状态",
            deliveryContract,
          }
        : undefined,
    deliveryContract,
    collectedInfoSummary: undefined,
    assumptions: goalAnalysis?.assumptions,
    risks: readStringArray(plan.risks),
    reasoning: readString(plan.reasoning),
    executionOrder: readString(plan.executionOrder),
    reviewSummary: reviewSummary.length > 0 ? reviewSummary : undefined,
    notificationStrategy: readString(presentation.notificationStrategy),
    subGoals,
  };
}
