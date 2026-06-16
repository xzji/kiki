import assert from "node:assert/strict";

import { getDatabase } from "@/lib/server/db/client";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";

import {
  acquireGovernanceTickJobLease,
  completeGovernanceTickJob,
  createGovernanceTickJob,
  expireGovernanceTickJobLeases,
  failGovernanceTickJob,
  getGovernanceTickJob,
} from "./governanceTickJobsRepository";

export function runGovernanceTickJobsRepositorySpecs() {
  ensureIsolatedPlanningSpecDataDir();
  getDatabase().prepare(`DELETE FROM governance_tick_jobs`).run();

  // 1. queued -> leased；同一时刻只允许一个 lease owner 获取。
  {
    const job = createGovernanceTickJob({
      targetKind: "thread",
      topicId: "topic-lease",
      threadId: "thread-lease",
      baseRevision: 0,
      payload: {
        targetKind: "thread",
        topicId: "topic-lease",
        threadId: "thread-lease",
        baseRevision: 0,
        snapshot: {},
      },
      idempotencyKey: "governance-tick-repo-lease",
      createdAt: "2026-06-01T00:00:00.000Z",
    });

    const leased = acquireGovernanceTickJobLease({
      leaseOwner: "worker-A",
      leaseDurationMs: 1_000,
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    assert.equal(leased?.id, job.id);
    assert.equal(leased?.status, "leased");
    assert.equal(leased?.leaseOwner, "worker-A");
    assert.ok(leased?.leaseToken);
    assert.equal(leased?.attemptCount, 1);

    const second = acquireGovernanceTickJobLease({
      leaseOwner: "worker-B",
      leaseDurationMs: 1_000,
      now: new Date("2026-06-01T00:00:00.500Z"),
    });
    assert.equal(second, null, "leased job is invisible until lease expiration");
  }

  // 2. lease 过期转 expired，并可重新 lease 重试。
  {
    const expiredCount = expireGovernanceTickJobLeases({
      now: new Date("2026-06-01T00:00:02.000Z"),
    });
    assert.equal(expiredCount, 1);

    const retried = acquireGovernanceTickJobLease({
      leaseOwner: "worker-B",
      leaseDurationMs: 2_000,
      now: new Date("2026-06-01T00:00:02.000Z"),
    });
    assert.ok(retried, "expired job can be leased again");
    assert.equal(retried?.status, "leased");
    assert.equal(retried?.leaseOwner, "worker-B");
    assert.equal(retried?.attemptCount, 2);
  }

  // 3. completed / failed 只接受匹配的 lease token。
  {
    const leased = acquireGovernanceTickJobLease({
      leaseOwner: "worker-C",
      leaseDurationMs: 1_000,
      now: new Date("2026-06-01T00:00:03.000Z"),
    });
    assert.equal(leased, null, "already leased retry job is not visible");

    const current = getGovernanceTickJob(
      createGovernanceTickJob({
        targetKind: "topic",
        topicId: "topic-complete",
        baseRevision: 3,
        payload: {
          targetKind: "topic",
          topicId: "topic-complete",
          baseRevision: 3,
          snapshot: {},
        },
        idempotencyKey: "governance-tick-repo-complete",
        createdAt: "2026-06-01T00:01:00.000Z",
      }).id,
    );
    assert.ok(current);
    const lease = acquireGovernanceTickJobLease({
      leaseOwner: "worker-C",
      leaseDurationMs: 1_000,
      now: new Date("2026-06-01T00:01:00.000Z"),
      targetKind: "topic",
    });
    assert.equal(lease?.id, current?.id);
    assert.equal(
      completeGovernanceTickJob({
        jobId: lease!.id,
        leaseOwner: "worker-C",
        leaseToken: "wrong-token",
        outcome: { ok: true },
      }),
      null,
    );
    const completed = completeGovernanceTickJob({
      jobId: lease!.id,
      leaseOwner: "worker-C",
      leaseToken: lease!.leaseToken!,
      outcome: { ok: true },
      finishedAt: "2026-06-01T00:01:01.000Z",
    });
    assert.equal(completed?.status, "completed");

    const failedJob = createGovernanceTickJob({
      targetKind: "topic",
      topicId: "topic-fail",
      baseRevision: 4,
      payload: {
        targetKind: "topic",
        topicId: "topic-fail",
        baseRevision: 4,
        snapshot: {},
      },
      idempotencyKey: "governance-tick-repo-fail",
      createdAt: "2026-06-01T00:02:00.000Z",
    });
    const failedLease = acquireGovernanceTickJobLease({
      leaseOwner: "worker-D",
      leaseDurationMs: 1_000,
      now: new Date("2026-06-01T00:02:00.000Z"),
      targetKind: "topic",
    });
    assert.equal(failedLease?.id, failedJob.id);
    const failed = failGovernanceTickJob({
      jobId: failedLease!.id,
      leaseOwner: "worker-D",
      leaseToken: failedLease!.leaseToken!,
      error: "runner_failed",
    });
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.lastError, "runner_failed");

    const requeued = createGovernanceTickJob({
      targetKind: "topic",
      topicId: "topic-fail",
      baseRevision: 4,
      payload: {
        targetKind: "topic",
        topicId: "topic-fail",
        baseRevision: 4,
        snapshot: {},
      },
      idempotencyKey: "governance-tick-repo-fail",
      createdAt: "2026-06-01T00:03:00.000Z",
    });
    assert.equal(requeued.id, failedJob.id, "same due tick idempotency key is reused");
    assert.equal(requeued.status, "queued", "failed due tick is requeued instead of blocking future scheduler frames");
    assert.equal(requeued.lastError, undefined);
  }
}
