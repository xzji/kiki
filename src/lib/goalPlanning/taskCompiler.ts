import type {
  ExecutionKind,
  GoalBreakdownDraft,
  TaskCollaborationRequirements,
  TaskExecutionMode,
  TaskExpectedResult,
} from "@/types/kiki";
import type { TaskDraft } from "@/lib/server/goalPlanning/taskDraftSchema";

export type TaskCompileWarning = {
  index: number;
  code: "cadence_invalid" | "dependency_unresolved" | "dependency_cycle" | "shape_defaulted";
  message: string;
};

export function sanitizeDraftIdPart(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "item";
}

export function buildDraftTaskId(input: {
  taskIdBatchSeed: string;
  subGoalDraftId: string;
  subGoalIndex: number;
  taskIndex: number;
  sourceTaskId?: string;
}) {
  const sourcePart = sanitizeDraftIdPart(input.sourceTaskId ?? `task-${input.taskIndex}`);
  return [
    "draft-task",
    input.taskIdBatchSeed,
    `sg${input.subGoalIndex}`,
    sanitizeDraftIdPart(input.subGoalDraftId),
    `t${input.taskIndex}`,
    sourcePart,
  ].join("-");
}

function textOf(draft: TaskDraft) {
  return `${draft.title}\n${draft.objective}\n${draft.deliverable}\n${draft.acceptanceCriteria.join("\n")}\n${draft.notes ?? ""}`;
}

export function inferExecutionKind(input: TaskDraft | { kind?: ExecutionKind; expectedOutcome?: string; description?: string }): ExecutionKind {
  void input;
  return "generic_result";
}

export function inferTaskType(draft: TaskDraft): "repeat" | "one_shot" {
  const cadence = draft.cadence ?? "";
  if (cadence || /每日|每天|每周|每月|定期|持续|监控|巡检|复盘/.test(textOf(draft))) return "repeat";
  return "one_shot";
}

export function inferExecutionMode(draft: TaskDraft): TaskExecutionMode {
  if (draft.triggerCondition) return "event_triggered";
  if (inferTaskType(draft) === "repeat") return "monitoring";
  if (draft.userInvolvement?.mode && draft.userInvolvement.mode !== "none") return "interactive";
  return "standard";
}

export function inferRequiredBlocks(
  kind: ExecutionKind,
  expectedOutcome: string,
  description: string,
): NonNullable<TaskExpectedResult["requiredBlocks"]> {
  void kind;
  const text = `${expectedOutcome}\n${description}`;
  const blocks: NonNullable<TaskExpectedResult["requiredBlocks"]> = ["heading"];
  if (/对比|比较|表|矩阵|维度/.test(text)) blocks.push("comparison_table");
  if (/清单|步骤|计划|训练|复盘|词汇|摘要|精读|复述|结构图|列表/.test(text)) blocks.push("list");
  if (!blocks.includes("comparison_table")) blocks.push("paragraph");
  blocks.push("callout");
  return Array.from(new Set(blocks));
}

export function inferPresentation(kind: ExecutionKind, expectedOutcome: string): NonNullable<TaskExpectedResult["presentation"]> {
  void kind;
  if (/表|对比|矩阵/.test(expectedOutcome)) return "visual_report";
  if (/时间线|日程|排期/.test(expectedOutcome)) return "timeline";
  if (/看板|dashboard/.test(expectedOutcome)) return "dashboard";
  if (/清单|checklist/.test(expectedOutcome)) return "checklist";
  return "document";
}

export function inferPrimaryFormat(kind: ExecutionKind): NonNullable<TaskExpectedResult["primaryFormat"]> {
  void kind;
  return "structured_blocks";
}

export function inferExportableFormats(kind: ExecutionKind, expectedOutcome: string): NonNullable<TaskExpectedResult["exportableFormats"]> {
  void kind;
  if (/表|对比|矩阵/.test(expectedOutcome)) return ["html", "markdown"];
  return ["markdown"];
}

export function buildExpectedResult(
  kind: ExecutionKind,
  expectedOutcome: string,
  description: string,
): TaskExpectedResult {
  return {
    type: "deliverable",
    description: expectedOutcome,
    format: /表|对比|矩阵/.test(expectedOutcome) ? "table" : "markdown",
    presentation: inferPresentation(kind, expectedOutcome),
    primaryFormat: inferPrimaryFormat(kind),
    surfaces: ["interactive"],
    interactiveSurface: { required: true, kind: "blocks" },
    exportableFormats: inferExportableFormats(kind, expectedOutcome),
    requiredBlocks: inferRequiredBlocks(kind, expectedOutcome, description),
    completionCriteria: `围绕任务目标「${expectedOutcome}」输出完整、可展示、可复用的结果。`,
  };
}

