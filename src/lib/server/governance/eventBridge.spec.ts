import assert from "node:assert/strict";

import { createIdempotencyKey, deriveOpaqueId } from "@/lib/opaqueIds";
import { appendGovernanceEvent } from "@/lib/server/repositories/governanceEventOutboxRepository";
import { readGoalsSnapshotMeta, upsertGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import type { Goal, Task } from "@/types/kiki";

import {
  createEventTriggeredTaskInstances,
  TaskEventBridge,
  ThreadEventBridge,
} from "./eventBridge";

const TOPIC_ID = deriveOpaqueId("goal", "event-bridge-topic");
const THREAD_ID = deriveOpaqueId("sg", "event-bridge-thread");
const SOURCE_TASK_ID = deriveOpaqueId("task", "event-bridge-source-task");
const EVENT_TASK_ID = deriveOpaqueId("task", "event-bridge-event-task");
const OTHER_THREAD_ID = deriveOpaqueId("sg", "event-bridge-other-thread");
const OTHER_EVENT_TASK_ID = deriveOpaqueId("task", "event-bridge-other-event-task");

function makeTask(input: Partial<Task> & Pick<Task, "id" | "subGoalId" | "title">): Task {
  return {
    description: "",
    expectedOutcome: "",
    taskType: "repeat",
    triggerRule: "每天 09:00 触发",
    progress: 0,
    instances: [],
    executionKind: "generic_result",
    ...input,
  };
}

function seedGoals(goals: Goal[]) {
  const meta = readGoalsSnapshotMeta([]);
  const first = upsertGoalsSnapshot(goals, meta.revision);
  if (first.ok) return;
  const retry = upsertGoalsSnapshot(goals, first.revision);
  assert.equal(retry.ok, true, "seed goals ok");
}

function makeGoal(): Goal {
  return {
    id: TOPIC_ID,
    title: "Event Bridge Topic",
    deadline: "",
    progress: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    conversationId: "conversation-event-bridge",
    topicRevision: 0,
    subGoals: [
      {
        id: THREAD_ID,
        goalId: TOPIC_ID,
        title: "Thread",
        threadStatus: "active",
        nextTickAt: "2026-06-02T00:00:00.000Z",
        threadRevision: 0,
        tasks: [
          makeTask({ id: SOURCE_TASK_ID, subGoalId: THREAD_ID, title: "Source" }),
          makeTask({
            id: EVENT_TASK_ID,
            subGoalId: THREAD_ID,
            title: "Event Task",
            executionMode: "event_triggered",
            trigger: { kind: "event", sources: ["task_completed"] },
          }),
        ],
      },
      {
        id: OTHER_THREAD_ID,
        goalId: TOPIC_ID,
        title: "Other Thread",
        threadStatus: "active",
        threadRevision: 0,
        tasks: [
          makeTask({
            id: OTHER_EVENT_TASK_ID,
            subGoalId: OTHER_THREAD_ID,
            title: "Other Event Task",
            executionMode: "event_triggered",
            trigger: { kind: "event", sources: ["task_completed"] },
          }),
        ],
      },
    ],
  };
}

export async function runGovernanceEventBridgeSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // ThreadEventBridge consumes task terminal events and wakes the thread by
  // pulling nextTickAt forward to the event time.
  {
    seedGoals([makeGoal()]);
    const now = new Date("2026-06-01T01:00:00.000Z");
    const event = appendGovernanceEvent({
      eventType: "task_completed",
      source: "task_completed",
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      taskId: SOURCE_TASK_ID,
      instanceId: deriveOpaqueId("inst", "source-instance"),
      idempotencyKey: createIdempotencyKey("event-bridge-thread", "task-completed"),
      createdAt: now.toISOString(),
      payload: { reason: "done" },
    });

    const bridge = new ThreadEventBridge();
    const result = bridge.consumePending({ afterId: event.id - 1, limit: 10, now });
    assert.equal(result.checked, 1);
    assert.equal(result.processed, 1);
    const thread = readGoalsSnapshotMeta([]).value[0]?.subGoals[0];
    assert.equal(thread?.nextTickAt, now.toISOString(), "thread nextTickAt is pulled forward");

    const duplicate = bridge.consumePending({ afterId: event.id - 1, limit: 10, now });
    assert.equal(duplicate.checked, 0, "already consumed event is not delivered twice to same bridge");
  }

  // Event-triggered task instances are idempotent on eventId + taskId +
  // trigger fingerprint.
  {
    seedGoals([makeGoal()]);
    const event = appendGovernanceEvent({
      eventType: "task_completed",
      source: "task_completed",
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      taskId: SOURCE_TASK_ID,
      instanceId: deriveOpaqueId("inst", "source-instance-2"),
      idempotencyKey: createIdempotencyKey("event-bridge-task", "task-completed"),
      createdAt: "2026-06-01T02:00:00.000Z",
      payload: {},
    });

    const first = createEventTriggeredTaskInstances({
      event,
      now: new Date("2026-06-01T02:00:00.000Z"),
    });
    const second = createEventTriggeredTaskInstances({
      event,
      now: new Date("2026-06-01T02:01:00.000Z"),
    });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.created, true);
    assert.equal(second.length, 1);
    assert.equal(second[0]?.created, false);
    assert.equal(second[0]?.instanceId, first[0]?.instanceId);

    const snapshot = readGoalsSnapshotMeta([]).value[0];
    const task = snapshot?.subGoals[0]?.tasks.find((candidate) => candidate.id === EVENT_TASK_ID);
    assert.equal(task?.instances.length, 1, "duplicate event processing does not create duplicate instances");
  }

  // TaskEventBridge marks consumed after creating matching event-triggered
  // instances, so retrying the bridge itself is also deduped.
  {
    seedGoals([makeGoal()]);
    const idempotencyKey = createIdempotencyKey("event-bridge-task-consumer", "task-completed");
    const event = appendGovernanceEvent({
      eventType: "task_completed",
      source: "task_completed",
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      taskId: SOURCE_TASK_ID,
      instanceId: deriveOpaqueId("inst", "source-instance-3"),
      idempotencyKey,
      createdAt: "2026-06-01T02:00:00.000Z",
      payload: {},
    });
    const duplicateEvent = appendGovernanceEvent({
      eventType: "task_completed",
      source: "task_completed",
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      taskId: SOURCE_TASK_ID,
      instanceId: deriveOpaqueId("inst", "source-instance-3"),
      idempotencyKey,
      createdAt: "2026-06-01T02:00:00.000Z",
      payload: {},
    });
    assert.equal(duplicateEvent.eventId, event.eventId, "duplicate governance event idempotency is collapsed");
    const bridge = new TaskEventBridge();
    const first = bridge.consumePending({ afterId: event.id - 1, limit: 10 });
    const second = bridge.consumePending({ afterId: event.id - 1, limit: 10 });
    assert.equal(first.processed, 1);
    assert.equal(second.checked, 0);
    const snapshot = readGoalsSnapshotMeta([]).value[0];
    const task = snapshot?.subGoals[0]?.tasks.find((candidate) => candidate.id === EVENT_TASK_ID);
    const otherTask = snapshot?.subGoals[1]?.tasks.find((candidate) => candidate.id === OTHER_EVENT_TASK_ID);
    assert.equal(task?.instances.length, 1, "duplicate task_completed event does not create duplicate instances");
    assert.equal(otherTask?.instances.length, 0, "event-triggered tasks in other threads are not triggered");
  }

  // Event source offsets defer event-triggered task instance creation until
  // the offset time is reached, and the outbox event remains unconsumed while
  // deferred.
  {
    const goal = makeGoal();
    const eventTask = goal.subGoals[0]?.tasks.find((task) => task.id === EVENT_TASK_ID);
    assert.ok(eventTask);
    eventTask.trigger = {
      kind: "event",
      sources: [{ kind: "task_completed", offsetMinutes: 60, taskIds: [SOURCE_TASK_ID] }],
    };
    seedGoals([goal]);
    const event = appendGovernanceEvent({
      eventType: "task_completed",
      source: "task_completed",
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      taskId: SOURCE_TASK_ID,
      instanceId: deriveOpaqueId("inst", "source-instance-offset"),
      idempotencyKey: createIdempotencyKey("event-bridge-task-offset", "task-completed"),
      createdAt: "2026-06-01T02:00:00.000Z",
      payload: {},
    });
    const bridge = new TaskEventBridge();
    const early = bridge.consumePending({
      afterId: event.id - 1,
      limit: 10,
      now: new Date("2026-06-01T02:30:00.000Z"),
    });
    assert.equal(early.checked, 1);
    assert.equal(early.processed, 0);
    const earlyTask = readGoalsSnapshotMeta([]).value[0]?.subGoals[0]?.tasks.find((task) => task.id === EVENT_TASK_ID);
    assert.equal(earlyTask?.instances.length, 0, "offset event is not executed before due time");

    const due = bridge.consumePending({
      afterId: event.id - 1,
      limit: 10,
      now: new Date("2026-06-01T03:00:00.000Z"),
    });
    assert.equal(due.processed, 1);
    const dueTask = readGoalsSnapshotMeta([]).value[0]?.subGoals[0]?.tasks.find((task) => task.id === EVENT_TASK_ID);
    assert.equal(dueTask?.instances.length, 1, "offset event executes at due time");
  }
}
