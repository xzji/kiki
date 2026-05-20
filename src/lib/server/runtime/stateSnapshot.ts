import { getDatabase } from "@/lib/server/db/client";
import { migrateGoalIds } from "@/lib/opaqueIds";
import { normalizeGoalTriggerRules } from "@/lib/taskTriggerTime";
import type { Goal } from "@/types/kiki";
import type { AgentEvent } from "@/types/schedule";
import type { RuntimeEnvironment } from "@/types/runtime";

type SnapshotKey = "goals" | "runtimeEnvironments" | "scheduleEvents";

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
