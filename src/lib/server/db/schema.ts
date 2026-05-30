export const KIKI_DB_SCHEMA_VERSION = 10;

export const KIKI_DB_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_jobs (
  id TEXT PRIMARY KEY,
  task_instance_id TEXT,
  task_id TEXT,
  goal_id TEXT,
  conversation_id TEXT,
  user_id TEXT NOT NULL DEFAULT 'local-user',
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT,
  runtime_env_id TEXT,
  runtime_transport TEXT NOT NULL DEFAULT 'local_daemon',
  payload_json TEXT NOT NULL,
  progress_json TEXT,
  logs_json TEXT,
  trajectory_json TEXT,
  blocker_json TEXT,
  result_json TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  available_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_jobs_status_available
  ON runtime_jobs(status, available_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_runtime_jobs_task_instance_id
  ON runtime_jobs(task_instance_id);

CREATE TABLE IF NOT EXISTS runtime_state_snapshots (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  task_id TEXT,
  instance_id TEXT,
  runtime_job_id TEXT,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  summary TEXT,
  storage_rel_path TEXT,
  mime TEXT,
  size INTEGER,
  url TEXT,
  embed_url TEXT,
  provider TEXT,
  inline_content TEXT,
  manifest_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_conversation
  ON artifacts(conversation_id);

CREATE INDEX IF NOT EXISTS idx_artifacts_instance
  ON artifacts(instance_id);

CREATE TABLE IF NOT EXISTS artifact_interaction_state (
  artifact_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  task_id TEXT,
  instance_id TEXT,
  state_json TEXT NOT NULL,
  events_json TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifact_interaction_conversation_updated
  ON artifact_interaction_state(conversation_id, updated_at);

CREATE TABLE IF NOT EXISTS goal_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  goal_id TEXT NOT NULL,
  task_id TEXT,
  instance_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  produced_by TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_event_log_goal
  ON goal_event_log(goal_id, id);

CREATE INDEX IF NOT EXISTS idx_goal_event_log_idempotency_key
  ON goal_event_log(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_goal_event_log_instance
  ON goal_event_log(instance_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_event_log_idem
  ON goal_event_log(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS goal_deliverables (
  goal_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal_id TEXT,
  workspace_path TEXT,
  workspace_initialized_at TEXT,
  runtime_env_id TEXT,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  pinned INTEGER NOT NULL DEFAULT 0,
  goal_info_collection_json TEXT,
  planning_run_state_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'local-user'
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated
  ON conversations(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_goal
  ON conversations(goal_id);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  source TEXT,
  status TEXT,
  content TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  ref_json TEXT,
  snapshot_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_seq
  ON conversation_messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS conversation_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  produced_by TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_event_log_conv
  ON conversation_event_log(conversation_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_event_log_idem
  ON conversation_event_log(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`;

export const KIKI_DB_MIGRATIONS: Array<{
  version: number;
  sql: string;
}> = [
  {
    version: 2,
    sql: `
      ALTER TABLE runtime_jobs ADD COLUMN trajectory_json TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE runtime_jobs ADD COLUMN blocker_json TEXT;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        task_id TEXT,
        instance_id TEXT,
        runtime_job_id TEXT,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        summary TEXT,
        storage_rel_path TEXT,
        mime TEXT,
        size INTEGER,
        url TEXT,
        inline_content TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_conversation
        ON artifacts(conversation_id);

      CREATE INDEX IF NOT EXISTS idx_artifacts_instance
        ON artifacts(instance_id);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE artifacts ADD COLUMN manifest_json TEXT;

      CREATE TABLE IF NOT EXISTS artifact_interaction_state (
        artifact_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        task_id TEXT,
        instance_id TEXT,
        state_json TEXT NOT NULL,
        events_json TEXT,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_interaction_conversation_updated
        ON artifact_interaction_state(conversation_id, updated_at);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE artifacts ADD COLUMN embed_url TEXT;
      ALTER TABLE artifacts ADD COLUMN provider TEXT;
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS goal_event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        goal_id TEXT NOT NULL,
        task_id TEXT,
        instance_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        produced_by TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_goal_event_log_goal
        ON goal_event_log(goal_id, id);

      CREATE INDEX IF NOT EXISTS idx_goal_event_log_instance
        ON goal_event_log(instance_id, id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_event_log_idem
        ON goal_event_log(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    version: 8,
    sql: `
      DELETE FROM goal_event_log
      WHERE idempotency_key IS NOT NULL
        AND id NOT IN (
          SELECT MIN(id)
          FROM goal_event_log
          WHERE idempotency_key IS NOT NULL
          GROUP BY idempotency_key
        );

      DROP INDEX IF EXISTS idx_goal_event_log_idem;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_event_log_idem
        ON goal_event_log(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS goal_deliverables (
        goal_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal_id TEXT,
        workspace_path TEXT,
        workspace_initialized_at TEXT,
        runtime_env_id TEXT,
        claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        pinned INTEGER NOT NULL DEFAULT 0,
        goal_info_collection_json TEXT,
        planning_run_state_json TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'local-user'
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_updated
        ON conversations(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_conversations_goal
        ON conversations(goal_id);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        role TEXT NOT NULL,
        source TEXT,
        status TEXT,
        content TEXT NOT NULL,
        unread INTEGER NOT NULL DEFAULT 0,
        ref_json TEXT,
        snapshot_json TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (conversation_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conv_seq
        ON conversation_messages(conversation_id, seq);

      CREATE TABLE IF NOT EXISTS conversation_event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        produced_by TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conv_event_log_conv
        ON conversation_event_log(conversation_id, id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_event_log_idem
        ON conversation_event_log(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `,
  },
];
