-- PROPOSED (DO NOT APPLY without explicit owner approval)
-- Hardens public.cancel_bet_tx to club_id + player_id + ticket_id isolation
-- and removes phantom $1000 fallback when club_members is missing.
--
-- DOES NOT change cancel arithmetic: refund = risk_amount only.
-- DOES NOT mutate existing rows at apply time (CREATE OR REPLACE function only).
--
-- BEFORE (prod as of 2026-09-09 read):
--   * club check soft: only mismatch when BOTH p_club_id and ticket.club_id set
--   * club_members: (v_effective_club_id IS NULL OR club_id = v_effective_club_id)
--   * tickets aggregate: same soft OR
--   * missing member / NULL balance_start → v_start_balance := 1000  (PHANTOM1000)
--   * UPDATE tickets locks by id only (no club/player predicate)
--
-- AFTER:
--   * p_club_id / p_player_id / p_ticket_id all required
--   * ticket must match club_id + player_id (hard; NULL club rejected)
--   * club_members locked by club_id + player_id; missing → no_club_member_balance_found
--   * tickets aggregate hard-scoped by club_id + player_id
--   * already canceled/voided → ok + idempotent (no second refund)
--   * settled / other statuses → invalid_transition (no refund)
--   * UPDATE tickets WHERE id + club_id + player_id
--
-- Rollback: migrations/ROLLBACK_cancel_bet_tx_club_isolation.sql
-- Owner package: docs/CANCEL_BET_TX_PROD_GATE.md

BEGIN;

