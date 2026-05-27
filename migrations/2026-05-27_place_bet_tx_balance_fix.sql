-- ============================================================================
-- 2026-05-27_place_bet_tx_balance_fix
-- ============================================================================
-- Fixes three balance-derivation defects in the original place_bet_tx
-- (2026-05-23_place_bet_tx.sql):
--
--   1. Starting balance source: was club_members (legacy, no club filter).
--      Now: player_limits (modern, scoped by club_id + player_id).
--      The JS handler already uses player_limits — this makes the RPC
--      consistent with the JS precheck.
--
--   2. Ticket query missing club_id filter: was
--        WHERE player_id = p_player_id
--      Now:
--        WHERE player_id = p_player_id AND club_id = p_club_id
--      Without the filter, tickets from OTHER clubs contaminated the
--      open-risk / settled-gains / settled-losses calculation.
--
--   3. Silent $1,000 fallback removed: if no player_limits row exists
--      the function now returns insufficient_balance instead of granting
--      a phantom $1,000 line of credit. Operators must create a
--      player_limits row before a player can place bets.
--
-- Row serialization: the FOR UPDATE lock moves from club_members to
-- player_limits. Per-player-per-club serialization is now correct.
--
-- What is NOT changed:
--   • The balance formula itself (start - open_risk - losses + gains).
--     Ledger adjustments (BALANCE_ADJUSTMENT, WEEKLY_ROLLOVER, etc.) are
--     still not included — that requires a materialized balance view and
--     is tracked as a separate follow-up task.
--   • Return contract shape — callers (index.js /api/bets/place) are
--     unchanged.
--   • Idempotency / ticket insert / ledger insert logic — untouched.
--
-- Safe to apply: CREATE OR REPLACE replaces the function atomically.
-- No table DDL changes. No data mutations.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.place_bet_tx(
  p_ticket_id        text,
  p_club_id          text,
  p_player_id        text,
  p_player_username  text,
  p_bet_type         text,
  p_stake            numeric,
  p_potential_profit numeric,
  p_estimated_payout numeric,
  p_idempotency_key  text,
  p_created_by       text,
  p_leg_count        int       DEFAULT 0,
  p_sports           text[]    DEFAULT '{}',
  p_markets          text[]    DEFAULT '{}',
  p_canonical_keys   text[]    DEFAULT '{}',
  p_is_live          boolean   DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_balance   numeric;       -- NULL until read from player_limits
  v_open_risk       numeric := 0;
  v_settled_gains   numeric := 0;
  v_settled_losses  numeric := 0;
  v_available       numeric;
  v_balance_after   numeric;
  v_existing_ledger record;
  v_existing_ticket record;
  v_now             timestamptz := now();
BEGIN
  -- 0. Param sanity
  IF p_ticket_id IS NULL OR length(p_ticket_id) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ticket_id');
  END IF;
  IF p_player_id IS NULL OR length(p_player_id) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_player_id');
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;
  IF p_stake IS NULL OR p_stake <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_stake');
  END IF;

  -- 1. Idempotency replay: if this idempotency key already produced a ledger
  --    entry, return the matching ticket as { ok:true, idempotent:true }.
  SELECT id, ticket_id, balance_after
    INTO v_existing_ledger
    FROM ledger_entries
   WHERE id = p_idempotency_key
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok',            true,
      'idempotent',    true,
      'ticket_id',     v_existing_ledger.ticket_id,
      'balance_after', v_existing_ledger.balance_after
    );
  END IF;

  -- 2. Lock the player row in player_limits to serialize concurrent placements
  --    for the same player at the same club.
  --    FIX: was club_members (legacy, no club filter). Now player_limits
  --    (modern, scoped). If no row exists → explicit rejection, no $1,000 fallback.
  SELECT balance_start
    INTO v_start_balance
    FROM player_limits
   WHERE player_id = p_player_id
     AND club_id   = p_club_id
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND OR v_start_balance IS NULL THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'insufficient_balance',
      'code',  'no_player_limits_found',
      'hint',  'No balance record found for this player at this club'
    );
  END IF;

  -- 3. Re-derive available balance from tickets, scoped to this club.
  --    FIX: added AND club_id = p_club_id (was missing — cross-club contamination).
  --    NOTE: ledger adjustments (BALANCE_ADJUSTMENT etc.) are not included here;
  --    tracked separately as a follow-up requiring a ledger balance view.
  SELECT
    COALESCE(SUM(CASE WHEN lower(status) IN ('active','open')
                      THEN COALESCE(risk_amount, 0) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN lower(status) = 'won'
                      THEN COALESCE(potential_profit, 0) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN lower(status) = 'lost'
                      THEN COALESCE(risk_amount, 0) ELSE 0 END), 0)
    INTO v_open_risk, v_settled_gains, v_settled_losses
    FROM tickets
   WHERE player_id = p_player_id
     AND club_id   = p_club_id;

  v_available := round((v_start_balance - v_open_risk
                        - v_settled_losses + v_settled_gains)::numeric, 2);

  IF p_stake > v_available + 0.005 THEN
    RETURN jsonb_build_object(
      'ok',        false,
      'error',     'insufficient_balance',
      'available', v_available,
      'stake',     p_stake
    );
  END IF;

  -- 4. Insert the tickets row.
  INSERT INTO tickets (
    id, club_id, player_id, player_username,
    type, status, risk_amount, potential_profit, estimated_payout,
    placed_at
  ) VALUES (
    p_ticket_id, NULLIF(p_club_id, ''), p_player_id, p_player_username,
    p_bet_type, 'active',
    round(p_stake::numeric, 2),
    round(COALESCE(p_potential_profit, 0)::numeric, 2),
    round(COALESCE(p_estimated_payout, 0)::numeric, 2),
    v_now
  )
  ON CONFLICT (id) DO NOTHING;

  -- 5. Canonical ledger entry.
  v_balance_after := round((v_available - p_stake)::numeric, 2);

  BEGIN
    INSERT INTO ledger_entries (
      id, club_id, player_id, ticket_id,
      type, amount, balance_before, balance_after,
      reason, created_at, created_by
    ) VALUES (
      p_idempotency_key,
      NULLIF(p_club_id, ''),
      p_player_id,
      p_ticket_id,
      'bet_placed',
      round((-p_stake)::numeric, 2),
      v_available,
      v_balance_after,
      'bet_placed:' || COALESCE(p_bet_type, 'Single'),
      v_now,
      COALESCE(p_created_by, p_player_id)
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT id, ticket_id, balance_after
      INTO v_existing_ledger
      FROM ledger_entries
     WHERE id = p_idempotency_key
     LIMIT 1;
    RETURN jsonb_build_object(
      'ok',            true,
      'idempotent',    true,
      'ticket_id',     COALESCE(v_existing_ledger.ticket_id, p_ticket_id),
      'balance_after', v_existing_ledger.balance_after
    );
  END;

  -- 6. Success
  RETURN jsonb_build_object(
    'ok',            true,
    'idempotent',    false,
    'ticket_id',     p_ticket_id,
    'balance_after', v_balance_after,
    'available',     v_available,
    'stake',         p_stake
  );

EXCEPTION
  WHEN OTHERS THEN
    DECLARE
      v_sqlstate    text;
      v_msg         text;
      v_detail      text;
      v_hint        text;
      v_context     text;
      v_schema      text;
      v_table       text;
      v_column      text;
      v_constraint  text;
    BEGIN
      GET STACKED DIAGNOSTICS
        v_sqlstate   = RETURNED_SQLSTATE,
        v_msg        = MESSAGE_TEXT,
        v_detail     = PG_EXCEPTION_DETAIL,
        v_hint       = PG_EXCEPTION_HINT,
        v_context    = PG_EXCEPTION_CONTEXT,
        v_schema     = SCHEMA_NAME,
        v_table      = TABLE_NAME,
        v_column     = COLUMN_NAME,
        v_constraint = CONSTRAINT_NAME;

      RETURN jsonb_build_object(
        'ok',         false,
        'error',      'place_bet_tx_failed',
        'sqlstate',   v_sqlstate,
        'message',    v_msg,
        'detail',     v_detail,
        'hint',       v_hint,
        'context',    v_context,
        'schema',     v_schema,
        'table',      v_table,
        'column',     v_column,
        'constraint', v_constraint
      );
    END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_bet_tx(
  text, text, text, text, text, numeric, numeric, numeric, text, text,
  int, text[], text[], text[], boolean
) TO authenticated, service_role;
