import { computeThreadDueTickAt, isTriggerSpecInPhasedWindow, parseThreadLoopInterval } from "@/lib/taskTriggerTime";
import type { Thread, Topic } from "@/types/topic";

export type DueTopic = {
  topic: Topic;
  scheduledAt: Date;
  reason: "first_tick" | "event_triggered" | "interval_due" | "cron_due";
};

export function selectDueTopics(topics: Topic[], now: Date): DueTopic[] {
  const due: DueTopic[] = [];
  for (const topic of topics) {
    const verdict = isTopicDue(topic, now);
    if (verdict) due.push({ topic, ...verdict });
  }
  due.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  return due;
}

export function isTopicDue(
  topic: Topic,
  now: Date,
): { scheduledAt: Date; reason: DueTopic["reason"] } | null {
  if (topic.status !== "active") return null;
  const explicitNext = parseDateSafe(topic.nextTickAt);
  if (explicitNext) {
    if (explicitNext.getTime() > now.getTime()) return null;
    if (!isTriggerSpecInPhasedWindow(topic.loop, now)) return null;
    return {
      scheduledAt: explicitNext,
      reason: topic.lastTickAt ? "interval_due" : "first_tick",
    };
  }
  if (!topic.lastTickAt) return { scheduledAt: new Date(now.getTime()), reason: "first_tick" };
  const scheduledAt = computeThreadDueTickAt(topicAsLoopThread(topic), now);
  if (!scheduledAt) return null;
  if (!isTriggerSpecInPhasedWindow(topic.loop, now)) return null;
  const parsed = parseThreadLoopInterval(topic.loop);
  return {
    scheduledAt,
    reason: parsed.kind === "cron" ? "cron_due" : "interval_due",
  };
}

function topicAsLoopThread(topic: Topic): Thread {
  return {
    id: `${topic.id}:topic-loop`,
    topicId: topic.id,
    title: topic.title,
    intent: topic.summary,
    loopInterval: topic.loop,
    status: topic.status === "active" ? "active" : "paused",
    lastTickAt: topic.lastTickAt,
    nextTickAt: topic.nextTickAt,
    memory: {},
    silentCount: topic.silentCount,
    failureCount: topic.failureCount,
    infraFailureCount: topic.infraFailureCount,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
    revision: topic.revision,
  };
}

function parseDateSafe(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
