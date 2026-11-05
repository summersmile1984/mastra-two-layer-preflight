-- 0006_permissions.sql — 用户权限规则 / 用户设置（schedules-secrets spec S2.2，移植远端 0005 的数据面）
-- 消费方（HITL 审批/工具放行）在后续切片接入
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
