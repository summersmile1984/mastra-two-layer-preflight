-- 0007_experts.sql — L2 专家目录 + l2_tasks 专家管道（l2-experts spec S2.2/S2.3）
-- L1 只有一个主 agent；专家定义在此表，执行位 = 用户 PC/云电脑（L2 Mastra Agent）
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

ALTER TABLE l2_tasks ADD COLUMN expert_id TEXT;
ALTER TABLE l2_tasks ADD COLUMN instructions TEXT;
ALTER TABLE l2_tasks ADD COLUMN kind TEXT DEFAULT 'sandbox';
CREATE INDEX IF NOT EXISTS idx_l2_tasks_expert ON l2_tasks(expert_id, state);
