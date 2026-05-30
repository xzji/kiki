import type { GoalServerProgress } from "@/types/goalTelemetry";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { InteractionRequirement, Task, TaskInstance } from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";

import {
  createInteractionRequirementFields,
  fieldsSuggestedActions,
  singleFieldOptions,
} from "@/lib/server/informationRequest/compileFields";
import { normalizeInteractionRequirement } from "@/lib/server/protocol/normalizeAwaitingInteraction";
import type { TaskReadinessCheck } from "@/lib/server/taskReadinessPolicy";

function nowIso() {
  return new Date().toISOString();
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

function buildQuestion(readiness: TaskReadinessCheck, fields: ReturnType<typeof createInteractionRequirementFields>) {
  if (fields.length === 1) return "";
  if (fields.length > 1) return `请补全本轮所需的 ${fields.length} 项信息：${fields.map((field) => field.label).join("、")}。`;
  return "请补充完成任务所需的关键信息。";
}

function buildSuggestedActions(readiness: TaskReadinessCheck, fieldActions: string[]) {
  const labels = readiness.missingUserInfo.map((item) => `补充${item.label}`);
  return uniqueStrings([...fieldActions, ...labels]).slice(0, 5);
}

export function createPreExecutionInteractionRequirement(readiness: TaskReadinessCheck): InteractionRequirement {
  const fields = createInteractionRequirementFields(readiness);
  const question = buildQuestion(readiness, fields);
  const options = singleFieldOptions(fields);
  const suggestedActions = buildSuggestedActions(readiness, fieldsSuggestedActions(fields));
  return normalizeInteractionRequirement({
    type: "provide_context",
    timing: "before_execution",
    reason: readiness.summary || question,
    question,
    options,
    fields,
    suggestedActions,
    shouldNotifyUser: true,
  })!;
}

export function createPreExecutionBlocker(input: {
  executionId: string;
  taskId: string;
  instanceId: string;
  interactionRequirement: InteractionRequirement;
}): ExecutionBlocker {
  return {
    executionId: input.executionId,
    taskId: input.taskId,
    instanceId: input.instanceId,
    blockedStepIndex: 0,
    resumeToken: `resume-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    interactionRequirement: input.interactionRequirement,
    resumeStrategy: "rerun_with_feedback",
    status: "waiting",
    createdAt: nowIso(),
  };
}

export function createPreExecutionTaskResult(input: {
  task: Task;
  instance: TaskInstance;
  readiness: TaskReadinessCheck;
  interactionRequirement: InteractionRequirement;
}): TaskResult {
  const missingItems = input.readiness.missingUserInfo.map((item) => item.description || item.label);
  return {
    schemaVersion: 1,
    taskId: input.task.id,
    instanceId: input.instance.id,
    title: "需要补充信息后继续",
    status: "pending_user",
    blocks: [
      {
        kind: "callout",
        tone: "warn",
        text: "当前缺少用户才能提供的关键信息，KiKi 已暂停执行，未生成基于猜测的方案。",
      },
      { kind: "heading", level: 2, text: "需要你补充" },
      { kind: "paragraph", text: input.interactionRequirement.question || input.interactionRequirement.reason },
      { kind: "list", ordered: false, items: missingItems },
    ],
    meta: {
      producedAt: nowIso(),
      presentation: "summary_card",
      primaryFormat: "structured_blocks",
      exportableFormats: ["markdown"],
      role: "pending_user_placeholder",
    },
  };
}

export function createPreExecutionAwaitingProgress(input: {
  requestId: string;
  goalId: string;
  task: Task;
  instance: TaskInstance;
  readiness: TaskReadinessCheck;
  interactionRequirement: InteractionRequirement;
  blocker: ExecutionBlocker;
  taskResult: TaskResult;
  trajectory?: ExecutionTrajectoryStep[];
}): GoalServerProgress {
  const now = nowIso();
  return {
    requestId: input.requestId,
    scope: "goal_task_execute",
    status: "completed",
    phase: "executing",
    message: "等待用户补充信息",
    startedAt: input.instance.execution?.startedAt ?? input.instance.createdAt,
    updatedAt: now,
    finishedAt: now,
    goalId: input.goalId,
    taskId: input.task.id,
    taskInstanceId: input.instance.id,
    summary: "需要你补充关键信息后才能继续执行。",
    resultPayload: {
      awaitingUser: true,
      awaitingReason: input.interactionRequirement.reason,
      interactionRequirement: input.interactionRequirement,
      suggestedActions: input.interactionRequirement.suggestedActions,
      blocker: input.blocker,
      taskResult: input.taskResult,
      structuredOutput: {
        taskReadiness: input.readiness,
        taskResult: input.taskResult,
        interactionRequirement: input.interactionRequirement,
        blockedByMissingUserContext: true,
      },
      finalMessage: input.interactionRequirement.reason,
      trajectory: input.trajectory ?? [],
    },
  };
}
