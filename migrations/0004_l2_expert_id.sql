-- Experts are L2 (same pipeline as ACP/CUA sandbox jobs). NULL expert_id = sandbox/ACP task.
ALTER TABLE l2_tasks ADD COLUMN expert_id TEXT;
CREATE INDEX IF NOT EXISTS idx_l2_tasks_expert ON l2_tasks(expert_id, state);
