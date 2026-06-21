/**
 * dispatchTaskFromThread — Thread tick 治理 Task 集合的薄包装（PR14.5）。
 *
 * 计划 ref：§12.3.1.5 + §3.3.4 第 5 条。
 *
 * 设计：
 *  - ThreadRunner.tick 输出的 `dispatch_task` action 已通过 `parseThreadTickOutput`
 *    校验 threadId/taskDraft；本服务的职责仅是把 `TaskDraft` + `threadId` 翻译为
 *    底层 `applyGoalCommand({ type: "create_task" })`。Task 的执行频率由 draft
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
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import { mergeTaskPatch } from "@/lib/server/governance/taskPatchMerge";
import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { applyGoalCommand } from "@/lib/server/services/goalCommandService";
import { runSpecWriter } from "@/lib/server/taskExecution/runSpecWriter";
import { computeTaskSpecSourceRevision } from "@/lib/server/taskExecution/taskSpecRevision";
import type { TaskDraft } from "@/lib/server/goalPlanning/taskDraftSchema";
import type {
  ThreadTickPostMessageSeverity,
} from "@/types/topic";
import { normalizeConcreteTriggerRule } from "@/lib/taskTriggerTime";
import { normalizeExecutionKind, type Task, type TaskSpec } from "@/types/kiki";

// ---------------------------------------------------------------------------
// Thread → Task 调度契约（治理层产出 / 本 service 消费）
//
// 这些类型是治理层 → 调度层造/改/删 task 的**唯一公共契约**：
//  - 治理层（governance/*）产出 request；
//  - 本 service（services/dispatchTaskFromThread）落库；
//  - 治理层不允许绕开本 service 直接写 envelope。
//
// 把契约定义放在调度层（service 所在目录）保证依赖方向单向：governance → services。
// ---------------------------------------------------------------------------

export type DispatchTaskRequest = {
  topicId: string;
  threadId: string;
  reason: string;
  taskDraft: TaskDraft;
  /** @deprecated Task 频率由 taskDraft 推断；保留为旧调用点兼容。 */
  taskType?: Task["taskType"];
};

export type UpdateTaskRequest = {
  topicId: string;
  threadId: string;
  taskId: string;
  reason: string;
  patch: Partial<TaskDraft>;
  currentTask: Task;
};

export type CancelTaskRequest = {
  topicId: string;
  threadId: string;
  taskId: string;
  reason: string;
};

export type SendThreadMessageRequest = {
  topicId: string;
  threadId: string;
  text: string;
  severity: ThreadTickPostMessageSeverity;
};

/** 治理层产出、调度层消费的「task 治理意图」联合类型。 */
export type ThreadTaskIntent =
  | { kind: "dispatch"; request: DispatchTaskRequest }
  | { kind: "update"; request: UpdateTaskRequest }
  | { kind: "cancel"; request: CancelTaskRequest };

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
 *  - taskType       ← draft.taskType / cadence / triggerCondition 推断
 *  - triggerRule    ← draft.triggerRule / cadence / triggerCondition / "立即触发"
 *  - executionKind  = "general"（默认；后续 PR15 可替换）
 */
function descriptionFromDraft(draft: Partial<TaskDraft>, fallback = "") {
  const acceptance = draft.acceptanceCriteria?.length
    ? `\n验收标准：\n${draft.acceptanceCriteria.map((line) => `- ${line}`).join("\n")}`
    : "";
  return `${draft.objective ?? fallback}${acceptance}`.trim();
}

