-- ============================================================================
-- 2026-05-28_live_betting_risk_controls
-- ============================================================================
-- Phase 2A live straight-bet backend controls.
--
-- This migration prepares club-level live betting risk controls while keeping
-- live betting opt-in. It does not enable live placement; the backend hard
-- block for live/post-commence placement remains in runtime code until a later
-- controlled rollout.
--
-- Destructive-ops audit:
--   - No DROP
--   - No DELETE
--   - No TRUNCATE
--   - No table rebuild
--   - ALTER TABLE is additive/default-only for new live controls
--   - Existing allow_live_betting rows are normalized to false so a future
--     live-placement unlock cannot accidentally inherit the prior permissive
--     default.
-- ============================================================================

ALTER TABLE public.club_risk_settings
  ADD COLUMN IF NOT EXISTS max_live_stake numeric DEFAULT 50.00,
  ADD COLUMN IF NOT EXISTS max_live_payout numeric DEFAULT 500.00,
  ADD COLUMN IF NOT EXISTS allow_live_parlays boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_enabled_sports text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS max_live_event_exposure numeric DEFAULT 1000.00,
  ADD COLUMN IF NOT EXISTS max_live_market_exposure numeric DEFAULT 500.00;

ALTER TABLE public.club_risk_settings
  ALTER COLUMN allow_live_betting SET DEFAULT false,
  ALTER COLUMN allow_live_parlays SET DEFAULT false,
  ALTER COLUMN max_live_stake SET DEFAULT 50.00,
  ALTER COLUMN max_live_payout SET DEFAULT 500.00,
  ALTER COLUMN live_enabled_sports SET DEFAULT '{}',
  ALTER COLUMN max_live_event_exposure SET DEFAULT 1000.00,
  ALTER COLUMN max_live_market_exposure SET DEFAULT 500.00;

UPDATE public.club_risk_settings
SET
  allow_live_betting = false,
  allow_live_parlays = COALESCE(allow_live_parlays, false),
  max_live_stake = COALESCE(max_live_stake, 50.00),
  max_live_payout = COALESCE(max_live_payout, 500.00),
  live_enabled_sports = COALESCE(live_enabled_sports, '{}'),
  max_live_event_exposure = COALESCE(max_live_event_exposure, 1000.00),
  max_live_market_exposure = COALESCE(max_live_market_exposure, 500.00),
  updated_at = COALESCE(updated_at, now())
WHERE allow_live_betting IS DISTINCT FROM false
   OR allow_live_parlays IS NULL
   OR max_live_stake IS NULL
   OR max_live_payout IS NULL
   OR live_enabled_sports IS NULL
   OR max_live_event_exposure IS NULL
   OR max_live_market_exposure IS NULL;

-- Verification SELECTs:
SELECT
  column_name,
  data_type,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'club_risk_settings'
  AND column_name IN (
    'allow_live_betting',
    'max_live_stake',
    'max_live_payout',
    'allow_live_parlays',
    'live_enabled_sports',
    'max_live_event_exposure',
    'max_live_market_exposure'
  )
ORDER BY column_name;

SELECT
  club_id,
  allow_live_betting,
  max_live_stake,
  max_live_payout,
  allow_live_parlays,
  live_enabled_sports,
  max_live_event_exposure,
  max_live_market_exposure
FROM public.club_risk_settings
ORDER BY club_id;
