export type TaskDraftUserInvolvementMode = "none" | "confirm" | "answer" | "collaborate";

export type TaskDraft = {
  index?: number;
  title: string;
  objective: string;
  deliverable: string;
  acceptanceCriteria: string[];
  taskType?: "repeat" | "one_shot";
  triggerRule?: string;
  cadence?: string;
  triggerCondition?: string;
  userInvolvement?: {
    mode?: TaskDraftUserInvolvementMode;
    reason?: string;
    actionLabel?: string;
  };
  dependencyHints?: string[];
  priorityHint?: "critical" | "high" | "medium" | "low";
  estimatedMinutes?: number;
  notes?: string;
};

export type TaskDraftDropReason = {
  index: number;
  missingFields: string[];
  reason?: string;
  rawBlock?: string;
};

export type TaskDraftBatch = {
  subGoalSummary?: string;
  coverageNotes?: string[];
  risks?: string[];
  tasks: TaskDraft[];
  droppedTaskIndices?: number[];
  droppedReasons?: TaskDraftDropReason[];
  recoveredTaskCount?: number;
  warnings?: string[];
  rawBlocks?: Array<{ index: number; raw: string }>;
};

export class TaskDraftBatchEmptyError extends Error {
  droppedReasons: TaskDraftDropReason[];

  constructor(message: string, droppedReasons: TaskDraftDropReason[]) {
    super(message);
    this.name = "TaskDraftBatchEmptyError";
    this.droppedReasons = droppedReasons;
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\n|；|;/)
      .map((item) => item.replace(/^\s*[-*]\s*/, "").trim())
      .filter(Boolean);
  }
  return [];
}

function normalizePriority(value: unknown): TaskDraft["priorityHint"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low" ? value : undefined;
}

function normalizeMode(value: unknown): TaskDraftUserInvolvementMode | undefined {
  return value === "none" || value === "confirm" || value === "answer" || value === "collaborate" ? value : undefined;
}

function normalizeTaskType(value: unknown): TaskDraft["taskType"] {
  return value === "repeat" || value === "one_shot" ? value : undefined;
}

export function normalizeTaskDraft(value: unknown, fallbackIndex: number): { draft?: TaskDraft; reason?: TaskDraftDropReason } {
  if (!value || typeof value !== "object") {
    return { reason: { index: fallbackIndex, missingFields: ["task"], reason: "任务草稿不是对象" } };
  }
  const record = value as Record<string, unknown>;
  const draft: TaskDraft = {
    index: typeof record.index === "number" && Number.isFinite(record.index) ? record.index : fallbackIndex,
    title: text(record.title),
    objective: text(record.objective),
    deliverable: text(record.deliverable),
    acceptanceCriteria: list(record.acceptanceCriteria),
    taskType: normalizeTaskType(record.taskType),
    triggerRule: text(record.triggerRule) || undefined,
    cadence: text(record.cadence) || undefined,
    triggerCondition: text(record.triggerCondition) || undefined,
    dependencyHints: list(record.dependencyHints),
    priorityHint: normalizePriority(record.priorityHint),
    estimatedMinutes: typeof record.estimatedMinutes === "number" && Number.isFinite(record.estimatedMinutes)
      ? Math.max(1, Math.round(record.estimatedMinutes))
      : undefined,
    notes: text(record.notes) || undefined,
  };
  const involvement = record.userInvolvement && typeof record.userInvolvement === "object"
    ? (record.userInvolvement as Record<string, unknown>)
    : undefined;
  if (involvement) {
    draft.userInvolvement = {
      mode: normalizeMode(involvement.mode),
      reason: text(involvement.reason) || undefined,
      actionLabel: text(involvement.actionLabel) || undefined,
    };
  }

  const missingFields: string[] = [];
  if (!draft.title) missingFields.push("title");
  if (!draft.objective) missingFields.push("objective");
  if (!draft.deliverable) missingFields.push("deliverable");
  if (draft.acceptanceCriteria.length === 0) missingFields.push("acceptanceCriteria");
  if (missingFields.length > 0) {
    return { reason: { index: draft.index ?? fallbackIndex, missingFields, reason: "任务草稿缺少必填字段" } };
  }
  return { draft };
}

export function validateTaskDraftBatch(batch: TaskDraftBatch): TaskDraftBatch {
  const droppedReasons = [...(batch.droppedReasons ?? [])];
  const tasks: TaskDraft[] = [];
  batch.tasks.forEach((task, index) => {
    const result = normalizeTaskDraft(task, task.index ?? index + 1);
    if (result.draft) tasks.push(result.draft);
    if (result.reason) droppedReasons.push(result.reason);
  });
  const normalized: TaskDraftBatch = {
    ...batch,
    tasks,
    droppedReasons,
    droppedTaskIndices: Array.from(new Set(droppedReasons.map((item) => item.index))).sort((a, b) => a - b),
  };
  if (tasks.length === 0) {
    throw new TaskDraftBatchEmptyError("任务草稿全部不可用", droppedReasons);
  }
  return normalized;
}
