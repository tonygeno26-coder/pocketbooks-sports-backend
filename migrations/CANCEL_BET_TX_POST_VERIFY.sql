-- Post-apply verification for cancel_bet_tx club isolation.
-- Run ONLY after owner applies migrations/PROPOSED_cancel_bet_tx_club_isolation.sql
-- These are SELECT / call-shape checks. Prefer designated test accounts for cancel RPCs
-- (see docs/CANCEL_BET_TX_PROD_GATE.md § TEST PLAN). Do not cancel ordinary users.

-- 1) Function body no longer soft-club / phantom1000
SELECT
  (pg_get_functiondef('public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure)
     ILIKE '%v_effective_club_id%') AS soft_club_gone_expect_false,
  (pg_get_functiondef('public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure)
     ILIKE '%v_start_balance := 1000%') AS phantom_assign_gone_expect_false,
  (pg_get_functiondef('public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure)
     ILIKE '%coalesce(balance_start, 1000)%') AS coalesce_1000_gone_expect_false,
  (pg_get_functiondef('public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure)
     ILIKE '%no_club_member_balance_found%') AS hard_member_reject_expect_true,
  (pg_get_functiondef('public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure)
     ILIKE '%ticket_club_mismatch%') AS hard_club_mismatch_expect_true,
  (pg_get_functiondef('public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure)
     ILIKE '%already_canceled%') AS already_canceled_idempotent_expect_true;

-- 2) Grants unchanged (service_role + postgres)
SELECT grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public' AND routine_name = 'cancel_bet_tx'
ORDER BY 1, 2;

-- 3) Missing required args rejected without side effects
SELECT public.cancel_bet_tx(NULL, 'club', 'player', 'k', 'r', 'c') AS missing_ticket;
SELECT public.cancel_bet_tx('t', NULL, 'player', 'k', 'r', 'c') AS missing_club;
SELECT public.cancel_bet_tx('t', 'club', NULL, 'k', 'r', 'c') AS missing_player;

-- 4) Nonexistent ticket
SELECT public.cancel_bet_tx(
  'NO_SUCH_TICKET_CANCEL_GATE',
  'NO_SUCH_CLUB',
  'NO_SUCH_PLAYER',
  'VERIFY_CANCEL_GATE_TICKET_NF',
  'verify',
  'verify'
) AS nonexistent_ticket;

-- 5) Inventory unchanged by function replace itself (expect same counts as precheck)
SELECT
  count(*) FILTER (WHERE lower(status) IN ('active','open')) AS active_open,
  count(*) FILTER (WHERE lower(status) IN ('canceled','cancelled','voided')) AS canceled_voided,
  count(*) AS total
FROM tickets;