function inferTaskTiming(draft: Partial<TaskDraft>, fallback?: Pick<Task, "taskType" | "triggerRule">) {
  const explicitTaskType = draft.taskType;
  const explicitTriggerRule = draft.triggerRule?.trim();
  const cadence = draft.cadence?.trim();
  const triggerCondition = draft.triggerCondition?.trim();
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

function buildTaskCommandInput(draft: TaskDraft, taskSpec?: TaskSpec) {
  const description = descriptionFromDraft(draft, draft.title);
  const timing = inferTaskTiming(draft);
  return {
    title: draft.title || "未命名任务",
    description,
    expectedOutcome: draft.deliverable || description || draft.title,
    taskType: timing.taskType,
    triggerRule: timing.triggerRule,
    trigger: draft.triggerSpec,
    executionKind: normalizeExecutionKind(undefined),
    taskSpec,
  };
}

function findTopicTitle(topicId: string) {
  const normalizedTopicId = normalizeGoalId(topicId);
  // allow-raw-goals-snapshot: 仅读取 goal.title 结构字段，不读取 instance 执行态。
  return readGoalsSnapshot([]).find((goal) => normalizeGoalId(goal.id) === normalizedTopicId)?.title;
}

async function buildTaskSpecForDraft(input: {
  request: DispatchTaskRequest;
  invoke?: LlmInvoke;
}): Promise<TaskSpec | undefined> {
  if (!input.invoke) return undefined;
  try {
    const draft = input.request.taskDraft;
    const description = descriptionFromDraft(draft, draft.title);
    const timing = inferTaskTiming(draft);
    const result = await runSpecWriter({
      tasks: [{
        taskId: "0",
        title: draft.title || "未命名任务",
        description,
        expectedOutcome: draft.deliverable || description || draft.title,
        taskType: timing.taskType,
        triggerRule: timing.triggerRule,
      }],
      goalContext: { goalTitle: findTopicTitle(input.request.topicId) ?? draft.title ?? input.request.topicId },
      attribution: { topicId: input.request.topicId, threadId: input.request.threadId },
      invoke: input.invoke,
    });
    const content = result.specs[0]?.content;
    if (!content) return undefined;
    return {
      content,
      generatedAt: new Date().toISOString(),
      sourceRevision: computeTaskSpecSourceRevision({
        title: draft.title || "未命名任务",
        description,
        expectedOutcome: draft.deliverable || description || draft.title,
        taskType: timing.taskType,
        triggerRule: timing.triggerRule,
      }),
    };
  } catch {
    return undefined;
  }
}

/**
 * 派发一条 Thread 派生 Task。
 *
 * 强约束：
 *  - request.threadId 必填（否则抛错，避免没有归属的 task 进入 envelope）
 * 幂等：调用方必须传入稳定 idempotencyKey；同 key 重入不会重复创建 task（由
 * 底层 applyGoalCommand 的事件去重保证）。
 *
 * 当前不返回 instanceId — task 创建后 instances=[]，由 scheduler/runner
 * 后续生成实例。后续 PR 如果需要立即创建首个 instance，再扩展返回。
 */
export async function dispatchTaskFromThread(
  request: DispatchTaskRequest,
  options: { idempotencyKey: string; invoke?: LlmInvoke },
): Promise<DispatchTaskFromThreadResult> {
  if (!request.threadId) {
    throw new Error("dispatchTaskFromThread: threadId required");
  }
  if (!options.idempotencyKey) {
    throw new Error("dispatchTaskFromThread: idempotencyKey required");
  }

  const taskSpec = await buildTaskSpecForDraft({ request, invoke: options.invoke });

  const result = applyGoalCommand({
    command: {
      type: "create_task",
      goalId: request.topicId,
      subGoalId: request.threadId,
      task: buildTaskCommandInput(request.taskDraft, taskSpec),
    },
    idempotencyKey: options.idempotencyKey,
  });

  // taskId 由底层 createTask 通过 `deriveOpaqueId("task", idempotencyKey)` 稳定派生，
  // 直接复算即可（不依赖 envelope 顺序，避免并发或重入歧义）。
  const taskId = deriveOpaqueId("task", options.idempotencyKey);

  // 校验 envelope 中确实存在该 task（保证 applyGoalCommand 已成功投影）；
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

function locateTask(topicId: string, taskId: string, goals: ReturnType<typeof applyGoalCommand>["goals"]) {
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
  const current = applyGoalCommand({
    command: {
      type: "update_task",
      goalId: request.topicId,
      taskId: request.taskId,
      task: mergeTaskPatch(request.currentTask, request.patch),
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
  applyGoalCommand({
    command: {
      type: "delete_task",
      goalId: request.topicId,
      taskId: request.taskId,
    },
    idempotencyKey: options.idempotencyKey,
  });
  return { taskId: request.taskId };
}
