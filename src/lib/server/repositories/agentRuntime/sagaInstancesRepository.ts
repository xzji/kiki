/**
 * Repository for `saga_instances` table.
 * Plan ref: §3.1.2 + §9.1 problem 4 (idempotency_key on saga_instances).
 */

import { randomUUID } from "crypto";

import { getDatabase } from "@/lib/server/db/client";
import type { SagaInstance, SagaStatus, SagaType } from "@/types/agentRuntime";

type SagaInstanceRow = {
  id: string;
  topic_id: string;
  type: SagaType;
  status: SagaStatus;
  current_step: string | null;
  retry_count: number;
  started_at: string;
  finished_at: string | null;
  revision: number;
  idempotency_key: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function mapRow(row: SagaInstanceRow): SagaInstance {
  return {
    id: row.id,
    topicId: row.topic_id,
    type: row.type,
    status: row.status,
    currentStep: row.current_step ?? undefined,
    retryCount: row.retry_count,
    revision: row.revision,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
  };
}

export type CreateSagaInstanceInput = {
  id?: string;
  topicId: string;
  type: SagaType;
  status?: SagaStatus;
  currentStep?: string;
  idempotencyKey?: string;
  startedAt?: string;
};

export function createSagaInstance(input: CreateSagaInstanceInput): SagaInstance {
  const db = getDatabase();
  const id = input.id ?? `saga-${randomUUID()}`;
  const startedAt = input.startedAt ?? nowIso();
  const status: SagaStatus = input.status ?? "pending";

  if (input.idempotencyKey) {
    const existing = db
      .prepare(`SELECT * FROM saga_instances WHERE idempotency_key = ? LIMIT 1`)
      .get(input.idempotencyKey) as SagaInstanceRow | undefined;
    if (existing) return mapRow(existing);
  }

  db.prepare(
    `
      INSERT INTO saga_instances (
        id, topic_id, type, status, current_step, retry_count,
        started_at, revision, idempotency_key
      ) VALUES (
        @id, @topic_id, @type, @status, @current_step, 0,
        @started_at, 0, @idempotency_key
      )
    `,
  ).run({
    id,
    topic_id: input.topicId,
    type: input.type,
    status,
    current_step: input.currentStep ?? null,
    started_at: startedAt,
    idempotency_key: input.idempotencyKey ?? null,
  });

  const row = db
    .prepare(`SELECT * FROM saga_instances WHERE id = ? LIMIT 1`)
    .get(id) as SagaInstanceRow | undefined;
  if (!row) throw new Error(`saga_instances row not found after insert: ${id}`);
  return mapRow(row);
}

export type UpdateSagaInstanceInput = {
  id: string;
  status?: SagaStatus;
  currentStep?: string | null;
  finishedAt?: string;
  expectedRevision?: number;
};

export function updateSagaInstance(input: UpdateSagaInstanceInput): SagaInstance | null {
  const db = getDatabase();
  const sets: string[] = ["revision = revision + 1"];
  const params: Record<string, unknown> = { id: input.id };

  if (input.status !== undefined) {
    sets.push("status = @status");
    params.status = input.status;
  }
  if (input.currentStep !== undefined) {
    sets.push("current_step = @current_step");
    params.current_step = input.currentStep;
  }
  if (input.finishedAt !== undefined) {
    sets.push("finished_at = @finished_at");
    params.finished_at = input.finishedAt;
  }

  let where = "id = @id";
  if (input.expectedRevision !== undefined) {
    where += " AND revision = @expected_revision";
    params.expected_revision = input.expectedRevision;
  }

  const result = db
    .prepare(`UPDATE saga_instances SET ${sets.join(", ")} WHERE ${where}`)
    .run(params);

  if (result.changes === 0) return null;
  return findSagaInstanceById(input.id);
}

export function incrementSagaRetry(id: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE saga_instances SET retry_count = retry_count + 1, revision = revision + 1 WHERE id = ?`,
  ).run(id);
}

export function findSagaInstanceById(id: string): SagaInstance | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM saga_instances WHERE id = ? LIMIT 1`)
    .get(id) as SagaInstanceRow | undefined;
  return row ? mapRow(row) : null;
}

export function findSagaInstanceByIdempotencyKey(key: string): SagaInstance | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM saga_instances WHERE idempotency_key = ? LIMIT 1`)
    .get(key) as SagaInstanceRow | undefined;
  return row ? mapRow(row) : null;
}

export function listRunningSagas(): SagaInstance[] {
  const db = getDatabase();
  // Includes 'awaiting_user' so resumeManager can decide to skip them explicitly
  // (§9.2 problem 6 — awaiting_user is non-terminal but should not be replayed).
  const rows = db
    .prepare(
      `SELECT * FROM saga_instances WHERE status IN ('pending', 'running', 'awaiting_user') ORDER BY started_at ASC`,
    )
    .all() as SagaInstanceRow[];
  return rows.map(mapRow);
}

export type ListSagaInstancesInput = {
  /** Filter by status whitelist; empty/undefined returns all statuses. */
  statuses?: SagaStatus[];
  /** Filter by type whitelist; empty/undefined returns all types. */
  types?: SagaType[];
  /** Filter by topicId. */
  topicId?: string;
  /** Returns only sagas started_at >= sinceIso. */
  sinceIso?: string;
  /** Default 50, capped at 200. */
  limit?: number;
  /** Skip rows; used together with limit for pagination. */
  offset?: number;
};

/**
 * DevPanel 数据源（PR15 §12.5.2）。按 status / type / topicId / 时间范围过滤，
 * 按 started_at 降序返回；调用方分页。
 */
export function listSagaInstances(input: ListSagaInstancesInput = {}): SagaInstance[] {
  const db = getDatabase();
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.statuses && input.statuses.length > 0) {
    where.push(`status IN (${input.statuses.map(() => "?").join(",")})`);
    params.push(...input.statuses);
  }
  if (input.types && input.types.length > 0) {
    where.push(`type IN (${input.types.map(() => "?").join(",")})`);
    params.push(...input.types);
  }
  if (input.topicId) {
    where.push(`topic_id = ?`);
    params.push(input.topicId);
  }
  if (input.sinceIso) {
    where.push(`started_at >= ?`);
    params.push(input.sinceIso);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM saga_instances ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as SagaInstanceRow[];
  return rows.map(mapRow);
}

export function countSagaInstances(input: Omit<ListSagaInstancesInput, "limit" | "offset"> = {}): number {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.statuses && input.statuses.length > 0) {
    where.push(`status IN (${input.statuses.map(() => "?").join(",")})`);
    params.push(...input.statuses);
  }
  if (input.types && input.types.length > 0) {
    where.push(`type IN (${input.types.map(() => "?").join(",")})`);
    params.push(...input.types);
  }
  if (input.topicId) {
    where.push(`topic_id = ?`);
    params.push(input.topicId);
  }
  if (input.sinceIso) {
    where.push(`started_at >= ?`);
    params.push(input.sinceIso);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const row = db
    .prepare(`SELECT COUNT(*) as c FROM saga_instances ${whereClause}`)
    .get(...params) as { c: number };
  return row.c;
}
