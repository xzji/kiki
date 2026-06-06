import type { Task } from "@/types/kiki";

/**
 * 任务在展示层的统一状态。历史上 TaskRow / TopicPlanContent 各自维护了语义重叠但
 * paused/error 处理不一致的推导函数，曾导致「失败任务误显示为待开始」。此处收敛为单一真值源，
 * 所有展示层共用，避免再次分叉。
 */
export type TaskDisplayState =
  | "in_progress"
  | "paused"
  | "awaiting_user"
  | "pending"
  | "error"
  | "completed";

export function deriveTaskDisplayState(task: Task): TaskDisplayState {
  const latest = task.instances[0];
  const latestStatus = latest?.status;
  if (latestStatus === "awaiting_user" || latest?.awaitingUser) return "awaiting_user";
  if (latestStatus === "completed" || task.progress >= 100) return "completed";
  if (latestStatus === "error") return "error";
  if (latestStatus === "paused") return "paused";
  if (latestStatus === "in_progress") return "in_progress";
  if (latestStatus === "pending") return task.progress > 0 ? "in_progress" : "pending";
  return task.progress > 0 ? "in_progress" : "pending";
}

export function stripTaskPrefix(value: string) {
  return value.replace(/^任务\d+：/, "");
}
