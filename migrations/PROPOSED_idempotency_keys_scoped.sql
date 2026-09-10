-- ============================================================================
-- PROPOSED ONLY — DO NOT APPLY
-- ============================================================================
-- Idempotency keys scoped uniqueness: (club_id, player_id, client_key)
-- Owner apply gate: docs/IDEMPOTENCY_FINAL_OWNER_REVIEW.md
-- Companion rollback: migrations/ROLLBACK_idempotency_keys_scoped.sql
-- Retention: migrations/PROPOSED_idempotency_keys_retention.sql
--
-- Preconditions (owner must confirm before apply):
--   1) Explicit owner message: APPLY IDEMPOTENCY MIGRATION
--   2) cancel_bet_tx isolation already APPLIED + VERIFIED
--   3) Read-only preflight of current public.idempotency_keys shape
--   4) BE dual-read/write code for scoped rows deployed OR deployed in same window
--   5) FE sticky path-matched Idempotency-Key on prod lineage (0e1d678 / 7a5ffa3)
--
-- PRODUCTION DATA TOUCHED if applied: schema only (table/index); no ticket/ledger rewrite
-- Path A (greenfield): table ABSENT on prod preflight → run section A only.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Target store (greenfield Path A — preferred when table absent)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  club_id          text NOT NULL,
  player_id        text NOT NULL,
  client_key       text NOT NULL,
  endpoint         text NOT NULL,
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'processing'
                   CHECK (status IN ('pending','processing','completed','failed')),
  response_status  integer,
  response_body    jsonb,
  ticket_id        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (club_id, player_id, client_key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx
  ON public.idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- B. Legacy bare-PK → scoped PK (only if preflight shows idempotency_key PK)
-- ---------------------------------------------------------------------------
-- Uncomment and run ONLY after confirming legacy columns via information_schema.
-- Requires BE dual-read before cutover.
--
-- ALTER TABLE public.idempotency_keys
--   ADD COLUMN IF NOT EXISTS player_id text,
--   ADD COLUMN IF NOT EXISTS client_key text,
--   ADD COLUMN IF NOT EXISTS ticket_id text;
--
-- UPDATE public.idempotency_keys
--    SET client_key = COALESCE(client_key, idempotency_key),
--        player_id  = COALESCE(NULLIF(player_id, ''), NULLIF(actor_id, ''), 'unknown'),
--        status     = CASE WHEN status = 'pending' THEN 'processing' ELSE status END
--  WHERE client_key IS NULL OR player_id IS NULL OR status = 'pending';
--
-- ALTER TABLE public.idempotency_keys
--   ALTER COLUMN club_id SET NOT NULL,
--   ALTER COLUMN player_id SET NOT NULL,
--   ALTER COLUMN client_key SET NOT NULL;
--
-- ALTER TABLE public.idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_pkey;
-- ALTER TABLE public.idempotency_keys
--   ADD PRIMARY KEY (club_id, player_id, client_key);

-- ---------------------------------------------------------------------------
-- C. Optional defense-in-depth on tickets (deterministic ticket id already in BE)
-- ---------------------------------------------------------------------------
-- ALTER TABLE public.tickets
--   ADD COLUMN IF NOT EXISTS client_idempotency_key text;
--
-- CREATE UNIQUE INDEX IF NOT EXISTS tickets_club_player_client_idem_uidx
--   ON public.tickets (club_id, player_id, client_idempotency_key)
--   WHERE client_idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- D. Retention helper (schedule externally — not auto-cron in this file)
-- ---------------------------------------------------------------------------
-- Prefer: migrations/PROPOSED_idempotency_keys_retention.sql

COMMIT;
