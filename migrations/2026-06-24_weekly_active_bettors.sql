-- weekly_active_bettors: tracks which players have been charged the host
-- active-bettor diamond fee for a given club + ISO week (Monday start).
-- Used by _processActiveBettorCharge() after place_bet_tx succeeds.

CREATE TABLE IF NOT EXISTS public.weekly_active_bettors (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id           text NOT NULL,
  player_id         text NOT NULL,
  week_start        date NOT NULL,
  first_ticket_id   text,
  activated_at      timestamptz NOT NULL DEFAULT now(),
  charged_diamonds  numeric NOT NULL DEFAULT 15,
  charge_ledger_id  text,
  CONSTRAINT weekly_active_bettors_club_player_week_unique
    UNIQUE (club_id, player_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_active_bettors_club_week
  ON public.weekly_active_bettors (club_id, week_start);

CREATE INDEX IF NOT EXISTS idx_weekly_active_bettors_player
  ON public.weekly_active_bettors (player_id);

ALTER TABLE public.weekly_active_bettors ENABLE ROW LEVEL SECURITY;

-- Backend uses service_role; no anon/authenticated policies yet.
REVOKE ALL ON public.weekly_active_bettors FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.weekly_active_bettors TO service_role;
