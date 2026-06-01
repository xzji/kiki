/**
 * taskInstancesRepository spec — 验证 PR14.2 只读视图行为。
 *
 * 计划 ref：§12.3.4。
 *
 * 覆盖：
 *  1. 按 threadId 命中正确 SubGoal 嵌套 instance；
 *  2. limit / sinceDays 截断与时间窗过滤；
 *  3. 多个 task 下 instance 合并 + createdAt 倒序；
 *  4. 不存在的 threadId 返回空；limit ≤ 0 返回空；
 *  5. createdAt 解析失败的 instance 自动跳过。
 */

import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  readGoalsSnapshotMeta,
  upsertGoalsSnapshot,
} from "@/lib/server/runtime/stateSnapshot";
import { deriveOpaqueId } from "@/lib/opaqueIds";
import type { Goal, Task, TaskInstance } from "@/types/kiki";

import { listRecentByThreadId } from "./taskInstancesRepository";

// upsertGoalsSnapshot 内部会调 migrateGoalIds → normalizeSubGoalId 等把 IDs
// 重写为 opaque 形式；spec 内必须用同一组 derive 后的 ID 避免读出后失配。
const GOAL_1 = deriveOpaqueId("goal", "goal-1");
const GOAL_2 = deriveOpaqueId("goal", "goal-2");
const GOAL_3 = deriveOpaqueId("goal", "goal-3");
const THREAD_A = deriveOpaqueId("sg", "thread-A");
const THREAD_B = deriveOpaqueId("sg", "thread-B");
const THREAD_WINDOW = deriveOpaqueId("sg", "thread-window");
const THREAD_BAD_TS = deriveOpaqueId("sg", "thread-bad-ts");
const TASK_A1 = deriveOpaqueId("task", "task-a1");
const TASK_A2 = deriveOpaqueId("task", "task-a2");
const TASK_B1 = deriveOpaqueId("task", "task-b1");
const TASK_W = deriveOpaqueId("task", "task-w");
const TASK_BAD = deriveOpaqueId("task", "task-bad");

function makeInstance(id: string, createdAt: string, taskId = "task-x"): TaskInstance {
  return {
    id,
    taskId,
    dateLabel: createdAt.slice(0, 10),
    status: "pending",
    intro: id,
    payload: { kind: "generic_result", summary: id },
    createdAt,
  };
}

function makeTask(id: string, subGoalId: string, instances: TaskInstance[]): Task {
  return {
    id,
    subGoalId,
    title: id,
    description: "",
    expectedOutcome: "",
    taskType: "one_shot",
    triggerRule: "",
    progress: 0,
    instances,
    executionKind: "generic_result",
  };
}

function seedGoals(goals: Goal[]) {
  // 与 threadsRepository.spec 同样：先用 meta.revision 试写，冲突则用真实
  // revision 重试一次，吸收 envelope 已存在导致的 stale revision。
  const meta = readGoalsSnapshotMeta([]);
  const first = upsertGoalsSnapshot(goals, meta.revision);
  if (first.ok) return;
  const retry = upsertGoalsSnapshot(goals, first.revision);
  assert.equal(retry.ok, true, "seed goals ok");
}

