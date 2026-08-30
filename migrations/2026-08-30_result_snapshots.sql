-- Server-trusted final scores for MLB (and other sports) grading.
-- Worker upserts on canonical_game_key; service_role only.
CREATE TABLE IF NOT EXISTS public.result_snapshots (
  result_snapshot_id text PRIMARY KEY,
  sport text,
  event_id text,
  canonical_game_key text NOT NULL,
  home_team text,
  away_team text,
  commence_time timestamptz,
  status text NOT NULL DEFAULT 'scheduled',
  home_score integer,
  away_score integer,
  winner text,
  final_at timestamptz,
  source text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS result_snapshots_canonical_game_key_uidx
  ON public.result_snapshots (canonical_game_key);

CREATE INDEX IF NOT EXISTS result_snapshots_status_fetched_idx
  ON public.result_snapshots (status, fetched_at DESC);

ALTER TABLE public.result_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS result_snapshots_deny_anon ON public.result_snapshots;
CREATE POLICY result_snapshots_deny_anon ON public.result_snapshots
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS result_snapshots_deny_authenticated ON public.result_snapshots;
CREATE POLICY result_snapshots_deny_authenticated ON public.result_snapshots
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON public.result_snapshots FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.result_snapshots TO service_role;
