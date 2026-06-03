import { migrateConversationIds } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
import { listConversationMessages } from "@/lib/server/repositories/conversationMessagesRepository";
import type { Conversation, GoalInfoCollection, GoalPlanningRunState } from "@/types/kiki";
import type { Topic } from "@/types/topic";

type ConversationRow = {
  id: string;
  title: string;
  goal_id: string | null;
  workspace_path: string | null;
  workspace_initialized_at: string | null;
  runtime_env_id: string | null;
  claude_session_id: string | null;
  status: Conversation["status"];
  pinned: number;
  goal_info_collection_json: string | null;
  planning_run_state_json: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  user_id: string;
};

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as T;
}

type SnapshotEnvelope<T> = {
  value: T;
  revision: number;
  updatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseSnapshotEnvelope<T>(value: string | null): SnapshotEnvelope<T> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      isRecord(parsed) &&
      Array.isArray(parsed.value) &&
      typeof parsed.revision === "number" &&
      typeof parsed.updatedAt === "string"
    ) {
      return parsed as SnapshotEnvelope<T>;
    }
    if (Array.isArray(parsed)) {
      return { value: parsed as T, revision: 0, updatedAt: "" };
    }
  } catch {
    return null;
  }
  return null;
}

function addDefined(target: Set<string>, ...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (value) target.add(value);
  }
}

function collectIdsFromTopic(topic: Topic, ids: RelatedConversationIds) {
  addDefined(ids.topicIds, topic.id);
  for (const thread of topic.threads ?? []) {
    addDefined(ids.threadIds, thread.id);
  }
}

type LegacyGoalSnapshot = Array<{
  id?: string;
  conversationId?: string;
  subGoals?: Array<{
    id?: string;
    tasks?: Array<{
      id?: string;
      instances?: Array<{ id?: string }>;
    }>;
  }>;
}>;

type RelatedConversationIds = {
  goalIds: Set<string>;
  topicIds: Set<string>;
  threadIds: Set<string>;
  taskIds: Set<string>;
  taskInstanceIds: Set<string>;
  runtimeJobIds: Set<string>;
  sagaInstanceIds: Set<string>;
  agentRunIds: Set<string>;
};

function placeholders(values: Set<string>) {
  return Array.from(values).map(() => "?").join(",");
}

