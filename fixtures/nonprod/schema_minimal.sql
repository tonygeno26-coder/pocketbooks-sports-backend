-- Minimal non-prod fixture schema for Option A settlement + cancel_bet_tx isolation.
-- NEVER apply to production padgicwrrzmukahfsyhk.
-- Used by fixtures/nonprod/apply_and_test.js against local Postgres only.

BEGIN;

CREATE TABLE IF NOT EXISTS public.club_members (
  club_id       text NOT NULL,
  player_id     text NOT NULL,
  balance_start numeric(14,2),
  status        text DEFAULT 'approved',
  PRIMARY KEY (club_id, player_id)
);

CREATE TABLE IF NOT EXISTS public.tickets (
  id               text PRIMARY KEY,
  club_id          text,
  player_id        text,
  status           text NOT NULL DEFAULT 'active',
  risk_amount      numeric(14,2) NOT NULL DEFAULT 0,
  potential_profit numeric(14,2) DEFAULT 0,
  placed_at        timestamptz DEFAULT now(),
  graded_at        timestamptz
);

CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id             text PRIMARY KEY,
  club_id        text,
  player_id      text,
  ticket_id      text,
  type           text,
  amount         numeric(14,2),
  balance_before numeric(14,2),
  balance_after  numeric(14,2),
  reason         text,
  created_at     timestamptz DEFAULT now(),
  created_by     text
);

COMMIT;
