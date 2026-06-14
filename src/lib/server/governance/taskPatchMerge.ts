import type { TaskDraft } from "@/lib/server/goalPlanning/taskDraftSchema";
import { normalizeConcreteTriggerRule } from "@/lib/taskTriggerTime";
import { normalizeExecutionKind } from "@/types/kiki";
import type { ExecutionKind, Task, TaskExpectedResult, TaskSpec } from "@/types/kiki";
import type { TriggerSpec } from "@/types/trigger";
import { appendText, normalizeRequiredBlocks } from "./taskFieldRegistry";

export type TaskCommandInputForMerge = {
  title: string;
  description?: string;
  expectedOutcome: string;
  expectedResult?: TaskExpectedResult;
  taskType: Task["taskType"];
  triggerRule: string;
  trigger?: TriggerSpec;
  deadline?: string;
  executionKind: ExecutionKind;
  taskSpec?: TaskSpec;
};

export type TaskPatch = Partial<TaskDraft> & {
  description?: string;
  expectedOutcome?: string;
  expectedResult?: Partial<TaskExpectedResult>;
  completionCriteria?: string;
  requiredBlocks?: TaskExpectedResult["requiredBlocks"];
};

function descriptionFromPatch(patch: Partial<TaskDraft> & { description?: string }, fallback = "") {
  if (typeof patch.description === "string") return patch.description.trim();
  const acceptance = patch.acceptanceCriteria?.length
    ? `\n验收标准：\n${patch.acceptanceCriteria.map((line) => `- ${line}`).join("\n")}`
    : "";
  return `${patch.objective ?? fallback}${acceptance}`.trim();
}

function inferTaskTiming(patch: Partial<TaskDraft>, fallback: Pick<Task, "taskType" | "triggerRule">) {
  const explicitTaskType = patch.taskType;
  const explicitTriggerRule = patch.triggerRule?.trim();
  const cadence = patch.cadence?.trim();
  const triggerCondition = patch.triggerCondition?.trim();
  if (explicitTriggerRule || cadence || triggerCondition) {
    const taskType = explicitTaskType ?? (cadence || triggerCondition ? "repeat" : "one_shot");
    const triggerRule = normalizeConcreteTriggerRule(
      explicitTriggerRule || cadence || `满足条件：${triggerCondition}`,
      taskType,
    );
    return { taskType, triggerRule };
  }
  if (explicitTaskType) {
    return {
      taskType: explicitTaskType,
      triggerRule: normalizeConcreteTriggerRule(
        explicitTaskType === "one_shot" ? "立即触发" : "每天 09:00",
        explicitTaskType,
      ),
    };
  }
  return {
    taskType: fallback.taskType,
    triggerRule: normalizeConcreteTriggerRule(fallback.triggerRule, fallback.taskType),
  };
}

function mergeExpectedResult(task: Task, patch: TaskPatch): TaskExpectedResult | undefined {
  const current = task.expectedResult;
  const patchExpected = patch.expectedResult;
  const completionCriteria = appendText(
    current?.completionCriteria,
    patchExpected?.completionCriteria ?? patch.completionCriteria,
  );
  const requiredBlocks = normalizeRequiredBlocks([
    ...(current?.requiredBlocks ?? []),
    ...(patchExpected?.requiredBlocks ?? []),
    ...(patch.requiredBlocks ?? []),
  ]);
  if (!current && !patchExpected && !completionCriteria && !requiredBlocks) return undefined;
  return {
    ...(current ?? {
      type: "deliverable",
      description: task.expectedOutcome,
      format: "markdown",
    }),
    ...(patchExpected ?? {}),
    completionCriteria: completionCriteria ?? patchExpected?.completionCriteria ?? current?.completionCriteria,
    requiredBlocks: requiredBlocks ?? patchExpected?.requiredBlocks ?? current?.requiredBlocks,
  };
}

export function mergeTaskPatch(task: Task, patch: TaskPatch): TaskCommandInputForMerge {
  const description = descriptionFromPatch(patch, task.description);
  const timing = inferTaskTiming(patch, task);
  const touchesDefinition =
    patch.title !== undefined ||
    patch.description !== undefined ||
    patch.objective !== undefined ||
    patch.expectedOutcome !== undefined ||
    patch.deliverable !== undefined ||
    patch.expectedResult !== undefined ||
    patch.completionCriteria !== undefined ||
    patch.requiredBlocks !== undefined ||
    patch.acceptanceCriteria !== undefined ||
    patch.taskType !== undefined ||
    patch.triggerRule !== undefined ||
    patch.triggerSpec !== undefined ||
    patch.cadence !== undefined ||
    patch.triggerCondition !== undefined;
  return {
    title: patch.title?.trim() || task.title,
    description,
    expectedOutcome: patch.expectedOutcome?.trim() || patch.deliverable?.trim() || task.expectedOutcome,
    expectedResult: mergeExpectedResult(task, patch),
    taskType: timing.taskType,
    triggerRule: timing.triggerRule,
    trigger: patch.triggerSpec ?? task.trigger,
    deadline: task.deadline,
    executionKind: normalizeExecutionKind(task.executionKind),
    taskSpec: task.taskSpec && touchesDefinition ? { ...task.taskSpec, stale: true } : task.taskSpec,
  };
}
