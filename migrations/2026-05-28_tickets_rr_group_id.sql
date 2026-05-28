-- ============================================================================
-- 2026-05-28_tickets_rr_group_id
-- ============================================================================
-- Adds rr_group_id to tickets for Option C Round Robin architecture:
-- each RR combo is stored as a Parlay ticket; rr_group_id links all combos
-- back to the originating RR slip so history queries can group them.
--
-- Architecture note (GRD-2/RR Option C):
--   A Round Robin placement creates N independent Parlay tickets, one per
--   combo. All N share the same rr_group_id. Grading uses existing Parlay
--   logic — no RR-specific settlement code needed. Cashout and live betting
--   apply per-combo identically to standard Parlays.
--
-- Column semantics:
--   rr_group_id  text  DEFAULT NULL
--     • NULL on all Single / Parlay / Teaser tickets (not an RR combo).
--     • Non-NULL on every ticket created by place_rr_tx.
--     • Value is the "slip ID" generated at confirmation time
--       (format: RRG_<ms>_<rand>), shared across all combos in one slip.
--
-- Properties:
--   • Additive / backward-safe: all existing rows get NULL; no data movement.
--   • Idempotent: ADD COLUMN IF NOT EXISTS.
--   • Partial index covers only RR rows, keeping index tiny for non-RR traffic.
--   • Does NOT add a FK from rr_group_id to any parent tickets row —
--     the group ID is a logical slip identifier, not a row reference.
--
-- Pair with: 2026-05-28_place_rr_tx.sql (function that writes rr_group_id).
-- ============================================================================

-- 1. Add column (idempotent)
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS rr_group_id text;

-- 2. Partial index for history / grading queries that filter by group.
--    WHERE rr_group_id IS NOT NULL keeps the index small — it only covers
--    RR combo rows, which will be a tiny fraction of total tickets.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename  = 'tickets'
       AND indexname  = 'idx_tickets_rr_group_id'
  ) THEN
    CREATE INDEX idx_tickets_rr_group_id
      ON public.tickets (rr_group_id)
     WHERE rr_group_id IS NOT NULL;
    RAISE NOTICE 'Created partial index idx_tickets_rr_group_id';
  ELSE
    RAISE NOTICE 'Index idx_tickets_rr_group_id already exists — skipping';
  END IF;
END$$;

-- 3. Verification — paste into SQL editor to confirm the column landed.
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'tickets'
  AND column_name  = 'rr_group_id';
-- Expected: column_name=rr_group_id | data_type=text | is_nullable=YES | column_default=null
