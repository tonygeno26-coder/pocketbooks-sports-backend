-- 2026-05-22_canonical_market_identity
--
-- Adds canonical / structured identity columns to odds_snapshots so the
-- snapshot upsert (priority #12 plumbing) and the verifier (priority #11
-- canonical lookup) can persist and retrieve player-prop + structured
-- market identity without overloading display strings.
--
-- Safe on Railway: every statement is idempotent (`ADD COLUMN IF NOT
-- EXISTS`, `CREATE INDEX IF NOT EXISTS`). Existing rows keep their values
-- and get NULL in the new columns until the next upsert overwrites them.
--
-- Run order:
--   1. ALTER TABLE adds 10 new columns. No-op when they already exist.
--   2. CREATE INDEX adds a composite index keyed by (canonical_market_key,
--      canonical_selection_key). The verifier's canonical lookup uses this
--      pair, so the index is the critical path.
--
-- Rollback: drop the columns + index. Not provided here because the
-- snapshot upsert tolerates either schema (catch block strips the new
-- columns when missing) — you can roll the app back without rolling the
-- DB back.

ALTER TABLE odds_snapshots
  ADD COLUMN IF NOT EXISTS canonical_market_key     TEXT,
  ADD COLUMN IF NOT EXISTS canonical_selection_key  TEXT,
  ADD COLUMN IF NOT EXISTS market_type              TEXT,
  ADD COLUMN IF NOT EXISTS provider_game_id         TEXT,
  ADD COLUMN IF NOT EXISTS player_name              TEXT,
  ADD COLUMN IF NOT EXISTS player_name_normalized   TEXT,
  ADD COLUMN IF NOT EXISTS prop_type                TEXT,
  ADD COLUMN IF NOT EXISTS prop_type_normalized     TEXT,
  ADD COLUMN IF NOT EXISTS prop_side                TEXT,
  ADD COLUMN IF NOT EXISTS player_team              TEXT;

CREATE INDEX IF NOT EXISTS idx_odds_snapshots_canonical
  ON odds_snapshots (canonical_market_key, canonical_selection_key);
