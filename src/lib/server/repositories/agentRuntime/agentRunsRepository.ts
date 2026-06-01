/**
 * Repository for `agent_runs` table.
 * Plan ref: §3.1.2 + §9.1 problem 4 (idempotency_key on agent_runs).
 */

import { randomUUID } from "crypto";

import { getDatabase } from "@/lib/server/db/client";
import type {
  AgentRun,
  AgentRunRole,
  AgentRunStatus,
} from "@/types/agentRuntime";

type AgentRunRow = {
  id: string;
  topic_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  saga_instance_id: string | null;
  role: AgentRunRole;
  status: AgentRunStatus;
  started_at: string;
  finished_at: string | null;
  last_event_seq: number;
  revision: number;
  idempotency_key: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function mapRow(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    topicId: row.topic_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    taskId: row.task_id ?? undefined,
    sagaInstanceId: row.saga_instance_id ?? undefined,
    role: row.role,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    lastEventSeq: row.last_event_seq,
    revision: row.revision,
    idempotencyKey: row.idempotency_key ?? undefined,
  };
}

export type CreateAgentRunInput = {
  id?: string;
  topicId?: string;
  threadId?: string;
  taskId?: string;
  sagaInstanceId?: string;
  role: AgentRunRole;
  status?: AgentRunStatus;
  idempotencyKey?: string;
  startedAt?: string;
};

export function createAgentRun(input: CreateAgentRunInput): AgentRun {
  const db = getDatabase();
  const id = input.id ?? `agent-run-${randomUUID()}`;
  const startedAt = input.startedAt ?? nowIso();
  const status: AgentRunStatus = input.status ?? "pending";

  // Idempotency: if key already exists, return the existing run.
  if (input.idempotencyKey) {
    const existing = db
      .prepare(`SELECT * FROM agent_runs WHERE idempotency_key = ? LIMIT 1`)
      .get(input.idempotencyKey) as AgentRunRow | undefined;
    if (existing) return mapRow(existing);
  }

  db.prepare(
    `
      INSERT INTO agent_runs (
        id, topic_id, thread_id, task_id, saga_instance_id,
        role, status, started_at, last_event_seq, revision, idempotency_key
      ) VALUES (
        @id, @topic_id, @thread_id, @task_id, @saga_instance_id,
        @role, @status, @started_at, 0, 0, @idempotency_key
      )
    `,
  ).run({
    id,
    topic_id: input.topicId ?? null,
    thread_id: input.threadId ?? null,
    task_id: input.taskId ?? null,
    saga_instance_id: input.sagaInstanceId ?? null,
    role: input.role,
    status,
    started_at: startedAt,
    idempotency_key: input.idempotencyKey ?? null,
  });

  const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ? LIMIT 1`).get(id) as
    | AgentRunRow
    | undefined;
  if (!row) throw new Error(`agent_runs row not found after insert: ${id}`);
  return mapRow(row);
}

export type UpdateAgentRunInput = {
  id: string;
  status?: AgentRunStatus;
  lastEventSeq?: number;
  finishedAt?: string;
  expectedRevision?: number;
};

/**
 * Optimistic-locking update. When `expectedRevision` is provided and does not
 * match, returns null (caller should refetch & retry).
 */
export function updateAgentRun(input: UpdateAgentRunInput): AgentRun | null {
  const db = getDatabase();
  const sets: string[] = ["revision = revision + 1"];
  const params: Record<string, unknown> = { id: input.id };

  if (input.status !== undefined) {
    sets.push("status = @status");
    params.status = input.status;
  }
  if (input.lastEventSeq !== undefined) {
    sets.push("last_event_seq = @last_event_seq");
    params.last_event_seq = input.lastEventSeq;
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
    .prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE ${where}`)
    .run(params);

  if (result.changes === 0) return null;
  return findAgentRunById(input.id);
}

export function findAgentRunById(id: string): AgentRun | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ? LIMIT 1`).get(id) as
    | AgentRunRow
    | undefined;
  return row ? mapRow(row) : null;
}

export function findAgentRunByIdempotencyKey(key: string): AgentRun | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM agent_runs WHERE idempotency_key = ? LIMIT 1`)
    .get(key) as AgentRunRow | undefined;
  return row ? mapRow(row) : null;
}

export function listAgentRunsBySaga(sagaInstanceId: string): AgentRun[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM agent_runs WHERE saga_instance_id = ? ORDER BY started_at ASC`,
    )
    .all(sagaInstanceId) as AgentRunRow[];
  return rows.map(mapRow);
}

export function listRunningAgentRunsBySaga(sagaInstanceId: string): AgentRun[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM agent_runs WHERE saga_instance_id = ? AND status = 'running' ORDER BY started_at ASC`,
    )
    .all(sagaInstanceId) as AgentRunRow[];
  return rows.map(mapRow);
}

export function listLatestAgentRunsByThread(threadId: string, limit = 10): AgentRun[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(threadId, limit) as AgentRunRow[];
  return rows.map(mapRow);
}
