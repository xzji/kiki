import assert from "node:assert/strict";

import { buildRuntimeEventsQuery } from "@/lib/api/runtime-events";
import { appendGoalEvent, getGoalEventsSince } from "@/lib/server/repositories/goalEventLogRepository";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";

export function runRuntimeEventsAggregationSpecs() {
  // 客户端拼参：合法值正常落到 query
  const queryHappy = buildRuntimeEventsQuery({ goalCursor: 12, conversationCursor: 7 });
  assert.equal(queryHappy, "goalCursor=12&conversationCursor=7");

  // 客户端拼参：负值/NaN 防御性置 0
  const queryDefense = buildRuntimeEventsQuery({
    goalCursor: -3 as unknown as number,
    conversationCursor: Number.NaN as unknown as number,
  });
  assert.equal(queryDefense, "goalCursor=0&conversationCursor=0");

  // 服务端 repo：聚合查询 + 单 SQL since
  ensureIsolatedPlanningSpecDataDir();
  const goalA = "goal-spec-aggregate-a";
  const goalB = "goal-spec-aggregate-b";
  const before = getGoalEventsSince({ fromId: 0, limit: 500 });
  const baseline = before[before.length - 1]?.id ?? 0;

  const e1 = appendGoalEvent({
    goalId: goalA,
    kind: "instance.status_changed",
    payload: { previousStatus: "pending", nextStatus: "in_progress" },
    producedBy: "worker",
  });
  const e2 = appendGoalEvent({
    goalId: goalB,
    kind: "instance.status_changed",
    payload: { previousStatus: "pending", nextStatus: "in_progress" },
    producedBy: "worker",
  });
  assert.ok(e1 && e2, "appendGoalEvent 必须返回记录");

  const fetched = getGoalEventsSince({ fromId: baseline, limit: 500 });
  const ids = fetched.map((event) => event.id).filter((id) => id === e1!.id || id === e2!.id);
  assert.deepEqual(ids, [e1!.id, e2!.id], "聚合查询应同时返回多个 goal 的事件，按 id 升序");

  // limit 应受参数边界控制（最小 1，最大 500）
  const limited = getGoalEventsSince({ fromId: baseline, limit: 1 });
  assert.ok(limited.length <= 1, "limit 应被尊重");
}
