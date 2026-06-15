/**
 * Repository for `agent_events` table.
 *
 * Plan ref: §3.1.2 + §9.1 problem 5 (payload_ref path) + §3.0 (≤ 8KB cap).
 *
 * Per-run sequence numbers are guaranteed monotonic by `(agent_run_id, seq)`
 * UNIQUE constraint at the DB layer. Callers should use `appendAgentEvent`,
 * which auto-allocates `seq = max(seq) + 1` for the run.
 */

import { randomUUID } from "crypto";

import { getDatabase } from "@/lib/server/db/client";
import type { AgentEvent, AgentEventType } from "@/types/agentRuntime";

type AgentEventRow = {
  id: string;
  agent_run_id: string;
  seq: number;
  type: AgentEventType;
  payload: string;
  payload_ref: string | null;
  created_at: string;
};

function nowIso() {
  return new Date().toISOString();
}

function mapRow(row: AgentEventRow): AgentEvent {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    seq: row.seq,
    type: row.type,
    payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {},
    payloadRef: row.payload_ref ?? undefined,
    createdAt: row.created_at,
  };
}

export type AppendAgentEventInput = {
  agentRunId: string;
  type: AgentEventType;
  /** Already-guarded payload string (≤ 8KB). Use payloadGuard before calling. */
  payloadJson: string;
  payloadRef?: string;
  /** Optional explicit seq (rare; mostly for resume); defaults to next available. */
  seq?: number;
  id?: string;
  createdAt?: string;
};

export function appendAgentEvent(input: AppendAgentEventInput): AgentEvent {
  const db = getDatabase();
  const id = input.id ?? `agent-event-${randomUUID()}`;
  const createdAt = input.createdAt ?? nowIso();

  const insert = db.transaction(() => {
    let seq = input.seq;
    if (seq === undefined) {
      const row = db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM agent_events WHERE agent_run_id = ?`)
        .get(input.agentRunId) as { max_seq: number };
      seq = row.max_seq + 1;
    }
    db.prepare(
      `
        INSERT INTO agent_events (id, agent_run_id, seq, type, payload, payload_ref, created_at)
        VALUES (@id, @agent_run_id, @seq, @type, @payload, @payload_ref, @created_at)
      `,
    ).run({
      id,
      agent_run_id: input.agentRunId,
      seq,
      type: input.type,
      payload: input.payloadJson,
      payload_ref: input.payloadRef ?? null,
      created_at: createdAt,
    });
    // Mirror to agent_runs.last_event_seq for fast resume lookups.
    db.prepare(
      `UPDATE agent_runs SET last_event_seq = ? WHERE id = ? AND last_event_seq < ?`,
    ).run(seq, input.agentRunId, seq);
    return seq;
  });

  insert();

  const row = db
    .prepare(`SELECT * FROM agent_events WHERE id = ? LIMIT 1`)
    .get(id) as AgentEventRow | undefined;
  if (!row) throw new Error(`agent_events row not found after insert: ${id}`);
  return mapRow(row);
}

export function listAgentEvents(input: {
  agentRunId: string;
  fromSeq?: number;
  limit?: number;
}): AgentEvent[] {
  const db = getDatabase();
  const fromSeq = input.fromSeq ?? 0;
  const limit = Math.min(Math.max(input.limit ?? 1000, 1), 5000);
  const rows = db
    .prepare(
      `
        SELECT * FROM agent_events
        WHERE agent_run_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?
      `,
    )
    .all(input.agentRunId, fromSeq, limit) as AgentEventRow[];
  return rows.map(mapRow);
}

export function getLastAgentEvent(agentRunId: string): AgentEvent | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM agent_events WHERE agent_run_id = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(agentRunId) as AgentEventRow | undefined;
  return row ? mapRow(row) : null;
}

export type GovernanceTickEntry = {
  id: string;
  occurredAt: string;
  kind: string;
  phase: "completed" | "failed" | "dispatch_partial_failure" | "paused" | "unknown";
  dispatchedTaskCount: number;
  updatedTaskCount: number;
  cancelledTaskCount: number;
  sentMessageCount: number;
  silentCount: number;
  failureCount?: number;
  failureReason?: string;
  errorKind?: string;
  assessment?: string;
  confidence?: number | string;
  paused: boolean;
};

type GovernanceTickEntryRow = AgentEventRow & {
  payload_kind: string | null;
};

function governancePhase(kind: string): GovernanceTickEntry["phase"] {
  if (kind.endsWith(".tick.completed")) return "completed";
  if (kind.endsWith(".tick.failed")) return "failed";
  if (kind.endsWith(".tick.dispatch_partial_failure")) return "dispatch_partial_failure";
  if (kind.endsWith(".paused.failure_threshold")) return "paused";
  return "unknown";
}

function numberField(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function listGovernanceTicksByEntity(input: {
  kind: "thread" | "topic";
  entityId: string;
  limit?: number;
}): GovernanceTickEntry[] {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const ownerColumn = input.kind === "thread" ? "r.thread_id" : "r.topic_id";
  const kindPrefix = `loop.${input.kind}.`;
  const rows = getDatabase()
    .prepare(
      `
        SELECT e.*, json_extract(e.payload, '$.kind') AS payload_kind
        FROM agent_events e
        JOIN agent_runs r ON e.agent_run_id = r.id
        WHERE ${ownerColumn} = ?
          AND json_extract(e.payload, '$.kind') LIKE ?
        ORDER BY e.created_at DESC, e.seq DESC
        LIMIT ?
      `,
    )
    .all(input.entityId, `${kindPrefix}%`, limit) as GovernanceTickEntryRow[];

  return rows
    .map((row) => {
      const event = mapRow(row);
      const kind = typeof event.payload.kind === "string" ? event.payload.kind : row.payload_kind ?? "";
      return {
        id: event.id,
        occurredAt: event.createdAt,
        kind,
        phase: governancePhase(kind),
        dispatchedTaskCount: numberField(event.payload, "dispatchedTaskCount"),
        updatedTaskCount: numberField(event.payload, "updatedTaskCount"),
        cancelledTaskCount: numberField(event.payload, "cancelledTaskCount"),
        sentMessageCount: numberField(event.payload, "sentMessageCount"),
        silentCount: numberField(event.payload, "silentCount"),
        failureCount: typeof event.payload.failureCount === "number" ? event.payload.failureCount : undefined,
        failureReason: typeof event.payload.failureReason === "string" ? event.payload.failureReason : undefined,
        errorKind: typeof event.payload.errorKind === "string" ? event.payload.errorKind : undefined,
        assessment: typeof event.payload.assessment === "string" ? event.payload.assessment : undefined,
        confidence:
          typeof event.payload.confidence === "number" || typeof event.payload.confidence === "string"
            ? event.payload.confidence
            : undefined,
        paused: kind.endsWith(".paused.failure_threshold"),
      };
    })
    .filter((entry) => entry.phase !== "unknown");
}
