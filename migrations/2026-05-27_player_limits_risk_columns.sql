-- ============================================================================
-- 2026-05-27_player_limits_risk_columns
-- ============================================================================
-- Adds the risk-control columns that _checkRiskLimitsJs reads but that were
-- absent from the live player_limits schema.  Without these columns every
-- player-level limit (suspension, max_single_bet, max_open_risk,
-- blocked_sports, blocked_markets, allowed_sports) silently evaluates to
-- undefined/false, making all per-player enforcement permanently inert.
--
-- Architecture rule enforced here:
--   player_limits   = per-player risk controls only  (THIS table)
--   club_members    = membership + balance_start      (NOT this table)
--   club_risk_settings = club-wide risk controls      (separate table)
--
-- DO NOT add balance_start to this table.  balance_start lives in
-- club_members exclusively.  See 2026-05-27_place_bet_tx_balance_fix_v2.sql.
--
-- Columns added (matching _checkRiskLimitsJs field names exactly):
--   max_single_bet   numeric         — per-bet stake cap  (JS: pl.max_single_bet)
--   max_open_risk    numeric         — total active risk cap (JS: pl.max_open_risk)
--   blocked_sports   text[]          — sports this player cannot bet (JS: pl.blocked_sports)
--   blocked_markets  text[]          — markets blocked for this player (JS: pl.blocked_markets)
--   allowed_sports   text[]          — explicit allowlist; empty = all allowed (JS: pl.allowed_sports)
--   suspended_until  timestamptz     — non-null means player is suspended (JS: pl.suspended_until)
--
-- Existing columns retained unchanged:
--   max_bet, max_daily_risk, max_payout, sport_access, bet_types
--
-- Unique index: idx_player_limits_club_player on (club_id, player_id)
--   Required for ON CONFLICT (club_id, player_id) upserts in the admin API.
--   Run duplicate check before applying (see below).
--
-- Seed: one row for the active Test Club player, using safe permissive defaults.
--   ON CONFLICT DO NOTHING makes this idempotent.
--
-- Safe to apply: ADD COLUMN IF NOT EXISTS is non-destructive.
--   CREATE UNIQUE INDEX IF NOT EXISTS is safe when 0 rows or no duplicates exist.
-- ============================================================================

-- ── Step 1: Add missing risk-control columns ─────────────────────────────────
ALTER TABLE public.player_limits
  ADD COLUMN IF NOT EXISTS max_single_bet   numeric,
  ADD COLUMN IF NOT EXISTS max_open_risk    numeric,
  ADD COLUMN IF NOT EXISTS blocked_sports   text[]      DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS blocked_markets  text[]      DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allowed_sports   text[]      DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS suspended_until  timestamptz;

-- ── Step 2: Duplicate check (must return 0 rows before step 3) ───────────────
-- If this query returns any rows, STOP — resolve duplicates manually before
-- creating the unique index.
SELECT club_id, player_id, count(*) AS duplicate_count
  FROM public.player_limits
 GROUP BY club_id, player_id
HAVING count(*) > 1;

-- ── Step 3: Unique index ──────────────────────────────────────────────────────
-- Enables ON CONFLICT (club_id, player_id) in POST /api/club/player-limits.
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_limits_club_player
  ON public.player_limits (club_id, player_id);

-- ── Step 4: Seed Test Club player row ────────────────────────────────────────
-- Safe permissive defaults — no player is blocked, not suspended.
-- Uses ON CONFLICT DO NOTHING so repeated runs are idempotent.
INSERT INTO public.player_limits (
  club_id,
  player_id,
  max_bet,
  max_daily_risk,
  max_payout,
  max_single_bet,
  max_open_risk,
  blocked_sports,
  blocked_markets,
  allowed_sports,
  suspended_until
) VALUES (
  'd616dc2a-95a6-473a-97b1-7da330878479',
  '0a1885b8-0fe3-4e75-aeda-f89662c87d49',
  500,
  2000,
  5000,
  500,
  2000,
  '{}',
  '{}',
  '{}',
  NULL
)
ON CONFLICT (club_id, player_id) DO NOTHING;
