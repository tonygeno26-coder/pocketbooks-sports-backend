-- PROPOSED (DO NOT APPLY without explicit approval)
-- Option A serialized RECORD settlement: pg_advisory_xact_lock per (club_id, player_id).
-- Order in one txn: lock → recompute → validate → reject over-settlement → insert record → return before/after.
-- Records that an OFF-PLATFORM settlement occurred; does NOT move funds.
-- Never trusts FE preview. Does NOT mutate balance_start / tickets.
-- Lock timeout: SET LOCAL lock_timeout (default 3s) — no infinite wait.
-- Terminology: formerly settle_payment_option_a_tx / settlement_payments.
-- Rollback: DROP FUNCTION ... ; DROP FUNCTION settlement_lock_keys ...

BEGIN;

-- Deterministic low-collision two-key lock material (matches lib/settlement-lock.js)
CREATE OR REPLACE FUNCTION public.settlement_lock_keys(p_club_id text, p_player_id text)
RETURNS integer[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    (('x' || substr(md5('settle_v1|' || coalesce(p_club_id,'') || '|' || coalesce(p_player_id,'')), 1, 8))::bit(32)::int),
    (('x' || substr(md5('settle_v1|' || coalesce(p_club_id,'') || '|' || coalesce(p_player_id,'')), 9, 8))::bit(32)::int)
  ];
$$;

COMMENT ON FUNCTION public.settlement_lock_keys(text, text) IS
  'Advisory lock keys for Option A settlement-recording serialization (club_id + player_id).';

