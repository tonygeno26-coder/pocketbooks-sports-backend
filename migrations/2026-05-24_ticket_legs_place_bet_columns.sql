-- Narrow additive migration that patches live ticket_legs schema drift for
-- the current /api/bets/place insert payload. Production reported missing
-- accepted_at from Supabase schema cache; add it with the sibling Phase K and
-- canonical identity fields written by the same runtime payload.

ALTER TABLE public.ticket_legs
  ADD COLUMN IF NOT EXISTS accepted_at             timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_odds_american  numeric,
  ADD COLUMN IF NOT EXISTS accepted_odds_decimal   numeric,
  ADD COLUMN IF NOT EXISTS accepted_point_line     numeric,
  ADD COLUMN IF NOT EXISTS odds_snapshot_id        text,
  ADD COLUMN IF NOT EXISTS market_type             text,
  ADD COLUMN IF NOT EXISTS canonical_market_key    text,
  ADD COLUMN IF NOT EXISTS canonical_selection_key text,
  ADD COLUMN IF NOT EXISTS player_name_normalized  text,
  ADD COLUMN IF NOT EXISTS prop_type_normalized    text,
  ADD COLUMN IF NOT EXISTS prop_side               text;

-- Verification: every column below should exist after the ALTER TABLE.
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'ticket_legs'
  AND column_name IN (
    'accepted_at',
    'accepted_odds_american',
    'accepted_odds_decimal',
    'accepted_point_line',
    'odds_snapshot_id',
    'market_type',
    'canonical_market_key',
    'canonical_selection_key',
    'player_name_normalized',
    'prop_type_normalized',
    'prop_side'
  )
ORDER BY column_name;
