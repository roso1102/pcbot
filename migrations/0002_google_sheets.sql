ALTER TABLE jobs ADD COLUMN sheet_row_number INTEGER;
ALTER TABLE jobs ADD COLUMN sheet_synced_at TEXT;

CREATE INDEX jobs_sheet_row_idx ON jobs (sheet_row_number);
