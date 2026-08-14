-- Phase-based team reuse: unique per (pool, player, team) within
-- regular season (weeks 1-18) or playoffs (weeks 19+) separately.
-- A team used in Week 5 may be reused in Wild Card (Week 19).

ALTER TABLE public.survivor_picks
  DROP CONSTRAINT IF EXISTS survivor_picks_pool_id_player_id_team_key;

DROP INDEX IF EXISTS public.survivor_picks_pool_id_player_id_team_key;

CREATE UNIQUE INDEX IF NOT EXISTS survivor_picks_team_phase
ON public.survivor_picks (
  pool_id,
  player_id,
  team,
  ((CASE WHEN week <= 18 THEN 'regular' ELSE 'playoffs' END))
);
