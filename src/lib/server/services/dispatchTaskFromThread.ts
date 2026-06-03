/**
 * dispatchTaskFromThread — Thread tick 治理 Task 集合的薄包装（PR14.5）。
 *
 * 计划 ref：§12.3.1.5 + §3.3.4 第 5 条。
 *
 * 设计：
 *  - ThreadRunner.tick 输出的 `dispatch_task` action 已通过 `parseThreadTickOutput`
 *    校验 threadId/taskDraft；本服务的职责仅是把 `TaskDraft` + `threadId` 翻译为
 *    底层 `applyTopicCommand({ type: "create_task" })`。Task 的执行频率由 draft
 *    自带 cadence / triggerCondition 推断，不再由 Thread tick 强制 one_shot。
 *  - 不引入新事件 kind，直接复用 goalCommandService 投影路径，确保 task 落入
 *    `runtime_state_snapshots["goals"]` envelope，taskInstancesRepository
 *    立即可见。
 *  - threadId ↔ subGoalId 双写期等价（`legacySubGoalToThread`），直接透传。
 *
 * 入参 `DispatchTaskRequest` 由 `dispatchActions.ts` 定义；本服务仅读取需要的
 * 字段（topicId/threadId/taskDraft/reason），其余忽略。
 */

import { deriveOpaqueId, normalizeGoalId, normalizeSubGoalId } from "@/lib/opaqueIds";
import { applyTopicCommand } from "@/lib/server/services/topicCommandService";
import type {
  CancelTaskRequest,
  DispatchTaskRequest,
  UpdateTaskRequest,
} from "@/lib/server/thread/dispatchActions";
import type { TaskDraft } from "@/lib/server/goalPlanning/taskDraftSchema";
import { normalizeConcreteTriggerRule } from "@/lib/taskTriggerTime";
import { normalizeExecutionKind, type Task } from "@/types/kiki";

export type DispatchTaskFromThreadResult = {
  taskId: string;
  instanceId?: string;
};

/**
 * 把 TaskDraft 翻译为 goalCommandService 期望的 TaskCommandInput。
 *
 * 字段映射（§3.3.4 + 计划 §6.3）：
 *  - title          ← TaskDraft.title
 *  - description    ← TaskDraft.objective + acceptanceCriteria（拼接）
 *  - expectedOutcome ← TaskDraft.deliverable（一定有；schema 已校验）
 *  - taskType       = "one_shot"（硬约束）
 *  - triggerRule    ← TaskDraft.triggerCondition || "立即触发"
 *  - executionKind  = "general"（默认；后续 PR15 可替换）
 */
function descriptionFromDraft(draft: Partial<TaskDraft>, fallback = "") {
  const acceptance = draft.acceptanceCriteria?.length
    ? `\n验收标准：\n${draft.acceptanceCriteria.map((line) => `- ${line}`).join("\n")}`
    : "";
  return `${draft.objective ?? fallback}${acceptance}`.trim();
}

function inferTaskTiming(draft: Partial<TaskDraft>, fallback?: Pick<Task, "taskType" | "triggerRule">) {
  const cadence = draft.cadence?.trim();
  const triggerCondition = draft.triggerCondition?.trim();
  if (cadence || triggerCondition) {
    const taskType = "repeat" as const;
    const triggerRule = normalizeConcreteTriggerRule(
      cadence || `满足条件：${triggerCondition}`,
      taskType,
    );
    return { taskType, triggerRule };
  }
  if (fallback) {
    return {
      taskType: fallback.taskType,
      triggerRule: normalizeConcreteTriggerRule(fallback.triggerRule, fallback.taskType),
    };
  }
  return {
    taskType: "one_shot" as const,
    triggerRule: normalizeConcreteTriggerRule("立即触发", "one_shot"),
  };
}

function buildTaskCommandInput(draft: TaskDraft) {
  const description = descriptionFromDraft(draft, draft.title);
  const timing = inferTaskTiming(draft);
  return {
    title: draft.title || "未命名任务",
    description,
    expectedOutcome: draft.deliverable || description || draft.title,
    taskType: timing.taskType,
    triggerRule: timing.triggerRule,
    executionKind: normalizeExecutionKind(undefined),
  };
}

