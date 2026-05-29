import type { GoalBreakdownDraft, TaskExecutionStrategy } from "@/types/kiki";
import type { DecompositionSubGoalContext } from "./taskDraftReview";
import type { TaskDraft } from "./taskDraftSchema";
import {
  buildCollaboration,
  buildDraftTaskId,
  buildExpectedResult,
  inferExecutionKind,
  inferExecutionMode,
  inferTaskType,
  resolveDependencies,
  validateCadence,
  type TaskCompileWarning,
} from "@/lib/goalPlanning/taskCompiler";

export type { TaskCompileWarning } from "@/lib/goalPlanning/taskCompiler";

type DraftTask = GoalBreakdownDraft["subGoals"][number]["tasks"][number];

function strategyFor(collaboration: NonNullable<DraftTask["collaboration"]>): TaskExecutionStrategy {
  if (collaboration.mode === "agent_user_collaborative") return "hybrid";
  if (collaboration.mode === "user_primary_agent_assistive") return "user_interactive";
  return collaboration.userInteractionType === "none" ? "agent_autonomous" : "user_interactive";
}

function assertDraftTaskShape(task: DraftTask) {
  if (!task.id || !task.title || !task.description || !task.expectedOutcome || !task.expectedResult?.requiredBlocks?.length) {
    throw new Error(`编译后的任务字段不完整：${task.title || task.id}`);
  }
}

export function compileTaskDraftsToDraftTasks(input: {
  drafts: TaskDraft[];
  subGoalContext: DecompositionSubGoalContext;
  taskIdBatchSeed: string;
  subGoalDraftId: string;
  subGoalIndex: number;
}): { tasks: DraftTask[]; warnings: TaskCompileWarning[] } {
  const warnings: TaskCompileWarning[] = [];
  const idByHint = new Map<string, string>();
  input.drafts.forEach((draft, index) => {
    const taskId = buildDraftTaskId({
      taskIdBatchSeed: input.taskIdBatchSeed,
      subGoalDraftId: input.subGoalDraftId,
      subGoalIndex: input.subGoalIndex,
      taskIndex: index + 1,
      sourceTaskId: `task-${draft.index ?? index + 1}`,
    });
    idByHint.set(String(draft.index ?? index + 1), taskId);
    idByHint.set(`task-${draft.index ?? index + 1}`, taskId);
    idByHint.set(draft.title, taskId);
  });

  const tasks = input.drafts.map((draft, index) => {
    const taskType = inferTaskType(draft);
    const executionKind = inferExecutionKind(draft);
    const executionMode = inferExecutionMode(draft);
    const cadence = validateCadence(draft);
    if (cadence.warning) warnings.push(cadence.warning);
    const expectedOutcome = draft.deliverable;
    const description = draft.objective;
    const expectedResult = buildExpectedResult(executionKind, expectedOutcome, description);
    const collaboration = buildCollaboration(draft, description, expectedOutcome);
    const deps = resolveDependencies(draft, idByHint);
    if (deps.unresolved.length > 0) {
      warnings.push({
        index: draft.index ?? index + 1,
        code: "dependency_unresolved",
        message: `依赖无法解析：${deps.unresolved.join(", ")}`,
      });
    }
    const triggerRule = draft.triggerCondition
      ? `满足触发条件执行：${draft.triggerCondition}`
      : taskType === "repeat"
        ? cadence.cadence || "每周固定节奏执行"
        : "准备好后执行一次";
    const task: DraftTask = {
      id: buildDraftTaskId({
        taskIdBatchSeed: input.taskIdBatchSeed,
        subGoalDraftId: input.subGoalDraftId,
        subGoalIndex: input.subGoalIndex,
        taskIndex: index + 1,
        sourceTaskId: `task-${draft.index ?? index + 1}`,
      }),
      title: draft.title,
      description,
      expectedOutcome,
      taskType,
      triggerRule,
      executionKind,
      resultViewKind: executionKind,
      executionStrategy: strategyFor(collaboration),
      priority: draft.priorityHint ?? input.subGoalContext.priority ?? "medium",
      dependencies: deps.dependencies,
      executionMode,
      expectedResult,
      executionObjective: description,
      recommendedWorkingDirectory: undefined,
      autoRunDisabled: false,
      requiresConfirmation: collaboration.userInteractionType === "confirm" || expectedResult.type === "decision" || expectedResult.type === "confirmation",
      collaboration,
    };
    assertDraftTaskShape(task);
    return task;
  });
  return { tasks, warnings };
}
