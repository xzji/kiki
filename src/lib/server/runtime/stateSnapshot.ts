import { getDatabase } from "@/lib/server/db/client";
import type { Goal } from "@/types/kiki";
import type { AgentEvent } from "@/types/schedule";
import type { RuntimeEnvironment } from "@/types/runtime";

type SnapshotKey = "goals" | "conversations" | "runtimeEnvironments" | "scheduleEvents";

function nowIso() {
  return new Date().toISOString();
}

function upsertSnapshot<T>(key: SnapshotKey, value: T) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO runtime_state_snapshots (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `,
  ).run(key, JSON.stringify(value), nowIso());
}

function readSnapshot<T>(key: SnapshotKey, fallback: T): T {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT value_json FROM runtime_state_snapshots WHERE key = ? LIMIT 1`)
    .get(key) as { value_json: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export function upsertGoalsSnapshot(goals: Goal[]) {
  upsertSnapshot("goals", goals);
}

export function readGoalsSnapshot(fallback: Goal[]) {
  return readSnapshot("goals", fallback);
}

export function upsertRuntimeEnvironmentsSnapshot(environments: RuntimeEnvironment[]) {
  upsertSnapshot("runtimeEnvironments", environments);
}

export function readRuntimeEnvironmentsSnapshot(fallback: RuntimeEnvironment[]) {
  return readSnapshot("runtimeEnvironments", fallback);
}

export function upsertScheduleEventsSnapshot(events: AgentEvent[]) {
  upsertSnapshot("scheduleEvents", events);
}

export function readScheduleEventsSnapshot(fallback: AgentEvent[]) {
  return readSnapshot("scheduleEvents", fallback);
}
