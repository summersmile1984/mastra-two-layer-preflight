-- 0005_schedules.sql — 定时任务（schedules）+ 运行记录（schedule_runs）
-- 产品级 cron 例程（Workers cron tick 驱动），非 Mastra Workflows EE。
-- D1 = SQLite。日期一律 INTEGER（Unix 毫秒），布尔 INTEGER 0/1。
-- 应用方式：npx wrangler d1 execute mastra-l1 --remote --file migrations/0005_schedules.sql

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  prompt TEXT NOT NULL,
  -- 本产品 target 只有聊天房间（主会话 = is_main=1 的房间）；butler/expert 枚举后续切片再放开
  target_type TEXT NOT NULL CHECK (target_type IN ('room')),
  target_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_user ON schedules(user_id, enabled);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS schedule_runs_sched ON schedule_runs(schedule_id, created_at);
