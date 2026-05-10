export const KIKI_DB_SCHEMA_VERSION = 1;

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
`;