export function buildCollaboration(
  draftOrKind: TaskDraft | ExecutionKind,
  description: string,
  expectedOutcome: string,
): TaskCollaborationRequirements {
  const explicitMode = typeof draftOrKind === "string" ? undefined : draftOrKind.userInvolvement?.mode;
  const userInteractionType =
    explicitMode === "answer" || explicitMode === "collaborate"
      ? "answer"
      : explicitMode === "confirm"
        ? "confirm"
        : "none";
  const mode =
    userInteractionType === "answer"
      ? "agent_user_collaborative"
      : userInteractionType === "confirm"
        ? "agent_with_user_confirmation"
        : "agent_autonomous";
  return {
    mode,
    agentResponsibilities: [description, "按任务目标生成可复用结果"],
    userResponsibilities:
      userInteractionType === "answer" ? ["完成作答或互动"] : userInteractionType === "confirm" ? ["确认结果或提出修改建议"] : [],
    userInteractionType,
    userInteractionTiming: userInteractionType === "answer" ? "core_task_step" : userInteractionType === "confirm" ? "after_agent_output" : "not_required",
    userFacingActionLabel:
      typeof draftOrKind !== "string" && draftOrKind.userInvolvement?.actionLabel
        ? draftOrKind.userInvolvement.actionLabel
        : userInteractionType === "answer"
          ? "开始作答"
          : userInteractionType === "confirm"
            ? "确认或提出修改建议"
            : "查看结果",
    shouldNotifyUser: userInteractionType !== "none",
    completionOwner: userInteractionType === "answer" ? "shared" : "agent",
    completionDefinition: expectedOutcome,
  };
}

export function validateCadence(draft: TaskDraft) {
  const cadence = draft.cadence?.trim();
  if (!cadence) return { cadence: undefined, warning: undefined };
  const hasConcreteTime = /\d{1,2}:\d{2}/.test(cadence);
  const hasChineseInterval = /每\s*(\d+|周一|周二|周三|周四|周五|周六|周日|月|天|日|小时|分钟)/.test(cadence);
  const hasEventSource = Boolean(draft.triggerCondition?.trim());
  if (hasConcreteTime || hasChineseInterval || hasEventSource) return { cadence, warning: undefined };
  return {
    cadence: undefined,
    warning: {
      index: draft.index ?? 0,
      code: "cadence_invalid" as const,
      message: `周期任务 cadence 缺少具体时间或间隔：${cadence}`,
    },
  };
}

export function resolveDependencies(draft: TaskDraft, draftIds: Map<string, string>) {
  const dependencies: string[] = [];
  const unresolved: string[] = [];
  for (const hint of draft.dependencyHints ?? []) {
    const normalized = hint.trim();
    const resolved = draftIds.get(normalized) || draftIds.get(normalized.replace(/^task-/, ""));
    if (resolved) dependencies.push(resolved);
    else unresolved.push(hint);
  }
  return { dependencies: Array.from(new Set(dependencies)), unresolved };
}

type DraftSubGoal = GoalBreakdownDraft["subGoals"][number];
type DraftTask = DraftSubGoal["tasks"][number];

function normalizedDependencyKey(value: string) {
  return value.trim().replace(/^任务\s*\d+\s*[:：]\s*/, "").toLowerCase();
}

function addCandidate(index: Map<string, Set<string>>, key: string | undefined, taskId: string) {
  if (!key?.trim()) return;
  const normalized = normalizedDependencyKey(key);
  if (!normalized) return;
  const current = index.get(normalized) ?? new Set<string>();
  current.add(taskId);
  index.set(normalized, current);
}

function isBlockingOutputTask(task: DraftTask) {
  return task.taskType === "one_shot" && task.executionMode !== "monitoring";
}

function hasPath(graph: Map<string, string[]>, from: string, to: string, seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (graph.get(from) ?? []).some((next) => hasPath(graph, next, to, seen));
}

function wouldCreateCycle(graph: Map<string, string[]>, taskId: string, dependencyId: string) {
  return taskId === dependencyId || hasPath(graph, dependencyId, taskId);
}

