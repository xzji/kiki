import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { Conversation, ConversationMessage, Goal, Task, TaskExecutionStep, TaskInstance } from "@/types/kiki";

const OPAQUE_MARKER = "opq";

type OpaquePrefix = "goal" | "sg" | "task" | "inst" | "idem";

function fnv1a(input: string, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function stableOpaqueToken(input: string) {
  const primary = fnv1a(input).toString(36);
  const secondary = fnv1a(`salt:${input}`, 0x9e3779b9).toString(36);
  return `${primary}${secondary}`;
}

function opaqueIdPattern(prefix: OpaquePrefix) {
  return new RegExp(`^${prefix}-${OPAQUE_MARKER}-[a-z0-9]+(?:-[a-z0-9]+)*$`);
}

function remapTimelineStep(step: TaskExecutionStep, previousInstanceId: string, nextInstanceId: string) {
  if (!step.id.startsWith(previousInstanceId)) return step;
  return {
    ...step,
    id: `${nextInstanceId}${step.id.slice(previousInstanceId.length)}`,
  };
}

function remapBlocker(
  blocker: ExecutionBlocker | undefined,
  nextTaskId: string,
  nextInstanceId: string,
): ExecutionBlocker | undefined {
  if (!blocker) return blocker;
  return {
    ...blocker,
    taskId: nextTaskId,
    instanceId: nextInstanceId,
  };
}

export function isOpaqueId(value: string | undefined, prefix: OpaquePrefix) {
  return Boolean(value && opaqueIdPattern(prefix).test(value));
}

export function createOpaqueId(prefix: OpaquePrefix) {
  return `${prefix}-${OPAQUE_MARKER}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function deriveOpaqueId(prefix: OpaquePrefix, source: string) {
  if (isOpaqueId(source, prefix)) return source;
  return `${prefix}-${OPAQUE_MARKER}-${stableOpaqueToken(`${prefix}:${source}`)}`;
}

export function normalizeGoalId(value: string) {
  return deriveOpaqueId("goal", value);
}

export function normalizeSubGoalId(value: string) {
  return deriveOpaqueId("sg", value);
}

export function normalizeTaskId(value: string) {
  return deriveOpaqueId("task", value);
}

export function normalizeInstanceId(value: string) {
  return deriveOpaqueId("inst", value);
}

export function createIdempotencyKey(scope: string, ...parts: Array<string | undefined>) {
  const normalizedParts = parts
    .filter((part): part is string => Boolean(part))
    .map((part, index) => deriveOpaqueId("idem", `${scope}:${index}:${part}`));
  return [scope, ...normalizedParts].join(":");
}

export function migrateTaskInstanceIds(instance: TaskInstance, taskId = normalizeTaskId(instance.taskId)): TaskInstance {
  const nextInstanceId = normalizeInstanceId(instance.id);
  return {
    ...instance,
    id: nextInstanceId,
    taskId,
    blocker: remapBlocker(instance.blocker, taskId, nextInstanceId),
    awaitingUser: instance.awaitingUser
      ? {
          ...instance.awaitingUser,
          blocker: remapBlocker(instance.awaitingUser.blocker, taskId, nextInstanceId),
        }
      : instance.awaitingUser,
    timeline: instance.timeline?.map((step) => remapTimelineStep(step, instance.id, nextInstanceId)),
  };
}

export function migrateTaskIds(task: Task): Task {
  const nextTaskId = normalizeTaskId(task.id);
  return {
    ...task,
    id: nextTaskId,
    subGoalId: normalizeSubGoalId(task.subGoalId),
    dependencies: task.dependencies?.map((dependencyId) => normalizeTaskId(dependencyId)),
    instances: task.instances.map((instance) => migrateTaskInstanceIds(instance, nextTaskId)),
  };
}

export function migrateGoalIds(goal: Goal): Goal {
  const nextGoalId = normalizeGoalId(goal.id);
  return {
    ...goal,
    id: nextGoalId,
    subGoals: goal.subGoals.map((subGoal) => ({
      ...subGoal,
      id: normalizeSubGoalId(subGoal.id),
      goalId: nextGoalId,
      dependencies: subGoal.dependencies?.map((dependencyId) => normalizeSubGoalId(dependencyId)),
      tasks: subGoal.tasks.map((task) => migrateTaskIds(task)),
    })),
  };
}

function migrateConversationMessageIds(message: ConversationMessage): ConversationMessage {
  if (message.kind === "goal_plan_card") {
    return {
      ...message,
      goalRef: {
        ...message.goalRef,
        goalId: normalizeGoalId(message.goalRef.goalId),
      },
    };
  }
  if (message.kind === "task_interaction_request") {
    return {
      ...message,
      taskRef: {
        goalId: normalizeGoalId(message.taskRef.goalId),
        subGoalId: normalizeSubGoalId(message.taskRef.subGoalId),
        taskId: normalizeTaskId(message.taskRef.taskId),
        instanceId: normalizeInstanceId(message.taskRef.instanceId),
      },
    };
  }
  if (message.kind !== "task_card") return message;

  const migratedTask = message.taskSnapshot?.task ? migrateTaskIds(message.taskSnapshot.task) : undefined;
  const migratedInstance = message.taskSnapshot?.instance
    ? migrateTaskInstanceIds(
        message.taskSnapshot.instance,
        migratedTask?.id ?? normalizeTaskId(message.taskSnapshot.instance.taskId),
      )
    : undefined;

  return {
    ...message,
    taskRef: {
      goalId: normalizeGoalId(message.taskRef.goalId),
      subGoalId: normalizeSubGoalId(message.taskRef.subGoalId),
      taskId: normalizeTaskId(message.taskRef.taskId),
      instanceId: normalizeInstanceId(message.taskRef.instanceId),
    },
    taskSnapshot:
      migratedTask && migratedInstance
        ? {
            task: migratedTask,
            instance: migratedInstance,
          }
        : message.taskSnapshot,
  };
}

export function migrateConversationIds(conversation: Conversation): Conversation {
  return {
    ...conversation,
    goalId: conversation.goalId ? normalizeGoalId(conversation.goalId) : conversation.goalId,
    messages: conversation.messages.map((message) => migrateConversationMessageIds(message)),
  };
}
