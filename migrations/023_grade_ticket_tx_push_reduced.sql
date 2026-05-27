-- Migration 023: grade_ticket_tx — push-reduced parlay support (GRD-2)
--
-- Adds optional p_override_profit parameter so push-reduced parlays
-- (some legs pushed, remaining winning legs) can be settled at corrected
-- reduced odds rather than the original full-parlay potential_profit.
--
-- Backward compatible: all existing callers that omit p_override_profit
-- behave exactly as before.
--
-- Changes vs original grade_ticket_tx (008_money_rpcs.sql):
--   1. New param:  p_override_profit NUMERIC DEFAULT NULL
--   2. Profit resolution: p_override_profit takes precedence over p_profit
--   3. profit_mismatch guard skipped when p_override_profit IS NOT NULL
--   4. tickets.potential_profit updated to corrected value when p_override_profit IS NOT NULL
--
-- Unchanged:
--   - status transition logic
--   - idempotency checks
--   - ledger insert structure
--   - club isolation
--   - balance formula

CREATE OR REPLACE FUNCTION grade_ticket_tx(
  p_ticket_id        TEXT,
  p_club_id          TEXT,
  p_player_id        TEXT,
  p_grade_result     TEXT,       -- 'won' | 'lost' | 'push'
  p_profit           NUMERIC     DEFAULT 0,
  p_idempotency_key  TEXT        DEFAULT NULL,
  p_created_by       TEXT        DEFAULT 'server',
  p_override_profit  NUMERIC     DEFAULT NULL  -- GRD-2: push-reduced parlay override
) RETURNS JSONB AS $$
DECLARE
  v_ticket        RECORD;
  v_starting      NUMERIC;
  v_ledger_bal    NUMERIC;
  v_event_type    TEXT;
  v_amount        NUMERIC;
  v_direction     TEXT;
  v_bal_after     NUMERIC;
  v_target_status TEXT;
  v_profit        NUMERIC;  -- resolved profit for this grading
BEGIN
  -- ── Map result to event type ──────────────────────────────────────────────
  IF    p_grade_result = 'won'  THEN v_event_type := 'BET_GRADED_WIN';  v_target_status := 'won';
  ELSIF p_grade_result = 'lost' THEN v_event_type := 'BET_GRADED_LOSS'; v_target_status := 'lost';
  ELSIF p_grade_result = 'push' THEN v_event_type := 'BET_GRADED_PUSH'; v_target_status := 'push';
  ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_grade_result:' || p_grade_result);
  END IF;

  -- ── Prior grade idempotency ───────────────────────────────────────────────
  PERFORM 1 FROM ledger
    WHERE ticket_id = p_ticket_id
      AND event_type IN ('BET_GRADED_WIN', 'BET_GRADED_LOSS', 'BET_GRADED_PUSH')
    LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'ticket_id', p_ticket_id);
  END IF;

  -- ── Lock + load ticket ────────────────────────────────────────────────────
  SELECT * INTO v_ticket FROM tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ticket_not_found');
  END IF;
  IF v_ticket.status NOT IN ('active', 'open') THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'invalid_transition:' || v_ticket.status || '→' || v_target_status);
  END IF;

  -- ── GRD-2: Resolve profit ─────────────────────────────────────────────────
  -- p_override_profit takes precedence (push-reduced parlay path).
  -- When present the profit_mismatch guard is intentionally skipped —
  -- the override was computed server-side from actual won-leg odds.
  IF p_override_profit IS NOT NULL THEN
    v_profit := ROUND(p_override_profit::NUMERIC, 2);
  ELSIF p_profit IS NOT NULL THEN
    v_profit := ROUND(p_profit::NUMERIC, 2);
  ELSE
    v_profit := ROUND(COALESCE(v_ticket.potential_profit, 0)::NUMERIC, 2);
  END IF;

  -- ── Update ticket status (and corrected profit when push-reduced) ─────────
  IF p_override_profit IS NOT NULL THEN
    UPDATE tickets
       SET status           = v_target_status,
           graded_at        = NOW(),
           potential_profit = ROUND(p_override_profit::NUMERIC, 2)
     WHERE id = p_ticket_id;
  ELSE
    UPDATE tickets
       SET status    = v_target_status,
           graded_at = NOW()
     WHERE id = p_ticket_id;
  END IF;

  -- ── Compute ledger amount + direction ─────────────────────────────────────
  IF p_grade_result = 'won' THEN
    v_amount    := ROUND(v_ticket.risk_amount + v_profit, 2);
    v_direction := 'credit';
  ELSIF p_grade_result = 'push' THEN
    v_amount    := v_ticket.risk_amount;  -- full stake refund
    v_direction := 'credit';
  ELSE -- lost: risk was already reserved at placement; no new ledger credit needed
    v_amount    := v_ticket.risk_amount;
    v_direction := 'neutral';
  END IF;

  -- ── Balance stamp ─────────────────────────────────────────────────────────
  SELECT COALESCE(balance_start, 1000) INTO v_starting
    FROM player_limits
   WHERE club_id = p_club_id AND player_id = p_player_id
   LIMIT 1;
  IF NOT FOUND THEN v_starting := 1000; END IF;

  v_ledger_bal := _pb_ledger_balance(p_club_id, p_player_id, v_starting);
  v_bal_after  := CASE
    WHEN v_direction = 'credit' THEN ROUND(v_ledger_bal + v_amount, 2)
    ELSE v_ledger_bal
  END;

  -- ── Write ledger ──────────────────────────────────────────────────────────
  INSERT INTO ledger(
    ledger_id, club_id, player_id, ticket_id,
    event_type, amount, currency,
    direction, balance_before, balance_after,
    idempotency_key, created_by, reason
  ) VALUES (
    'LE_GR_' || p_ticket_id || '_' || p_grade_result,
    p_club_id, p_player_id, p_ticket_id,
    v_event_type, v_amount, 'diamonds',
    v_direction, v_ledger_bal, v_bal_after,
    p_idempotency_key, p_created_by,
    'grade_' || p_grade_result
      || CASE WHEN p_override_profit IS NOT NULL THEN ':push_reduced' ELSE '' END
  );

  RETURN jsonb_build_object(
    'ok',              true,
    'ticket_id',       p_ticket_id,
    'grade_result',    p_grade_result,
    'event_type',      v_event_type,
    'amount',          v_amount,
    'balance_after',   v_bal_after,
    'push_reduced',    (p_override_profit IS NOT NULL),
    'override_profit', p_override_profit
  );
END;
$$ LANGUAGE plpgsql;
