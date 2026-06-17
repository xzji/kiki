import assert from "node:assert/strict";

import { isTopicDue } from "@/lib/server/governance/topicScheduler";
import type { Topic } from "@/types/topic";

const NOW = new Date("2026-06-08T09:00:00.000Z");

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: "topic-scheduler-topic",
    title: "Topic Scheduler",
    summary: "Verify topic scheduling",
    loop: { kind: "weekly", weekdays: [1], time: "09:00", timezone: "UTC" },
    phase: "running",
    status: "active",
    threads: [],
    silentCount: 0,
    failureCount: 0,
    infraFailureCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

export function runTopicSchedulerSpecs() {
  {
    const verdict = isTopicDue(
      makeTopic({
        lastTickAt: "2026-06-01T09:00:00.000Z",
        nextTickAt: undefined,
      }),
      NOW,
    );
    assert.equal(verdict?.reason, "interval_due");
    assert.equal(verdict?.scheduledAt.toISOString(), NOW.toISOString());
  }

  {
    const verdict = isTopicDue(
      makeTopic({
        lastTickAt: "2026-06-01T09:00:00.000Z",
        nextTickAt: undefined,
      }),
      new Date("2026-06-08T08:59:00.000Z"),
    );
    assert.equal(verdict, null, "topic is not due before the weekly slot");
  }

  {
    const verdict = isTopicDue(
      makeTopic({
        loop: { kind: "event", sources: ["task_completed"] },
        lastTickAt: "2026-06-01T09:00:00.000Z",
        nextTickAt: undefined,
      }),
      NOW,
    );
    assert.equal(verdict, null, "event-only topic is not due without explicit wake-up");
  }
}
