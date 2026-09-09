-- PROPOSED (DO NOT APPLY without explicit approval)
-- Explicit auditable opening-balance primitive for Option A go-live bootstrap.
-- NOT fake tickets. Historical P&L opens at 0 after T0 epoch marker; intentional
-- residues (−500 / +300) are preserved here per (club_id, player_id).
-- NEVER apply to production without signed-off rehearsal + human review of ambiguous accounts.
-- Additive / reversible.

BEGIN;

CREATE TABLE IF NOT EXISTS public.settlement_opening_balances (
  bootstrap_id      text PRIMARY KEY,
  club_id           text NOT NULL,
  player_id         text NOT NULL,
  t0                timestamptz NOT NULL,
  opening_balance   numeric(14,2) NOT NULL,
  rationale         text,
  source            text NOT NULL DEFAULT 'bootstrap_rehearsal'
                      CHECK (source IN (
                        'bootstrap_rehearsal',
                        'bootstrap_prod',
                        'manual_review'
                      )),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  CONSTRAINT settlement_opening_balances_club_player_uidx UNIQUE (club_id, player_id)
);

CREATE INDEX IF NOT EXISTS settlement_opening_balances_club_idx
  ON public.settlement_opening_balances (club_id);

COMMENT ON TABLE public.settlement_opening_balances IS
  'Option A go-live opening settlement balances (signed player POV). Not ticket bankroll.';

COMMIT;

-- ROLLBACK:
--   DROP INDEX IF EXISTS public.settlement_opening_balances_club_idx;
--   DROP TABLE IF EXISTS public.settlement_opening_balances;