function buildMergedTaskCommandInput(task: Task, patch: Partial<TaskDraft>) {
  const description = descriptionFromDraft(patch, task.description);
  const timing = inferTaskTiming(patch, task);
  return {
    title: patch.title?.trim() || task.title,
    description,
    expectedOutcome: patch.deliverable?.trim() || task.expectedOutcome,
    taskType: timing.taskType,
    triggerRule: timing.triggerRule,
    deadline: task.deadline,
    executionKind: normalizeExecutionKind(task.executionKind),
  };
}

/**
 * 派发一条 Thread 派生 Task。
 *
 * 强约束：
 *  - request.threadId 必填（否则抛错，避免没有归属的 task 进入 envelope）
 * 幂等：调用方必须传入稳定 idempotencyKey；同 key 重入不会重复创建 task（由
 * 底层 applyTopicCommand 的事件去重保证）。
 *
 * 当前不返回 instanceId — task 创建后 instances=[]，由 scheduler/runner
 * 后续生成实例。后续 PR 如果需要立即创建首个 instance，再扩展返回。
 */
export async function dispatchTaskFromThread(
  request: DispatchTaskRequest,
  options: { idempotencyKey: string },
): Promise<DispatchTaskFromThreadResult> {
  if (!request.threadId) {
    throw new Error("dispatchTaskFromThread: threadId required");
  }
  if (!options.idempotencyKey) {
    throw new Error("dispatchTaskFromThread: idempotencyKey required");
  }

  const result = applyTopicCommand({
    command: {
      type: "create_task",
      topicId: request.topicId,
      threadId: request.threadId,
      task: buildTaskCommandInput(request.taskDraft),
    },
    idempotencyKey: options.idempotencyKey,
  });

  // taskId 由底层 createTask 通过 `deriveOpaqueId("task", idempotencyKey)` 稳定派生，
  // 直接复算即可（不依赖 envelope 顺序，避免并发或重入歧义）。
  const taskId = deriveOpaqueId("task", options.idempotencyKey);

  // 校验 envelope 中确实存在该 task（保证 applyTopicCommand 已成功投影）；
  // 同时尝试取首个 instance（当前 createTask instances=[]，预留给后续 PR）。
  const normalizedTopicId = normalizeGoalId(request.topicId);
  const normalizedThreadId = normalizeSubGoalId(request.threadId);
  const topicGoal = result.goals.find((g) => normalizeGoalId(g.id) === normalizedTopicId);
  const subGoal = topicGoal?.subGoals.find(
    (sg) => normalizeSubGoalId(sg.id) === normalizedThreadId,
  );
  const task = subGoal?.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(
      `dispatchTaskFromThread: failed to locate created task ${taskId} for thread ${request.threadId}`,
    );
  }
  const instanceId = task.instances[0]?.id;

  return { taskId, instanceId };
}

function locateTask(topicId: string, taskId: string, goals: ReturnType<typeof applyTopicCommand>["goals"]) {
  const normalizedTopicId = normalizeGoalId(topicId);
  const topicGoal = goals.find((g) => normalizeGoalId(g.id) === normalizedTopicId);
  for (const subGoal of topicGoal?.subGoals ?? []) {
    const task = subGoal.tasks.find((candidate) => candidate.id === taskId);
    if (task) return task;
  }
  return null;
}

export async function updateTaskFromThread(
  request: UpdateTaskRequest,
  options: { idempotencyKey: string },
) {
  const current = applyTopicCommand({
    command: {
      type: "update_task",
      topicId: request.topicId,
      taskId: request.taskId,
      task: buildMergedTaskCommandInput(request.currentTask, request.patch),
    },
    idempotencyKey: options.idempotencyKey,
  });
  const task = locateTask(request.topicId, request.taskId, current.goals);
  if (!task) {
    throw new Error(`updateTaskFromThread: failed to locate updated task ${request.taskId}`);
  }
  return { taskId: task.id };
}

export async function cancelTaskFromThread(
  request: CancelTaskRequest,
  options: { idempotencyKey: string },
) {
  applyTopicCommand({
    command: {
      type: "delete_task",
      topicId: request.topicId,
      taskId: request.taskId,
    },
    idempotencyKey: options.idempotencyKey,
  });
  return { taskId: request.taskId };
}
