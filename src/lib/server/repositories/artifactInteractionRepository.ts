import { getDatabase } from "@/lib/server/db/client";

export type ArtifactInteractionEvent = {
  type: string;
  payload?: Record<string, unknown>;
  createdAt: string;
};

export type ArtifactInteractionState = {
  artifactId: string;
  conversationId: string;
  taskId?: string;
  instanceId?: string;
  state: Record<string, unknown>;
  events: ArtifactInteractionEvent[];
  createdAt: string;
  updatedAt: string;
};

type ArtifactInteractionRow = {
  artifact_id: string;
  conversation_id: string;
  task_id: string | null;
  instance_id: string | null;
  state_json: string;
  events_json: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_EVENTS = 50;

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseEvents(value: string | null | undefined): ArtifactInteractionEvent[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is ArtifactInteractionEvent => {
          return Boolean(
            item &&
              typeof item === "object" &&
              typeof (item as ArtifactInteractionEvent).type === "string" &&
              typeof (item as ArtifactInteractionEvent).createdAt === "string",
          );
        })
      : [];
  } catch {
    return [];
  }
}

function mapRow(row: ArtifactInteractionRow): ArtifactInteractionState {
  return {
    artifactId: row.artifact_id,
    conversationId: row.conversation_id,
    taskId: row.task_id ?? undefined,
    instanceId: row.instance_id ?? undefined,
    state: parseRecord(row.state_json),
    events: parseEvents(row.events_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getArtifactInteractionState(artifactId: string) {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM artifact_interaction_state WHERE artifact_id = ? LIMIT 1`)
    .get(artifactId) as ArtifactInteractionRow | undefined;
  return row ? mapRow(row) : null;
}

export function getRecentArtifactInteractionStates(conversationId: string, limit = 5) {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT * FROM artifact_interaction_state
        WHERE conversation_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(conversationId, limit) as ArtifactInteractionRow[];
  return rows.map(mapRow);
}

export function upsertArtifactInteractionState(input: {
  artifactId: string;
  conversationId: string;
  taskId?: string;
  instanceId?: string;
  state: Record<string, unknown>;
  events?: ArtifactInteractionEvent[];
  updatedAt?: string;
}) {
  const db = getDatabase();
  const now = input.updatedAt ?? new Date().toISOString();
  const existing = getArtifactInteractionState(input.artifactId);
  const events = (input.events ?? existing?.events ?? []).slice(-MAX_EVENTS);
  db.prepare(
    `
      INSERT INTO artifact_interaction_state (
        artifact_id, conversation_id, task_id, instance_id, state_json, events_json, created_at, updated_at
      ) VALUES (
        @artifact_id, @conversation_id, @task_id, @instance_id, @state_json, @events_json, @created_at, @updated_at
      )
      ON CONFLICT(artifact_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        task_id = excluded.task_id,
        instance_id = excluded.instance_id,
        state_json = excluded.state_json,
        events_json = excluded.events_json,
        updated_at = excluded.updated_at
    `,
  ).run({
    artifact_id: input.artifactId,
    conversation_id: input.conversationId,
    task_id: input.taskId ?? null,
    instance_id: input.instanceId ?? null,
    state_json: JSON.stringify(input.state),
    events_json: JSON.stringify(events),
    created_at: existing?.createdAt ?? now,
    updated_at: now,
  });
  return getArtifactInteractionState(input.artifactId);
}

export function appendArtifactInteractionEvent(input: {
  artifactId: string;
  conversationId: string;
  taskId?: string;
  instanceId?: string;
  state: Record<string, unknown>;
  event?: Omit<ArtifactInteractionEvent, "createdAt"> & { createdAt?: string };
}) {
  const existing = getArtifactInteractionState(input.artifactId);
  const events = existing?.events ?? [];
  const nextEvents = input.event
    ? [
        ...events,
        {
          type: input.event.type,
          payload: input.event.payload,
          createdAt: input.event.createdAt ?? new Date().toISOString(),
        },
      ].slice(-MAX_EVENTS)
    : events;
  return upsertArtifactInteractionState({
    artifactId: input.artifactId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    instanceId: input.instanceId,
    state: input.state,
    events: nextEvents,
  });
}
