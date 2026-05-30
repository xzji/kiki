import type { GoalEventRecord } from "@/types/goalEventLog";

export type GoalEventsResponse = {
  events: GoalEventRecord[];
  nextCursor: number;
};

export async function fetchGoalEvents(input: { goalId: string; fromId?: number; limit?: number }) {
  const params = new URLSearchParams({
    goalId: input.goalId,
    fromId: String(input.fromId ?? 0),
    limit: String(input.limit ?? 200),
  });
  const response = await fetch(`/api/goals/events?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("目标事件流获取失败");
  }
  return (await response.json()) as GoalEventsResponse;
}

/**
 * @deprecated 已被 `createRuntimeEventsSource` (`/api/runtime/events/stream`) 取代。
 * 仅作为回退/外部消费者通道；禁止在新代码中使用。
 */
export function createGoalEventsSource(input: { goalId: string; fromId?: number }) {
  const params = new URLSearchParams({
    goalId: input.goalId,
    fromId: String(input.fromId ?? 0),
  });
  return new EventSource(`/api/goals/events/stream?${params.toString()}`);
}

