-- Settings: 权限 / 保险库 / 用量；Agent Builder；MCP connection ↔ vault link; l2_tasks.user_id for usage attribution.
CREATE TABLE IF NOT EXISTS user_permission_rules (
  user_id TEXT NOT NULL,
  category_or_tool TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('allow','ask','deny')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, category_or_tool)
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  auto_review INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_secrets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_secrets_user ON vault_secrets(user_id, created_at);
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_user ON usage_events(user_id, created_at);
CREATE TABLE IF NOT EXISTS agent_defs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  instructions TEXT NOT NULL,
  model TEXT,
  tools_json TEXT,
  mcp_json TEXT,
  memory_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_defs_owner ON agent_defs(owner_user_id, updated_at);
ALTER TABLE user_mcp_connections ADD COLUMN vault_id TEXT;
ALTER TABLE l2_tasks ADD COLUMN user_id TEXT;
