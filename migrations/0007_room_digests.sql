-- Room → user conclusion digests (cross-room awareness for butler DM).
-- Membership-filtered promotion; leave-room stops new rows; historical digests retained.
CREATE TABLE IF NOT EXISTS room_digests (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  evidence TEXT,
  open_questions TEXT,
  task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS room_digests_user ON room_digests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS room_digests_room ON room_digests(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS room_digests_task ON room_digests(task_id);
