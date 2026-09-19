PRAGMA foreign_keys = ON;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  telegram_update_id INTEGER NOT NULL,
  url_index INTEGER NOT NULL DEFAULT 0 CHECK (url_index >= 0),
  chat_id TEXT,
  message_id INTEGER,
  original_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  url_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE UNIQUE INDEX jobs_update_url_idx ON jobs (telegram_update_id, url_index);
CREATE INDEX jobs_status_created_idx ON jobs (status, created_at);
CREATE INDEX jobs_chat_created_idx ON jobs (chat_id, created_at);

CREATE TABLE errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  error_code TEXT NOT NULL,
  message TEXT NOT NULL,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  provider_status INTEGER,
  attempt_number INTEGER NOT NULL DEFAULT 0 CHECK (attempt_number >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
);

CREATE INDEX errors_job_created_idx ON errors (job_id, created_at);
CREATE INDEX errors_retryable_idx ON errors (retryable, created_at);