CREATE OR REPLACE FUNCTION public.cancel_bet_tx(
  p_ticket_id text,
  p_club_id text,
  p_player_id text,
  p_idempotency_key text,
  p_reason text,
  p_created_by text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now              timestamptz := now();
  v_ticket           record;
  v_existing_ledger  record;
  v_start_balance    numeric;
  v_open_risk        numeric := 0;
  v_settled_gains    numeric := 0;
  v_settled_losses   numeric := 0;
  v_balance_before   numeric := 0;
  v_balance_after    numeric := 0;
  v_refund           numeric := 0;
  v_prev_status      text;
BEGIN
  IF p_ticket_id IS NULL OR length(trim(p_ticket_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ticket_id');
  END IF;
  IF p_club_id IS NULL OR length(trim(p_club_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_club_id');
  END IF;
  IF p_player_id IS NULL OR length(trim(p_player_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_player_id');
  END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;

  -- Idempotent replay by ledger id (unique). Hard-require club match on replay.
  SELECT id, ticket_id, player_id, club_id, type, amount, balance_after, reason
    INTO v_existing_ledger
    FROM ledger_entries
   WHERE id = p_idempotency_key
   LIMIT 1;

  IF FOUND THEN
    IF v_existing_ledger.ticket_id = p_ticket_id
       AND v_existing_ledger.player_id = p_player_id
       AND v_existing_ledger.club_id = p_club_id
       AND v_existing_ledger.type = 'bet_canceled' THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'ticket_id', v_existing_ledger.ticket_id,
        'status', 'canceled',
        'refund', v_existing_ledger.amount,
        'ledger_entry_id', v_existing_ledger.id,
        'balance_after', v_existing_ledger.balance_after,
        'replay_of', v_existing_ledger.id
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'error', 'idempotency_key_conflict',
      'ledger_entry_id', v_existing_ledger.id,
      'ticket_id', v_existing_ledger.ticket_id,
      'existing_type', v_existing_ledger.type,
      'requested_type', 'bet_canceled'
    );
  END IF;

  -- Lock ticket by id, then enforce club + player + ticket scope.
  SELECT *
    INTO v_ticket
    FROM tickets
   WHERE id = p_ticket_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ticket_not_found',
      'ticket_id', p_ticket_id);
  END IF;

  v_prev_status := lower(coalesce(v_ticket.status, ''));

  IF v_ticket.player_id IS DISTINCT FROM p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ticket_player_mismatch',
      'ticket_id', p_ticket_id,
      'ticket_player_id', v_ticket.player_id,
      'requested_player_id', p_player_id);
  END IF;

  -- HARD club lock: ticket must belong to requested club (NULL club rejected).
  IF v_ticket.club_id IS NULL OR v_ticket.club_id IS DISTINCT FROM p_club_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ticket_club_mismatch',
      'ticket_id', p_ticket_id,
      'ticket_club_id', v_ticket.club_id,
      'requested_club_id', p_club_id);
  END IF;

  -- Already canceled/voided: safe idempotent — no second refund / no ledger write.
  IF v_prev_status IN ('canceled', 'cancelled', 'voided') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'ticket_id', p_ticket_id,
      'status', v_ticket.status,
      'refund', 0,
      'message', 'already_canceled'
    );
  END IF;

  -- Settled / any other status: cannot cancel (no incorrect refund).
  IF v_prev_status NOT IN ('active', 'open') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition',
      'ticket_id', p_ticket_id, 'status', v_ticket.status);
  END IF;

  v_refund := round(coalesce(v_ticket.risk_amount, 0)::numeric, 2);

  IF v_refund < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_risk_amount',
      'ticket_id', p_ticket_id, 'risk_amount', v_ticket.risk_amount);
  END IF;

  -- HARD membership lock — no phantom $1000 (parity with place_bet_tx).
  SELECT balance_start
    INTO v_start_balance
    FROM club_members
   WHERE player_id = p_player_id
     AND club_id   = p_club_id
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND OR v_start_balance IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'no_club_member_balance_found',
      'code', 'no_club_member_balance_found',
      'hint', 'No balance record found for this player at this club'
    );
  END IF;

  -- Presentation balances for ledger_entries only; cancel arithmetic = +risk refund.
  -- Aggregate hard-scoped to this club + player (no soft OR / no cross-club).
  SELECT
    coalesce(sum(CASE WHEN lower(status) IN ('active','open')
                      THEN coalesce(risk_amount, 0) ELSE 0 END), 0),
    coalesce(sum(CASE WHEN lower(status) = 'won'
                      THEN coalesce(potential_profit, 0) ELSE 0 END), 0),
    coalesce(sum(CASE WHEN lower(status) = 'lost'
                      THEN coalesce(risk_amount, 0) ELSE 0 END), 0)
    INTO v_open_risk, v_settled_gains, v_settled_losses
    FROM tickets
   WHERE player_id = p_player_id
     AND club_id   = p_club_id;

  v_balance_before := round((v_start_balance - v_open_risk
                             - v_settled_losses + v_settled_gains)::numeric, 2);
  v_balance_after := round((v_balance_before + v_refund)::numeric, 2);

  BEGIN
    INSERT INTO ledger_entries (
      id, club_id, player_id, ticket_id,
      type, amount, balance_before, balance_after,
      reason, created_at, created_by
    ) VALUES (
      p_idempotency_key,
      p_club_id,
      p_player_id,
      p_ticket_id,
      'bet_canceled',
      v_refund,
      v_balance_before,
      v_balance_after,
      'cancel:' || coalesce(nullif(p_reason, ''), 'player_request'),
      v_now,
      coalesce(p_created_by, p_player_id)
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT id, ticket_id, player_id, club_id, type, amount, balance_after, reason
      INTO v_existing_ledger
      FROM ledger_entries
     WHERE id = p_idempotency_key
     LIMIT 1;

    IF FOUND
       AND v_existing_ledger.ticket_id = p_ticket_id
       AND v_existing_ledger.player_id = p_player_id
       AND v_existing_ledger.club_id = p_club_id
       AND v_existing_ledger.type = 'bet_canceled' THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'ticket_id', v_existing_ledger.ticket_id,
        'status', 'canceled',
        'refund', v_existing_ledger.amount,
        'ledger_entry_id', v_existing_ledger.id,
        'balance_after', v_existing_ledger.balance_after,
        'replay_of', v_existing_ledger.id
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'error', 'idempotency_key_conflict',
      'ticket_id', p_ticket_id,
      'existing_type', CASE WHEN FOUND THEN v_existing_ledger.type ELSE NULL END,
      'requested_type', 'bet_canceled'
    );
  END;

  -- Defense in depth: status flip only when club + player + ticket still match.
  UPDATE tickets
     SET status = 'canceled'
   WHERE id = p_ticket_id
     AND club_id = p_club_id
     AND player_id = p_player_id;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'ticket_id', p_ticket_id,
    'status', 'canceled',
    'previous_status', v_ticket.status,
    'refund', v_refund,
    'ledger_entry_id', p_idempotency_key,
    'balance_before', v_balance_before,
    'balance_after', v_balance_after
  );

EXCEPTION
  WHEN OTHERS THEN
    DECLARE
      v_sqlstate text;
      v_msg      text;
      v_detail   text;
      v_hint     text;
    BEGIN
      GET STACKED DIAGNOSTICS
        v_sqlstate = RETURNED_SQLSTATE,
        v_msg      = MESSAGE_TEXT,
        v_detail   = PG_EXCEPTION_DETAIL,
        v_hint     = PG_EXCEPTION_HINT;

      RETURN jsonb_build_object(
        'ok', false,
        'error', 'cancel_bet_tx_failed',
        'sqlstate', v_sqlstate,
        'message', v_msg,
        'detail', v_detail,
        'hint', v_hint,
        'ticket_id', p_ticket_id
      );
    END;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_bet_tx(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_bet_tx(text, text, text, text, text, text) TO service_role;
-- Keep postgres EXECUTE (owner/superuser) as in current prod grants.

COMMIT;
