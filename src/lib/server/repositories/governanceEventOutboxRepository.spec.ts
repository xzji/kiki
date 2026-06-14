import assert from "node:assert/strict";

import { createIdempotencyKey } from "@/lib/opaqueIds";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";

import {
  appendGovernanceEvent,
  listPendingGovernanceEvents,
  markGovernanceEventConsumed,
} from "./governanceEventOutboxRepository";

export function runGovernanceEventOutboxRepositorySpecs() {
  ensureIsolatedPlanningSpecDataDir();

  const idempotencyKey = createIdempotencyKey("governance-outbox-spec", "same-event");
  const first = appendGovernanceEvent({
    eventType: "task_completed",
    source: "task_completed",
    topicId: "topic-outbox",
    threadId: "thread-outbox",
    taskId: "task-outbox",
    instanceId: "instance-outbox",
    idempotencyKey,
    createdAt: "2026-06-01T00:00:00.000Z",
    payload: { attempt: 1 },
  });
  const duplicate = appendGovernanceEvent({
    eventType: "task_completed",
    source: "task_completed",
    topicId: "topic-outbox",
    threadId: "thread-outbox",
    taskId: "task-outbox",
    instanceId: "instance-outbox",
    idempotencyKey,
    createdAt: "2026-06-01T00:01:00.000Z",
    payload: { attempt: 2 },
  });
  assert.equal(duplicate.id, first.id, "same idempotencyKey returns the durable existing event");
  assert.deepEqual(duplicate.payload, { attempt: 1 }, "duplicate append must not overwrite payload");

  const second = appendGovernanceEvent({
    eventType: "task_failed",
    source: "task_failed",
    idempotencyKey: createIdempotencyKey("governance-outbox-spec", "second-event"),
    payload: { attempt: 3 },
  });

  const consumerA = "outbox-spec-A";
  const pendingA = listPendingGovernanceEvents({ consumer: consumerA, afterId: first.id - 1, limit: 10 });
  assert.ok(pendingA.some((event) => event.id === first.id), "first event is pending for consumer A");
  assert.ok(pendingA.some((event) => event.id === second.id), "second event is pending for consumer A");

  markGovernanceEventConsumed({ eventId: first.eventId, consumer: consumerA, consumedAt: "2026-06-01T00:02:00.000Z" });
  markGovernanceEventConsumed({ eventId: first.eventId, consumer: consumerA, consumedAt: "2026-06-01T00:03:00.000Z" });
  const afterConsumedA = listPendingGovernanceEvents({ consumer: consumerA, afterId: first.id - 1, limit: 10 });
  assert.ok(!afterConsumedA.some((event) => event.id === first.id), "duplicate markConsumed remains consumed");
  assert.ok(afterConsumedA.some((event) => event.id === second.id), "other events remain pending");

  const consumerB = "outbox-spec-B";
  const pendingB = listPendingGovernanceEvents({ consumer: consumerB, afterId: first.id - 1, limit: 10 });
  assert.ok(pendingB.some((event) => event.id === first.id), "consumption is per bridge consumer");

  const offsetPending = listPendingGovernanceEvents({ consumer: consumerB, afterId: first.id, limit: 10 });
  assert.ok(!offsetPending.some((event) => event.id === first.id), "afterId is an exclusive event offset");
  assert.ok(offsetPending.some((event) => event.id === second.id), "events after offset are still visible");
}
