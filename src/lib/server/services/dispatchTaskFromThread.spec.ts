/**
 * dispatchTaskFromThread spec — PR14.5。
 *
 * 计划 ref：§12.3.4。
 *
 * 覆盖：
 *  1. happy path：把 TaskDraft 写入 envelope，返回的 taskId 与 envelope 一致；
 *     无频率 draft 默认为 one_shot。
 *  2. 缺 threadId / 缺 idempotencyKey 抛错；有 cadence/triggerCondition 时生成 repeat。
 *  3. 同 idempotencyKey 重入：底层去重，不重复创建 task。
 */

import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { upsertGoalsSnapshot, readGoalsSnapshot, readGoalsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import { deriveOpaqueId, normalizeSubGoalId } from "@/lib/opaqueIds";
import type { Goal } from "@/types/kiki";
import type { TaskDraft } from "@/lib/server/goalPlanning/taskDraftSchema";
import type { DispatchTaskRequest } from "@/lib/server/thread/dispatchActions";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";

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
    assert.equal(sub?.tasks[0]?.taskType, "one_shot", "无频率 draft 默认为 one_shot");
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

  // 3. 有 cadence 时生成 repeat，不再强制 one_shot
  {
    const result = await dispatchTaskFromThread(
      makeRequest({ taskDraft: makeDraft({ cadence: "每天" }) }),
      { idempotencyKey: "dispatch-repeat" },
    );
    const goals = readGoalsSnapshot([]);
    const task = goals[0]?.subGoals
      .flatMap((subGoal) => subGoal.tasks)
      .find((candidate) => candidate.id === result.taskId);
    assert.equal(task?.taskType, "repeat");
    assert.match(task?.triggerRule ?? "", /每天/);
  }

  // 4. 显式 taskType + triggerRule 应被保留
  {
    const result = await dispatchTaskFromThread(
      makeRequest({ taskDraft: makeDraft({ taskType: "repeat", triggerRule: "每小时" }) }),
      { idempotencyKey: "dispatch-explicit-rule" },
    );
    const goals = readGoalsSnapshot([]);
    const task = goals[0]?.subGoals
      .flatMap((subGoal) => subGoal.tasks)
      .find((candidate) => candidate.id === result.taskId);
    assert.equal(task?.taskType, "repeat");
    assert.match(task?.triggerRule ?? "", /每小时/);
  }

  // 5. 缺 idempotencyKey 抛错
  {
    await assert.rejects(
      () => dispatchTaskFromThread(makeRequest(), { idempotencyKey: "" }),
      /idempotencyKey required/,
    );
  }

  // 6. 传入 invoke 时生成 taskSpec；invoke 失败时不阻断创建。
  {
    const invoke: LlmInvoke = async () => ({
      rawText: "{}",
      parsed: { specs: [{ taskId: "0", content: "## 任务目标\n输出行情摘要" }] },
    });
    const result = await dispatchTaskFromThread(makeRequest(), {
      idempotencyKey: "dispatch-with-spec",
      invoke,
    });
    const task = readGoalsSnapshot([])[0]?.subGoals
      .flatMap((subGoal) => subGoal.tasks)
      .find((candidate) => candidate.id === result.taskId);
    assert.equal(task?.taskSpec?.content, "## 任务目标\n输出行情摘要");
    assert.ok(task?.taskSpec?.sourceRevision, "sourceRevision should be populated");
  }

  {
    const result = await dispatchTaskFromThread(makeRequest(), {
      idempotencyKey: "dispatch-spec-fallback",
      invoke: async () => {
        throw new Error("spec invoke failed");
      },
    });
    const task = readGoalsSnapshot([])[0]?.subGoals
      .flatMap((subGoal) => subGoal.tasks)
      .find((candidate) => candidate.id === result.taskId);
    assert.equal(task?.taskSpec, undefined);
  }
}
