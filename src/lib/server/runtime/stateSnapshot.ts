import { getDatabase } from "@/lib/server/db/client";
import { migrateGoalIds } from "@/lib/opaqueIds";
import { legacyGoalToTopic } from "@/lib/migration/legacyGoalToTopic";
import { normalizeGoalTriggerRules } from "@/lib/taskTriggerTime";
import type { Goal } from "@/types/kiki";
import type { Topic } from "@/types/topic";
import type { AgentEvent } from "@/types/schedule";
import type { RuntimeEnvironment } from "@/types/runtime";

// §10.5 问题 25：v12 起新增 "topics" key（双写期与 "goals" 共存）
type SnapshotKey = "goals" | "topics" | "runtimeEnvironments" | "scheduleEvents";

export type SnapshotMeta = {
  revision: number;
  updatedAt: string;
};

type SnapshotEnvelope<T> = SnapshotMeta & {
  value: T;
};

export type SnapshotWriteResult = SnapshotMeta & {
  ok: boolean;
  conflict?: boolean;
};

function nowIso() {
  return new Date().toISOString();
}

function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope<unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      "value" in value &&
      typeof (value as { revision?: unknown }).revision === "number" &&
      typeof (value as { updatedAt?: unknown }).updatedAt === "string",
  );
}

function readSnapshotWithMeta<T>(key: SnapshotKey, fallback: T): SnapshotEnvelope<T> {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT value_json, updated_at FROM runtime_state_snapshots WHERE key = ? LIMIT 1`)
    .get(key) as { value_json: string; updated_at: string } | undefined;
  if (!row) return { value: fallback, revision: 0, updatedAt: "" };
  try {
    const parsed = JSON.parse(row.value_json) as unknown;
    if (isSnapshotEnvelope(parsed)) {
      return {
        value: parsed.value as T,
        revision: parsed.revision,
        updatedAt: parsed.updatedAt,
      };
    }
    return { value: parsed as T, revision: 0, updatedAt: row.updated_at };
  } catch {
    return { value: fallback, revision: 0, updatedAt: row.updated_at };
  }
}

function upsertSnapshot<T>(key: SnapshotKey, value: T, expectedRevision?: number): SnapshotWriteResult {
  const db = getDatabase();
  const current = readSnapshotWithMeta<T>(key, value);
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    return {
      ok: false,
      conflict: true,
      revision: current.revision,
      updatedAt: current.updatedAt,
    };
  }
  const updatedAt = nowIso();
  const next: SnapshotEnvelope<T> = {
    value,
    revision: current.revision + 1,
    updatedAt,
  };
  db.prepare(
    `
      INSERT INTO runtime_state_snapshots (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `,
  ).run(key, JSON.stringify(next), updatedAt);
  return { ok: true, revision: next.revision, updatedAt };
}

export function upsertGoalsSnapshot(goals: Goal[], expectedRevision?: number) {
  return upsertSnapshot(
    "goals",
    goals.map((goal) => normalizeGoalTriggerRules(migrateGoalIds(goal))),
    expectedRevision,
  );
}

export function readGoalsSnapshot(fallback: Goal[]) {
  return readSnapshotWithMeta("goals", fallback).value.map((goal) =>
    normalizeGoalTriggerRules(migrateGoalIds(goal)),
  );
}

export function readGoalsSnapshotMeta(fallback: Goal[]) {
  const snapshot = readSnapshotWithMeta("goals", fallback);
  return {
    ...snapshot,
    value: snapshot.value.map((goal) => normalizeGoalTriggerRules(migrateGoalIds(goal))),
  };
}

export function upsertRuntimeEnvironmentsSnapshot(environments: RuntimeEnvironment[], expectedRevision?: number) {
  return upsertSnapshot("runtimeEnvironments", environments, expectedRevision);
}

export function readRuntimeEnvironmentsSnapshot(fallback: RuntimeEnvironment[]) {
  return readSnapshotWithMeta("runtimeEnvironments", fallback).value;
}

export function readRuntimeEnvironmentsSnapshotMeta(fallback: RuntimeEnvironment[]) {
  return readSnapshotWithMeta("runtimeEnvironments", fallback);
}

export function upsertScheduleEventsSnapshot(events: AgentEvent[], expectedRevision?: number) {
  return upsertSnapshot("scheduleEvents", events, expectedRevision);
}

export function readScheduleEventsSnapshot(fallback: AgentEvent[]) {
  return readSnapshotWithMeta("scheduleEvents", fallback).value;
}

export function readScheduleEventsSnapshotMeta(fallback: AgentEvent[]) {
  return readSnapshotWithMeta("scheduleEvents", fallback);
}

// ===== Topic snapshot =====
// 一期：goals envelope 是唯一权威源；topics 仅作为从 goals 实时投影出的只读视图。
// 物理 topics 行可能存在历史空副本，读路径不再信任它，避免空数组短路投影。
export type TopicsSnapshotSource = "topics" | "goals_fallback" | "fallback";

function projectGoalsToTopics(goals: Goal[]): Topic[] {
  return goals.map((goal) => legacyGoalToTopic({ goal }));
}

export function readTopicsSnapshot(fallback: Topic[]): Topic[] {
  const goals = readGoalsSnapshot([]);
  return goals.length > 0 ? projectGoalsToTopics(goals) : fallback;
}

export function readTopicsSnapshotMeta(fallback: Topic[]) {
  const goals = readGoalsSnapshotMeta([]);
  const value = goals.value.length > 0 ? projectGoalsToTopics(goals.value) : fallback;
  return {
    value,
    revision: goals.revision,
    updatedAt: goals.updatedAt,
    source: value === fallback ? ("fallback" as const) : ("goals_fallback" as const),
  };
}

export function upsertTopicsSnapshot(topics: Topic[], expectedRevision?: number) {
  return upsertSnapshot("topics", topics, expectedRevision);
}
