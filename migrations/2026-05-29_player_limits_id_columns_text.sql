-- ============================================================================
-- 2026-05-29_player_limits_id_columns_text
-- ============================================================================
-- Converts player_limits.club_id and player_limits.player_id from uuid to
-- text, matching every other table in the schema (tickets, ledger_entries,
-- ticket_legs, club_members — all converted by 2026-05-24_id_columns_text.sql).
--
-- WHY this migration is needed (PL-4):
--   _checkRiskLimitsJs in index.js queries player_limits with text values:
--     .eq('club_id', clubId).eq('player_id', playerId)
--   When these columns are uuid-typed, PostgREST returns a 400 type-mismatch
--   error.  The catch(_e){} in _checkRiskLimitsJs silently swallows it, leaving
--   pl={} (empty).  Every per-player risk limit evaluates to allow-all.
--   Risk controls are effectively disabled for every player.
--
--   POST /api/club/player-limits similarly upserts with text club_id/player_id
--   and fails silently — limits set via the admin API are never persisted.
--
-- Properties:
--   • Idempotent: every statement is wrapped in DO $$ catalog checks or uses
--     IF NOT EXISTS / IF EXISTS so re-running is a no-op.
--   • Data-preserving: type change uses USING uuid::text — no data loss.
--     Existing UUID string values are preserved byte-for-byte as text.
--   • FK-safe: we do a broad pre-flight drop of any FK that references
--     player_limits.club_id or player_limits.player_id (or vice versa)
--     before altering types, then skip re-attachment — player_limits is a
--     pure risk-control table with no relational children and the prior FK
--     (player_limits.club_id → clubs.id) is a uuid→uuid FK that would be
--     invalid after the type change anyway.
--
-- Scope (this migration only):
--   • player_limits.club_id   uuid → text
--   • player_limits.player_id uuid → text
--   • Drop + recreate idx_player_limits_club_player
--
-- NOT in scope:
--   • Any other table (tickets, ledger_entries, ticket_legs, club_members,
--     club_risk_settings — all correct already)
--
-- Run order: §0 drop FKs → §1 type changes → §2 recreate index → §3 verify
-- ============================================================================

BEGIN;

-- ============================================================================
-- §0. Pre-flight: drop any FK that touches the columns we are about to alter.
--     player_limits FK names vary by environment (Supabase auto-names or
--     manually created).  We scan pg_constraint rather than hard-coding names.
-- ============================================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.contype = 'f'
       AND c.conrelid = 'public.player_limits'::regclass
       AND a.attname IN ('club_id', 'player_id')
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.tbl, r.conname);
    RAISE NOTICE 'Dropped FK % on %', r.conname, r.tbl;
  END LOOP;

  -- Also drop any inbound FKs pointing AT player_limits (unlikely but safe)
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl
      FROM pg_constraint c
      JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = ANY(c.confkey)
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.player_limits'::regclass
       AND af.attname IN ('club_id', 'player_id')
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.tbl, r.conname);
    RAISE NOTICE 'Dropped inbound FK % on %', r.conname, r.tbl;
  END LOOP;
END$$;

-- ============================================================================
-- §1. Type changes: uuid → text
-- ============================================================================

-- 1a. club_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'player_limits'
       AND column_name  = 'club_id'
       AND data_type   <> 'text'
  ) THEN
    ALTER TABLE public.player_limits
      ALTER COLUMN club_id TYPE text USING club_id::text;
    RAISE NOTICE 'player_limits.club_id converted to text';
  ELSE
    RAISE NOTICE 'player_limits.club_id already text — skipped';
  END IF;
END$$;

-- 1b. player_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'player_limits'
       AND column_name  = 'player_id'
       AND data_type   <> 'text'
  ) THEN
    ALTER TABLE public.player_limits
      ALTER COLUMN player_id TYPE text USING player_id::text;
    RAISE NOTICE 'player_limits.player_id converted to text';
  ELSE
    RAISE NOTICE 'player_limits.player_id already text — skipped';
  END IF;
END$$;

-- ============================================================================
-- §2. Unique index: drop old (may be uuid-typed), recreate on text columns
-- ============================================================================

-- 2a. Drop the existing index (was created against uuid columns; must rebuild)
DROP INDEX IF EXISTS public.idx_player_limits_club_player;

-- 2b. Recreate on the now-text columns
--     ON CONFLICT (club_id, player_id) in the admin upsert depends on this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_limits_club_player
  ON public.player_limits (club_id, player_id);

COMMIT;

-- ============================================================================
-- §3. Verification — proof the SQL editor will print
-- ============================================================================
-- Run this block after COMMIT to confirm the migration landed correctly.
-- Every row below should show data_type = 'text' for club_id and player_id.
-- If either row shows 'uuid', the migration did not take — diagnose with:
--   SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE state='idle in transaction';
-- then re-run.
-- ============================================================================

-- 3a. Column type proof
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'player_limits'
  AND column_name IN ('club_id', 'player_id')
ORDER BY column_name;

-- Expected output:
--   player_limits | club_id   | text | YES
--   player_limits | player_id | text | YES

-- 3b. Index proof — must exist and be on the text columns
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename  = 'player_limits'
  AND indexname  = 'idx_player_limits_club_player';

-- Expected output:
--   idx_player_limits_club_player | CREATE UNIQUE INDEX idx_player_limits_club_player
--                                     ON public.player_limits USING btree (club_id, player_id)

-- 3c. FK proof — no FKs should remain on club_id / player_id after §0
SELECT
  c.conname,
  c.conrelid::regclass AS from_table,
  a.attname            AS from_column
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND c.conrelid = 'public.player_limits'::regclass
  AND a.attname IN ('club_id', 'player_id');

-- Expected output: 0 rows (all FK constraints on these columns were dropped in §0)

-- ============================================================================
-- END
-- ============================================================================
