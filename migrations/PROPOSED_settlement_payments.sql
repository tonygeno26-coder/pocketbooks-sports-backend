-- PROPOSED (DO NOT APPLY without explicit approval)
-- Option A: minimal append-only settlement_payments primitive.
-- Bankroll SoT remains club_members.balance_start + tickets.
-- This table tracks host↔player cash toward zero ONLY.
-- Does NOT create settle_player_tx, public.ledger money engine, or mutate tickets.
-- Additive / reversible.

BEGIN;

CREATE TABLE IF NOT EXISTS public.settlement_payments (
  payment_id            text PRIMARY KEY,
  period_id             text NOT NULL DEFAULT 'DIRECT',
  revision              integer NOT NULL DEFAULT 0,
  club_id               text NOT NULL,
  player_id             text NOT NULL,
  direction             text NOT NULL
                          CHECK (direction IN ('player_paid_host', 'host_paid_player')),
  amount                numeric(14,2) NOT NULL CHECK (amount > 0),
  amount_cents          integer NOT NULL CHECK (amount_cents > 0),
  method                text NOT NULL DEFAULT 'direct',
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
  CONSTRAINT settlement_payments_amount_cents_matches
    CHECK (amount_cents = round(amount * 100)::integer)
);

-- Club-scoped idempotency for non-prefixed keys (payment_id already club-prefixed by API).
CREATE UNIQUE INDEX IF NOT EXISTS settlement_payments_club_ledger_settlement_uidx
  ON public.settlement_payments (club_id, ledger_settlement_id)
  WHERE ledger_settlement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS settlement_payments_club_player_confirmed_idx
  ON public.settlement_payments (club_id, player_id, status, confirmed_at DESC);

CREATE INDEX IF NOT EXISTS settlement_payments_club_confirmed_idx
  ON public.settlement_payments (club_id, status, confirmed_at DESC);

COMMENT ON TABLE public.settlement_payments IS
  'Option A append-only cash settlements. Does not rewrite ticket bankroll.';

COMMIT;

-- ROLLBACK:
--   DROP INDEX IF EXISTS public.settlement_payments_club_confirmed_idx;
--   DROP INDEX IF EXISTS public.settlement_payments_club_player_confirmed_idx;
--   DROP INDEX IF EXISTS public.settlement_payments_club_ledger_settlement_uidx;
--   DROP TABLE IF EXISTS public.settlement_payments;