function deleteWhereIn(table: string, column: string, values: Set<string>) {
  if (values.size === 0) return 0;
  const result = getDatabase()
    .prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders(values)})`)
    .run(...Array.from(values));
  return result.changes;
}

function selectStrings(sql: string, ...params: unknown[]) {
  return (getDatabase().prepare(sql).all(...params) as Array<{ value: string | null }>).flatMap((row) =>
    row.value ? [row.value] : [],
  );
}

function setSize(ids: RelatedConversationIds) {
  return (
    ids.goalIds.size +
    ids.topicIds.size +
    ids.threadIds.size +
    ids.taskIds.size +
    ids.taskInstanceIds.size +
    ids.runtimeJobIds.size +
    ids.sagaInstanceIds.size +
    ids.agentRunIds.size
  );
}

function createRelatedConversationIds(): RelatedConversationIds {
  return {
    goalIds: new Set(),
    topicIds: new Set(),
    threadIds: new Set(),
    taskIds: new Set(),
    taskInstanceIds: new Set(),
    runtimeJobIds: new Set(),
    sagaInstanceIds: new Set(),
    agentRunIds: new Set(),
  };
}

function collectRuntimeSnapshotIds(conversationId: string, ids: RelatedConversationIds) {
  const rows = getDatabase()
    .prepare(`SELECT key, value_json FROM runtime_state_snapshots WHERE key IN ('goals', 'topics')`)
    .all() as Array<{ key: "goals" | "topics"; value_json: string }>;

  for (const row of rows) {
    if (row.key === "goals") {
      const envelope = parseSnapshotEnvelope<LegacyGoalSnapshot>(row.value_json);
      for (const goal of envelope?.value ?? []) {
        if (goal.conversationId !== conversationId) continue;
        addDefined(ids.goalIds, goal.id);
        addDefined(ids.topicIds, goal.id);
        for (const subGoal of goal.subGoals ?? []) {
          addDefined(ids.threadIds, subGoal.id);
          for (const task of subGoal.tasks ?? []) {
            addDefined(ids.taskIds, task.id);
            for (const instance of task.instances ?? []) {
              addDefined(ids.taskInstanceIds, instance.id);
            }
          }
        }
      }
      continue;
    }

    const envelope = parseSnapshotEnvelope<Topic[]>(row.value_json);
    for (const topic of envelope?.value ?? []) {
      if (topic.conversationId !== conversationId) continue;
      collectIdsFromTopic(topic, ids);
    }
  }
}

function collectRowsBySet(
  table: string,
  column: string,
  values: Set<string>,
  selectColumn: string,
) {
  if (values.size === 0) return [];
  return selectStrings(
    `SELECT ${selectColumn} AS value FROM ${table} WHERE ${column} IN (${placeholders(values)})`,
    ...Array.from(values),
  );
}

function collectRuntimeJobIds(conversationId: string, ids: RelatedConversationIds) {
  for (const value of selectStrings(`SELECT id AS value FROM runtime_jobs WHERE conversation_id = ?`, conversationId)) {
    addDefined(ids.runtimeJobIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "goal_id", ids.goalIds, "id")) {
    addDefined(ids.runtimeJobIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "topic_id", ids.topicIds, "id")) {
    addDefined(ids.runtimeJobIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "thread_id", ids.threadIds, "id")) {
    addDefined(ids.runtimeJobIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "task_id", ids.taskIds, "id")) {
    addDefined(ids.runtimeJobIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "task_instance_id", ids.taskInstanceIds, "id")) {
    addDefined(ids.runtimeJobIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "saga_instance_id", ids.sagaInstanceIds, "id")) {
    addDefined(ids.runtimeJobIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "id", ids.runtimeJobIds, "goal_id")) {
    addDefined(ids.goalIds, value);
    addDefined(ids.topicIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "id", ids.runtimeJobIds, "topic_id")) {
    addDefined(ids.topicIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "id", ids.runtimeJobIds, "thread_id")) {
    addDefined(ids.threadIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "id", ids.runtimeJobIds, "task_id")) {
    addDefined(ids.taskIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "id", ids.runtimeJobIds, "task_instance_id")) {
    addDefined(ids.taskInstanceIds, value);
  }
  for (const value of collectRowsBySet("runtime_jobs", "id", ids.runtimeJobIds, "saga_instance_id")) {
    addDefined(ids.sagaInstanceIds, value);
  }
}

function collectArtifactIds(conversationId: string, ids: RelatedConversationIds) {
  const rows = getDatabase()
    .prepare(
      `
        SELECT task_id, instance_id, runtime_job_id
        FROM artifacts
        WHERE conversation_id = ?
        UNION ALL
        SELECT task_id, instance_id, NULL AS runtime_job_id
        FROM artifact_interaction_state
        WHERE conversation_id = ?
      `,
    )
    .all(conversationId, conversationId) as Array<{
    task_id: string | null;
    instance_id: string | null;
    runtime_job_id: string | null;
  }>;

  for (const row of rows) {
    addDefined(ids.taskIds, row.task_id);
    addDefined(ids.taskInstanceIds, row.instance_id);
    addDefined(ids.runtimeJobIds, row.runtime_job_id);
  }
}

function collectAgentRuntimeIds(ids: RelatedConversationIds) {
  for (const value of collectRowsBySet("saga_instances", "topic_id", ids.topicIds, "id")) {
    addDefined(ids.sagaInstanceIds, value);
  }

  for (const value of collectRowsBySet("agent_runs", "topic_id", ids.topicIds, "id")) {
    addDefined(ids.agentRunIds, value);
  }
  for (const value of collectRowsBySet("agent_runs", "thread_id", ids.threadIds, "id")) {
    addDefined(ids.agentRunIds, value);
  }
  for (const value of collectRowsBySet("agent_runs", "task_id", ids.taskIds, "id")) {
    addDefined(ids.agentRunIds, value);
  }
  for (const value of collectRowsBySet("agent_runs", "saga_instance_id", ids.sagaInstanceIds, "id")) {
    addDefined(ids.agentRunIds, value);
  }

  for (const value of collectRowsBySet("agent_runs", "id", ids.agentRunIds, "saga_instance_id")) {
    addDefined(ids.sagaInstanceIds, value);
  }
}

function collectRelatedConversationIds(conversationId: string): RelatedConversationIds {
  const ids = createRelatedConversationIds();
  const row = getDatabase()
    .prepare(`SELECT goal_id FROM conversations WHERE id = ? LIMIT 1`)
    .get(conversationId) as { goal_id: string | null } | undefined;
  addDefined(ids.goalIds, row?.goal_id);
  addDefined(ids.topicIds, row?.goal_id);

  collectRuntimeSnapshotIds(conversationId, ids);
  let previousSize = -1;
  while (previousSize !== setSize(ids)) {
    previousSize = setSize(ids);
    collectArtifactIds(conversationId, ids);
    collectRuntimeJobIds(conversationId, ids);
    collectAgentRuntimeIds(ids);
  }
  return ids;
}

function updateSnapshotArray<T>(
  key: "goals" | "topics",
  shouldKeep: (item: T) => boolean,
) {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT value_json FROM runtime_state_snapshots WHERE key = ? LIMIT 1`)
    .get(key) as { value_json: string } | undefined;
  if (!row) return;

  const envelope = parseSnapshotEnvelope<T[]>(row.value_json);
  if (!envelope) return;
  const nextValue = envelope.value.filter(shouldKeep);
  if (nextValue.length === envelope.value.length) return;
  const nextEnvelope: SnapshotEnvelope<T[]> = {
    value: nextValue,
    revision: envelope.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(`UPDATE runtime_state_snapshots SET value_json = ?, updated_at = ? WHERE key = ?`).run(
    JSON.stringify(nextEnvelope),
    nextEnvelope.updatedAt,
    key,
  );
}

