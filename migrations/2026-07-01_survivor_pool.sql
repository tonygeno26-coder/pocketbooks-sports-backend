-- survivor_pools
CREATE TABLE IF NOT EXISTS public.survivor_pools (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL,
  season integer NOT NULL DEFAULT 2026,
  join_code text UNIQUE NOT NULL,
  created_by text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','canceled')),
  current_week integer NOT NULL DEFAULT 1,
  pick_deadline_day text NOT NULL DEFAULT 'Sunday',
  pick_deadline_time text NOT NULL DEFAULT '13:00',
  created_at timestamptz DEFAULT now()
);

-- survivor_entries
CREATE TABLE IF NOT EXISTS public.survivor_entries (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pool_id text NOT NULL REFERENCES survivor_pools(id),
  player_id text NOT NULL,
  player_username text,
  status text NOT NULL DEFAULT 'alive' CHECK (status IN ('alive','eliminated')),
  eliminated_week integer,
  joined_at timestamptz DEFAULT now(),
  UNIQUE(pool_id, player_id)
);

-- survivor_picks
CREATE TABLE IF NOT EXISTS public.survivor_picks (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pool_id text NOT NULL REFERENCES survivor_pools(id),
  player_id text NOT NULL,
  week integer NOT NULL,
  team text NOT NULL,
  game_id text,
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','won','lost')),
  picked_at timestamptz DEFAULT now(),
  graded_at timestamptz,
  UNIQUE(pool_id, player_id, week),
  UNIQUE(pool_id, player_id, team)
);

CREATE INDEX IF NOT EXISTS idx_survivor_entries_pool ON survivor_entries(pool_id);
CREATE INDEX IF NOT EXISTS idx_survivor_picks_pool_week ON survivor_picks(pool_id, week);

-- Backend uses service_role; no anon/authenticated policies yet.
ALTER TABLE public.survivor_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survivor_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survivor_picks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.survivor_pools FROM anon, authenticated;
REVOKE ALL ON public.survivor_entries FROM anon, authenticated;
REVOKE ALL ON public.survivor_picks FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.survivor_pools TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.survivor_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.survivor_picks TO service_role;
