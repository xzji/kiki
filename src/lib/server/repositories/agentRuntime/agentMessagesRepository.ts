/**
 * Repository for `agent_messages` table.
 * Inter-role structured messages (handoff / review / refinement). Plan ref: §3.1.2.
 */

import { randomUUID } from "crypto";

import { getDatabase } from "@/lib/server/db/client";
import type {
  AgentMessage,
  AgentMessageKind,
  AgentRunRole,
} from "@/types/agentRuntime";

type AgentMessageRow = {
  id: string;
  saga_instance_id: string;
  from_role: AgentRunRole;
  to_role: AgentRunRole;
  kind: AgentMessageKind;
  payload: string;
  created_at: string;
};

function nowIso() {
  return new Date().toISOString();
}

function mapRow(row: AgentMessageRow): AgentMessage {
  return {
    id: row.id,
    sagaInstanceId: row.saga_instance_id,
    fromRole: row.from_role,
    toRole: row.to_role,
    kind: row.kind,
    payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {},
    createdAt: row.created_at,
  };
}

export type AppendAgentMessageInput = {
  sagaInstanceId: string;
  fromRole: AgentRunRole;
  toRole: AgentRunRole;
  kind: AgentMessageKind;
  payload: Record<string, unknown>;
  id?: string;
  createdAt?: string;
};

export function appendAgentMessage(input: AppendAgentMessageInput): AgentMessage {
  const db = getDatabase();
  const id = input.id ?? `agent-msg-${randomUUID()}`;
  const createdAt = input.createdAt ?? nowIso();
  db.prepare(
    `
      INSERT INTO agent_messages (
        id, saga_instance_id, from_role, to_role, kind, payload, created_at
      ) VALUES (
        @id, @saga_instance_id, @from_role, @to_role, @kind, @payload, @created_at
      )
    `,
  ).run({
    id,
    saga_instance_id: input.sagaInstanceId,
    from_role: input.fromRole,
    to_role: input.toRole,
    kind: input.kind,
    payload: JSON.stringify(input.payload),
    created_at: createdAt,
  });
  const row = db
    .prepare(`SELECT * FROM agent_messages WHERE id = ? LIMIT 1`)
    .get(id) as AgentMessageRow | undefined;
  if (!row) throw new Error(`agent_messages row not found after insert: ${id}`);
  return mapRow(row);
}

export function listMessagesBySaga(sagaInstanceId: string): AgentMessage[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM agent_messages WHERE saga_instance_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(sagaInstanceId) as AgentMessageRow[];
  return rows.map(mapRow);
}
