-- ============================================================================
-- PL-6 hardening: revoke direct RPC access from authenticated role
-- ============================================================================
-- place_bet_tx was granted to 'authenticated', meaning any Supabase-auth user
-- who knows the project URL + anon key could call the RPC directly, bypassing
-- all JS-side risk limit checks (_checkRiskLimitsJs), snapshot validation,
-- conflict detection, and permission enforcement.
--
-- Fix: revoke from authenticated, keep service_role only.
-- The backend Node server calls RPCs as service_role → no behaviour change.
-- Direct client RPC calls are rejected at the DB privilege level.
--
-- Idempotent: REVOKE IF EXISTS is not standard SQL but REVOKE is safe to
-- re-run (it is a no-op if the privilege is already absent).
-- ============================================================================

-- Exact signature from GRANT in 2026-05-27_place_bet_tx_balance_fix_v2.sql:
-- (text x5, numeric x3, text x2, int, text[], text[], text[], boolean)
REVOKE EXECUTE ON FUNCTION public.place_bet_tx(
  text, text, text, text, text,
  numeric, numeric, numeric,
  text, text,
  int,
  text[], text[], text[],
  boolean
) FROM authenticated;

-- Verification query (run after applying):
-- SELECT
--   p.proname,
--   r.rolname,
--   has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can_execute
-- FROM pg_proc p
-- CROSS JOIN pg_roles r
-- WHERE p.proname = 'place_bet_tx'
--   AND r.rolname IN ('authenticated', 'service_role');
--
-- Expected:
--   authenticated → false
--   service_role  → true
