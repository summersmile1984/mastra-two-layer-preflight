-- Per-user MCP / "连接应用" stubs. Real MCPClient.listToolsets injection is TODO on Workers.
CREATE TABLE IF NOT EXISTS user_mcp_connections (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  label TEXT,
  config_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, server_id)
);
CREATE INDEX IF NOT EXISTS user_mcp_connections_user ON user_mcp_connections(user_id);
