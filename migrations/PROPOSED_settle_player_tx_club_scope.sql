-- PROPOSED (DO NOT APPLY TO PRODUCTION WITHOUT REVIEW)
-- settle_player_tx: scope settlement_id idempotency lookup by club_id
-- Risk today: PERFORM ... WHERE settlement_id=p_settlement_id without club_id
-- Mitigation already shipped in app layer: settlementId = clubId::idempotencyKey
-- This migration hardens the RPC itself.

CREATE OR REPLACE FUNCTION settle_player_tx(
  p_settlement_id  TEXT,
  p_club_id        TEXT,
  p_player_id      TEXT,
  p_amount         NUMERIC,
  p_direction      TEXT,
  p_idempotency_key TEXT,
  p_created_by     TEXT DEFAULT 'host'
) RETURNS JSONB AS $$
DECLARE
  v_starting    NUMERIC;
  v_ledger_bal  NUMERIC;
  v_event_dir   TEXT;
  v_bal_after   NUMERIC;
BEGIN
  -- Idempotency MUST be club-scoped
  PERFORM 1 FROM ledger
    WHERE club_id = p_club_id
      AND settlement_id = p_settlement_id
      AND event_type = 'SETTLEMENT_APPLIED'
    LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'settlement_id',p_settlement_id);
  END IF;

  -- ... remainder unchanged from current settle_player_tx ...
  RAISE EXCEPTION 'template_only_replace_body_from_live_function';
END;
$$ LANGUAGE plpgsql;
