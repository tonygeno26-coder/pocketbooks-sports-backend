-- ============================================================================
-- teaser_payout_tiers — v1 teaser payout lookup table
-- ============================================================================
-- Draft migration only. This creates static payout tiers for future teaser
-- grading/placement work; it does not change runtime grading behavior.
--
-- Decimal odds conversion:
--   positive American odds: 1 + (odds_american / 100)
--   negative American odds: 1 + (100 / abs(odds_american))
--
-- v1 seed:
--   football   sports={NFL,NCAAF}   teaser_points=6
--   basketball sports={NBA,NCAAB}   teaser_points=4
--   leg counts 2..6 use the same payout ladder for each sport group.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.teaser_payout_tiers (
  id             text PRIMARY KEY,
  sport_group    text NOT NULL,
  sports         text[] NOT NULL,
  teaser_points  numeric NOT NULL,
  leg_count      integer NOT NULL,
  odds_american  integer NOT NULL,
  odds_decimal   numeric NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  version        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teaser_payout_tiers_unique
    UNIQUE (sport_group, teaser_points, leg_count, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS teaser_payout_tiers_one_active
ON public.teaser_payout_tiers (sport_group, teaser_points, leg_count)
WHERE is_active = true;

INSERT INTO public.teaser_payout_tiers (
  id,
  sport_group,
  sports,
  teaser_points,
  leg_count,
  odds_american,
  odds_decimal,
  is_active,
  version
) VALUES
  ('teaser_v1_football_6pt_2leg',   'football',   ARRAY['NFL','NCAAF']::text[], 6, 2, -110, round((1 + (100.0 / 110.0))::numeric, 6), true, 'v1'),
  ('teaser_v1_football_6pt_3leg',   'football',   ARRAY['NFL','NCAAF']::text[], 6, 3,  180, 2.800000, true, 'v1'),
  ('teaser_v1_football_6pt_4leg',   'football',   ARRAY['NFL','NCAAF']::text[], 6, 4,  300, 4.000000, true, 'v1'),
  ('teaser_v1_football_6pt_5leg',   'football',   ARRAY['NFL','NCAAF']::text[], 6, 5,  450, 5.500000, true, 'v1'),
  ('teaser_v1_football_6pt_6leg',   'football',   ARRAY['NFL','NCAAF']::text[], 6, 6,  600, 7.000000, true, 'v1'),

  ('teaser_v1_basketball_4pt_2leg', 'basketball', ARRAY['NBA','NCAAB']::text[], 4, 2, -110, round((1 + (100.0 / 110.0))::numeric, 6), true, 'v1'),
  ('teaser_v1_basketball_4pt_3leg', 'basketball', ARRAY['NBA','NCAAB']::text[], 4, 3,  180, 2.800000, true, 'v1'),
  ('teaser_v1_basketball_4pt_4leg', 'basketball', ARRAY['NBA','NCAAB']::text[], 4, 4,  300, 4.000000, true, 'v1'),
  ('teaser_v1_basketball_4pt_5leg', 'basketball', ARRAY['NBA','NCAAB']::text[], 4, 5,  450, 5.500000, true, 'v1'),
  ('teaser_v1_basketball_4pt_6leg', 'basketball', ARRAY['NBA','NCAAB']::text[], 4, 6,  600, 7.000000, true, 'v1')
ON CONFLICT (sport_group, teaser_points, leg_count, version) DO NOTHING;

-- ============================================================================
-- Verification SELECTs
-- ============================================================================

SELECT
  table_schema,
  table_name,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'teaser_payout_tiers'
ORDER BY ordinal_position;

SELECT
  conname,
  contype,
  pg_get_constraintdef(oid) AS constraint_definition
FROM pg_constraint
WHERE conrelid = 'public.teaser_payout_tiers'::regclass
ORDER BY conname;

SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'teaser_payout_tiers'
ORDER BY indexname;

SELECT
  sport_group,
  sports,
  teaser_points,
  leg_count,
  odds_american,
  odds_decimal,
  version,
  is_active
FROM public.teaser_payout_tiers
WHERE version = 'v1'
ORDER BY sport_group, teaser_points, leg_count;

SELECT
  'teaser_payout_tiers_v1_seed_count' AS check_name,
  CASE WHEN count(*) = 10 THEN 'PASS' ELSE 'FAIL' END AS status,
  count(*) AS row_count
FROM public.teaser_payout_tiers
WHERE version = 'v1'
  AND sport_group IN ('football','basketball');

-- ============================================================================
-- Rollback section
-- ============================================================================
-- Preferred rollback for this seed-only migration:
--
-- DELETE FROM public.teaser_payout_tiers
-- WHERE version = 'v1'
--   AND id IN (
--     'teaser_v1_football_6pt_2leg',
--     'teaser_v1_football_6pt_3leg',
--     'teaser_v1_football_6pt_4leg',
--     'teaser_v1_football_6pt_5leg',
--     'teaser_v1_football_6pt_6leg',
--     'teaser_v1_basketball_4pt_2leg',
--     'teaser_v1_basketball_4pt_3leg',
--     'teaser_v1_basketball_4pt_4leg',
--     'teaser_v1_basketball_4pt_5leg',
--     'teaser_v1_basketball_4pt_6leg'
--   );
--
-- If the table was created only by this migration and has no production
-- dependencies, full rollback is:
--
-- DROP TABLE IF EXISTS public.teaser_payout_tiers;

-- ============================================================================
-- Destructive-ops audit
-- ============================================================================
-- No DROP statements are executed.
-- No DELETE statements are executed.
-- No TRUNCATE statements.
-- CREATE TABLE IF NOT EXISTS is additive.
-- INSERT ... ON CONFLICT is idempotent for the v1 seed rows.
-- Rollback commands are comments only and must be run manually if needed.
