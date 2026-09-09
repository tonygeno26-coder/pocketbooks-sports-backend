-- PROPOSED (DO NOT APPLY without explicit approval)
-- NON-PROD rehearsal helper: opening-epoch bootstrap for Option A.
-- Lifetime history must NOT become settlement debt without explicit bootstrap.
-- T0 deterministic; tickets before/at T0 excluded; after T0 included.
-- Opening residues via settlement_opening_balances (not fake tickets).
-- Idempotent per (club_id, player_id). Ambiguous → needs_human_review.
-- NEVER run against production without separate approval.

BEGIN;

CREATE OR REPLACE FUNCTION public.bootstrap_settlement_opening_epoch(
  p_club_id text,
  p_player_id text,
  p_t0 timestamptz,
  p_opening_balance numeric DEFAULT 0,
  p_rationale text DEFAULT NULL,
  p_created_by text DEFAULT 'bootstrap_rehearsal',
  p_source text DEFAULT 'bootstrap_rehearsal',
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_t0 timestamptz;
  v_epoch_id text;
  v_boot_id text;
  v_existing_open record;
  v_existing_epoch record;
  v_lifetime_net numeric := 0;
  v_t record;
  v_ambiguous boolean := false;
  v_reasons text[] := ARRAY[]::text[];
BEGIN
  IF p_club_id IS NULL OR length(trim(p_club_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_club_id');
  END IF;
  IF p_player_id IS NULL OR length(trim(p_player_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_player_id');
  END IF;
  IF p_t0 IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_t0');
  END IF;
  IF coalesce(p_source,'') NOT IN ('bootstrap_rehearsal','bootstrap_prod','manual_review') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_source');
  END IF;
  IF p_source = 'bootstrap_prod' AND NOT p_force THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'prod_bootstrap_blocked',
      'message', 'Production bootstrap requires explicit force + human approval. Refusing.'
    );
  END IF;

  v_t0 := p_t0;
  v_epoch_id := 'SETTLEMENT_APPLIED_BOOTSTRAP_' || p_club_id || '_' || p_player_id || '_' ||
                (extract(epoch FROM v_t0) * 1000)::bigint::text;
  v_boot_id := 'OPENING_BOOTSTRAP_' || p_club_id || '_' || p_player_id;

  -- Lifetime graded net (diagnostic only — must NOT silently become debt)
  FOR v_t IN
    SELECT status, risk_amount, potential_profit, graded_at, placed_at
      FROM public.tickets
     WHERE club_id = p_club_id AND player_id = p_player_id
  LOOP
    IF lower(coalesce(v_t.status,'')) IN ('canceled','voided','deleted','push','pushed','active','open') THEN
      CONTINUE;
    END IF;
    IF lower(v_t.status) = 'won' THEN
      v_lifetime_net := v_lifetime_net + coalesce(v_t.potential_profit, 0);
    ELSIF lower(v_t.status) = 'lost' THEN
      v_lifetime_net := v_lifetime_net - coalesce(v_t.risk_amount, 0);
    END IF;
  END LOOP;
  v_lifetime_net := round(v_lifetime_net::numeric, 2);

  -- Ambiguous: large lifetime net + opening left at 0 without rationale
  IF abs(v_lifetime_net) >= 100 AND round(coalesce(p_opening_balance,0)::numeric, 2) = 0
     AND (p_rationale IS NULL OR length(trim(p_rationale)) = 0) THEN
    v_ambiguous := true;
    v_reasons := array_append(v_reasons, 'lifetime_net_nonzero_opening_zero_no_rationale');
  END IF;
  IF abs(v_lifetime_net) >= 100
     AND abs(round(coalesce(p_opening_balance,0)::numeric, 2) - v_lifetime_net) > 0.01
     AND abs(round(coalesce(p_opening_balance,0)::numeric, 2)) > 0.005
     AND (p_rationale IS NULL OR length(trim(p_rationale)) < 8) THEN
    v_ambiguous := true;
    v_reasons := array_append(v_reasons, 'opening_differs_from_lifetime_without_rationale');
  END IF;

  IF v_ambiguous AND NOT p_force THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'needs_human_review',
      'ambiguous', true,
      'reasons', to_jsonb(v_reasons),
      'lifetimeNet', v_lifetime_net,
      'requestedOpening', round(coalesce(p_opening_balance,0)::numeric, 2),
      'clubId', p_club_id,
      'playerId', p_player_id,
      'message', 'Ambiguous go-live opening — human review required before bootstrap.'
    );
  END IF;

  -- Idempotent epoch marker (historical shape so cutoff logic counts it)
  SELECT id, created_at INTO v_existing_epoch
    FROM public.ledger_entries WHERE id = v_epoch_id LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO public.ledger_entries (
      id, club_id, player_id, type, amount, reason, created_at, created_by
    ) VALUES (
      v_epoch_id, p_club_id, p_player_id, 'SETTLEMENT_APPLIED', 0,
      'weekly_rollover:bootstrap_epoch T0=' || v_t0::text,
      v_t0, coalesce(p_created_by, 'bootstrap_rehearsal')
    );
  END IF;

  -- Idempotent opening balance row
  SELECT bootstrap_id, opening_balance, t0 INTO v_existing_open
    FROM public.settlement_opening_balances
   WHERE club_id = p_club_id AND player_id = p_player_id
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'clubId', p_club_id,
      'playerId', p_player_id,
      't0', v_existing_open.t0,
      'epochMarkerId', v_epoch_id,
      'bootstrapId', v_existing_open.bootstrap_id,
      'openingBalance', v_existing_open.opening_balance,
      'lifetimeNet', v_lifetime_net,
      'historicalPnLOpensAt', 0,
      'bankrollMutated', false
    );
  END IF;

  INSERT INTO public.settlement_opening_balances (
    bootstrap_id, club_id, player_id, t0, opening_balance, rationale, source, created_by
  ) VALUES (
    v_boot_id, p_club_id, p_player_id, v_t0,
    round(coalesce(p_opening_balance,0)::numeric, 2),
    p_rationale, p_source, coalesce(p_created_by, 'bootstrap_rehearsal')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'clubId', p_club_id,
    'playerId', p_player_id,
    't0', v_t0,
    'epochMarkerId', v_epoch_id,
    'bootstrapId', v_boot_id,
    'openingBalance', round(coalesce(p_opening_balance,0)::numeric, 2),
    'lifetimeNet', v_lifetime_net,
    'historicalPnLOpensAt', 0,
    'ticketBoundary', jsonb_build_object(
      'beforeOrAtT0', 'excluded',
      'afterT0', 'included'
    ),
    'bankrollMutated', false,
    'forced', p_force,
    'ambiguousOverride', v_ambiguous AND p_force
  );
END;
$function$;

COMMENT ON FUNCTION public.bootstrap_settlement_opening_epoch IS
  'NON-PROD/approved go-live: T0 epoch marker + opening_balance primitive. Idempotent. No bankroll mutation.';

COMMIT;

-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.bootstrap_settlement_opening_epoch(text,text,timestamptz,numeric,text,text,text,boolean);
