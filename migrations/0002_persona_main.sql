-- 0002_persona_main.sql — 主会话标记 + 可配置人格（persona-main-session spec S2.1/S2.2）
-- 应用方式：npx wrangler d1 execute mastra-l1 --remote --file migrations/0002_persona_main.sql
-- （运行时 db() 链路也有幂等 ALTER/CREATE，两边一致）

ALTER TABLE rooms ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS persona_config (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  style TEXT NOT NULL,
  main_room_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
