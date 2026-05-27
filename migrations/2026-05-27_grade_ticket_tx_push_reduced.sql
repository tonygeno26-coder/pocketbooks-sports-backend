-- ============================================================================
-- 2026-05-27_grade_ticket_tx_push_reduced
-- ============================================================================
-- GRD-2: Correct partial-push parlay settlement.
--
-- Problem:
--   When some parlay legs push and all remaining legs win, the JS path in
--   _deriveTicketOutcome now returns outcome='won' with a recomputed
--   overrideProfit (stake * ∏decimal_odds_of_won_legs - stake).  But the
--   existing profit_mismatch guard rejects any p_profit that differs from
--   the ticket's stored potential_profit.  The ticket was placed with N-leg
--   odds; after a push it should pay at (N-k)-leg odds.  This migration
--   adds an optional p_override_profit parameter so the JS caller can pass
--   the reduced profit and have it accepted without a mismatch error.
--
-- New parameter:
--   p_override_profit  numeric  DEFAULT NULL
--
-- Semantic rule for v_profit (replaces the single coalesce):
--   IF p_override_profit IS NOT NULL        → use p_override_profit
--   ELSIF p_profit IS NOT NULL              → use p_profit
--   ELSE                                    → use ticket.potential_profit (or 0)
--
-- profit_mismatch guard:
--   Only applied when p_override_profit IS NULL (normal grading path).
--   Skipped when p_override_profit IS NOT NULL (push-reduced grading path).
--
-- Ticket UPDATE:
--   Adds   potential_profit = CASE WHEN p_override_profit IS NOT NULL
--                                  THEN round(p_override_profit,2)
--                                  ELSE potential_profit END
--   so the settled ticket row reflects the actual profit paid, not the
--   original full-parlay potential_profit.
--
-- Everything else unchanged:
--   • p_club_id validation (GRD-5)
--   • balance lock and club isolation (GRD-5)
--   • idempotency logic (GRD-3)
--   • status transition check
--   • payout formula (won=risk+profit, lost=0, push=risk)
--   • ledger INSERT / unique_violation handler
--   • audit INSERT (best-effort)
--   • return shape (no new fields; callers see same shape)
--   • GRANT/REVOKE (updated for new signature)
--
-- Backward-compatible: DEFAULT NULL means all existing callers (worker,
--   /api/grade/run, /api/grade/manual) continue to work without change.
--   Only the push-reduced parlay paths pass a non-null p_override_profit.
--
-- Builds on 2026-05-27_grade_ticket_tx_club_isolation.sql (GRD-5).
-- Safe to apply: CREATE OR REPLACE is atomic; no table DDL; no data mutations.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.grade_ticket_tx(
  p_ticket_id        text,
  p_club_id          text,
  p_player_id        text,
  p_grade_result     text,
  p_profit           numeric,
  p_idempotency_key  text,
  p_created_by       text,
  p_grading_source   text    DEFAULT 'server-grade',
  p_grading_snapshot jsonb   DEFAULT '{}'::jsonb,
  p_override_profit  numeric DEFAULT NULL      -- GRD-2: push-reduced parlay override
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settlement_version CONSTANT text := 'pb_v1';
  v_now                timestamptz := now();
  v_result             text := lower(coalesce(p_grade_result, ''));
  v_ticket             record;
  v_existing_ledger    record;
  v_start_balance      numeric;         -- NULL until read; no phantom $1,000 default (GRD-1)
  v_open_risk          numeric := 0;
  v_settled_gains      numeric := 0;
  v_settled_losses     numeric := 0;
  v_balance_before     numeric := 0;
  v_balance_after      numeric := 0;
  v_risk               numeric := 0;
  v_profit             numeric := 0;
  v_amount             numeric := 0;
  v_ledger_type        text;
  v_expected_ledger_type text;
  -- GRD-5: p_club_id is required (validated below) and used directly throughout.
  v_prev_status        text;
  v_snapshot           jsonb;
BEGIN
  -- 0. Param sanity.
  IF p_ticket_id IS NULL OR length(trim(p_ticket_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ticket_id',
      'settlement_version', v_settlement_version);
  END IF;
  -- GRD-5: p_club_id is required.
  IF p_club_id IS NULL OR length(trim(p_club_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_club_id',
      'hint', 'p_club_id is required for club-scoped grading',
      'settlement_version', v_settlement_version);
  END IF;
  IF p_player_id IS NULL OR length(trim(p_player_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_player_id',
      'settlement_version', v_settlement_version);
  END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key',
      'settlement_version', v_settlement_version);
  END IF;
  IF v_result NOT IN ('won','lost','push') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_grade_result',
      'grade_result', p_grade_result, 'settlement_version', v_settlement_version);
  END IF;

  -- GRD-2: p_override_profit must be non-negative when provided.
  IF p_override_profit IS NOT NULL AND p_override_profit < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_override_profit',
      'override_profit', p_override_profit, 'settlement_version', v_settlement_version);
  END IF;

  IF v_result = 'won' THEN
    v_expected_ledger_type := 'bet_won';
  ELSIF v_result = 'lost' THEN
    v_expected_ledger_type := 'bet_lost';
  ELSE
    v_expected_ledger_type := 'bet_push';
  END IF;

  -- 1. Replay by idempotency key.  The ledger id is the canonical anchor.
  SELECT id, ticket_id, player_id, club_id, type, amount, balance_after, reason
    INTO v_existing_ledger
    FROM ledger_entries
   WHERE id = p_idempotency_key
   LIMIT 1;

  IF FOUND THEN
    IF v_existing_ledger.ticket_id = p_ticket_id
       AND v_existing_ledger.player_id = p_player_id
       AND v_existing_ledger.type = v_expected_ledger_type THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'replayed', true,
        'ticket_id', v_existing_ledger.ticket_id,
        'status', v_result,
        'ledger_entry_id', v_existing_ledger.id,
        'amount', v_existing_ledger.amount,
        'balance_after', v_existing_ledger.balance_after,
        'replay_of', v_existing_ledger.id,
        'settlement_version', v_settlement_version
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'error', 'idempotency_key_conflict',
      'ledger_entry_id', v_existing_ledger.id,
      'ticket_id', v_existing_ledger.ticket_id,
      'existing_type', v_existing_ledger.type,
      'requested_type', v_expected_ledger_type,
      'settlement_version', v_settlement_version
    );
  END IF;

  -- 2. Lock the ticket row.  This serializes settlement per ticket.
  SELECT *
    INTO v_ticket
    FROM tickets
   WHERE id = p_ticket_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ticket_not_found',
      'ticket_id', p_ticket_id, 'settlement_version', v_settlement_version);
  END IF;

  v_prev_status := lower(coalesce(v_ticket.status, ''));

  IF v_ticket.player_id IS DISTINCT FROM p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ticket_player_mismatch',
      'ticket_id', p_ticket_id, 'settlement_version', v_settlement_version);
  END IF;

  -- GRD-5: Hard club mismatch check.
  IF v_ticket.club_id IS DISTINCT FROM p_club_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ticket_club_mismatch',
      'ticket_id', p_ticket_id,
      'ticket_club_id', v_ticket.club_id,
      'provided_club_id', p_club_id,
      'settlement_version', v_settlement_version);
  END IF;

  IF v_prev_status NOT IN ('active','open') OR v_ticket.graded_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition',
      'ticket_id', p_ticket_id, 'status', v_ticket.status,
      'settlement_version', v_settlement_version);
  END IF;

  v_risk := round(coalesce(v_ticket.risk_amount, 0)::numeric, 2);

  -- GRD-2: Profit source priority:
  --   1. p_override_profit (push-reduced parlay — skip mismatch check)
  --   2. p_profit          (normal grade — subject to mismatch check)
  --   3. ticket.potential_profit (fallback)
  IF p_override_profit IS NOT NULL THEN
    v_profit := round(p_override_profit::numeric, 2);
  ELSIF p_profit IS NOT NULL THEN
    v_profit := round(p_profit::numeric, 2);
  ELSE
    v_profit := round(coalesce(v_ticket.potential_profit, 0)::numeric, 2);
  END IF;

  IF v_risk < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_risk_amount',
      'ticket_id', p_ticket_id, 'risk_amount', v_ticket.risk_amount,
      'settlement_version', v_settlement_version);
  END IF;
  IF v_profit < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_profit',
      'ticket_id', p_ticket_id, 'profit', v_profit,
      'settlement_version', v_settlement_version);
  END IF;

  -- GRD-2: profit_mismatch guard only applies on the normal path (no override).
  IF p_override_profit IS NULL
     AND p_profit IS NOT NULL
     AND abs(round(p_profit::numeric, 2)
             - round(coalesce(v_ticket.potential_profit, 0)::numeric, 2)) > 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'profit_mismatch',
      'ticket_id', p_ticket_id, 'provided_profit', p_profit,
      'ticket_profit', v_ticket.potential_profit,
      'settlement_version', v_settlement_version);
  END IF;

  -- 3. Lock the club_members row to serialize per-player settlement.
  --    GRD-1: hard reject if no club_members row or balance_start IS NULL.
  --    GRD-5: club_id = p_club_id directly; no OR-NULL bypass.
  SELECT balance_start
    INTO v_start_balance
    FROM club_members
   WHERE player_id = p_player_id
     AND club_id   = p_club_id
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND OR v_start_balance IS NULL THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'insufficient_balance',
      'code',  'no_club_member_balance_found',
      'hint',  'No balance record found for this player at this club',
      'ticket_id', p_ticket_id,
      'settlement_version', v_settlement_version
    );
  END IF;

  -- 4. Balance before settlement, using the current ticket-derived model.
  --    GRD-5: club_id = p_club_id directly; no OR-NULL bypass.
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

  IF v_result = 'won' THEN
    v_amount := round((v_risk + v_profit)::numeric, 2);
    v_ledger_type := v_expected_ledger_type;
  ELSIF v_result = 'lost' THEN
    v_amount := 0;
    v_ledger_type := v_expected_ledger_type;
  ELSE
    v_amount := v_risk;
    v_ledger_type := v_expected_ledger_type;
  END IF;

  v_balance_after := round((v_balance_before + v_amount)::numeric, 2);

  v_snapshot := coalesce(p_grading_snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'settlement_version', v_settlement_version,
      'grade_result', v_result,
      'previous_status', v_ticket.status,
      'risk_amount', v_risk,
      'profit', v_profit,
      'settlement_amount', v_amount,
      'idempotency_key', p_idempotency_key,
      'push_reduced', (p_override_profit IS NOT NULL)   -- GRD-2: audit flag
    );

  -- 5. Insert canonical settlement ledger row first.  If this fails, ticket
  --    update and audit insert do not happen.
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
      v_ledger_type,
      v_amount,
      v_balance_before,
      v_balance_after,
      'grade_ticket_tx:' || v_settlement_version || ':' || v_result,
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
       AND v_existing_ledger.type = v_expected_ledger_type THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'replayed', true,
        'ticket_id', v_existing_ledger.ticket_id,
        'status', v_result,
        'ledger_entry_id', v_existing_ledger.id,
        'amount', v_existing_ledger.amount,
        'balance_after', v_existing_ledger.balance_after,
        'replay_of', v_existing_ledger.id,
        'settlement_version', v_settlement_version
      );
    END IF;

    RETURN jsonb_build_object('ok', false, 'error', 'idempotency_key_conflict',
      'ticket_id', p_ticket_id,
      'existing_type', CASE WHEN FOUND THEN v_existing_ledger.type ELSE NULL END,
      'requested_type', v_expected_ledger_type,
      'settlement_version', v_settlement_version);
  END;

  -- 6. Update the locked ticket to terminal status.
  --    GRD-2: When push-reduced, also correct potential_profit to the actual
  --    reduced profit that was paid, so the settled ticket record is accurate.
  UPDATE tickets
     SET status           = v_result,
         potential_profit = CASE
                              WHEN p_override_profit IS NOT NULL
                              THEN round(p_override_profit::numeric, 2)
                              ELSE potential_profit
                            END,
         graded_at        = v_now,
         grading_source   = coalesce(p_grading_source, 'server-grade'),
         grading_snapshot = v_snapshot
   WHERE id = p_ticket_id;

  -- 7. Best-effort canonical audit event.
  BEGIN
    INSERT INTO audit_events (
      event_type, ticket_id, player_id, club_id, payload
    ) VALUES (
      'ticket_graded_canonical',
      p_ticket_id,
      p_player_id,
      p_club_id,
      jsonb_build_object(
        'settlement_version', v_settlement_version,
        'previous_status', v_ticket.status,
        'new_status', v_result,
        'ledger_entry_id', p_idempotency_key,
        'ledger_type', v_ledger_type,
        'amount', v_amount,
        'balance_before', v_balance_before,
        'balance_after', v_balance_after,
        'push_reduced', (p_override_profit IS NOT NULL),
        'grading_source', coalesce(p_grading_source, 'server-grade'),
        'grading_snapshot', v_snapshot,
        'created_by', coalesce(p_created_by, p_player_id)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'ticket_id', p_ticket_id,
    'status', v_result,
    'previous_status', v_ticket.status,
    'ledger_entry_id', p_idempotency_key,
    'settlement_type', v_ledger_type,
    'amount', v_amount,
    'balance_before', v_balance_before,
    'balance_after', v_balance_after,
    'graded_at', v_now,
    'push_reduced', (p_override_profit IS NOT NULL),
    'settlement_version', v_settlement_version
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
        'error', 'grade_ticket_tx_failed',
        'sqlstate', v_sqlstate,
        'message', v_msg,
        'detail', v_detail,
        'hint', v_hint,
        'ticket_id', p_ticket_id,
        'settlement_version', v_settlement_version
      );
    END;
END;
$$;

-- Revoke from all non-service roles (same pattern as prior migrations).
REVOKE EXECUTE ON FUNCTION public.grade_ticket_tx(
  text, text, text, text, numeric, text, text, text, jsonb, numeric
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.grade_ticket_tx(
  text, text, text, text, numeric, text, text, text, jsonb, numeric
) FROM anon;
REVOKE EXECUTE ON FUNCTION public.grade_ticket_tx(
  text, text, text, text, numeric, text, text, text, jsonb, numeric
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.grade_ticket_tx(
  text, text, text, text, numeric, text, text, text, jsonb, numeric
) TO service_role;
