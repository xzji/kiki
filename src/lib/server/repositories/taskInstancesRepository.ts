/**
 * taskInstancesRepository — TaskInstance 只读仓库（PR14.2）。
 *
 * 计划 ref：§12.3.1.2。
 *
 * 存储现状（重要修订）：
 *  - 计划 v1 §12.3.1.2 描述 "走现有 task_instances 表 WHERE thread_id=?"，但
 *    schema 中并不存在 task_instances 表。TaskInstance 仍内嵌在 legacy Goal
 *    envelope（runtime_state_snapshots["goals"]）的
 *    `goal.subGoals[].tasks[].instances[]` 路径中。
 *  - threadId ↔ subGoalId 由 legacySubGoalToThread 保持一致（同 id），因此
 *    `task.subGoalId === threadId` 即可定位 thread 下的所有 task；汇总每个 task
 *    的 instances 后按 createdAt 倒序截断。
 *  - 当 subGoalId 字段缺失（迁移过渡态）时回退到 `subGoal.id` 索引位置匹配，
 *    确保 daemon 拉取最近 instances 不被双写期间隙打断。
 *
 * 该仓库当前是只读视图；写入 / 派发由 dispatchTaskFromThread + task command
 * service 走原 Goal 路径，envelope 双写策略覆盖。
 */

import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";

export type ListRecentByThreadIdOptions = {
  /** 默认 12（与 ThreadRunner prompt 限制对齐）。 */
  limit?: number;
  /** 默认 7 天。createdAt 早于 now-sinceDays 的 instance 会被过滤。 */
  sinceDays?: number;
  /** 注入时钟，便于 spec；默认 new Date()。 */
  now?: () => Date;
};

const DEFAULT_LIMIT = 12;
const DEFAULT_SINCE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 检索 thread 下最近的 TaskInstance；返回按 createdAt **倒序** 排列、最多
 * `limit` 条且 createdAt ≥ now - sinceDays 的实例。
 *
 * 流程：
 *  1. 读取 "goals" envelope 全量；
 *  2. 遍历每个 goal.subGoals[]，找到 sub.id === threadId 的 SubGoal；
 *  3. 收集该 SubGoal 下所有 task.instances（保持 task.subGoalId 与 sub.id 一致）；
 *  4. 时间窗过滤 + 排序 + 截断。
 */
export function listRecentByThreadId(
  threadId: string,
  options: ListRecentByThreadIdOptions = {},
): TaskInstance[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const sinceDays = options.sinceDays ?? DEFAULT_SINCE_DAYS;
  if (limit <= 0) return [];

  const nowFn = options.now ?? (() => new Date());
  const cutoffMs = nowFn().getTime() - sinceDays * MS_PER_DAY;

  const goals = readGoalsSnapshot([]);
  const collected: TaskInstance[] = [];

  for (const goal of goals as Goal[]) {
    if (!Array.isArray(goal.subGoals)) continue;
    const subGoal = goal.subGoals.find((sub: SubGoal) => sub.id === threadId);
    if (!subGoal || !Array.isArray(subGoal.tasks)) continue;

    for (const task of subGoal.tasks as Task[]) {
      // 双写期 subGoalId 字段可能滞后；以 SubGoal 嵌套位置为权威。
      if (task.subGoalId && task.subGoalId !== threadId) continue;
      if (!Array.isArray(task.instances)) continue;
      for (const instance of task.instances) {
        collected.push(instance);
      }
    }
  }

  // 时间窗过滤 — createdAt 解析失败的实例视为过期，跳过。
  const fresh = collected.filter((instance) => {
    const ts = Date.parse(instance.createdAt);
    if (Number.isNaN(ts)) return false;
    return ts >= cutoffMs;
  });

  fresh.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return fresh.slice(0, limit);
}
