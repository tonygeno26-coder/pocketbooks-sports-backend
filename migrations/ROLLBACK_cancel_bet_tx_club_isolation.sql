-- ROLLBACK for PROPOSED_cancel_bet_tx_club_isolation.sql
-- Restores the EXACT production body captured read-only on 2026-09-09
-- from project padgicwrrzmukahfsyhk via pg_get_functiondef.
--
-- DO NOT apply unless rolling back the isolation replace.
-- Source snapshot also mirrored in docs/CANCEL_BET_TX_PROD_GATE.md § CURRENT FUNCTION.

BEGIN;

CREATE OR REPLACE FUNCTION public.cancel_bet_tx(p_ticket_id text, p_club_id text, p_player_id text, p_idempotency_key text, p_reason text, p_created_by text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now              timestamptz := now();
  v_ticket           record;
  v_existing_ledger  record;
  v_start_balance    numeric := 1000;
  v_open_risk        numeric := 0;
  v_settled_gains    numeric := 0;
  v_settled_losses   numeric := 0;
  v_balance_before   numeric := 0;
  v_balance_after    numeric := 0;
  v_refund           numeric := 0;
  v_prev_status      text;
  v_effective_club_id text;
BEGIN
  IF p_ticket_id IS NULL OR length(trim(p_ticket_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ticket_id');
  END IF;
  IF p_player_id IS NULL OR length(trim(p_player_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_player_id');
  END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;

  SELECT id, ticket_id, player_id, club_id, type, amount, balance_after, reason
    INTO v_existing_ledger
    FROM ledger_entries
   WHERE id = p_idempotency_key
   LIMIT 1;

  IF FOUND THEN
    IF v_existing_ledger.ticket_id = p_ticket_id
       AND v_existing_ledger.player_id = p_player_id
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
      'ticket_id', p_ticket_id);
  END IF;

  IF nullif(p_club_id, '') IS NOT NULL
     AND v_ticket.club_id IS NOT NULL
     AND v_ticket.club_id IS DISTINCT FROM p_club_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ticket_club_mismatch',
      'ticket_id', p_ticket_id);
  END IF;

  v_effective_club_id := coalesce(nullif(p_club_id, ''), v_ticket.club_id);

  IF v_prev_status NOT IN ('active','open') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition',
      'ticket_id', p_ticket_id, 'status', v_ticket.status);
  END IF;

  v_refund := round(coalesce(v_ticket.risk_amount, 0)::numeric, 2);

  IF v_refund < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_risk_amount',
      'ticket_id', p_ticket_id, 'risk_amount', v_ticket.risk_amount);
  END IF;

  SELECT coalesce(balance_start, 1000)
    INTO v_start_balance
    FROM club_members
   WHERE player_id = p_player_id
     AND (v_effective_club_id IS NULL OR club_id = v_effective_club_id)
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    v_start_balance := 1000;
  END IF;

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
     AND (v_effective_club_id IS NULL OR club_id = v_effective_club_id);

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
      v_effective_club_id,
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

  UPDATE tickets
     SET status = 'canceled'
   WHERE id = p_ticket_id;

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
GRANT EXECUTE ON FUNCTION public.cancel_bet_tx(text, text, text, text, text, text) TO postgres;

COMMIT;
