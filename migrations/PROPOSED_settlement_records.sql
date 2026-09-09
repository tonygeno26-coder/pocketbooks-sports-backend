-- PROPOSED (DO NOT APPLY without explicit approval)
-- Option A: minimal append-only settlement_records primitive.
-- Bankroll SoT remains club_members.balance_start + tickets.
-- This table stores host RECORDS of OFF-PLATFORM settlements toward zero ONLY.
-- PocketBooks does NOT initiate/receive/send/hold funds or payment rails.
-- Does NOT create settle_player_tx, public.ledger money engine, or mutate tickets.
-- Additive / reversible.
--
-- Terminology: formerly proposed as settlement_payments — renamed before production schema.

BEGIN;

CREATE TABLE IF NOT EXISTS public.settlement_records (
  record_id             text PRIMARY KEY,
  period_id             text NOT NULL DEFAULT 'DIRECT',
  revision              integer NOT NULL DEFAULT 0,
  club_id               text NOT NULL,
  player_id             text NOT NULL,
  -- Direction of the off-platform settlement being recorded (not an in-app transfer).
  direction             text NOT NULL
                          CHECK (direction IN ('player_paid_host', 'host_paid_player')),
  amount                numeric(14,2) NOT NULL CHECK (amount > 0),
  amount_cents          integer NOT NULL CHECK (amount_cents > 0),
  method                text NOT NULL DEFAULT 'recorded',
  status                text NOT NULL DEFAULT 'confirmed'
                          CHECK (status IN ('pending', 'confirmed', 'voided')),
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text,
  confirmed_at          timestamptz,
  confirmed_by          text,
  voided_at             timestamptz,
  voided_by             text,
  ledger_written        boolean NOT NULL DEFAULT false,
  ledger_settlement_id  text,
  balance_before        numeric(14,2),
  balance_after         numeric(14,2),
  CONSTRAINT settlement_records_amount_cents_matches
    CHECK (amount_cents = round(amount * 100)::integer)
);

-- Club-scoped idempotency for non-prefixed keys (record_id already club-prefixed by API).
CREATE UNIQUE INDEX IF NOT EXISTS settlement_records_club_ledger_settlement_uidx
  ON public.settlement_records (club_id, ledger_settlement_id)
  WHERE ledger_settlement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS settlement_records_club_player_confirmed_idx
  ON public.settlement_records (club_id, player_id, status, confirmed_at DESC);

CREATE INDEX IF NOT EXISTS settlement_records_club_confirmed_idx
  ON public.settlement_records (club_id, status, confirmed_at DESC);

COMMENT ON TABLE public.settlement_records IS
  'Option A append-only RECORDED off-platform settlements. Updates ledger position toward zero only. Does not rewrite ticket bankroll. Does not process funds.';

COMMIT;

-- ROLLBACK:
--   DROP INDEX IF EXISTS public.settlement_records_club_confirmed_idx;
--   DROP INDEX IF EXISTS public.settlement_records_club_player_confirmed_idx;
--   DROP INDEX IF EXISTS public.settlement_records_club_ledger_settlement_uidx;
--   DROP TABLE IF EXISTS public.settlement_records;
