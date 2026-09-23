-- Phase 13: introduce workspace ownership without deleting existing records.
-- The legacy installation is assigned to workspace_default. Existing URL hashes
-- remain stable for that workspace so current Sheets rows continue to reconcile.

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  external_subject TEXT UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS telegram_connections (
  chat_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connected_by_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  FOREIGN KEY (connected_by_user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS telegram_connections_workspace_idx ON telegram_connections (workspace_id, status);

CREATE TABLE IF NOT EXISTS google_connections (
  workspace_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'apps_script_bridge',
  external_reference TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect', 'disconnected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT PRIMARY KEY,
  extraction_provider TEXT NOT NULL DEFAULT 'groq',
  extraction_model TEXT NOT NULL DEFAULT 'openai/gpt-oss-120b',
  max_urls_per_message INTEGER NOT NULL DEFAULT 10 CHECK (max_urls_per_message > 0),
  settings_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO workspaces (id, name, status) VALUES ('workspace_default', 'Legacy owner workspace', 'active');
INSERT OR IGNORE INTO users (id, external_subject, display_name) VALUES ('user_legacy_owner', 'legacy-owner', 'Legacy owner');
INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES ('workspace_default', 'user_legacy_owner', 'owner');
INSERT OR IGNORE INTO workspace_settings (workspace_id) VALUES ('workspace_default');

-- Rebuild only the jobs table so the old global URL/update uniqueness rules are
-- replaced with workspace-scoped rules. Data and all existing columns are copied.
PRAGMA foreign_keys = OFF;

CREATE TABLE jobs_v6 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'workspace_default',
  telegram_update_id INTEGER NOT NULL,
  url_index INTEGER NOT NULL DEFAULT 0 CHECK (url_index >= 0),
  chat_id TEXT,
  message_id INTEGER,
  original_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  canonical_url_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  sheet_row_number INTEGER,
  sheet_synced_at TEXT,
  original_message TEXT,
  user_note TEXT,
  sender_name TEXT,
  sender_username TEXT,
  record_state TEXT NOT NULL DEFAULT 'active' CHECK (record_state IN ('active', 'archived')),
  state_changed_at TEXT
);

INSERT INTO jobs_v6 (
  id, workspace_id, telegram_update_id, url_index, chat_id, message_id,
  original_url, normalized_url, url_hash, canonical_url_hash, status,
  attempt_count, provider, result_json, created_at, updated_at, completed_at,
  sheet_row_number, sheet_synced_at, original_message, user_note, sender_name,
  sender_username, record_state, state_changed_at
)
SELECT
  id, 'workspace_default', telegram_update_id, url_index, chat_id, message_id,
  original_url, normalized_url, url_hash, url_hash, status,
  attempt_count, provider, result_json, created_at, updated_at, completed_at,
  sheet_row_number, sheet_synced_at, original_message, user_note, sender_name,
  sender_username, record_state, state_changed_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v6 RENAME TO jobs;

CREATE UNIQUE INDEX jobs_workspace_url_idx ON jobs (workspace_id, canonical_url_hash);
CREATE UNIQUE INDEX jobs_workspace_update_url_idx ON jobs (workspace_id, telegram_update_id, url_index);
CREATE INDEX jobs_status_created_idx ON jobs (workspace_id, status, created_at);
CREATE INDEX jobs_chat_created_idx ON jobs (workspace_id, chat_id, created_at);
CREATE INDEX jobs_storage_hash_idx ON jobs (url_hash);
CREATE INDEX jobs_sheet_row_idx ON jobs (workspace_id, sheet_row_number);

PRAGMA foreign_keys = ON;

ALTER TABLE errors ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'workspace_default';
ALTER TABLE job_deletions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'workspace_default';
ALTER TABLE job_replays ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'workspace_default';
ALTER TABLE job_alerts ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'workspace_default';

CREATE INDEX errors_workspace_created_idx ON errors (workspace_id, created_at);
CREATE INDEX job_deletions_workspace_idx ON job_deletions (workspace_id, deleted_at);
CREATE INDEX job_replays_workspace_idx ON job_replays (workspace_id, created_at);
CREATE INDEX job_alerts_workspace_idx ON job_alerts (workspace_id, created_at);

INSERT OR IGNORE INTO telegram_connections (chat_id, workspace_id, status)
SELECT DISTINCT chat_id, 'workspace_default', 'active'
FROM jobs
WHERE chat_id IS NOT NULL;
