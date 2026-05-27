-- ============================================================================
-- 2026-05-27_club_risk_settings
-- ============================================================================
-- Creates club_risk_settings, which has never been migrated despite being
-- read by _checkRiskLimitsJs (index.js) on every bet placement.
-- Without this table the try/catch in _checkRiskLimitsJs leaves cs = {},
-- making all club-level limits (max_stake, allow_live_betting, etc.)
-- permanently inoperative.
--
-- Design:
--   • club_id (text) PRIMARY KEY — one row per club, same type used in tickets.
--   • All limit columns have safe conservative defaults so a club with no
--     customised row behaves predictably (not silently unlimited).
--   • odds_change_policy kept for schema completeness; inert in the JS path
--     since RISK-9 enforces exact-match unconditionally.
--   • No FK to clubs — clubs.id is uuid, club_id here is text (matches
--     tickets, ledger_entries). Loose coupling avoids type cast issues.
--
-- Seed: inserts one row for the existing Test Club using column defaults.
--   ON CONFLICT DO NOTHING makes this idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.club_risk_settings (
  club_id            text        PRIMARY KEY,
  min_stake          numeric     DEFAULT 0.50,
  max_stake          numeric     DEFAULT 500.00,
  max_payout         numeric     DEFAULT 10000.00,
  allow_parlays      boolean     DEFAULT true,
  allow_teasers      boolean     DEFAULT true,
  allow_round_robins boolean     DEFAULT true,
  max_parlay_legs    int         DEFAULT 12,
  blocked_sports     text[]      DEFAULT '{}',
  blocked_markets    text[]      DEFAULT '{}',
  allow_live_betting boolean     DEFAULT true,
  odds_change_policy text        DEFAULT 'reject',
  updated_at         timestamptz DEFAULT now(),
  updated_by         text
);

-- Seed existing Test Club with column defaults.
INSERT INTO public.club_risk_settings (club_id)
VALUES ('d616dc2a-95a6-473a-97b1-7da330878479')
ON CONFLICT (club_id) DO NOTHING;