export async function runTaskInstancesRepositorySpecs() {
  ensureIsolatedPlanningSpecDataDir();

  const fixedNow = () => new Date("2026-06-01T12:00:00.000Z");

  // -----------------------------------------------------------------------
  // 1. 命中 thread 下 instances + 倒序 + limit 截断
  // -----------------------------------------------------------------------
  {
    // 注：seed 同一组 goals 完整覆盖快照，避免之前 spec 残留干扰。
    const goal: Goal = {
      id: GOAL_1,
      title: "G",
      deadline: "",
      progress: 0,
      createdAt: "2026-05-25T00:00:00.000Z",
      subGoals: [
        {
          id: THREAD_A,
          goalId: GOAL_1,
          title: "A",
          tasks: [
            makeTask(TASK_A1, THREAD_A, [
              makeInstance("inst-a1-1", "2026-05-30T00:00:00.000Z", TASK_A1),
              makeInstance("inst-a1-2", "2026-05-31T00:00:00.000Z", TASK_A1),
            ]),
            makeTask(TASK_A2, THREAD_A, [
              makeInstance("inst-a2-1", "2026-06-01T08:00:00.000Z", TASK_A2),
            ]),
          ],
        },
        {
          id: THREAD_B,
          goalId: GOAL_1,
          title: "B",
          tasks: [
            makeTask(TASK_B1, THREAD_B, [
              makeInstance("inst-b1", "2026-05-31T00:00:00.000Z", TASK_B1),
            ]),
          ],
        },
      ],
    };
    seedGoals([goal]);

    const all = listRecentByThreadId(THREAD_A, { now: fixedNow });
    assert.equal(all.length, 3, "thread-A 下 3 条 instance");
    assert.deepEqual(
      all.map((i) => i.createdAt),
      [
        "2026-06-01T08:00:00.000Z",
        "2026-05-31T00:00:00.000Z",
        "2026-05-30T00:00:00.000Z",
      ],
      "createdAt 倒序",
    );

    const limited = listRecentByThreadId(THREAD_A, { now: fixedNow, limit: 2 });
    assert.equal(limited.length, 2);
    assert.deepEqual(limited.map((i) => i.createdAt), [
      "2026-06-01T08:00:00.000Z",
      "2026-05-31T00:00:00.000Z",
    ]);

    // thread-B 不混入
    const bOnly = listRecentByThreadId(THREAD_B, { now: fixedNow });
    assert.equal(bOnly.length, 1);
    assert.equal(bOnly[0]?.createdAt, "2026-05-31T00:00:00.000Z");
  }

  // -----------------------------------------------------------------------
  // 2. sinceDays 时间窗过滤
  // -----------------------------------------------------------------------
  {
    const goal: Goal = {
      id: GOAL_2,
      title: "G",
      deadline: "",
      progress: 0,
      createdAt: "2026-05-01T00:00:00.000Z",
      subGoals: [
        {
          id: THREAD_WINDOW,
          goalId: GOAL_2,
          title: "W",
          tasks: [
            makeTask(TASK_W, THREAD_WINDOW, [
              makeInstance("inst-old", "2026-05-20T00:00:00.000Z", TASK_W), // 12 天前
              makeInstance("inst-recent", "2026-05-31T12:00:00.000Z", TASK_W), // 0.5 天前
            ]),
          ],
        },
      ],
    };
    seedGoals([goal]);

    const recent = listRecentByThreadId(THREAD_WINDOW, { now: fixedNow, sinceDays: 7 });
    assert.equal(recent.length, 1, "7 天窗只剩 1 条");
    assert.equal(recent[0]?.createdAt, "2026-05-31T12:00:00.000Z");

    const wide = listRecentByThreadId(THREAD_WINDOW, { now: fixedNow, sinceDays: 30 });
    assert.equal(wide.length, 2, "30 天窗包含全部");
  }

  // -----------------------------------------------------------------------
  // 3. 边界：threadId 不存在 / limit ≤ 0 / 时间戳无效
  // -----------------------------------------------------------------------
  {
    const goal: Goal = {
      id: GOAL_3,
      title: "G",
      deadline: "",
      progress: 0,
      createdAt: "2026-05-25T00:00:00.000Z",
      subGoals: [
        {
          id: THREAD_BAD_TS,
          goalId: GOAL_3,
          title: "X",
          tasks: [
            makeTask(TASK_BAD, THREAD_BAD_TS, [
              makeInstance("inst-good", "2026-05-31T00:00:00.000Z", TASK_BAD),
              makeInstance("inst-bad", "not-a-date", TASK_BAD),
            ]),
          ],
        },
      ],
    };
    seedGoals([goal]);

    assert.deepEqual(
      listRecentByThreadId("thread-does-not-exist", { now: fixedNow }),
      [],
      "missing thread → []",
    );
    assert.deepEqual(
      listRecentByThreadId(THREAD_BAD_TS, { now: fixedNow, limit: 0 }),
      [],
      "limit=0 → []",
    );
    const filtered = listRecentByThreadId(THREAD_BAD_TS, { now: fixedNow });
    assert.equal(filtered.length, 1, "无效时间戳被过滤");
    assert.equal(filtered[0]?.createdAt, "2026-05-31T00:00:00.000Z");
  }
}
