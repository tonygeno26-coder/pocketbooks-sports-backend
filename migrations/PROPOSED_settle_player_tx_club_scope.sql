-- =============================================================================
-- PROPOSED — DO NOT APPLY TO PRODUCTION
-- settle_player_tx: club-scope settlement_id idempotency (club_id + settlement_id)
-- =============================================================================
-- Inspected: 2026-09-08 against Supabase project padgicwrrzmukahfsyhk (READ-ONLY)
--
-- LIVE INSPECTION RESULT (BLOCKER)
-- --------------------------------
--   SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'settle_player_tx';
--   → 0 rows (function ABSENT)
--
--   Public money RPCs present:
--     place_bet_tx, grade_ticket_tx, cancel_bet_tx
--   ABSENT:
--     settle_player_tx, weekly_rollover_tx, place_rr_tx
--
--   to_regclass('public.ledger')              → NULL
--   to_regclass('public.settlement_payments') → NULL
--   to_regclass('public.idempotency_keys')    → NULL
--   to_regclass('public.weekly_rollovers')    → NULL
--
--   Canonical financial table in this project is ledger_entries only
--   (place_bet_tx idempotency uses ledger_entries.id = p_idempotency_key).
--
-- Therefore this file CANNOT be a CREATE OR REPLACE of the live body:
-- there is no live settle_player_tx to patch. Inventing a full RPC would
-- introduce new financial writes — OUT OF SCOPE for this safety step.
--
-- Recommendation: **DO NOT APPLY** until settle_player_tx + ledger exist
-- in the target DB and their live definitions are re-inspected.
-- App-layer defense already ships on cursor/settlement-partial-carry:
--   settlementId = clubId || '::' || idempotencyKey
--   payment_id   = 'SETTLE_DIRECT_' || clubId || '_' || idempotencyKey
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) CURRENT LIVE IDEMPOTENCY LOGIC
-- -----------------------------------------------------------------------------
-- N/A — settle_player_tx does not exist on padgicwrrzmukahfsyhk.
--
-- Historical / documented risk (from BE comments + prior audit template):
--   PERFORM 1 FROM ledger
--     WHERE settlement_id = p_settlement_id
--       AND event_type = 'SETTLEMENT_APPLIED'
--     LIMIT 1;
--   → global on settlement_id alone → cross-club collision if bare keys reused
--
-- Re-fetch when present:
--   SELECT pg_get_functiondef(p.oid)
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE p.proname = 'settle_player_tx' AND n.nspname = 'public';

-- -----------------------------------------------------------------------------
-- 2) PROPOSED REPLACEMENT (idempotency lookup ONLY — when live body is known)
-- -----------------------------------------------------------------------------
-- BEFORE (unsafe if bare settlement_id):
--   PERFORM 1 FROM ledger
--     WHERE settlement_id = p_settlement_id
--       AND event_type = 'SETTLEMENT_APPLIED'
--     LIMIT 1;
--
-- AFTER (club-safe):
--   PERFORM 1 FROM ledger
--     WHERE club_id = p_club_id
--       AND settlement_id = p_settlement_id
--       AND event_type = 'SETTLEMENT_APPLIED'
--     LIMIT 1;
--
-- If live code also matches on p_idempotency_key / UNIQUE(club_id, idempotency_key, event_type),
-- leave that path unchanged — only broaden settlement_id lookup to include club_id.
-- Do NOT change: signature, arithmetic, INSERT amounts, balance derivation,
-- return keys, SECURITY DEFINER / grants, search_path.

-- -----------------------------------------------------------------------------
-- 3) COMPLETE MIGRATION — INTENTIONAL NO-OP STUB (safe to review; DO NOT APPLY)
-- -----------------------------------------------------------------------------
-- When live settle_player_tx is deployed, REPLACE this stub with:
--   CREATE OR REPLACE FUNCTION public.settle_player_tx(<exact live args>)
--   ... exact live body with ONLY the idempotency WHERE clause patched as above ...
-- Keep ownership, GRANT EXECUTE, and COMMENT identical to live.

DO $$
BEGIN
  IF to_regprocedure(
    'public.settle_player_tx(text,text,text,numeric,text,text,text)'
  ) IS NULL THEN
    RAISE NOTICE
      'PROPOSED_settle_player_tx_club_scope: settle_player_tx ABSENT — no DDL applied (DO NOT invent RPC)';
  ELSE
    RAISE EXCEPTION
      'PROPOSED_settle_player_tx_club_scope: settle_player_tx NOW EXISTS — abort stub; regenerate migration from pg_get_functiondef before any apply';
  END IF;
END $$;

