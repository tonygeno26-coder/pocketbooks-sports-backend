-- Per-club lock: when true, new join requests are rejected.
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS is_locked boolean DEFAULT false;
