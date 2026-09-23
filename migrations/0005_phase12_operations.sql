CREATE TABLE job_replays (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  requested_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX job_replays_job_created_idx ON job_replays (job_id, created_at);

CREATE TABLE job_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_key TEXT NOT NULL UNIQUE,
  job_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE INDEX job_alerts_job_created_idx ON job_alerts (job_id, created_at);
CREATE INDEX job_alerts_kind_created_idx ON job_alerts (kind, created_at);
