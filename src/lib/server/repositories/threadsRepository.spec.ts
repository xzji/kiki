/**
 * threadsRepository spec — 验证 PR14.1 仓库行为。
 *
 * 计划 ref：§12.3.4。
 *
 * 覆盖：
 *  1. findThreadById：定位/不存在；
 *  2. listThreadsByTopicStatus：仅返回匹配 topic.status 的 thread；
 *  3. updateThread：thread.revision 不匹配抛错；
 *     成功路径 revision +1、updatedAt 刷新、memory 浅合并；
 *  4. markThreadPaused：active → paused；已 paused 不重复写入。
 */

import assert from "node:assert/strict";

import { normalizeSubGoalId } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
import { requestThreadGovernanceTick } from "@/lib/server/services/goalRuntimeService";
import { isThreadDue } from "@/lib/server/thread/threadLoopScheduler";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  readTopicsSnapshotMeta,
} from "@/lib/server/runtime/stateSnapshot";
import { writeGoalsProjection } from "@/lib/server/services/goalRuntimeService";
import type { Goal, GoalWorkflowPhase } from "@/types/kiki";
import type { Thread, Topic } from "@/types/topic";

import {
  ThreadNotFoundError,
  ThreadRevisionMismatchError,
  findThreadById,
  listThreadsByTopicStatus,
  markThreadPaused,
  updateThread,
} from "./threadsRepository";

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    topicId: overrides.topicId ?? "topic-x",
    title: id,
    intent: "",
    loopInterval: "daily",
    status: "active",
    memory: {},
    silentCount: 0,
    failureCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    ...overrides,
  };
}

function makeTopic(id: string, threads: Thread[], overrides: Partial<Topic> = {}): Topic {
  return {
    id,
    title: id,
    summary: "",
    threads,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    ...overrides,
  };
}

function topicStatusToGoalPhase(status: Topic["status"]): GoalWorkflowPhase {
  if (status === "active") return "executing";
  if (status === "paused") return "paused";
  if (status === "archived") return "completed";
  return "collecting_info";
}

function topicToGoal(topic: Topic): Goal {
  return {
    id: topic.id,
    title: topic.title,
    deadline: topic.deadline ?? "",
    progress: 0,
    createdAt: topic.createdAt,
    summary: topic.summary,
    workflow: {
      phase: topicStatusToGoalPhase(topic.status),
      planDecision: topic.status === "collecting_info" ? "pending" : "confirmed",
      startedAt: topic.createdAt,
      updatedAt: topic.updatedAt,
    },
    subGoals: topic.threads.map((thread) => ({
      id: thread.id,
      goalId: topic.id,
      title: thread.title,
      description: thread.intent,
      reviewInterval: thread.loopInterval as string,
      terminationCondition: thread.terminationCondition,
      threadStatus: thread.status,
      lastTickAt: thread.lastTickAt,
      nextTickAt: thread.nextTickAt,
      threadUpdatedAt: thread.updatedAt,
      threadMemory: thread.memory,
      silentCount: thread.silentCount,
      failureCount: thread.failureCount,
      threadRevision: thread.revision,
      tasks: [],
    })),
  };
}

function seedTopics(topics: Topic[]) {
  const result = writeGoalsProjection(topics.map(topicToGoal));
  assert.equal(result.ok, true, "seed projected topics via goals ok");
}

