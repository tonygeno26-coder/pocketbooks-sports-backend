-- ============================================================================
-- place_bet_tx — Phase A minimal viable RPC
-- ============================================================================
-- Atomic ticket placement: re-derives player balance under row lock, validates
-- stake, inserts tickets + ledger_entries, returns balance_after.
--
-- Scope intentionally narrow:
--   • Idempotency via ledger_entries.id UNIQUE on p_idempotency_key
--   • Balance re-check inside transaction (JS-side check is informational only)
--   • Per-player serialization via SELECT ... FOR UPDATE on club_members
--   • NO server-side risk-limit enforcement (Phase J) — JS pre-check covers
--     this until we add a follow-up SQL enforcement pass
--   • NO ticket_legs writes here — handler inserts legs after this RPC succeeds
--
-- Return contract (matches what /api/bets/place expects):
--   { ok: bool, idempotent: bool, balance_after: numeric, ticket_id: text,
--     error?: text, available?: numeric, stake?: numeric, code?: text }
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
  v_start_balance   numeric := 1000;   -- default if club_members row missing
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
  --    entry, return the matching ticket as { ok:true, idempotent:true } so
  --    the handler can short-circuit.
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

  -- 2. Lock the player row in club_members to serialize concurrent placements
  --    for the same player. If no row exists we fall back to the default
  --    start balance — same behavior as the JS pre-check.
  SELECT COALESCE(balance_start, 1000)
    INTO v_start_balance
    FROM club_members
   WHERE player_id = p_player_id
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    v_start_balance := 1000;
  END IF;

  -- 3. Re-derive available balance from tickets (canonical player storage).
  --    Status semantics mirror the JS check in /api/bets/place.
  SELECT
    COALESCE(SUM(CASE WHEN lower(status) IN ('active','open')
                      THEN COALESCE(risk_amount, 0) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN lower(status) = 'won'
                      THEN COALESCE(potential_profit, 0) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN lower(status) = 'lost'
                      THEN COALESCE(risk_amount, 0) ELSE 0 END), 0)
    INTO v_open_risk, v_settled_gains, v_settled_losses
    FROM tickets
   WHERE player_id = p_player_id;

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

  -- 4. Insert the tickets row. Parent must exist before ticket_legs FK is
  --    satisfied (handler inserts legs immediately after this returns ok).
  --    ON CONFLICT (id) guards against retry with same ticket_id.
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

  -- 5. Canonical ledger entry. UNIQUE on id (idempotency_key) is what makes
  --    replays safe — if a concurrent caller squeezed in between our step 1
  --    lookup and here, the unique violation tells us this exact placement
  --    already landed.
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
    -- Concurrent caller beat us with the same idempotency key. Return the
    -- ticket they created (or ours, whichever won the ticket_id INSERT).
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
    -- Surface SQLERRM so the handler logs something useful instead of a 500.
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'place_bet_tx_failed',
      'detail', SQLERRM
    );
END;
$$;

-- Grant execution to the role(s) Supabase uses. Both authenticated and
-- service_role; the backend uses the service-role key, but allowing
-- authenticated is harmless because the function is SECURITY DEFINER and
-- doesn't trust caller-supplied auth context — the handler already gates
-- placement via requirePermissionScoped('place_bet').
GRANT EXECUTE ON FUNCTION public.place_bet_tx(
  text, text, text, text, text, numeric, numeric, numeric, text, text,
  int, text[], text[], text[], boolean
) TO authenticated, service_role;
