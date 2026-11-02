-- Optional custom butler display name per user (NULL → UI/API fall back to 管家 Orchestrator).
-- D1-safe: single ALTER ADD COLUMN; existing rows get NULL.
ALTER TABLE butler_profile ADD COLUMN display_name TEXT;