export async function runThreadsRepositorySpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // -----------------------------------------------------------------------
  // 0. empty physical topics row is ignored; thread updates write back to goals
  // -----------------------------------------------------------------------
  {
    getDatabase().prepare(`DELETE FROM runtime_state_snapshots WHERE key = 'topics'`).run();
    getDatabase()
      .prepare(
        `INSERT INTO runtime_state_snapshots (key, value_json, updated_at)
         VALUES ('topics', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify({ value: [], revision: 3, updatedAt: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z");
    const legacyGoal: Goal = {
      id: "topic-fallback-goal",
      title: "Fallback Topic",
      deadline: "",
      progress: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      subGoals: [
        {
          id: "thread-fallback",
          goalId: "topic-fallback-goal",
          title: "Fallback Thread",
          tasks: [],
        },
      ],
    };
    writeGoalsProjection([legacyGoal]);

    const fallbackThreadId = normalizeSubGoalId("thread-fallback");
    const threads = listThreadsByTopicStatus("active");
    assert.equal(threads.some((thread) => thread.id === fallbackThreadId), true);

    const updated = updateThread(fallbackThreadId, { silentCount: 1 }, 0);
    assert.equal(updated.silentCount, 1);
    assert.equal(updated.revision, 1);
    assert.equal(readTopicsSnapshotMeta([]).source, "goals_fallback");
  }

  // -----------------------------------------------------------------------
  // 1. findThreadById / listThreadsByTopicStatus
  // -----------------------------------------------------------------------
  {
    const t1Id = normalizeSubGoalId("thread-1");
    const t2Id = normalizeSubGoalId("thread-2");
    const t3Id = normalizeSubGoalId("thread-3");
    const t1 = makeThread("thread-1", { topicId: "topic-A" });
    const t2 = makeThread("thread-2", { topicId: "topic-A", status: "paused" });
    const t3 = makeThread("thread-3", { topicId: "topic-B" });
    seedTopics([
      makeTopic("topic-A", [t1, t2], { status: "active" }),
      makeTopic("topic-B", [t3], { status: "paused" }),
    ]);

    const found = findThreadById(t2Id);
    assert.ok(found, "thread-2 located");
    assert.equal(found?.status, "paused");
    assert.equal(findThreadById("missing"), null, "missing returns null");

    const activeTopicThreads = listThreadsByTopicStatus("active");
    assert.equal(activeTopicThreads.length, 2, "topic-A's 2 threads");
    assert.deepEqual(
      activeTopicThreads.map((t) => t.id).sort(),
      [t1Id, t2Id].sort(),
      "list does not filter by thread.status",
    );

    const pausedTopicThreads = listThreadsByTopicStatus("paused");
    assert.equal(pausedTopicThreads.length, 1);
    assert.equal(pausedTopicThreads[0]?.id, t3Id);
  }

  // -----------------------------------------------------------------------
  // 2. updateThread happy path + memory shallow merge + revision bump
  // -----------------------------------------------------------------------
  {
    const threadId = normalizeSubGoalId("thread-update");
    const t = makeThread("thread-update", {
      topicId: "topic-U",
      memory: { foo: 1, bar: 2 },
      revision: 3,
    });
    seedTopics([makeTopic("topic-U", [t])]);

    const updated = updateThread(
      threadId,
      { memory: { bar: 99, baz: 3 }, silentCount: 5 },
      3,
    );
    assert.equal(updated.revision, 4, "revision bumped");
    assert.deepEqual(updated.memory, { foo: 1, bar: 99, baz: 3 }, "memory shallow-merged");
    assert.equal(updated.silentCount, 5);
    assert.notEqual(updated.updatedAt, t.updatedAt, "updatedAt refreshed");

    // Persisted in envelope
    const persisted = findThreadById(threadId);
    assert.equal(persisted?.revision, 4);
    assert.deepEqual(persisted?.memory, { foo: 1, bar: 99, baz: 3 });
  }

  // -----------------------------------------------------------------------
  // 3. updateThread thread-revision mismatch
  // -----------------------------------------------------------------------
  {
    const threadId = normalizeSubGoalId("thread-rev");
    const t = makeThread("thread-rev", { topicId: "topic-R", revision: 7 });
    seedTopics([makeTopic("topic-R", [t])]);

    assert.throws(
      () => updateThread(threadId, { silentCount: 1 }, 6),
      (err: unknown) =>
        err instanceof ThreadRevisionMismatchError &&
        err.scope === "thread" &&
        err.expected === 6 &&
        err.actual === 7,
      "thread-level revision mismatch",
    );
  }

  // -----------------------------------------------------------------------
  // 4. updateThread missing thread
  // -----------------------------------------------------------------------
  {
    seedTopics([makeTopic("topic-empty", [])]);
    assert.throws(
      () => updateThread("ghost", { silentCount: 0 }, 0),
      (err: unknown) => err instanceof ThreadNotFoundError && err.threadId === "ghost",
      "missing thread throws",
    );
  }

  // -----------------------------------------------------------------------
  // 5. markThreadPaused — active → paused; idempotent on already-paused
  // -----------------------------------------------------------------------
  {
    const activeThreadId = normalizeSubGoalId("thread-pause-1");
    const pausedThreadId = normalizeSubGoalId("thread-pause-2");
    const tActive = makeThread("thread-pause-1", { topicId: "topic-P", revision: 0 });
    const tAlreadyPaused = makeThread("thread-pause-2", {
      topicId: "topic-P",
      revision: 5,
      status: "paused",
    });
    seedTopics([makeTopic("topic-P", [tActive, tAlreadyPaused])]);

    const paused = markThreadPaused(activeThreadId, "5 consecutive failures");
    assert.equal(paused.status, "paused");
    assert.equal(paused.revision, 1, "revision bumped to 1");

    const noOp = markThreadPaused(pausedThreadId, "already paused");
    assert.equal(noOp.status, "paused");
    assert.equal(noOp.revision, 5, "no extra revision bump on already paused");
  }

  // -----------------------------------------------------------------------
  // 6. event bridge — completed task requests next Thread governance tick
  // -----------------------------------------------------------------------
  {
    const threadId = normalizeSubGoalId("thread-event");
    const now = new Date("2026-06-01T08:00:00.000Z");
    const t = makeThread("thread-event", {
      topicId: "topic-E",
      revision: 0,
      loopInterval: "daily",
      lastTickAt: "2026-06-01T07:00:00.000Z",
      nextTickAt: "2026-06-02T07:00:00.000Z",
    });
    seedTopics([makeTopic("topic-E", [t])]);

    assert.equal(requestThreadGovernanceTick(threadId, now), true);
    const updated = findThreadById(threadId);
    assert.equal(updated?.nextTickAt, now.toISOString());
    const verdict = updated ? isThreadDue(updated, now) : null;
    assert.equal(verdict?.reason, "event_triggered");
  }

  // -----------------------------------------------------------------------
  // 7. updateThread — explicit undefined nextTickAt clears it (archive/pause path)
  // -----------------------------------------------------------------------
  {
    const threadId = normalizeSubGoalId("thread-clear-tick");
    const t = makeThread("thread-clear-tick", {
      topicId: "topic-C",
      revision: 0,
      lastTickAt: "2026-06-01T07:00:00.000Z",
      nextTickAt: "2026-06-02T07:00:00.000Z",
    });
    seedTopics([makeTopic("topic-C", [t])]);

    // ThreadRunner archive/failure-pause path explicitly passes nextTickAt=undefined.
    const cleared = updateThread(
      threadId,
      { status: "archived", nextTickAt: undefined },
      0,
    );
    assert.equal(cleared.nextTickAt, undefined, "explicit undefined clears nextTickAt");
    assert.equal(cleared.status, "archived");
    assert.equal(cleared.lastTickAt, "2026-06-01T07:00:00.000Z", "lastTickAt untouched when key absent");

    // Persisted: not falling back to the old nextTickAt.
    const persisted = findThreadById(threadId);
    assert.equal(persisted?.nextTickAt, undefined, "cleared nextTickAt persists");
  }
}