function removeConversationRuntimeSnapshots(conversationId: string, ids: RelatedConversationIds) {
  updateSnapshotArray<LegacyGoalSnapshot[number]>("goals", (goal) => {
    return goal.conversationId !== conversationId && !ids.goalIds.has(goal.id ?? "");
  });
  updateSnapshotArray<Topic>("topics", (topic) => {
    return topic.conversationId !== conversationId && !ids.topicIds.has(topic.id);
  });
}

function deleteRelatedConversationData(conversationId: string) {
  const db = getDatabase();
  const ids = collectRelatedConversationIds(conversationId);
  removeConversationRuntimeSnapshots(conversationId, ids);

  db.prepare(`DELETE FROM artifact_interaction_state WHERE conversation_id = ?`).run(conversationId);
  deleteWhereIn("artifact_interaction_state", "task_id", ids.taskIds);
  deleteWhereIn("artifact_interaction_state", "instance_id", ids.taskInstanceIds);
  db.prepare(`DELETE FROM artifacts WHERE conversation_id = ?`).run(conversationId);
  deleteWhereIn("artifacts", "task_id", ids.taskIds);
  deleteWhereIn("artifacts", "instance_id", ids.taskInstanceIds);
  deleteWhereIn("artifacts", "runtime_job_id", ids.runtimeJobIds);
  db.prepare(`DELETE FROM runtime_jobs WHERE conversation_id = ?`).run(conversationId);
  deleteWhereIn("runtime_jobs", "id", ids.runtimeJobIds);

  deleteWhereIn("goal_deliverables", "goal_id", ids.goalIds);
  deleteWhereIn("goal_event_log", "goal_id", ids.goalIds);
  deleteWhereIn("goal_event_log", "task_id", ids.taskIds);
  deleteWhereIn("goal_event_log", "instance_id", ids.taskInstanceIds);

  deleteWhereIn("agent_events", "agent_run_id", ids.agentRunIds);
  deleteWhereIn("agent_snapshots", "agent_run_id", ids.agentRunIds);
  deleteWhereIn("agent_messages", "saga_instance_id", ids.sagaInstanceIds);
  deleteWhereIn("agent_runs", "id", ids.agentRunIds);
  deleteWhereIn("agent_runs", "topic_id", ids.topicIds);
  deleteWhereIn("agent_runs", "thread_id", ids.threadIds);
  deleteWhereIn("agent_runs", "task_id", ids.taskIds);
  deleteWhereIn("agent_runs", "saga_instance_id", ids.sagaInstanceIds);
  deleteWhereIn("saga_instances", "id", ids.sagaInstanceIds);
  deleteWhereIn("saga_instances", "topic_id", ids.topicIds);
}

