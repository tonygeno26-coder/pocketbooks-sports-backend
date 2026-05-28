-- ============================================================================
-- place_rr_tx — Round Robin atomic placement RPC (GRD-2/RR Option C)
-- ============================================================================
-- Atomically places a Round Robin bet as N independent Parlay tickets:
--   • Acquires per-player serialization lock (FOR UPDATE on club_members)
--   • Re-derives available balance from tickets (scoped to club)
--   • Inserts N Parlay ticket rows sharing a common rr_group_id
--   • Inserts ONE ledger_entries row debiting the total RR stake
--
-- Caller contract (index.js handler):
--   • JS pre-generates all combo ticket IDs and combo payloads (p_combos).
--   • JS handles ticket_legs insertion AFTER this RPC returns ok:true,
--     following the same pattern as place_bet_tx + leg insert.
--   • On leg insert failure, JS calls cancel_bet_tx for each combo ticket.
--
-- p_combos JSONB array element shape (each element = one combo):
--   {
--     "id":                text     -- unique ticket ID for this combo
--     "stake":             numeric  -- per-combo stake (e.g. 10.00)
--     "potential_profit":  numeric  -- server-computed combo profit
--     "estimated_payout":  numeric  -- server-computed combo payout
--   }
--
-- Return contract:
--   {
--     ok:            bool
--     idempotent:    bool
--     replayed:      bool       -- true only on idempotency replay
--     group_id:      text       -- the rr_group_id shared by all combos
--     combo_count:   int        -- number of ticket rows created
--     balance_after: numeric
--     available?:    numeric    -- only on first successful placement
--     total_stake?:  numeric    -- only on first successful placement
--     error?:        text
--     code?:         text
--   }
--
-- Idempotency:
--   Keyed on ledger_entries.id = p_idempotency_key (same mechanism as
--   place_bet_tx). A replayed request returns { ok:true, idempotent:true,
--   replayed:true } so the JS handler can short-circuit cleanly.
--
-- Prerequisite migration: 2026-05-28_tickets_rr_group_id.sql
--   (tickets.rr_group_id column + partial index must exist before this runs)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.place_rr_tx(
  p_group_id        text,          -- shared slip ID for all combos (RRG_...)
  p_club_id         text,
  p_player_id       text,
  p_player_username text,
  p_total_stake     numeric,       -- sum(stakePerCombo × comboCount) across all sizes
  p_idempotency_key text,
  p_created_by      text,
  p_combos          jsonb          -- [{id, stake, potential_profit, estimated_payout}]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_balance   numeric;
  v_open_risk       numeric := 0;
  v_settled_gains   numeric := 0;
  v_settled_losses  numeric := 0;
  v_available       numeric;
  v_balance_after   numeric;
  v_existing_ledger record;
  v_now             timestamptz := now();
  v_combo           jsonb;
  v_combo_id        text;
  v_combo_stake     numeric;
  v_combo_profit    numeric;
  v_combo_payout    numeric;
  v_combo_count     int     := 0;
  v_stakes_sum      numeric := 0;
BEGIN

  -- ── §0. Parameter sanity ──────────────────────────────────────────────────
  IF p_group_id IS NULL OR length(p_group_id) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_group_id');
  END IF;
  IF p_player_id IS NULL OR length(p_player_id) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_player_id');
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;
  IF p_total_stake IS NULL OR p_total_stake <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_total_stake');
  END IF;
  IF p_combos IS NULL OR jsonb_typeof(p_combos) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_combos',
      'detail', 'p_combos must be a non-null JSON array');
  END IF;
  IF jsonb_array_length(p_combos) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty_combos',
      'detail', 'p_combos must contain at least one combo');
  END IF;

  -- ── §0b. Validate combo elements and cross-check stake sum ────────────────
  -- Each element must have id (text) and stake (numeric > 0).
  -- Sum of combo stakes must equal p_total_stake within $0.01 tolerance.
  FOR v_combo IN SELECT value FROM jsonb_array_elements(p_combos) AS t(value)
  LOOP
    v_combo_id    := v_combo->>'id';
    v_combo_stake := (v_combo->>'stake')::numeric;

    IF v_combo_id IS NULL OR length(v_combo_id) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'combo_missing_id',
        'detail', 'Each combo element must have a non-empty "id" field');
    END IF;
    IF v_combo_stake IS NULL OR v_combo_stake <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'combo_invalid_stake',
        'combo_id', v_combo_id,
        'detail', 'Each combo stake must be > 0');
    END IF;

    v_stakes_sum  := v_stakes_sum + v_combo_stake;
    v_combo_count := v_combo_count + 1;
  END LOOP;

  IF abs(round(v_stakes_sum, 2) - round(p_total_stake, 2)) > 0.01 THEN
    RETURN jsonb_build_object(
      'ok',          false,
      'error',       'combo_stake_sum_mismatch',
      'total_stake', p_total_stake,
      'combo_sum',   round(v_stakes_sum, 2),
      'detail',      'Sum of combo stakes does not equal p_total_stake'
    );
  END IF;

  -- Reset counter for actual insert loop below.
  v_combo_count := 0;

  -- ── §1. Idempotency replay ────────────────────────────────────────────────
  -- If this key already produced a ledger entry, this is a replayed request.
  -- Return early with idempotent:true so the handler can short-circuit.
  -- The group_id comes from the function param (always available on replay).
  SELECT id, balance_after
    INTO v_existing_ledger
    FROM ledger_entries
   WHERE id = p_idempotency_key
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok',            true,
      'idempotent',    true,
      'replayed',      true,
      'group_id',      p_group_id,
      'combo_count',   jsonb_array_length(p_combos),
      'balance_after', v_existing_ledger.balance_after
    );
  END IF;

  -- ── §2. Per-player serialization lock ────────────────────────────────────
  -- Same mechanism as place_bet_tx: SELECT ... FOR UPDATE on club_members
  -- serializes concurrent placements for the same player+club.
  -- club_members.balance_start is the authoritative starting balance.
  -- No $1,000 fallback — missing club_members row is an explicit rejection.
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
      'hint',  'No balance record found for this player at this club'
    );
  END IF;

  -- ── §3. Re-derive available balance from tickets (club-scoped) ────────────
  -- Identical formula to place_bet_tx v2.  club_id = p_club_id prevents
  -- cross-club contamination.
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

  IF p_total_stake > v_available + 0.005 THEN
    RETURN jsonb_build_object(
      'ok',        false,
      'error',     'insufficient_balance',
      'available', v_available,
      'stake',     p_total_stake
    );
  END IF;

  -- ── §4. Insert combo ticket rows ──────────────────────────────────────────
  -- Each combo becomes a Parlay ticket with rr_group_id linking it back to
  -- the originating RR slip.  ON CONFLICT (id) DO NOTHING guards against
  -- a retry that re-enters after the ledger insert but before the response
  -- reaches the caller (tickets are idempotent on their own PK).
  FOR v_combo IN SELECT value FROM jsonb_array_elements(p_combos) AS t(value)
  LOOP
    v_combo_id     := v_combo->>'id';
    v_combo_stake  := (v_combo->>'stake')::numeric;
    v_combo_profit := (v_combo->>'potential_profit')::numeric;
    v_combo_payout := (v_combo->>'estimated_payout')::numeric;

    INSERT INTO tickets (
      id, club_id, player_id, player_username,
      type, status, risk_amount, potential_profit, estimated_payout,
      placed_at, rr_group_id
    ) VALUES (
      v_combo_id,
      NULLIF(p_club_id, ''),
      p_player_id,
      p_player_username,
      'Parlay',
      'active',
      round(v_combo_stake::numeric, 2),
      round(COALESCE(v_combo_profit, 0)::numeric, 2),
      round(COALESCE(v_combo_payout, 0)::numeric, 2),
      v_now,
      p_group_id
    )
    ON CONFLICT (id) DO NOTHING;

    v_combo_count := v_combo_count + 1;
  END LOOP;

  -- ── §5. Single ledger debit for total RR stake ────────────────────────────
  -- One ledger entry for the entire RR placement (not per combo).
  -- ticket_id is NULL — this is a slip-level entry, not combo-level.
  -- (ledger_entries.ticket_id FK is nullable per 2026-05-24_id_columns_text.sql §5b.)
  -- Individual combo wins/losses get their own ledger entries from grade_ticket_tx.
  v_balance_after := round((v_available - p_total_stake)::numeric, 2);

  BEGIN
    INSERT INTO ledger_entries (
      id, club_id, player_id, ticket_id,
      type, amount, balance_before, balance_after,
      reason, created_at, created_by
    ) VALUES (
      p_idempotency_key,
      NULLIF(p_club_id, ''),
      p_player_id,
      NULL,                         -- slip-level entry; no single ticket_id
      'bet_placed',
      round((-p_total_stake)::numeric, 2),
      v_available,
      v_balance_after,
      'bet_placed:RoundRobin:' || p_group_id,
      v_now,
      COALESCE(p_created_by, p_player_id)
    );
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent caller beat us to the ledger insert for this key.
    -- Treat as successful idempotent replay.
    SELECT id, balance_after
      INTO v_existing_ledger
      FROM ledger_entries
     WHERE id = p_idempotency_key
     LIMIT 1;
    RETURN jsonb_build_object(
      'ok',            true,
      'idempotent',    true,
      'replayed',      true,
      'group_id',      p_group_id,
      'combo_count',   v_combo_count,
      'balance_after', v_existing_ledger.balance_after
    );
  END;

  -- ── §6. Success ───────────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'ok',            true,
    'idempotent',    false,
    'replayed',      false,
    'group_id',      p_group_id,
    'combo_count',   v_combo_count,
    'balance_after', v_balance_after,
    'available',     v_available,
    'total_stake',   p_total_stake
  );

EXCEPTION
  WHEN OTHERS THEN
    DECLARE
      v_sqlstate   text;
      v_msg        text;
      v_detail     text;
      v_hint       text;
      v_context    text;
      v_schema     text;
      v_table      text;
      v_column     text;
      v_constraint text;
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
        'error',      'place_rr_tx_failed',
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

-- Grant execution to the roles Supabase uses. Mirrors place_bet_tx grants.
GRANT EXECUTE ON FUNCTION public.place_rr_tx(
  text, text, text, text, numeric, text, text, jsonb
) TO authenticated, service_role;