export function mergeCrossSubGoalTaskDependencies(input: {
  subGoals: GoalBreakdownDraft["subGoals"];
}): { subGoals: GoalBreakdownDraft["subGoals"]; warnings: TaskCompileWarning[] } {
  const warnings: TaskCompileWarning[] = [];
  const globalIndex = new Map<string, Set<string>>();
  const localIndexes = new Map<string, Map<string, Set<string>>>();
  const tasksById = new Map<string, DraftTask>();
  const subGoalByTaskId = new Map<string, string>();
  const subGoalIndexById = new Map<string, number>();

  input.subGoals.forEach((subGoal, subGoalIndex) => {
    subGoalIndexById.set(subGoal.id, subGoalIndex);
    const localIndex = new Map<string, Set<string>>();
    subGoal.tasks.forEach((task, taskIndex) => {
      tasksById.set(task.id, task);
      subGoalByTaskId.set(task.id, subGoal.id);
      const numericSubGoalId = subGoal.id.match(/\d+$/)?.[0];
      [
        task.id,
        task.title,
        String(taskIndex + 1),
        `task-${taskIndex + 1}`,
        `${subGoalIndex + 1}-${taskIndex + 1}`,
        numericSubGoalId ? `${numericSubGoalId}-${taskIndex + 1}` : undefined,
      ].forEach((key) => {
        addCandidate(globalIndex, key, task.id);
        addCandidate(localIndex, key, task.id);
      });
    });
    localIndexes.set(subGoal.id, localIndex);
  });

  const resolveHint = (hint: string, currentSubGoal: DraftSubGoal): { id?: string; ambiguous?: boolean } => {
    const normalized = normalizedDependencyKey(hint);
    if (!normalized) return {};

    const local = localIndexes.get(currentSubGoal.id)?.get(normalized);
    if (local?.size === 1) return { id: Array.from(local)[0] };

    const upstreamIds = new Set(currentSubGoal.dependencies ?? []);
    const upstreamCandidates = Array.from(globalIndex.get(normalized) ?? []).filter((taskId) => {
      const subGoalId = subGoalByTaskId.get(taskId);
      return Boolean(subGoalId && upstreamIds.has(subGoalId));
    });
    if (upstreamCandidates.length === 1) return { id: upstreamCandidates[0] };
    if (upstreamCandidates.length > 1) return { ambiguous: true };

    const global = globalIndex.get(normalized);
    if (global?.size === 1) return { id: Array.from(global)[0] };
    if (global && global.size > 1) return { ambiguous: true };
    return {};
  };

  const graph = new Map<string, string[]>();
  const nextSubGoals = input.subGoals.map((subGoal) => ({
    ...subGoal,
    tasks: subGoal.tasks.map((task) => ({ ...task })),
  }));

  const addDependency = (task: DraftTask, dependencyId: string, taskIndex: number, reason: string) => {
    if (!tasksById.has(dependencyId)) {
      if (reason === "explicit") {
        warnings.push({
          index: taskIndex + 1,
          code: "dependency_unresolved",
          message: `依赖无法解析：${dependencyId}`,
        });
      }
      return;
    }
    if (wouldCreateCycle(graph, task.id, dependencyId)) {
      warnings.push({
        index: taskIndex + 1,
        code: "dependency_cycle",
        message: `依赖会形成循环，已跳过：${task.title} -> ${tasksById.get(dependencyId)?.title ?? dependencyId}`,
      });
      return;
    }
    const current = graph.get(task.id) ?? [];
    if (!current.includes(dependencyId)) {
      current.push(dependencyId);
      graph.set(task.id, current);
    }
  };

  nextSubGoals.forEach((subGoal) => {
    subGoal.tasks.forEach((task, taskIndex) => {
      for (const dependencyId of task.dependencies ?? []) {
        addDependency(task, dependencyId, taskIndex, "explicit");
      }
      for (const hint of task.planningDependencyHints ?? []) {
        const resolved = resolveHint(hint, subGoal);
        if (resolved.id) {
          addDependency(task, resolved.id, taskIndex, "explicit");
        } else {
          warnings.push({
            index: taskIndex + 1,
            code: "dependency_unresolved",
            message: resolved.ambiguous ? `依赖引用不唯一：${hint}` : `依赖无法解析：${hint}`,
          });
        }
      }
    });
  });

  nextSubGoals.forEach((subGoal) => {
    const dependencySubGoalIds = new Set(subGoal.dependencies ?? []);
    if (dependencySubGoalIds.size === 0) return;
    const upstreamKeyTasks = input.subGoals
      .filter((candidate) => dependencySubGoalIds.has(candidate.id))
      .flatMap((candidate) => candidate.tasks.filter(isBlockingOutputTask));
    if (upstreamKeyTasks.length === 0) return;

    subGoal.tasks.forEach((task, taskIndex) => {
      const existingDependencySubGoals = new Set((graph.get(task.id) ?? []).map((dependencyId) => subGoalByTaskId.get(dependencyId)));
      for (const upstreamTask of upstreamKeyTasks) {
        const upstreamSubGoalId = subGoalByTaskId.get(upstreamTask.id);
        if (!upstreamSubGoalId || existingDependencySubGoals.has(upstreamSubGoalId)) continue;
        addDependency(task, upstreamTask.id, taskIndex, "derived");
      }
    });
  });

  for (const subGoal of nextSubGoals) {
    for (const task of subGoal.tasks) {
      task.dependencies = Array.from(new Set(graph.get(task.id) ?? []));
    }
  }
  nextSubGoals.sort((a, b) => (subGoalIndexById.get(a.id) ?? 0) - (subGoalIndexById.get(b.id) ?? 0));
  return { subGoals: nextSubGoals, warnings };
}
