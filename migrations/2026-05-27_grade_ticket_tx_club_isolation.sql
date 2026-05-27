-- ============================================================================
-- 2026-05-27_grade_ticket_tx_club_isolation
-- ============================================================================
-- Hardens club isolation in grade_ticket_tx (GRD-5).
--
-- What was wrong:
--   Three soft-bypass patterns allowed grading without proper club scoping:
--
--   1. Club mismatch check used double-NULLIF:
--        IF nullif(p_club_id,'') IS NOT NULL
--           AND v_ticket.club_id IS NOT NULL
--           AND v_ticket.club_id IS DISTINCT FROM p_club_id THEN ...
--      If either p_club_id or v_ticket.club_id was null/empty, the check
--      was silently skipped.
--
--   2. v_effective_club_id coalesced caller value with ticket value:
--        v_effective_club_id := coalesce(nullif(p_club_id,''), v_ticket.club_id)
--      An empty/null p_club_id silently inherited the ticket's own club_id.
--
--   3. Balance lock and ticket aggregate used OR-NULL bypass:
--        AND (v_effective_club_id IS NULL OR club_id = v_effective_club_id)
--      If v_effective_club_id was NULL (both caller empty AND ticket null),
--      no club filter was applied at all — any player's balance could be
--      locked and any ticket could be included in the aggregate.
--
-- What this fixes:
--   • Step 0 param sanity: p_club_id must be non-null and non-empty.
--     Returns { ok:false, error:'missing_club_id' } otherwise.
--   • v_effective_club_id removed from DECLARE — p_club_id used directly.
--   • Club mismatch check: hard reject if v_ticket.club_id != p_club_id.
--   • Balance lock: WHERE club_id = p_club_id (no OR-NULL bypass).
--   • Ticket aggregate: WHERE club_id = p_club_id (no OR-NULL bypass).
--   • Ledger INSERT and audit INSERT use p_club_id directly.
--
-- JS callers pass ticket.club_id||'' — empty string now returns missing_club_id.
--   _runGradeCore:   goes to else skipped++ (safe)
--   /api/grade/run:  thrown → errors array (more visible than before)
--   /api/grade/manual: returns 400 (correct)
--   No JS changes required.
--
-- What is NOT changed:
--   • Function signature — unchanged
--   • Param sanity for ticket_id, player_id, idempotency_key — unchanged
--   • Idempotency replay logic — unchanged
--   • Ticket lock (FOR UPDATE on tickets row) — unchanged
--   • Status transition / terminal check — unchanged
--   • Payout math (won=risk+profit, lost=0, push=risk) — unchanged
--   • Ledger INSERT + unique_violation handler — unchanged
--   • Ticket UPDATE — unchanged
--   • Audit event (best-effort block) — unchanged
--   • Return shape — unchanged (new error code: missing_club_id)
--   • GRANT / REVOKE — unchanged (service_role only)
--
-- Builds on 2026-05-27_grade_ticket_tx_balance_fix.sql (GRD-1).
-- Safe to apply: CREATE OR REPLACE is atomic. No table DDL. No data mutations.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.grade_ticket_tx(
  p_ticket_id        text,
  p_club_id          text,
  p_player_id        text,
  p_grade_result     text,
  p_profit           numeric,
  p_idempotency_key  text,
  p_created_by       text,
  p_grading_source   text  DEFAULT 'server-grade',
  p_grading_snapshot jsonb DEFAULT '{}'::jsonb
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
  -- GRD-5: p_club_id is required (validated above) and used directly throughout.
  v_prev_status        text;
  v_snapshot           jsonb;
BEGIN
  -- 0. Param sanity.
  IF p_ticket_id IS NULL OR length(trim(p_ticket_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ticket_id',
      'settlement_version', v_settlement_version);
  END IF;
  -- GRD-5: p_club_id is now required. Callers must pass a real club_id.
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

  -- GRD-5: Hard club mismatch check.  p_club_id is validated non-empty above.
  --   Reject if the ticket belongs to a different club than the caller claims.
  --   Tickets with a null club_id are also rejected (orphaned / legacy data).
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
  v_profit := round(coalesce(v_ticket.potential_profit, p_profit, 0)::numeric, 2);

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
  IF p_profit IS NOT NULL AND abs(round(p_profit::numeric, 2) - v_profit) > 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'profit_mismatch',
      'ticket_id', p_ticket_id, 'provided_profit', p_profit,
      'ticket_profit', v_profit, 'settlement_version', v_settlement_version);
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
      'idempotency_key', p_idempotency_key
    );

  -- 5. Insert canonical settlement ledger row first.  If this fails, ticket
  --    update and audit insert do not happen.
  --    GRD-5: uses p_club_id directly.
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
  UPDATE tickets
     SET status = v_result,
         graded_at = v_now,
         grading_source = coalesce(p_grading_source, 'server-grade'),
         grading_snapshot = v_snapshot
   WHERE id = p_ticket_id;

  -- 7. Best-effort canonical audit event.  audit_events has known live-schema
  --    drift risk; audit failure must not block canonical ticket/ledger safety.
  --    GRD-5: uses p_club_id directly.
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

REVOKE EXECUTE ON FUNCTION public.grade_ticket_tx(
  text, text, text, text, numeric, text, text, text, jsonb
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.grade_ticket_tx(
  text, text, text, text, numeric, text, text, text, jsonb
) FROM anon;
REVOKE EXECUTE ON FUNCTION public.grade_ticket_tx(
  text, text, text, text, numeric, text, text, text, jsonb
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.grade_ticket_tx(
  text, text, text, text, numeric, text, text, text, jsonb
) TO service_role;
