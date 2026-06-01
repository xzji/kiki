/**
 * dispatchTaskFromThread — Thread tick 派发 one_shot Task 的薄包装（PR14.5）。
 *
 * 计划 ref：§12.3.1.5 + §3.3.4 第 5 条。
 *
 * 设计：
 *  - ThreadRunner.tick 输出的 `dispatch_task` action 已通过 `parseThreadTickOutput`
 *    校验 threadId/taskDraft；本服务的职责仅是把 `TaskDraft` + `threadId` 翻译为
 *    底层 `applyTopicCommand({ type: "create_task" })`，并强制 `taskType="one_shot"`
 *    硬约束（不允许 ThreadRunner 派发循环任务）。
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
import type { DispatchTaskRequest } from "@/lib/server/thread/dispatchActions";
import type { TaskDraft } from "@/lib/server/goalPlanning/taskDraftSchema";
import { normalizeExecutionKind } from "@/types/kiki";

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
function buildTaskCommandInput(draft: TaskDraft) {
  const acceptance = draft.acceptanceCriteria?.length
    ? `\n验收标准：\n${draft.acceptanceCriteria.map((line) => `- ${line}`).join("\n")}`
    : "";
  const description = `${draft.objective ?? ""}${acceptance}`.trim();
  return {
    title: draft.title,
    description,
    expectedOutcome: draft.deliverable,
    taskType: "one_shot" as const,
    triggerRule: draft.triggerCondition?.trim() || "立即触发",
    executionKind: normalizeExecutionKind(undefined),
  };
}

/**
 * 派发一条 Thread 派生的 one_shot Task。
 *
 * 强约束：
 *  - request.threadId 必填（否则抛错，避免没有归属的 task 进入 envelope）
 *  - request.taskType 必须为 "one_shot"（dispatchActions 已强制；这里再断言）
 *
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
  if (request.taskType !== "one_shot") {
    throw new Error(
      `dispatchTaskFromThread: taskType must be "one_shot" (got ${request.taskType})`,
    );
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
