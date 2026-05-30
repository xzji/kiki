import { migrateConversationIds } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
import { listConversationMessages } from "@/lib/server/repositories/conversationMessagesRepository";
import type { Conversation, GoalInfoCollection, GoalPlanningRunState } from "@/types/kiki";

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