-- Expected caller contract (BE index.js settle-player — for regenerating patch only):
--   settle_player_tx(
--     p_settlement_id   text,  -- clubId::clientKey
--     p_club_id         text,
--     p_player_id       text,
--     p_amount          numeric,
--     p_direction       text,  -- host_owes_player | player_owes_host
--     p_idempotency_key text,  -- same club-scoped key
--     p_created_by      text default 'host'
--   ) returns jsonb
--   success shape includes: ok, idempotent, balance_after, settlement_id (and/or error)

-- -----------------------------------------------------------------------------
-- 4) WHY CLUB-SAFE
-- -----------------------------------------------------------------------------
-- Same bare key "abc123" for the same player in club-a and club-b must be
-- independent ops. Lookup on (club_id, settlement_id) ensures:
--   club-a::abc123  ≠  club-b::abc123
-- even if a caller forgets the app-layer prefix. App prefix is defense-in-depth;
-- RPC must also be club-scoped.

-- -----------------------------------------------------------------------------
-- 5) CALLER CHANGES REQUIRED?
-- -----------------------------------------------------------------------------
-- NO — once RPC exists and is patched. BE @ bdee035 already passes club-scoped
-- p_settlement_id / p_idempotency_key and p_club_id. Signature preserved →
-- no FE/BE caller changes for this migration alone.

-- -----------------------------------------------------------------------------
-- 6) INDEXES / CONSTRAINTS REQUIRED?
-- -----------------------------------------------------------------------------
-- Preferred (when ledger exists), non-mutating review checklist:
--   UNIQUE (club_id, idempotency_key, event_type)  -- already documented as intended
--   INDEX  (club_id, settlement_id) WHERE event_type = 'SETTLEMENT_APPLIED'
-- Do NOT add unique(settlement_id) alone — that would reintroduce cross-club collision.
-- Creating indexes is optional performance; not required for correctness of the
-- club-scoped PERFORM lookup. Do not apply index DDL in the same change set as
-- an unreviewed full RPC create.

-- -----------------------------------------------------------------------------
-- 7) EXISTING ROWS VALID?
-- -----------------------------------------------------------------------------
-- On padgicwrrzmukahfsyhk: no public.ledger → no SETTLEMENT_APPLIED rows to
-- invalidate. ledger_entries PK is global `id` (text); app already writes
-- club-prefixed settlement mirrors as id = clubId::key → existing mirrors OK.
-- If a future DB has bare settlement_id collisions across clubs, resolve with
-- data audit BEFORE unique(club_id, settlement_id) — out of scope here; no backfill.

-- -----------------------------------------------------------------------------
-- 8) ROLLBACK SQL
-- -----------------------------------------------------------------------------
-- Nothing applied → nothing to roll back.
-- After a future real CREATE OR REPLACE patch, rollback = restore prior
-- pg_get_functiondef snapshot taken immediately before apply:
--
--   -- ROLLBACK (example only — paste exact pre-apply definition)
--   CREATE OR REPLACE FUNCTION public.settle_player_tx(...) ...;
--
-- Never DROP settle_player_tx in production as "rollback".

-- -----------------------------------------------------------------------------
-- 9) TESTS (non-prod only — NOT production)
-- -----------------------------------------------------------------------------
-- Prerequisites: non-prod DB that actually has settle_player_tx + ledger.
-- After applying the real patched body there:
--   A. same player / same key / same club     → idempotent, single SETTLEMENT_APPLIED
--   B. same player / same key / different club → independent (two rows)
--   C. different player / same key / same club → independent unless live design
--      intentionally keys only on settlement_id (document if so)
--   D. retry / double-submit                   → no double-apply (balances unchanged)
--   E. migration itself                        → zero balance deltas
--        SELECT sum(amount) FROM ledger; -- before/after identical
--        SELECT sum(amount) FROM ledger_entries; -- before/after identical
-- Re-run BE suite on settlement branch: carry 18/18, cross-club 16/16,
-- settlement idempotency tests; FE UI 8/8.

-- -----------------------------------------------------------------------------
-- 10) FINAL STATUS (this safety step)
-- -----------------------------------------------------------------------------
-- live RPC inspected:        YES — ABSENT on padgicwrrzmukahfsyhk
-- exact migration ready:     NO (blocked — no live body to patch)
-- DB objects changed:        NONE (stub NOTICE only; DO NOT APPLY)
-- indexes added:             NO
-- callers changed:           NO
-- rollback ready:            N/A (nothing applied)
-- tests against prod RPC:    N/A (RPC missing)
-- migration changes $ values: N/A — stub does not touch balances
-- recommendation:            **DO NOT APPLY**
--
-- Next approval sequence (unchanged, gated on RPC existing + reviewed patch):
--   1) regenerate CREATE OR REPLACE from live pg_get_functiondef + club_id patch
--   2) apply on non-prod → pass tests
--   3) human approve production apply
--   4) deploy BE bdee035 → merge FE 6cfe713 → smoke test players only
-- =============================================================================