export function mapConversationRow(row: ConversationRow, messages: Conversation["messages"] = []) {
  return migrateConversationIds({
    id: row.id,
    title: row.title,
    goalId: row.goal_id ?? undefined,
    goalInfoCollection: parseJson<GoalInfoCollection>(row.goal_info_collection_json),
    planningRunState: parseJson<GoalPlanningRunState>(row.planning_run_state_json),
    workspacePath: row.workspace_path ?? undefined,
    workspaceInitializedAt: row.workspace_initialized_at ?? undefined,
    runtimeEnvId: row.runtime_env_id ?? undefined,
    claudeSessionId: row.claude_session_id ?? undefined,
    status: row.status ?? "idle",
    messages,
    updatedAt: row.updated_at,
    pinned: Boolean(row.pinned),
  } satisfies Conversation);
}

export type ConversationMeta = Omit<Conversation, "messages"> & {
  revision: number;
  messageCount: number;
  lastMessageAt?: string;
};

function mapConversationMetaRow(row: ConversationRow & { message_count: number; last_message_at: string | null }) {
  const conversation = mapConversationRow(row);
  return {
    ...conversation,
    revision: row.revision,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at ?? undefined,
  } satisfies ConversationMeta;
}

export function countConversations() {
  const row = getDatabase().prepare(`SELECT COUNT(*) AS count FROM conversations`).get() as { count: number };
  return row.count;
}

export function listConversationMetas() {
  const rows = getDatabase()
    .prepare(
      `
        SELECT c.*,
               COUNT(m.id) AS message_count,
               MAX(m.created_at) AS last_message_at
        FROM conversations c
        LEFT JOIN conversation_messages m ON m.conversation_id = c.id
        GROUP BY c.id
        ORDER BY c.pinned DESC, c.updated_at DESC
      `,
    )
    .all() as Array<ConversationRow & { message_count: number; last_message_at: string | null }>;
  return rows.map(mapConversationMetaRow);
}

export function getConversationRevision(conversationId: string) {
  const row = getDatabase()
    .prepare(`SELECT revision FROM conversations WHERE id = ? LIMIT 1`)
    .get(conversationId) as { revision: number } | undefined;
  return row?.revision;
}

export function getConversation(conversationId: string) {
  const row = getDatabase()
    .prepare(`SELECT * FROM conversations WHERE id = ? LIMIT 1`)
    .get(conversationId) as ConversationRow | undefined;
  if (!row) return null;
  return {
    conversation: mapConversationRow(row, listConversationMessages({ conversationId, limit: 1000 })),
    revision: row.revision,
  };
}

export function insertConversation(conversation: Conversation) {
  const now = new Date().toISOString();
  const normalized = migrateConversationIds(conversation);
  getDatabase()
    .prepare(
      `
        INSERT INTO conversations (
          id, title, goal_id, workspace_path, workspace_initialized_at, runtime_env_id,
          claude_session_id, status, pinned, goal_info_collection_json, planning_run_state_json,
          revision, created_at, updated_at, user_id
        ) VALUES (
          @id, @title, @goal_id, @workspace_path, @workspace_initialized_at, @runtime_env_id,
          @claude_session_id, @status, @pinned, @goal_info_collection_json, @planning_run_state_json,
          @revision, @created_at, @updated_at, @user_id
        )
      `,
    )
    .run({
      id: normalized.id,
      title: normalized.title,
      goal_id: normalized.goalId ?? null,
      workspace_path: normalized.workspacePath ?? null,
      workspace_initialized_at: normalized.workspaceInitializedAt ?? null,
      runtime_env_id: normalized.runtimeEnvId ?? null,
      claude_session_id: normalized.claudeSessionId ?? null,
      status: normalized.status ?? "idle",
      pinned: normalized.pinned ? 1 : 0,
      goal_info_collection_json: normalized.goalInfoCollection ? JSON.stringify(normalized.goalInfoCollection) : null,
      planning_run_state_json: normalized.planningRunState ? JSON.stringify(normalized.planningRunState) : null,
      revision: 1,
      created_at: normalized.updatedAt || now,
      updated_at: normalized.updatedAt || now,
      user_id: "local-user",
    });
  return getConversation(normalized.id);
}

