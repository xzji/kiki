export const KIKI_DB_SCHEMA_VERSION = 15;

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
  topic_id TEXT,
  thread_id TEXT,
  saga_instance_id TEXT,
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

CREATE INDEX IF NOT EXISTS idx_runtime_jobs_thread
  ON runtime_jobs(thread_id, status);

CREATE INDEX IF NOT EXISTS idx_runtime_jobs_topic
  ON runtime_jobs(topic_id);

CREATE TABLE IF NOT EXISTS runtime_state_snapshots (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- v12 注：本表 envelope key 含 "goals"（旧）与 "topics"（新），双写期同时存在；
-- value_json 内部的 Goal/SubGoal → Topic/Thread 形态映射由读路径完成。

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

-- ========================================================================
-- v11 终态：Topic / Thread Event Sourcing 基础设施
-- 计划引用：.trae/documents/Topic_Thread_代码实现计划_v1.md §3.1.1 + §9.1 + §12.4
-- ========================================================================

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  topic_id TEXT,
  thread_id TEXT,
  task_id TEXT,
  runtime_job_id TEXT,
  saga_instance_id TEXT,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_topic
  ON agent_runs(topic_id);

CREATE INDEX IF NOT EXISTS idx_agent_runs_saga
  ON agent_runs(saga_instance_id);

CREATE INDEX IF NOT EXISTS idx_agent_runs_thread
  ON agent_runs(thread_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_runtime_job
  ON agent_runs(runtime_job_id, started_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_idem
  ON agent_runs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(agent_run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_events_run
  ON agent_events(agent_run_id, seq);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  saga_instance_id TEXT NOT NULL,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_saga
  ON agent_messages(saga_instance_id, created_at);

CREATE TABLE IF NOT EXISTS saga_instances (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_saga_instances_topic
  ON saga_instances(topic_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saga_instances_idem
  ON saga_instances(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_snapshots (
  agent_run_id TEXT PRIMARY KEY,
  last_event_seq INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_item_states (
  inbox_item_id TEXT PRIMARY KEY,
  goal_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  favorite INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 1,
  snooze_until TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_item_states_status
  ON inbox_item_states(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_notification_states (
  instance_id TEXT PRIMARY KEY,
  goal_id TEXT,
  task_id TEXT,
  notification_json TEXT NOT NULL,
  delivery_state TEXT NOT NULL,
  notification_sequence INTEGER NOT NULL DEFAULT 0,
  inbox_item_id TEXT,
  conversation_message_ids_json TEXT,
  delivered_at TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_notification_states_delivery
  ON task_notification_states(delivery_state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_notification_states_goal
  ON task_notification_states(goal_id, task_id);
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
  {
    // v11 — Topic / Thread Event Sourcing infrastructure
    // Plan ref: .trae/documents/Topic_Thread_代码实现计划_v1.md §3.1.1 + §9.1
    version: 11,
    sql: `
      ALTER TABLE runtime_jobs ADD COLUMN topic_id TEXT;
      ALTER TABLE runtime_jobs ADD COLUMN thread_id TEXT;
      ALTER TABLE runtime_jobs ADD COLUMN saga_instance_id TEXT;

      -- §10.4：双写期一次性回填 goal_id → topic_id（旧任务读路径降级）
      UPDATE runtime_jobs
        SET topic_id = goal_id
        WHERE topic_id IS NULL AND goal_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_runtime_jobs_thread
        ON runtime_jobs(thread_id, status);

      CREATE INDEX IF NOT EXISTS idx_runtime_jobs_topic
        ON runtime_jobs(topic_id);

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        topic_id TEXT,
        thread_id TEXT,
        task_id TEXT,
        saga_instance_id TEXT,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_runs_topic
        ON agent_runs(topic_id);

      CREATE INDEX IF NOT EXISTS idx_agent_runs_saga
        ON agent_runs(saga_instance_id);

      CREATE INDEX IF NOT EXISTS idx_agent_runs_thread
        ON agent_runs(thread_id, started_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_idem
        ON agent_runs(idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        agent_run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_ref TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(agent_run_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_events_run
        ON agent_events(agent_run_id, seq);

      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        saga_instance_id TEXT NOT NULL,
        from_role TEXT NOT NULL,
        to_role TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_messages_saga
        ON agent_messages(saga_instance_id, created_at);

      CREATE TABLE IF NOT EXISTS saga_instances (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_saga_instances_topic
        ON saga_instances(topic_id, status);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_saga_instances_idem
        ON saga_instances(idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS agent_snapshots (
        agent_run_id TEXT PRIMARY KEY,
        last_event_seq INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    // v12 — Topic / Thread 物理迁移：复制 runtime_state_snapshots["goals"] →
    // ["topics"] 双写期键，保留 "goals" 行 1 个版本（§10.5 问题 25）。
    // 注意：本步骤是 SQL 行级复制（仅 envelope 层），envelope.value 内部的
    // Goal/SubGoal → Topic/Thread 形态映射由读路径在解析时通过
    // legacyGoalToTopic 完成（§9.4 问题 13），避免 SQL 内做 JSON 重写带来的
    // 复杂转义。
    version: 12,
    sql: `
      INSERT INTO runtime_state_snapshots (key, value_json, updated_at)
      SELECT 'topics', value_json, updated_at
        FROM runtime_state_snapshots
        WHERE key = 'goals'
          AND NOT EXISTS (
            SELECT 1 FROM runtime_state_snapshots WHERE key = 'topics'
          );
    `,
  },
  {
    // v13 — Link Goal Task runtime_jobs to AgentRuntime event-sourced runs.
    version: 13,
    sql: `
      ALTER TABLE agent_runs ADD COLUMN runtime_job_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_agent_runs_runtime_job
        ON agent_runs(runtime_job_id, started_at ASC);
    `,
  },
  {
    // v14 — Inbox 卡片用户操作状态覆盖表（归档/稍后/收藏/未读）。
    version: 14,
    sql: `
      CREATE TABLE IF NOT EXISTS inbox_item_states (
        inbox_item_id TEXT PRIMARY KEY,
        goal_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        favorite INTEGER NOT NULL DEFAULT 0,
        unread INTEGER NOT NULL DEFAULT 1,
        snooze_until TEXT,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_inbox_item_states_status
        ON inbox_item_states(status, updated_at DESC);
    `,
  },
  {
    // v15 — 任务通知决策与投递账本从 goals instance.notification 独立出来。
    version: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS task_notification_states (
        instance_id TEXT PRIMARY KEY,
        goal_id TEXT,
        task_id TEXT,
        notification_json TEXT NOT NULL,
        delivery_state TEXT NOT NULL,
        notification_sequence INTEGER NOT NULL DEFAULT 0,
        inbox_item_id TEXT,
        conversation_message_ids_json TEXT,
        delivered_at TEXT,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_notification_states_delivery
        ON task_notification_states(delivery_state, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_task_notification_states_goal
        ON task_notification_states(goal_id, task_id);
    `,
  },
];
