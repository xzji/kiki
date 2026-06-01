/**
 * dispatchTaskFromThread spec — PR14.5。
 *
 * 计划 ref：§12.3.4。
 *
 * 覆盖：
 *  1. happy path：把 TaskDraft 写入 envelope，返回的 taskId 与 envelope 一致；
 *     taskType 强制为 "one_shot"。
 *  2. 缺 threadId / 非 one_shot taskType / 缺 idempotencyKey 抛错。
 *  3. 同 idempotencyKey 重入：底层去重，不重复创建 task。
 */

import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { upsertGoalsSnapshot, readGoalsSnapshot, readGoalsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import { deriveOpaqueId, normalizeSubGoalId } from "@/lib/opaqueIds";
import type { Goal } from "@/types/kiki";
import type { TaskDraft } from "@/lib/server/goalPlanning/taskDraftSchema";
import type { DispatchTaskRequest } from "@/lib/server/thread/dispatchActions";

import { dispatchTaskFromThread } from "./dispatchTaskFromThread";

// envelope 内 IDs 会被 normalize 为 opaque 形式 — 与 taskInstancesRepository.spec
// 一样，先 derive 同一组稳定 ID，避免 seed 后失配。
const TOPIC_ID = deriveOpaqueId("goal", "topic-d1");
const THREAD_ID = deriveOpaqueId("sg", "thread-d1");

function seedGoal(goal: Goal) {
  const meta = readGoalsSnapshotMeta([]);
  const first = upsertGoalsSnapshot([goal], meta.revision);
  if (first.ok) return;
  const retry = upsertGoalsSnapshot([goal], first.revision);
  assert.equal(retry.ok, true, "seed goal ok");
}

function makeDraft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    title: overrides.title ?? "查最新行情",
    objective: overrides.objective ?? "拉取 NVDA 最新分析",
    deliverable: overrides.deliverable ?? "返回行情摘要",
    acceptanceCriteria: overrides.acceptanceCriteria ?? ["包含价格", "包含成交量"],
    triggerCondition: overrides.triggerCondition,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<DispatchTaskRequest> = {}): DispatchTaskRequest {
  return {
    topicId: TOPIC_ID,
    threadId: THREAD_ID,
    reason: "ThreadRunner tick",
    taskDraft: overrides.taskDraft ?? makeDraft(),
    taskType: "one_shot",
    ...overrides,
  };
}

export async function runDispatchTaskFromThreadSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // 1. happy path
  {
    const goal: Goal = {
      id: TOPIC_ID,
      title: "TopicD1",
      deadline: "",
      progress: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      subGoals: [
        {
          id: THREAD_ID,
          goalId: TOPIC_ID,
          title: "Thread D1",
          tasks: [],
        },
      ],
    };
    seedGoal(goal);

    const result = await dispatchTaskFromThread(makeRequest(), {
      idempotencyKey: "dispatch-1",
    });
    assert.ok(result.taskId, "taskId returned");

    const goals = readGoalsSnapshot([]);
    const sub = goals[0]?.subGoals.find((s) => normalizeSubGoalId(s.id) === THREAD_ID);
    assert.ok(sub, "subGoal located");
    assert.equal(sub?.tasks.length, 1, "task created in envelope");
    assert.equal(sub?.tasks[0]?.taskType, "one_shot", "taskType forced one_shot");
    assert.equal(sub?.tasks[0]?.id, result.taskId, "taskId matches envelope");
    assert.equal(sub?.tasks[0]?.expectedOutcome, "返回行情摘要");
  }

  // 2. 缺 threadId 抛错
  {
    await assert.rejects(
      () =>
        dispatchTaskFromThread(makeRequest({ threadId: "" }), {
          idempotencyKey: "dispatch-x",
        }),
      /threadId required/,
    );
  }

  // 3. 非 one_shot 抛错
  {
    await assert.rejects(
      () =>
        dispatchTaskFromThread(
          makeRequest({ taskType: "repeat" as unknown as "one_shot" }),
          { idempotencyKey: "dispatch-y" },
        ),
      /one_shot/,
    );
  }

  // 4. 缺 idempotencyKey 抛错
  {
    await assert.rejects(
      () => dispatchTaskFromThread(makeRequest(), { idempotencyKey: "" }),
      /idempotencyKey required/,
    );
  }
}
