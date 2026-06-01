/**
 * Repository for `agent_snapshots` table.
 * Per agent_run, latest known internal state for fast resume. Plan ref: §3.1.2.
 */

import { getDatabase } from "@/lib/server/db/client";
import type { AgentSnapshot } from "@/types/agentRuntime";

type AgentSnapshotRow = {
  agent_run_id: string;
  last_event_seq: number;
  state_json: string;
  updated_at: string;
};

function nowIso() {
  return new Date().toISOString();
}

function mapRow(row: AgentSnapshotRow): AgentSnapshot {
  return {
    agentRunId: row.agent_run_id,
    lastEventSeq: row.last_event_seq,
    state: row.state_json ? (JSON.parse(row.state_json) as Record<string, unknown>) : {},
    updatedAt: row.updated_at,
  };
}

export type UpsertAgentSnapshotInput = {
  agentRunId: string;
  lastEventSeq: number;
  state: Record<string, unknown>;
  updatedAt?: string;
};

export function upsertAgentSnapshot(input: UpsertAgentSnapshotInput): AgentSnapshot {
  const db = getDatabase();
  const updatedAt = input.updatedAt ?? nowIso();
  db.prepare(
    `
      INSERT INTO agent_snapshots (agent_run_id, last_event_seq, state_json, updated_at)
      VALUES (@agent_run_id, @last_event_seq, @state_json, @updated_at)
      ON CONFLICT(agent_run_id) DO UPDATE SET
        last_event_seq = excluded.last_event_seq,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `,
  ).run({
    agent_run_id: input.agentRunId,
    last_event_seq: input.lastEventSeq,
    state_json: JSON.stringify(input.state),
    updated_at: updatedAt,
  });
  const row = db
    .prepare(`SELECT * FROM agent_snapshots WHERE agent_run_id = ? LIMIT 1`)
    .get(input.agentRunId) as AgentSnapshotRow | undefined;
  if (!row) throw new Error(`agent_snapshots row not found after upsert: ${input.agentRunId}`);
  return mapRow(row);
}

export function loadAgentSnapshot(agentRunId: string): AgentSnapshot | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM agent_snapshots WHERE agent_run_id = ? LIMIT 1`)
    .get(agentRunId) as AgentSnapshotRow | undefined;
  return row ? mapRow(row) : null;
}
