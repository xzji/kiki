import assert from "node:assert/strict";

import {
  computeActiveExecutionDuration,
  formatDurationMs,
  resolveActiveExecutionMs,
} from "@/lib/taskExecutionDuration";
import type { GoalEventRecord } from "@/types/goalEventLog";

function statusEvent(input: {
  id: number;
  at: string;
  nextStatus: GoalEventRecord<"instance.status_changed">["payload"]["nextStatus"];
}): GoalEventRecord<"instance.status_changed"> {
  return {
    id: input.id,
    eventId: `event-${input.id}`,
    goalId: "goal-1",
    instanceId: "instance-1",
    kind: "instance.status_changed",
    payload: { nextStatus: input.nextStatus },
    producedBy: "worker",
    createdAt: input.at,
  };
}

export function runTaskExecutionDurationSpecs() {
  const paused = computeActiveExecutionDuration({
    events: [
      statusEvent({ id: 1, at: "2026-06-01T00:00:00.000Z", nextStatus: "in_progress" }),
      statusEvent({ id: 2, at: "2026-06-01T02:00:00.000Z", nextStatus: "paused" }),
    ],
    currentStatus: "paused",
    startedAt: "2026-06-01T00:00:00.000Z",
    lastUpdatedAt: "2026-06-01T02:00:00.000Z",
    nowMs: Date.parse("2026-06-07T00:00:00.000Z"),
  });
  assert.equal(paused.activeDurationMs, 2 * 60 * 60 * 1000);
  assert.equal(paused.activeSince, undefined);

  const resumed = computeActiveExecutionDuration({
    events: [
      statusEvent({ id: 1, at: "2026-06-01T00:00:00.000Z", nextStatus: "in_progress" }),
      statusEvent({ id: 2, at: "2026-06-01T01:00:00.000Z", nextStatus: "paused" }),
      statusEvent({ id: 3, at: "2026-06-01T05:00:00.000Z", nextStatus: "in_progress" }),
    ],
    currentStatus: "in_progress",
    startedAt: "2026-06-01T00:00:00.000Z",
    nowMs: Date.parse("2026-06-01T06:30:00.000Z"),
  });
  assert.equal(resumed.activeDurationMs, 1 * 60 * 60 * 1000);
  assert.equal(resumed.activeSince, "2026-06-01T05:00:00.000Z");
  assert.equal(
    resolveActiveExecutionMs({
      activeDurationMs: resumed.activeDurationMs,
      activeSince: resumed.activeSince,
      isActive: true,
      nowMs: Date.parse("2026-06-01T06:30:00.000Z"),
    }),
    2.5 * 60 * 60 * 1000,
  );

  const fallbackPaused = computeActiveExecutionDuration({
    events: [],
    currentStatus: "paused",
    startedAt: "2026-06-01T00:00:00.000Z",
    lastUpdatedAt: "2026-06-01T02:00:00.000Z",
    nowMs: Date.parse("2026-06-07T00:00:00.000Z"),
  });
  assert.equal(fallbackPaused.activeDurationMs, 2 * 60 * 60 * 1000);

  assert.equal(formatDurationMs(90_000), "1m 30s");
  assert.equal(formatDurationMs(3_660_000), "1h 1m");
}
