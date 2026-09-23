-- Phase 15: short-lived, single-use Telegram workspace connection tokens.

CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  connection_kind TEXT NOT NULL DEFAULT 'any' CHECK (connection_kind IN ('any', 'private', 'group')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  connected_chat_id TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS telegram_link_tokens_expiry_idx ON telegram_link_tokens (expires_at, consumed_at);
CREATE INDEX IF NOT EXISTS telegram_link_tokens_workspace_idx ON telegram_link_tokens (workspace_id, created_at);
