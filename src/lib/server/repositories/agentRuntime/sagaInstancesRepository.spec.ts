/**
 * sagaInstancesRepository spec — PR15 §12.5.2 数据源验证。
 *
 * 覆盖：
 *  1. listSagaInstances 按 status / type / topicId 过滤；
 *  2. listSagaInstances 默认按 started_at 降序；
 *  3. 分页 limit / offset；
 *  4. countSagaInstances 与 list 在同 filter 下一致；
 *  5. formatRoleDisplay 三 scope 分组。
 */

import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  countSagaInstances,
  createSagaInstance,
  listSagaInstances,
  updateSagaInstance,
} from "./sagaInstancesRepository";
import {
  createAgentRun,
  listAgentRunsBySaga,
  listLatestAgentRunsByThread,
} from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { formatRoleDisplay } from "@/lib/devPanel/formatRoleDisplay";

export async function runDevPanelDataSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // ---------- 准备 5 条样本：3 topic_init + 2 thread_loop，含不同 status/topicId ----------
  const t0 = "2026-06-01T00:00:00.000Z";
  const t1 = "2026-06-01T01:00:00.000Z";
  const t2 = "2026-06-01T02:00:00.000Z";
  const t3 = "2026-06-01T03:00:00.000Z";
  const t4 = "2026-06-01T04:00:00.000Z";

  const s1 = createSagaInstance({
    id: "saga-spec-1",
    topicId: "topic-A",
    type: "topic_init",
    status: "running",
    startedAt: t0,
  });
  const s2 = createSagaInstance({
    id: "saga-spec-2",
    topicId: "topic-A",
    type: "topic_init",
    status: "completed",
    startedAt: t1,
  });
  const s3 = createSagaInstance({
    id: "saga-spec-3",
    topicId: "topic-B",
    type: "topic_init",
    status: "awaiting_user",
    startedAt: t2,
  });
  const s4 = createSagaInstance({
    id: "saga-spec-4",
    topicId: "topic-A",
    type: "thread_loop",
    status: "completed",
    startedAt: t3,
  });
  const s5 = createSagaInstance({
    id: "saga-spec-5",
    topicId: "topic-B",
    type: "thread_loop",
    status: "failed",
    startedAt: t4,
  });
  // status 默认 pending，需要更新为目标值
  updateSagaInstance({ id: s1.id, status: "running" });
  updateSagaInstance({ id: s2.id, status: "completed" });
  updateSagaInstance({ id: s3.id, status: "awaiting_user" });
  updateSagaInstance({ id: s4.id, status: "completed" });
  updateSagaInstance({ id: s5.id, status: "failed" });

  // ---------- 默认按 started_at 降序 ----------
  const allRecent = listSagaInstances({
    sinceIso: "2026-06-01T00:00:00.000Z",
    limit: 100,
  });
  // 仅校验 spec 自己插入的 5 行的相对顺序（其他测试可能也有数据）
  const ids = allRecent.map((s) => s.id).filter((id) => id.startsWith("saga-spec-"));
  assert.deepEqual(
    ids,
    ["saga-spec-5", "saga-spec-4", "saga-spec-3", "saga-spec-2", "saga-spec-1"],
    "默认按 started_at 降序",
  );

  // ---------- status 过滤 ----------
  const completedOnly = listSagaInstances({
    statuses: ["completed"],
    sinceIso: "2026-06-01T00:00:00.000Z",
    limit: 100,
  })
    .map((s) => s.id)
    .filter((id) => id.startsWith("saga-spec-"));
  assert.deepEqual(completedOnly.sort(), ["saga-spec-2", "saga-spec-4"]);

  // ---------- type 过滤 ----------
  const threadLoopOnly = listSagaInstances({
    types: ["thread_loop"],
    sinceIso: "2026-06-01T00:00:00.000Z",
    limit: 100,
  })
    .map((s) => s.id)
    .filter((id) => id.startsWith("saga-spec-"));
  assert.deepEqual(threadLoopOnly.sort(), ["saga-spec-4", "saga-spec-5"]);

  // ---------- topicId 过滤 ----------
  const topicAOnly = listSagaInstances({
    topicId: "topic-A",
    sinceIso: "2026-06-01T00:00:00.000Z",
    limit: 100,
  })
    .map((s) => s.id)
    .filter((id) => id.startsWith("saga-spec-"));
  assert.deepEqual(topicAOnly.sort(), ["saga-spec-1", "saga-spec-2", "saga-spec-4"]);

  // ---------- 分页 limit / offset ----------
  const page1 = listSagaInstances({
    sinceIso: "2026-06-01T00:00:00.000Z",
    limit: 2,
    offset: 0,
  });
  const page2 = listSagaInstances({
    sinceIso: "2026-06-01T00:00:00.000Z",
    limit: 2,
    offset: 2,
  });
  assert.equal(page1.length, 2);
  assert.equal(page2.length >= 2, true);
  // 不重复
  const overlap = page1.filter((p1) => page2.some((p2) => p2.id === p1.id));
  assert.equal(overlap.length, 0, "分页结果不应重叠");

  // ---------- count 与 list 一致 ----------
  const cAll = countSagaInstances({
    sinceIso: "2026-06-01T00:00:00.000Z",
  });
  const lAll = listSagaInstances({
    sinceIso: "2026-06-01T00:00:00.000Z",
    limit: 200,
  }).length;
  assert.equal(cAll, lAll, "count 与 list 在同 filter 下一致");

  const cThreadLoop = countSagaInstances({
    types: ["thread_loop"],
    sinceIso: "2026-06-01T00:00:00.000Z",
  });
  assert.equal(cThreadLoop >= 2, true);

  // ---------- formatRoleDisplay 三 scope 分组 ----------
  assert.deepEqual(formatRoleDisplay("interviewer"), {
    scope: "topic_saga",
    label: "interviewer",
  });
  assert.deepEqual(formatRoleDisplay("planner"), {
    scope: "topic_saga",
    label: "planner",
  });
  assert.deepEqual(formatRoleDisplay("critic"), {
    scope: "topic_saga",
    label: "critic",
  });
  assert.deepEqual(formatRoleDisplay("refiner"), {
    scope: "topic_saga",
    label: "refiner",
  });
  assert.deepEqual(formatRoleDisplay("presenter"), {
    scope: "topic_saga",
    label: "presenter",
  });
  assert.deepEqual(formatRoleDisplay("thread_runner"), {
    scope: "thread",
    label: "thread_runner",
  });
  assert.deepEqual(formatRoleDisplay("task_orchestrator"), {
    scope: "task_orchestration",
    label: "task_orchestrator",
  });
  assert.deepEqual(formatRoleDisplay("custom_unknown_role"), {
    scope: "task_orchestration",
    label: "custom_unknown_role",
  });

  // ---------- DevPanel timeline：完整 TopicInitSaga 5 段 + Thread tick 分组 ----------
  const timelineSaga = createSagaInstance({
    id: "saga-spec-timeline",
    topicId: "topic-timeline",
    type: "topic_init",
    status: "completed",
    startedAt: "2026-06-01T10:00:00.000Z",
  });
  const topicSagaRoles = ["interviewer", "planner", "critic", "refiner", "presenter"] as const;
  topicSagaRoles.forEach((role, index) => {
    createAgentRun({
      id: `run-spec-timeline-${role}`,
      topicId: timelineSaga.topicId,
      sagaInstanceId: timelineSaga.id,
      role,
      status: "completed",
      startedAt: `2026-06-01T10:0${index}:00.000Z`,
    });
  });
  const sagaRuns = listAgentRunsBySaga(timelineSaga.id);
  assert.deepEqual(
    sagaRuns.map((run) => run.role),
    ["interviewer", "planner", "critic", "refiner", "presenter"],
    "DevPanel saga runs timeline should preserve 5-role order",
  );
  assert.deepEqual(
    sagaRuns.map((run) => formatRoleDisplay(run.role).scope),
    ["topic_saga", "topic_saga", "topic_saga", "topic_saga", "topic_saga"],
  );

  createAgentRun({
    id: "run-spec-thread-runner",
    topicId: timelineSaga.topicId,
    threadId: "thread-timeline",
    role: "thread_runner",
    status: "completed",
    startedAt: "2026-06-01T11:00:00.000Z",
  });
  const threadRuns = listLatestAgentRunsByThread("thread-timeline", 5);
  assert.equal(threadRuns[0]?.role, "thread_runner");
  assert.equal(formatRoleDisplay(threadRuns[0]!.role).scope, "thread");
}
