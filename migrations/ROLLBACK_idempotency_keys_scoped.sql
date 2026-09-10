-- ============================================================================
-- ROLLBACK — idempotency_keys scoped PK (DO NOT RUN unless owner ordered rollback)
-- ============================================================================
-- Pair: migrations/PROPOSED_idempotency_keys_scoped.sql
-- Restores prior bare-key schema ONLY if a pre-apply dump exists.
-- Prefer restore from schema dump taken immediately before apply.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS public.tickets_club_player_client_idem_uidx;
-- Optional: ALTER TABLE public.tickets DROP COLUMN IF EXISTS client_idempotency_key;

DROP INDEX IF EXISTS public.idempotency_keys_expires_at_idx;

-- If this review's CREATE TABLE was applied on an empty/new table:
DROP TABLE IF EXISTS public.idempotency_keys;

-- Then restore legacy DDL from pre-apply dump, e.g.:
-- CREATE TABLE public.idempotency_keys (
--   idempotency_key  TEXT PRIMARY KEY,
--   actor_id         TEXT NOT NULL,
--   club_id          TEXT NOT NULL DEFAULT '',
--   endpoint         TEXT NOT NULL,
--   request_hash     TEXT NOT NULL,
--   status           TEXT NOT NULL DEFAULT 'pending',
--   response_status  INTEGER,
--   response_body    JSONB,
--   created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--   completed_at     TIMESTAMPTZ,
--   expires_at       TIMESTAMPTZ NOT NULL
-- );
-- CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at ON public.idempotency_keys(expires_at);

COMMIT;
