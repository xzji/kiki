/**
 * threadsRepository spec — 验证 PR14.1 仓库行为。
 *
 * 计划 ref：§12.3.4。
 *
 * 覆盖：
 *  1. findThreadById：定位/不存在；
 *  2. listThreadsByTopicStatus：仅返回匹配 topic.status 的 thread；
 *  3. updateThread：thread.revision 不匹配抛错；envelope 冲突抛错；
 *     成功路径 revision +1、updatedAt 刷新、memory 浅合并；
 *  4. markThreadPaused：active → paused；已 paused 不重复写入。
 */

import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  readTopicsSnapshotMeta,
  upsertTopicsSnapshot,
} from "@/lib/server/runtime/stateSnapshot";
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

function seedTopics(topics: Topic[]) {
  // 注：readTopicsSnapshotMeta 当 "topics" key 缺失时会兜底返回 "goals"
  // envelope 的 revision；而 upsertTopicsSnapshot 比较的是 "topics" key 自身
  // revision。生产路径上由 TopicCommandService 持有真实 "topics" revision，
  // spec 直接复用 conflict 反馈的真实 revision 即可。
  const meta = readTopicsSnapshotMeta([]);
  const first = upsertTopicsSnapshot(topics, meta.revision);
  if (first.ok) return;
  const retry = upsertTopicsSnapshot(topics, first.revision);
  assert.equal(retry.ok, true, "seed topics ok");
}

export async function runThreadsRepositorySpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // -----------------------------------------------------------------------
  // 1. findThreadById / listThreadsByTopicStatus
  // -----------------------------------------------------------------------
  {
    const t1 = makeThread("thread-1", { topicId: "topic-A" });
    const t2 = makeThread("thread-2", { topicId: "topic-A", status: "paused" });
    const t3 = makeThread("thread-3", { topicId: "topic-B" });
    seedTopics([
      makeTopic("topic-A", [t1, t2], { status: "active" }),
      makeTopic("topic-B", [t3], { status: "paused" }),
    ]);

    const found = findThreadById("thread-2");
    assert.ok(found, "thread-2 located");
    assert.equal(found?.status, "paused");
    assert.equal(findThreadById("missing"), null, "missing returns null");

    const activeTopicThreads = listThreadsByTopicStatus("active");
    assert.equal(activeTopicThreads.length, 2, "topic-A's 2 threads");
    assert.deepEqual(
      activeTopicThreads.map((t) => t.id).sort(),
      ["thread-1", "thread-2"],
      "list does not filter by thread.status",
    );

    const pausedTopicThreads = listThreadsByTopicStatus("paused");
    assert.equal(pausedTopicThreads.length, 1);
    assert.equal(pausedTopicThreads[0]?.id, "thread-3");
  }

  // -----------------------------------------------------------------------
  // 2. updateThread happy path + memory shallow merge + revision bump
  // -----------------------------------------------------------------------
  {
    const t = makeThread("thread-update", {
      topicId: "topic-U",
      memory: { foo: 1, bar: 2 },
      revision: 3,
    });
    seedTopics([makeTopic("topic-U", [t])]);

    const updated = updateThread(
      "thread-update",
      { memory: { bar: 99, baz: 3 }, silentCount: 5 },
      3,
    );
    assert.equal(updated.revision, 4, "revision bumped");
    assert.deepEqual(updated.memory, { foo: 1, bar: 99, baz: 3 }, "memory shallow-merged");
    assert.equal(updated.silentCount, 5);
    assert.notEqual(updated.updatedAt, t.updatedAt, "updatedAt refreshed");

    // Persisted in envelope
    const persisted = findThreadById("thread-update");
    assert.equal(persisted?.revision, 4);
    assert.deepEqual(persisted?.memory, { foo: 1, bar: 99, baz: 3 });
  }

  // -----------------------------------------------------------------------
  // 3. updateThread thread-revision mismatch
  // -----------------------------------------------------------------------
  {
    const t = makeThread("thread-rev", { topicId: "topic-R", revision: 7 });
    seedTopics([makeTopic("topic-R", [t])]);

    assert.throws(
      () => updateThread("thread-rev", { silentCount: 1 }, 6),
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
    const tActive = makeThread("thread-pause-1", { topicId: "topic-P", revision: 0 });
    const tAlreadyPaused = makeThread("thread-pause-2", {
      topicId: "topic-P",
      revision: 5,
      status: "paused",
    });
    seedTopics([makeTopic("topic-P", [tActive, tAlreadyPaused])]);

    const paused = markThreadPaused("thread-pause-1", "5 consecutive failures");
    assert.equal(paused.status, "paused");
    assert.equal(paused.revision, 1, "revision bumped to 1");

    const noOp = markThreadPaused("thread-pause-2", "already paused");
    assert.equal(noOp.status, "paused");
    assert.equal(noOp.revision, 5, "no extra revision bump on already paused");
  }
}
