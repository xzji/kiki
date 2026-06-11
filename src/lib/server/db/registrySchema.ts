export const REGISTRY_DB_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS machines (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  name         TEXT,
  fingerprint  TEXT,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_machines_user ON machines(user_id);

CREATE TABLE IF NOT EXISTS invite_codes (
  code             TEXT PRIMARY KEY,
  created_at       TEXT NOT NULL,
  used_at          TEXT,
  used_by_user_id  TEXT,
  max_uses         INTEGER NOT NULL DEFAULT 1,
  usage_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_used ON invite_codes(used_at);

CREATE TABLE IF NOT EXISTS invite_code_redemptions (
  code       TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  used_at    TEXT NOT NULL,
  PRIMARY KEY (code, user_id)
);
CREATE INDEX IF NOT EXISTS idx_invite_code_redemptions_user ON invite_code_redemptions(user_id);
`;
