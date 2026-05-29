import { createHash } from "crypto";

import { deriveOpaqueId, normalizeGoalId, normalizeSubGoalId, normalizeTaskId } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
import {
  appendGoalEventOnce,
  getGoalEventByIdempotencyKey,
} from "@/lib/server/repositories/goalEventLogRepository";
import { readGoalsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import { writeGoalsProjection } from "@/lib/server/services/goalRuntimeService";
import type { GoalEventRecord } from "@/types/goalEventLog";
import { normalizeExecutionKind, normalizeTaskResultViewKind } from "@/types/kiki";
import type { ExecutionKind, Goal, GoalWorkflow, SubGoal, Task } from "@/types/kiki";

type TaskCommandInput = {
  title: string;
  description?: string;
  expectedOutcome: string;
  taskType: Task["taskType"];
  triggerRule: string;
  deadline?: string;
  executionKind: ExecutionKind;
};

export type GoalCommand =
  | {
      type: "create_goal";
      goal: Goal;
    }
  | {
      type: "confirm_goal_plan";
      goalId: string;
    }
  | {
      type: "request_goal_plan_revision";
      goalId: string;
      feedback: string;
    }
  | {
      type: "create_sub_goal";
      goalId: string;
      title: string;
    }
  | {
      type: "create_task";
      goalId: string;
      subGoalId: string;
      task: TaskCommandInput;
    }
  | {
      type: "update_task";
      goalId: string;
      taskId: string;
      task: TaskCommandInput;
    }
  | {
      type: "delete_task";
      goalId: string;
      taskId: string;
    }
  | {
      type: "delete_goals_by_conversation";
      conversationId: string;
    };

export type ApplyGoalCommandInput = {
  command: GoalCommand;
  idempotencyKey: string;
  baseRevision?: number;
};

export type ApplyGoalCommandResult = {
  event: GoalEventRecord;
  goals: Goal[];
  revision: number;
};

export class GoalCommandConflictError extends Error {
  constructor(
    public currentRevision: number,
    public expectedRevision: number,
  ) {
    super("目标已被更新，请刷新后重试");
    this.name = "GoalCommandConflictError";
  }
}

export class GoalCommandIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key 已用于不同命令，请更换后重试");
    this.name = "GoalCommandIdempotencyConflictError";
  }
}

export class GoalCommandValidationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoalCommandValidationError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function assertTitle(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new GoalCommandValidationError(400, `${label}不能为空`);
  }
  return normalized;
}

function findGoal(goals: Goal[], goalId: string) {
  const normalizedGoalId = normalizeGoalId(goalId);
  const goal = goals.find((item) => normalizeGoalId(item.id) === normalizedGoalId);
  if (!goal) {
    throw new GoalCommandValidationError(404, "未找到目标");
  }
  return goal;
}

function findSubGoal(goal: Goal, subGoalId: string) {
  const normalizedSubGoalId = normalizeSubGoalId(subGoalId);
  const subGoal = goal.subGoals.find((item) => normalizeSubGoalId(item.id) === normalizedSubGoalId);
  if (!subGoal) {
    throw new GoalCommandValidationError(404, "未找到子目标");
  }
  return subGoal;
}

