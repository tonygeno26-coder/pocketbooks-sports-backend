-- ============================================================================
-- grade_ticket_tx — canonical ticket settlement RPC (draft)
-- ============================================================================
-- Runtime owns outcome derivation. This RPC owns money safety only.
--
-- v1 scope:
--   - Supports only p_grade_result in ('won','lost','push')
--   - Locks the ticket row with SELECT ... FOR UPDATE
--   - Uses ledger_entries.id as the idempotency anchor
--   - Rejects terminal tickets unless replaying the same idempotency key
--   - Updates ticket + ledger atomically, then attempts best-effort audit
--   - Returns replay-safe JSON
--   - Stamps settlement_version='pb_v1' in return payload, ledger reason, and
--     grading/audit snapshots
--
-- Compatibility note:
--   Current balance views derive available balance from tickets:
--     balance_start - active/open risk - lost risk + won profit.
--   Therefore settlement deltas are:
--     won  => risk + profit  (release active risk + pay profit)
--     lost => 0              (active risk becomes settled loss)
--     push => risk           (release active risk)
--
-- This function is intentionally narrow. It does not implement re-grade,
-- void/refund/canceled handling, parlay reduction, or outcome derivation.
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
  v_start_balance      numeric := 1000;
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
  v_effective_club_id  text;
  v_prev_status        text;
  v_snapshot           jsonb;
BEGIN
  -- 0. Param sanity.
  IF p_ticket_id IS NULL OR length(trim(p_ticket_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ticket_id',
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

  -- 1. Replay by idempotency key. The ledger id is the canonical anchor.
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

  -- 2. Lock the ticket row. This serializes settlement per ticket.
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

  IF nullif(p_club_id, '') IS NOT NULL
     AND v_ticket.club_id IS NOT NULL
     AND v_ticket.club_id IS DISTINCT FROM p_club_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ticket_club_mismatch',
      'ticket_id', p_ticket_id, 'settlement_version', v_settlement_version);
  END IF;

  v_effective_club_id := coalesce(nullif(p_club_id, ''), v_ticket.club_id);

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

  -- 3. Lock player/club membership when present, matching place_bet_tx's
  --    per-player serialization. Missing membership keeps the legacy 1000
  --    fallback instead of failing.
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

  -- 4. Balance before settlement, using the current ticket-derived model.
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

  -- 5. Insert canonical settlement ledger row first. If this fails, ticket
  --    update and audit insert do not happen.
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

  -- 7. Best-effort canonical audit event. audit_events has known live-schema
  --    drift risk; audit failure must not block canonical ticket/ledger safety.
  BEGIN
    INSERT INTO audit_events (
      event_type, ticket_id, player_id, club_id, payload
    ) VALUES (
      'ticket_graded_canonical',
      p_ticket_id,
      p_player_id,
      v_effective_club_id,
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

-- Grants mirror the intended Supabase RPC usage. SECURITY DEFINER functions
-- should not keep default PUBLIC execute; backend calls use service_role.
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

-- ============================================================================
-- Destructive-ops audit
-- ============================================================================
-- No DROP statements.
-- No DELETE statements.
-- No TRUNCATE statements.
-- No table rewrites.
-- CREATE OR REPLACE FUNCTION replaces only public.grade_ticket_tx if it already
-- exists. Production currently reported zero rows for this function lookup.
-- REVOKE/GRANT only changes execute permissions for this function.

-- ============================================================================
-- Verification SELECTs
-- ============================================================================

SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS identity_args,
  pg_get_function_arguments(p.oid) AS full_args,
  pg_get_function_result(p.oid) AS result_type,
  r.rolname AS owner,
  p.prosecdef AS security_definer,
  p.provolatile AS volatility,
  p.proparallel AS parallel_safety,
  p.proconfig AS function_config,
  pg_get_functiondef(p.oid) AS function_definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public'
  AND p.proname = 'grade_ticket_tx';

SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS identity_args,
  grantee,
  privilege_type,
  is_grantable
FROM information_schema.routine_privileges rp
JOIN pg_proc p
  ON p.proname = rp.routine_name
JOIN pg_namespace n
  ON n.nspname = rp.routine_schema
 AND n.oid = p.pronamespace
WHERE rp.routine_schema = 'public'
  AND rp.routine_name = 'grade_ticket_tx'
ORDER BY grantee, privilege_type;

-- ============================================================================
-- Test plan SQL (transaction-wrapped; replace placeholders, then run as one
-- block and ROLLBACK so disposable rows do not persist)
-- ============================================================================
-- BEGIN;
--
-- 0. Disposable fixture. Replace values with valid local/live test IDs.
-- INSERT INTO tickets (
--   id, club_id, player_id, player_username, type, status,
--   risk_amount, potential_profit, estimated_payout, placed_at
-- ) VALUES (
--   'T_DISPOSABLE_WIN', '<club_id>', '<player_id>', 'sql-test-player',
--   'Single', 'active', 1.00, 0.79, 1.79, now()
-- );
--
-- 1. Missing params:
-- SELECT public.grade_ticket_tx(null, 'club', 'player', 'won', 1, 'TEST_MISSING', 'tester');
--
-- 2. Unknown ticket:
-- SELECT public.grade_ticket_tx('NO_SUCH_TICKET', 'club', 'player', 'won', 1, 'TEST_UNKNOWN', 'tester');
--
-- 3. Invalid result:
-- SELECT public.grade_ticket_tx('T_TEST', 'club', 'player', 'void', 1, 'TEST_BAD_RESULT', 'tester');
--
-- 4. Controlled win settlement:
-- SELECT public.grade_ticket_tx(
--   'T_DISPOSABLE_WIN', '<club_id>', '<player_id>', 'won', 0.79,
--   'SETTLE_T_DISPOSABLE_WIN_v1', 'sql-test', 'sql-test',
--   '{"test":true}'::jsonb
-- );
--
-- 5. Replay same idempotency key:
-- SELECT public.grade_ticket_tx(
--   'T_DISPOSABLE_WIN', '<club_id>', '<player_id>', 'won', 0.79,
--   'SETTLE_T_DISPOSABLE_WIN_v1', 'sql-test', 'sql-test',
--   '{"test":"replay"}'::jsonb
-- );
--
-- 6. Same idempotency key with different result should conflict:
-- SELECT public.grade_ticket_tx(
--   'T_DISPOSABLE_WIN', '<club_id>', '<player_id>', 'lost', 0,
--   'SETTLE_T_DISPOSABLE_WIN_v1', 'sql-test'
-- );
--
-- 7. Different idempotency key after terminal settlement should reject:
-- SELECT public.grade_ticket_tx(
--   'T_DISPOSABLE_WIN', '<club_id>', '<player_id>', 'lost', 0,
--   'SETTLE_T_DISPOSABLE_WIN_v1_DIFFERENT', 'sql-test'
-- );
--
-- 8. Verify one ledger row:
-- SELECT id, ticket_id, type, amount, balance_before, balance_after, reason
-- FROM ledger_entries
-- WHERE ticket_id = 'T_DISPOSABLE_WIN'
-- ORDER BY created_at;
--
-- 9. Verify ticket terminal state:
-- SELECT id, status, graded_at, grading_source, grading_snapshot
-- FROM tickets
-- WHERE id = 'T_DISPOSABLE_WIN';
--
-- ROLLBACK;
