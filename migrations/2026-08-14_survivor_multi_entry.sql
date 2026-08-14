-- Add request/approval fields to survivor_entries
ALTER TABLE survivor_entries ADD COLUMN IF NOT EXISTS entry_number integer NOT NULL DEFAULT 1;
ALTER TABLE survivor_entries ADD COLUMN IF NOT EXISTS entry_label text;
ALTER TABLE survivor_entries ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE survivor_entries ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- Add a join_requests table
CREATE TABLE IF NOT EXISTS survivor_join_requests (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pool_id text NOT NULL REFERENCES survivor_pools(id),
  player_id text NOT NULL,
  player_username text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  entries_granted integer,
  requested_at timestamptz DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by text,
  UNIQUE(pool_id, player_id)
);

-- Drop old unique constraint (one entry per player per pool)
ALTER TABLE survivor_entries DROP CONSTRAINT IF EXISTS survivor_entries_pool_id_player_id_key;

-- New constraint: one row per entry number per player per pool
CREATE UNIQUE INDEX IF NOT EXISTS survivor_entries_pool_player_entry
ON survivor_entries(pool_id, player_id, entry_number);

-- Add entry_number to survivor_picks
ALTER TABLE survivor_picks ADD COLUMN IF NOT EXISTS entry_number integer NOT NULL DEFAULT 1;

-- Drop old unique constraints on picks
ALTER TABLE survivor_picks DROP CONSTRAINT IF EXISTS survivor_picks_pool_id_player_id_week_key;
DROP INDEX IF EXISTS survivor_picks_pool_id_player_id_week_key;
DROP INDEX IF EXISTS survivor_picks_team_phase;

-- New unique: one pick per entry per week
CREATE UNIQUE INDEX IF NOT EXISTS survivor_picks_entry_week
ON survivor_picks(pool_id, player_id, entry_number, week);

-- New team reuse: one team per entry per phase
CREATE UNIQUE INDEX IF NOT EXISTS survivor_picks_entry_team_phase
ON survivor_picks(pool_id, player_id, entry_number, team,
  ((CASE WHEN week <= 18 THEN 'regular' ELSE 'playoffs' END)));

CREATE INDEX IF NOT EXISTS idx_survivor_join_requests_pool
ON survivor_join_requests(pool_id, status);

-- Backend uses service_role; lock down the new table like the other survivor tables.
ALTER TABLE public.survivor_join_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.survivor_join_requests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.survivor_join_requests TO service_role;

UPDATE survivor_entries
SET entry_label = COALESCE(NULLIF(player_username,''), 'Entry') || ' #' || entry_number
WHERE entry_label IS NULL;
