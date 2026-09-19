ALTER TABLE jobs ADD COLUMN record_state TEXT NOT NULL DEFAULT 'active' CHECK (record_state IN ('active', 'archived'));
ALTER TABLE jobs ADD COLUMN state_changed_at TEXT;

CREATE INDEX jobs_record_state_idx ON jobs (record_state, updated_at);

CREATE TABLE job_deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  result_json TEXT,
  deleted_by TEXT,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX job_deletions_hash_idx ON job_deletions (url_hash, deleted_at);