export function deleteConversation(conversationId: string) {
  const db = getDatabase();
  return db.transaction(() => {
    deleteRelatedConversationData(conversationId);
    db.prepare(`DELETE FROM conversation_event_log WHERE conversation_id = ?`).run(conversationId);
    const result = db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversationId);
    return result.changes > 0;
  })();
}

export function updateConversationFields(
  conversationId: string,
  patch: Partial<{
    title: string;
    goalId: string | null;
    workspacePath: string | null;
    workspaceInitializedAt: string | null;
    runtimeEnvId: string | null;
    claudeSessionId: string | null;
    status: Conversation["status"];
    pinned: boolean;
    goalInfoCollection: GoalInfoCollection | null;
    planningRunState: GoalPlanningRunState | null;
    unread: boolean;
  }>,
) {
  const current = getConversation(conversationId);
  if (!current) return null;
  const next = {
    ...current.conversation,
    ...patch,
    goalId: patch.goalId === null ? undefined : (patch.goalId ?? current.conversation.goalId),
    workspacePath:
      patch.workspacePath === null ? undefined : (patch.workspacePath ?? current.conversation.workspacePath),
    workspaceInitializedAt:
      patch.workspaceInitializedAt === null
        ? undefined
        : (patch.workspaceInitializedAt ?? current.conversation.workspaceInitializedAt),
    runtimeEnvId: patch.runtimeEnvId === null ? undefined : (patch.runtimeEnvId ?? current.conversation.runtimeEnvId),
    claudeSessionId:
      patch.claudeSessionId === null ? undefined : (patch.claudeSessionId ?? current.conversation.claudeSessionId),
    goalInfoCollection:
      patch.goalInfoCollection === null
        ? undefined
        : (patch.goalInfoCollection ?? current.conversation.goalInfoCollection),
    planningRunState:
      patch.planningRunState === null ? undefined : (patch.planningRunState ?? current.conversation.planningRunState),
    updatedAt: new Date().toISOString(),
  } satisfies Conversation;
  const revision = current.revision + 1;
  getDatabase()
    .prepare(
      `
        UPDATE conversations
        SET title = @title,
            goal_id = @goal_id,
            workspace_path = @workspace_path,
            workspace_initialized_at = @workspace_initialized_at,
            runtime_env_id = @runtime_env_id,
            claude_session_id = @claude_session_id,
            status = @status,
            pinned = @pinned,
            goal_info_collection_json = @goal_info_collection_json,
            planning_run_state_json = @planning_run_state_json,
            revision = @revision,
            updated_at = @updated_at
        WHERE id = @id
      `,
    )
    .run({
      id: conversationId,
      title: next.title,
      goal_id: next.goalId ?? null,
      workspace_path: next.workspacePath ?? null,
      workspace_initialized_at: next.workspaceInitializedAt ?? null,
      runtime_env_id: next.runtimeEnvId ?? null,
      claude_session_id: next.claudeSessionId ?? null,
      status: next.status ?? "idle",
      pinned: next.pinned ? 1 : 0,
      goal_info_collection_json: next.goalInfoCollection ? JSON.stringify(next.goalInfoCollection) : null,
      planning_run_state_json: next.planningRunState ? JSON.stringify(next.planningRunState) : null,
      revision,
      updated_at: next.updatedAt,
    });
  return { conversation: next, revision };
}
