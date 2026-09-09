-- READ ONLY precheck for cancel_bet_tx club-isolation gate.
-- Project: padgicwrrzmukahfsyhk
-- DO NOT apply PROPOSED SQL from this file. SELECT / pg_get_functiondef only.
-- Captured baseline (2026-09-09): see docs/CANCEL_BET_TX_PROD_GATE.md

-- 1) Exact live definition
SELECT pg_get_functiondef('public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure) AS def;

-- 2) Soft-club / phantom markers still present?
SELECT
  (pg_get_functiondef('public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure)
     ILIKE '%v_effective_club_id%') AS has_soft_club,
  (pg_get_functiondef('public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure)
     ILIKE '%1000%') AS mentions_1000,
  (pg_get_functiondef('public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure)
     ILIKE '%no_club_member_balance_found%') AS has_hard_member_reject;

-- 3) Grants
SELECT grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public' AND routine_name = 'cancel_bet_tx'
ORDER BY 1, 2;

-- 4) Triggers on money tables (expect none cancel-specific)
SELECT n.nspname AS schema, c.relname AS table_name, t.tgname AS trigger_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND c.relname IN ('tickets', 'club_members', 'ledger_entries')
ORDER BY 1, 2, 3;

-- 5) Ticket inventory
SELECT lower(status) AS status, count(*)::bigint AS n
FROM tickets
GROUP BY 1
ORDER BY n DESC;

SELECT
  count(*) FILTER (WHERE lower(status) IN ('active','open')) AS active_open,
  count(*) FILTER (WHERE lower(status) IN ('canceled','cancelled','voided')) AS canceled_voided,
  count(*) FILTER (WHERE lower(status) IN ('won','lost','push','pushed','settled')) AS settled_like,
  count(*) AS total
FROM tickets;

-- 6) Active tickets missing club_members (would fail hard membership after apply)
SELECT count(*)::bigint AS orphan_active_tickets
FROM tickets t
WHERE lower(coalesce(t.status, '')) IN ('active', 'open')
  AND NOT EXISTS (
    SELECT 1 FROM club_members m
    WHERE m.player_id = t.player_id AND m.club_id = t.club_id
  );

-- 7) Historical tickets missing membership (any status)
SELECT lower(t.status) AS status, count(*)::bigint AS n
FROM tickets t
WHERE t.club_id IS NOT NULL
  AND t.player_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM club_members m
    WHERE m.player_id = t.player_id AND m.club_id = t.club_id
  )
GROUP BY 1
ORDER BY n DESC;

-- 8) NULL club / NULL player tickets
SELECT
  count(*) FILTER (WHERE club_id IS NULL) AS null_club_tickets,
  count(*) FILTER (WHERE club_id IS NULL AND lower(status) IN ('active','open')) AS null_club_active,
  count(*) FILTER (WHERE player_id IS NULL) AS null_player_tickets
FROM tickets;

-- 9) Cancel ledger anomalies
SELECT
  count(*) FILTER (WHERE type = 'bet_canceled' AND club_id IS NULL) AS null_club_cancel_ledger,
  count(*) FILTER (WHERE type = 'bet_canceled') AS cancel_ledger_total,
  count(*) FILTER (WHERE type = 'bet_canceled' AND amount = 1000) AS cancel_amount_eq_1000
FROM ledger_entries;

-- 10) Members with NULL balance_start (would reject under new function)
SELECT count(*)::bigint AS members_null_balance_start
FROM club_members
WHERE balance_start IS NULL;