function findTask(goal: Goal, taskId: string) {
  const normalizedTaskId = normalizeTaskId(taskId);
  const task = goal.subGoals
    .flatMap((subGoal) => subGoal.tasks)
    .find((item) => normalizeTaskId(item.id) === normalizedTaskId);
  if (!task) {
    throw new GoalCommandValidationError(404, "未找到任务");
  }
  return task;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashValue(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function validateGoalEntity(goal: Goal) {
  assertTitle(goal.id, "目标 ID");
  assertTitle(goal.title, "目标标题");
  if (!Array.isArray(goal.subGoals)) {
    throw new GoalCommandValidationError(400, "目标结构无效");
  }
  for (const subGoal of goal.subGoals) {
    assertTitle(subGoal.id, "子目标 ID");
    assertTitle(subGoal.title, "子目标标题");
    if (subGoal.goalId && normalizeGoalId(subGoal.goalId) !== normalizeGoalId(goal.id)) {
      throw new GoalCommandValidationError(400, "子目标引用的目标不一致");
    }
    if (!Array.isArray(subGoal.tasks)) {
      throw new GoalCommandValidationError(400, "子目标任务结构无效");
    }
    for (const task of subGoal.tasks) {
      task.executionKind = normalizeExecutionKind(task.executionKind);
      task.resultViewKind = normalizeTaskResultViewKind(task.resultViewKind ?? task.executionKind);
      assertTitle(task.id, "任务 ID");
      assertTitle(task.title, "任务标题");
      assertTitle(task.expectedOutcome, "任务交付物");
      assertTitle(task.triggerRule, "任务触发时机");
      if (task.subGoalId && normalizeSubGoalId(task.subGoalId) !== normalizeSubGoalId(subGoal.id)) {
        throw new GoalCommandValidationError(400, "任务引用的子目标不一致");
      }
      if (!task.taskType || !task.executionKind) {
        throw new GoalCommandValidationError(400, "任务类型或执行方式无效");
      }
    }
  }
}

function normalizeTaskInput(input: TaskCommandInput): TaskCommandInput {
  return {
    ...input,
    executionKind: normalizeExecutionKind(input.executionKind),
    title: assertTitle(input.title, "任务标题"),
    description: input.description?.trim() ?? "",
    expectedOutcome: assertTitle(input.expectedOutcome, "任务交付物"),
    triggerRule: assertTitle(input.triggerRule, "任务触发时机"),
  };
}

function withGoal(goals: Goal[], goalId: string, updater: (goal: Goal) => Goal) {
  findGoal(goals, goalId);
  const normalizedGoalId = normalizeGoalId(goalId);
  return goals.map((goal) => (normalizeGoalId(goal.id) === normalizedGoalId ? updater(goal) : goal));
}

function updateGoalWorkflow(goal: Goal, updater: (previous: GoalWorkflow | undefined) => GoalWorkflow): Goal {
  return {
    ...goal,
    workflow: updater(goal.workflow),
  };
}

function createSubGoal(input: { goalId: string; title: string; idempotencyKey: string; index: number }): SubGoal {
  const title = assertTitle(input.title, "子目标标题");
  return {
    id: deriveOpaqueId("sg", input.idempotencyKey),
    goalId: input.goalId,
    title: title.startsWith("子目标") ? title : `子目标${input.index}：${title}`,
    tasks: [],
  };
}

function createTask(input: { subGoalId: string; task: TaskCommandInput; idempotencyKey: string; index: number }): Task {
  const task = normalizeTaskInput(input.task);
  return {
    id: deriveOpaqueId("task", input.idempotencyKey),
    subGoalId: input.subGoalId,
    title: task.title.startsWith("任务") ? task.title : `任务${input.index}：${task.title}`,
    description: task.description ?? "",
    expectedOutcome: task.expectedOutcome,
    taskType: task.taskType,
    triggerRule: task.triggerRule,
    deadline: task.deadline,
    progress: 0,
    instances: [],
    executionKind: task.executionKind,
    resultViewKind: normalizeTaskResultViewKind(task.executionKind),
    executionStrategy: "agent_autonomous",
    executionObjective: task.description ?? "",
  };
}

function applyCommandToGoals(goals: Goal[], command: GoalCommand, idempotencyKey: string) {
  const now = nowIso();
  switch (command.type) {
    case "create_goal": {
      validateGoalEntity(command.goal);
      const nextGoalId = normalizeGoalId(command.goal.id);
      if (goals.some((goal) => normalizeGoalId(goal.id) === nextGoalId)) {
        throw new GoalCommandValidationError(409, "目标已存在，请刷新后重试");
      }
      return [...goals, command.goal];
    }
    case "confirm_goal_plan":
      return withGoal(goals, command.goalId, (goal) =>
        updateGoalWorkflow(goal, (previous) => ({
          ...previous,
          phase: "executing",
          planDecision: "confirmed",
          startedAt: previous?.startedAt ?? now,
          updatedAt: now,
          confirmedAt: previous?.confirmedAt ?? now,
        })),
      );
    case "request_goal_plan_revision":
      return withGoal(goals, command.goalId, (goal) =>
        updateGoalWorkflow(goal, (previous) => ({
          ...previous,
          phase: "decomposing",
          planDecision: "revision_requested",
          startedAt: previous?.startedAt ?? now,
          updatedAt: now,
          collectedInfo: {
            ...(previous?.collectedInfo ?? {}),
            revisionFeedback: assertTitle(command.feedback, "调整建议"),
          },
        })),
      );
    case "create_sub_goal":
      return withGoal(goals, command.goalId, (goal) => {
        const nextSubGoal = createSubGoal({
          goalId: goal.id,
          title: command.title,
          idempotencyKey,
          index: goal.subGoals.length + 1,
        });
        if (goal.subGoals.some((subGoal) => subGoal.id === nextSubGoal.id)) return goal;
        return {
          ...goal,
          subGoals: [...goal.subGoals, nextSubGoal],
        };
      });
    case "create_task":
      return withGoal(goals, command.goalId, (goal) => {
        findSubGoal(goal, command.subGoalId);
        const normalizedSubGoalId = normalizeSubGoalId(command.subGoalId);
        return {
          ...goal,
          subGoals: goal.subGoals.map((subGoal) => {
            if (normalizeSubGoalId(subGoal.id) !== normalizedSubGoalId) return subGoal;
            const nextTask = createTask({
              subGoalId: subGoal.id,
              task: command.task,
              idempotencyKey,
              index: subGoal.tasks.length + 1,
            });
            if (subGoal.tasks.some((task) => task.id === nextTask.id)) return subGoal;
            return {
              ...subGoal,
              tasks: [...subGoal.tasks, nextTask],
            };
          }),
        };
      });
    case "update_task": {
      const nextTaskInput = normalizeTaskInput(command.task);
      const normalizedTaskId = normalizeTaskId(command.taskId);
      return withGoal(goals, command.goalId, (goal) => {
        findTask(goal, command.taskId);
        return {
          ...goal,
          subGoals: goal.subGoals.map((subGoal) => ({
            ...subGoal,
            tasks: subGoal.tasks.map((task) =>
              normalizeTaskId(task.id) === normalizedTaskId
                ? {
                    ...task,
                    title: nextTaskInput.title,
                    description: nextTaskInput.description ?? "",
                    expectedOutcome: nextTaskInput.expectedOutcome,
                    taskType: nextTaskInput.taskType,
                    triggerRule: nextTaskInput.triggerRule,
                    deadline: nextTaskInput.deadline,
                    executionKind: nextTaskInput.executionKind,
                    resultViewKind: normalizeTaskResultViewKind(nextTaskInput.executionKind),
                    executionObjective: nextTaskInput.description ?? "",
                  }
                : task,
            ),
          })),
        };
      });
    }
    case "delete_task":
      return withGoal(goals, command.goalId, (goal) => {
        findTask(goal, command.taskId);
        const normalizedTaskId = normalizeTaskId(command.taskId);
        return {
          ...goal,
          subGoals: goal.subGoals.map((subGoal) => ({
            ...subGoal,
            tasks: subGoal.tasks.filter((task) => normalizeTaskId(task.id) !== normalizedTaskId),
          })),
        };
      });
    case "delete_goals_by_conversation":
      return goals.filter((goal) => goal.conversationId !== command.conversationId);
  }
}

function eventPayloadForCommand(command: GoalCommand, idempotencyKey: string) {
  switch (command.type) {
    case "create_goal":
      return {
        kind: "goal.structure_changed" as const,
        payload: {
          action: "goal.created" as const,
          entityId: normalizeGoalId(command.goal.id),
          entityHash: hashValue(command.goal),
          title: command.goal.title,
        },
      };
    case "confirm_goal_plan":
      return {
        kind: "goal.workflow_changed" as const,
        payload: {
          nextPhase: "executing" as const,
          reason: "用户确认目标规划",
        },
      };
    case "request_goal_plan_revision":
      return {
        kind: "goal.workflow_changed" as const,
        payload: {
          nextPhase: "decomposing" as const,
          reason: "用户请求调整目标规划",
        },
      };
    case "create_sub_goal":
      return {
        kind: "goal.structure_changed" as const,
        payload: {
          action: "sub_goal.created" as const,
          entityId: deriveOpaqueId("sg", idempotencyKey),
          title: command.title,
        },
      };
    case "create_task":
      return {
        kind: "goal.structure_changed" as const,
        taskId: deriveOpaqueId("task", idempotencyKey),
        payload: {
          action: "task.created" as const,
          entityId: deriveOpaqueId("task", idempotencyKey),
          parentId: command.subGoalId,
          title: command.task.title,
        },
      };
    case "update_task":
      return {
        kind: "goal.structure_changed" as const,
        taskId: command.taskId,
        payload: {
          action: "task.updated" as const,
          entityId: command.taskId,
          title: command.task.title,
        },
      };
    case "delete_task":
      return {
        kind: "goal.structure_changed" as const,
        taskId: command.taskId,
        payload: {
          action: "task.deleted" as const,
          entityId: command.taskId,
        },
      };
    case "delete_goals_by_conversation":
      return {
        kind: "goal.structure_changed" as const,
        payload: {
          action: "goal.conversation_unlinked" as const,
          entityId: command.conversationId,
        },
      };
  }
}

function goalIdForCommand(command: GoalCommand, goals: Goal[]) {
  if (command.type === "create_goal") return command.goal.id;
  if ("goalId" in command) return command.goalId;
  const affected = goals.find((goal) => goal.conversationId === command.conversationId);
  return affected?.id ?? deriveOpaqueId("goal", `conversation:${command.conversationId}`);
}

function isSameIdempotentEvent(
  event: GoalEventRecord,
  expected: {
    goalId: string;
    taskId?: string;
    kind: GoalEventRecord["kind"];
    payload: GoalEventRecord["payload"];
  },
) {
  return (
    event.goalId === normalizeGoalId(expected.goalId) &&
    event.taskId === (expected.taskId ? normalizeTaskId(expected.taskId) : undefined) &&
    event.kind === expected.kind &&
    JSON.stringify(event.payload) === JSON.stringify(expected.payload)
  );
}

export function applyGoalCommand(input: ApplyGoalCommandInput): ApplyGoalCommandResult {
  if (!input.idempotencyKey) {
    throw new GoalCommandValidationError(400, "缺少 Idempotency-Key");
  }
  const db = getDatabase();
  return db.transaction(() => {
    const snapshot = readGoalsSnapshotMeta([]);
    const eventDescriptor = eventPayloadForCommand(input.command, input.idempotencyKey);
    const goalId = goalIdForCommand(input.command, snapshot.value);
    const taskId = "taskId" in eventDescriptor ? eventDescriptor.taskId : undefined;
    const existingEvent = getGoalEventByIdempotencyKey(input.idempotencyKey);
    if (existingEvent) {
      if (
        !isSameIdempotentEvent(existingEvent, {
          goalId,
          taskId,
          kind: eventDescriptor.kind,
          payload: eventDescriptor.payload,
        })
      ) {
        throw new GoalCommandIdempotencyConflictError();
      }
      return {
        event: existingEvent,
        goals: snapshot.value,
        revision: snapshot.revision,
      };
    }
    if (typeof input.baseRevision === "number" && input.baseRevision !== snapshot.revision) {
      throw new GoalCommandConflictError(snapshot.revision, input.baseRevision);
    }
    const nextGoals = applyCommandToGoals(snapshot.value, input.command, input.idempotencyKey);
    const event = appendGoalEventOnce({
      goalId,
      taskId,
      kind: eventDescriptor.kind,
      payload: eventDescriptor.payload,
      producedBy: "api",
      idempotencyKey: input.idempotencyKey,
    });
    if (!event) {
      throw new GoalCommandValidationError(500, "命令事件写入失败");
    }
    const result = writeGoalsProjection(nextGoals, snapshot.revision);
    if (!result.ok) {
      throw new GoalCommandConflictError(result.revision, snapshot.revision);
    }
    return {
      event,
      goals: nextGoals,
      revision: result.revision,
    };
  })();
}
