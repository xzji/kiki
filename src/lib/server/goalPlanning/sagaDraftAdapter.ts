import type { TopicInitSagaResult } from "@/lib/server/goalPlanning/topicInitSaga";
import type { GoalAnalysis, GoalBreakdownDraft, TaskPriority } from "@/types/kiki";

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseRecord) : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  if (!coreIntent && !successState && assumptions.length === 0) return undefined;
  return {
    coreIntent: coreIntent ?? "明确主题核心意图",
    successState: successState ?? "形成可持续推进的执行状态",
    assumptions,
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
): GoalBreakdownDraft["subGoals"][number]["tasks"][number] {
  const record = asRecord(value) ?? {};
  const title = readString(record.title) ?? `任务 ${index + 1}`;
  const description = readString(record.description) ?? readString(record.objective) ?? title;
  const expectedOutcome = readString(record.expectedOutcome) ?? readString(record.deliverable) ?? description;
  const triggerRule =
    readString(record.triggerRule) ??
    readString(record.cadence) ??
    (readString(record.triggerCondition) ? `满足条件：${readString(record.triggerCondition)}` : undefined) ??
    "手动触发";
  return {
    id: String(record.id ?? record.index ?? index + 1),
    title,
    description,
    expectedOutcome,
    taskType:
      record.taskType === "repeat" || readString(record.cadence) || readString(record.triggerCondition)
        ? "repeat"
        : "one_shot",
    triggerRule,
    executionKind: "generic_result",
    priority: normalizePriority(record.priority ?? record.priorityHint),
  };
}

function normalizeSubGoals(
  value: unknown,
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
      const tasks = rawTasks.map((task, taskIndex) => normalizeTask(task, taskIndex));
      return {
        id,
        title,
        description,
        reviewInterval: readString(record.reviewInterval) ?? readString(record.loopInterval),
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

  const subGoals = normalizeSubGoals(plan.subGoals ?? plan.threads);
  if (subGoals.length === 0) {
    throw new Error("TopicInitSaga 未返回任何可落库的子目标/线程");
  }

  const criticNotes = readString(input.result.artifacts.critic?.notes);
  const goalAnalysis = normalizeGoalAnalysis(plan.goalAnalysis);
  return {
    goalTitle: readString(presentation.goalTitle) ?? input.topicText,
    summary: readString(presentation.summary),
    deadline: readString(presentation.deadline),
    goalAnalysis,
    collectedInfoSummary: undefined,
    assumptions: goalAnalysis?.assumptions,
    risks: readStringArray(plan.risks),
    reasoning: readString(plan.reasoning),
    executionOrder: readString(plan.executionOrder),
    reviewSummary: criticNotes ? [criticNotes] : undefined,
    notificationStrategy: readString(presentation.notificationStrategy),
    subGoals,
  };
}
