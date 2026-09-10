-- ============================================================================
-- PROPOSED ONLY — DO NOT APPLY / DO NOT SCHEDULE AGAINST PROD YET
-- ============================================================================
-- Retention helper for idempotency_keys
-- Pair: migrations/PROPOSED_idempotency_keys_scoped.sql
-- Policy: DELETE rows where expires_at < now() - interval '7 days'
-- Owner must schedule (pg_cron / external cron) after scoped table apply.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.purge_expired_idempotency_keys(
  p_grace interval DEFAULT interval '7 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.idempotency_keys
   WHERE expires_at < (now() - p_grace);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.purge_expired_idempotency_keys(interval) IS
  'Idempotency retention purge — code artifact only; do not cron against prod until owner schedules.';

-- Example schedule (NOT ENABLED — owner must opt in after apply):
-- SELECT cron.schedule(
--   'purge_idempotency_keys_nightly',
--   '15 5 * * *',
--   $$SELECT public.purge_expired_idempotency_keys();$$
-- );