-- Epoch cutoff ms (historical markers only) for one club+player
CREATE OR REPLACE FUNCTION public._settlement_cutoff_ms(p_club_id text, p_player_id text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_ms bigint := 0;
  r record;
BEGIN
  FOR r IN
    SELECT id, type, reason, created_at
      FROM public.ledger_entries
     WHERE club_id = p_club_id
       AND player_id = p_player_id
       AND type IN ('SETTLEMENT_APPLIED','settlement_applied','weekly_rollover','WEEKLY_ROLLOVER')
  LOOP
    IF r.type IN ('weekly_rollover','WEEKLY_ROLLOVER')
       OR (
         r.type IN ('SETTLEMENT_APPLIED','settlement_applied')
         AND (
           coalesce(r.id,'') LIKE 'SETTLEMENT_APPLIED_%'
           OR coalesce(r.reason,'') LIKE 'weekly_rollover:%'
         )
       )
    THEN
      IF (extract(epoch FROM r.created_at) * 1000)::bigint > v_ms THEN
        v_ms := (extract(epoch FROM r.created_at) * 1000)::bigint;
      END IF;
    END IF;
  END LOOP;
  RETURN v_ms;
END;
$$;

-- Authoritative carry recompute (player POV)
CREATE OR REPLACE FUNCTION public._settlement_recompute_carry(
  p_club_id text,
  p_player_id text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_cut_ms bigint;
  v_cut timestamptz;
  v_ticket_net numeric := 0;
  v_player_settled numeric := 0;
  v_host_settled numeric := 0;
  v_opening numeric := 0;
  v_carry numeric;
  v_grade timestamptz;
  t record;
  p record;
BEGIN
  v_cut_ms := public._settlement_cutoff_ms(p_club_id, p_player_id);
  IF v_cut_ms > 0 THEN
    v_cut := to_timestamp(v_cut_ms / 1000.0);
  ELSE
    v_cut := NULL;
  END IF;

  IF to_regclass('public.settlement_opening_balances') IS NOT NULL THEN
    SELECT coalesce(opening_balance, 0) INTO v_opening
      FROM public.settlement_opening_balances
     WHERE club_id = p_club_id AND player_id = p_player_id
     LIMIT 1;
    IF NOT FOUND THEN v_opening := 0; END IF;
  ELSE
    v_opening := 0;
  END IF;

  FOR t IN
    SELECT status, risk_amount, potential_profit, graded_at, placed_at
      FROM public.tickets
     WHERE club_id = p_club_id AND player_id = p_player_id
  LOOP
    IF lower(coalesce(t.status,'')) IN ('canceled','voided','deleted','push','pushed') THEN
      CONTINUE;
    END IF;
    IF lower(coalesce(t.status,'')) IN ('active','open') THEN
      CONTINUE;
    END IF;
    v_grade := coalesce(t.graded_at, t.placed_at);
    IF v_cut IS NOT NULL AND v_grade IS NOT NULL AND v_grade <= v_cut THEN
      CONTINUE;
    END IF;
    IF lower(t.status) = 'won' THEN
      v_ticket_net := v_ticket_net + coalesce(t.potential_profit, 0);
    ELSIF lower(t.status) = 'lost' THEN
      v_ticket_net := v_ticket_net - coalesce(t.risk_amount, 0);
    END IF;
  END LOOP;

  FOR p IN
    SELECT direction, amount, confirmed_at, created_at
      FROM public.settlement_records
     WHERE club_id = p_club_id
       AND player_id = p_player_id
       AND status = 'confirmed'
  LOOP
    IF v_cut IS NOT NULL
       AND coalesce(p.confirmed_at, p.created_at) IS NOT NULL
       AND coalesce(p.confirmed_at, p.created_at) <= v_cut THEN
      CONTINUE;
    END IF;
    IF p.direction = 'player_paid_host' THEN
      v_player_settled := v_player_settled + coalesce(p.amount, 0);
    ELSIF p.direction = 'host_paid_player' THEN
      v_host_settled := v_host_settled + coalesce(p.amount, 0);
    END IF;
  END LOOP;

  v_ticket_net := round(v_ticket_net::numeric, 2);
  v_player_settled := round(v_player_settled::numeric, 2);
  v_host_settled := round(v_host_settled::numeric, 2);
  v_opening := round(v_opening::numeric, 2);
  v_carry := round((v_opening + v_ticket_net + v_player_settled - v_host_settled)::numeric, 2);

  RETURN jsonb_build_object(
    'openingBalance', v_opening,
    'ticketSettledNet', v_ticket_net,
    'playerPaidHost', v_player_settled,  -- amount settled player→host (recorded; off-platform)
    'hostPaidPlayer', v_host_settled,    -- amount settled host→player (recorded; off-platform)
    'settlementBalance', v_carry,
    'cutoffMs', v_cut_ms
  );
END;
$$;

/**
 * Serialized Option A settlement RECORD (off-platform settlement acknowledgment).
 * p_lock_timeout_ms: default 3000; on lock wait failure → ok:false error lock_timeout (no mutation).
 */
CREATE OR REPLACE FUNCTION public.record_settlement_option_a_tx(
  p_club_id text,
  p_player_id text,
  p_amount numeric,
  p_idempotency_key text,
  p_direction text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_created_by text DEFAULT 'host',
  p_period_id text DEFAULT 'DIRECT',
  p_lock_timeout_ms integer DEFAULT 3000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_keys integer[];
  v_timeout text;
  v_carry jsonb;
  v_before numeric;
  v_amt numeric;
  v_max numeric;
  v_after numeric;
  v_dir text;
  v_record_id text;
  v_settlement_id text;
  v_existing record;
  v_now timestamptz := now();
  v_inserted_id text;
BEGIN
  IF p_club_id IS NULL OR length(trim(p_club_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_club_id');
  END IF;
  IF p_player_id IS NULL OR length(trim(p_player_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_player_id');
  END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;

  v_amt := round(coalesce(p_amount, 0)::numeric, 2);
  IF v_amt IS NULL OR v_amt <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;

  -- 1) Acquire per club+player advisory xact lock (NOT global)
  v_keys := public.settlement_lock_keys(p_club_id, p_player_id);
  v_timeout := greatest(1, least(coalesce(p_lock_timeout_ms, 3000), 30000))::text || 'ms';
  BEGIN
    EXECUTE format('SET LOCAL lock_timeout = %L', v_timeout);
    PERFORM pg_advisory_xact_lock(v_keys[1], v_keys[2]);
  EXCEPTION
    WHEN lock_not_available OR query_canceled THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'lock_timeout',
        'lockTimeoutMs', coalesce(p_lock_timeout_ms, 3000),
        'lockKey', jsonb_build_object('key1', v_keys[1], 'key2', v_keys[2], 'scope', 'club_id+player_id'),
        'retry', jsonb_build_object(
          'recommended', true,
          'backoffMs', 250,
          'maxAttempts', 3,
          'message', 'Settlement lock busy; retry with same Idempotency-Key. No settlement record was written.'
        ),
        'bankrollMutated', false
      );
    WHEN OTHERS THEN
      IF SQLSTATE IN ('55P03', '57014') THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'lock_timeout',
          'lockTimeoutMs', coalesce(p_lock_timeout_ms, 3000),
          'lockKey', jsonb_build_object('key1', v_keys[1], 'key2', v_keys[2], 'scope', 'club_id+player_id'),
          'retry', jsonb_build_object(
            'recommended', true,
            'backoffMs', 250,
            'maxAttempts', 3,
            'message', 'Settlement lock busy; retry with same Idempotency-Key. No settlement record was written.'
          ),
          'bankrollMutated', false
        );
      END IF;
      RAISE;
  END;

  v_record_id := 'SETTLE_DIRECT_' || p_club_id || '_' || p_idempotency_key;
  v_settlement_id := p_club_id || '::' || p_idempotency_key;

  -- Idempotent replay (same club-scoped key)
  SELECT record_id, amount, direction, status, balance_before, balance_after
    INTO v_existing
    FROM public.settlement_records
   WHERE record_id = v_record_id
     AND club_id = p_club_id
   LIMIT 1;

  IF FOUND AND coalesce(v_existing.status,'') = 'confirmed' THEN
    v_carry := public._settlement_recompute_carry(p_club_id, p_player_id);
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'executed', false,
      'recordId', v_record_id,
      'settlementId', v_settlement_id,
      'direction', v_existing.direction,
      'amount', v_existing.amount,
      'balanceBefore', v_existing.balance_before,
      'balanceAfter', (v_carry->>'settlementBalance')::numeric,
      'settlementBalance', (v_carry->>'settlementBalance')::numeric,
      'serialized', true,
      'bankrollMutated', false,
      'settlePlayerTxUsed', false,
      'lockKey', jsonb_build_object('key1', v_keys[1], 'key2', v_keys[2], 'scope', 'club_id+player_id')
    );
  END IF;

  -- 2) Recompute authoritative position (never trust FE)
  v_carry := public._settlement_recompute_carry(p_club_id, p_player_id);
  v_before := (v_carry->>'settlementBalance')::numeric;

  -- 3–4) Validate / reject over-settlement
  IF abs(v_before) < 0.005 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'balance_already_zero',
      'balanceBefore', v_before,
      'maxAmount', 0,
      'serialized', true,
      'bankrollMutated', false
    );
  END IF;

  v_max := round(abs(v_before)::numeric, 2);
  IF v_amt > v_max + 0.01 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'over_settlement_blocked',
      'amount', v_amt,
      'maxAmount', v_max,
      'balanceBefore', v_before,
      'message', 'Recorded settlement cannot cross zero. Max amount settled is $' || v_max::text,
      'serialized', true,
      'bankrollMutated', false
    );
  END IF;

  v_dir := CASE WHEN v_before < 0 THEN 'player_paid_host' ELSE 'host_paid_player' END;
  IF p_direction IS NOT NULL AND length(trim(p_direction)) > 0 AND p_direction <> v_dir THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'direction_mismatch',
      'expected', v_dir,
      'got', p_direction,
      'balanceBefore', v_before,
      'serialized', true,
      'bankrollMutated', false
    );
  END IF;

  v_after := round((sign(v_before) * greatest(abs(v_before) - v_amt, 0))::numeric, 2);
  IF abs(v_after) < 0.005 THEN v_after := 0; END IF;

  -- 5) Insert settlement record (append-only ledger SoT for recorded off-platform settlements)
  INSERT INTO public.settlement_records (
    record_id, period_id, revision, club_id, player_id, direction,
    amount, amount_cents, method, status, note,
    created_at, created_by, confirmed_at, confirmed_by,
    ledger_written, ledger_settlement_id, balance_before, balance_after
  ) VALUES (
    v_record_id, coalesce(nullif(p_period_id,''), 'DIRECT'), 0, p_club_id, p_player_id, v_dir,
    v_amt, round(v_amt * 100)::integer, 'recorded', 'confirmed',
    coalesce(p_note,'') || CASE WHEN coalesce(p_note,'') = '' THEN '' ELSE ' | ' END ||
      'carry:' || v_before::text || '→' || v_after::text,
    v_now, coalesce(p_created_by,'host'), v_now, coalesce(p_created_by,'host'),
    false, v_settlement_id, v_before, v_after
  )
  ON CONFLICT (record_id) DO NOTHING
  RETURNING record_id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    -- Unique race on record_id → idempotent
    SELECT record_id, amount, direction, status, balance_before, balance_after
      INTO v_existing
      FROM public.settlement_records
     WHERE record_id = v_record_id AND club_id = p_club_id
     LIMIT 1;
    v_carry := public._settlement_recompute_carry(p_club_id, p_player_id);
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'executed', false,
      'recordId', v_record_id,
      'settlementId', v_settlement_id,
      'direction', coalesce(v_existing.direction, v_dir),
      'amount', coalesce(v_existing.amount, v_amt),
      'balanceBefore', v_existing.balance_before,
      'balanceAfter', (v_carry->>'settlementBalance')::numeric,
      'settlementBalance', (v_carry->>'settlementBalance')::numeric,
      'serialized', true,
      'bankrollMutated', false,
      'settlePlayerTxUsed', false
    );
  END IF;

  -- Audit-only ledger mirror (does not advance epoch; not bankroll; not funds movement)
  INSERT INTO public.ledger_entries (
    id, club_id, player_id, type, amount, reason, created_at, created_by
  ) VALUES (
    v_settlement_id, p_club_id, p_player_id, 'settlement_record',
    CASE WHEN v_dir = 'host_paid_player' THEN v_amt ELSE -v_amt END,
    'recorded ' || v_dir || ' carry ' || v_before::text || '→' || v_after::text,
    v_now, coalesce(p_created_by,'host')
  )
  ON CONFLICT (id) DO NOTHING;

  -- 6) Return authoritative before/after (7 = commit by caller/xact end)
  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'executed', true,
    'recordId', v_record_id,
    'settlementId', v_settlement_id,
    'direction', v_dir,
    'amount', v_amt,
    'maxAmount', v_max,
    'balanceBefore', v_before,
    'balanceAfter', v_after,
    'settlementBalance', v_after,
    'owesHost', CASE WHEN v_after < -0.005 THEN abs(v_after) ELSE 0 END,
    'hostOwes', CASE WHEN v_after > 0.005 THEN v_after ELSE 0 END,
    'serialized', true,
    'bankrollMutated', false,
    'settlePlayerTxUsed', false,
    'lockKey', jsonb_build_object('key1', v_keys[1], 'key2', v_keys[2], 'scope', 'club_id+player_id'),
    'carryComponents', v_carry
  );
END;
$function$;

COMMENT ON FUNCTION public.record_settlement_option_a_tx IS
  'Option A serialized settlement RECORD via pg_advisory_xact_lock(club,player). Off-platform acknowledgment only; no funds movement; no bankroll mutation.';

COMMIT;

-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.record_settlement_option_a_tx(text,text,numeric,text,text,text,text,text,integer);
--   DROP FUNCTION IF EXISTS public._settlement_recompute_carry(text,text);
--   DROP FUNCTION IF EXISTS public._settlement_cutoff_ms(text,text);
--   DROP FUNCTION IF EXISTS public.settlement_lock_keys(text,text);
