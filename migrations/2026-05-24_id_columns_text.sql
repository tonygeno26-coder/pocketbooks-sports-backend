-- ============================================================================
-- 2026-05-24_id_columns_text — codify the manual UUID→text + column-add changes
-- ============================================================================
-- Backfills the DDL we applied by hand in the Supabase SQL editor on 2026-05-24
-- so the schema is reproducible from git alone (reset-and-replay safe).
--
-- WHY this migration exists:
--   • place_bet_tx (2026-05-23_place_bet_tx.sql) and the cancel_bet_tx /
--     grade_ticket_tx siblings all declare their id params as `text`.
--   • The JS layer (index.js) generates ids like 'T_<ms>_<rand>' and
--     'T_..._leg<i>' — non-UUID strings. Any column that stays `uuid` rejects
--     these payloads at insert/upsert time.
--   • Phase K (odds snapshot) and priority #11 (canonical identity) added new
--     columns to tickets / ticket_legs / ledger_entries that older databases
--     don't have. The handler has fallback code that strips them, but we want
--     the canonical shape persisted so future code paths can rely on them.
--
-- Properties this file MUST maintain:
--   • Idempotent: every statement is wrapped in DO $$ catalog checks or uses
--     IF NOT EXISTS / IF EXISTS so re-running is a no-op.
--   • Data-preserving: every type change uses `USING <col>::text` — no
--     TRUNCATE, no DROP TABLE, no destructive rewrites.
--   • FK-safe: when a column's type changes, every FK that references it (or
--     is referenced by it) is dropped, the type is changed on BOTH sides,
--     then the FK is re-added. uuid↔text FK pairs would otherwise reject.
--   • Verifiable: the final block SELECTs from information_schema.columns so
--     the SQL editor output proves the columns landed with the expected
--     types.
--
-- Scope (sections below):
--   §1  ledger_entries          — id uuid→text (PK preserved), supporting cols
--   §2  tickets                 — id, player_id, club_id, player_username
--                                  uuid→text + missing Phase A cols
--   §3  ticket_legs             — id, ticket_id uuid→text + canonical cols
--   §4  club_members            — player_id uuid→text (place_bet_tx FOR UPDATE)
--   §5  FK reattachment         — ticket_legs.ticket_id → tickets.id
--                                  ledger_entries.ticket_id → tickets.id
--   §6  Verification SELECTs    — paste-and-read final state proof
--
-- NOT in scope (call out as drift if it bites us):
--   • audit_events, grade_overrides, result_snapshots, odds_snapshots id
--     columns — those have not blown up yet. If they reference tickets.id /
--     player_id / club_id with a uuid FK, the §5 reattach block will catch
--     it via the pg_constraint scan. Flagged in 2026-05-24_schema_drift_notes.md.
--
-- Run order matters: §1→§4 do the type changes (DROP FK, ALTER TYPE, ADD COLS).
-- §5 reattaches FKs once both sides are `text`. §6 is read-only verification.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- §0. Pre-flight: drop every FK that points at any column whose type we are
--     about to change. We re-add them in §5 after both sides are text.
--     Doing this up-front (rather than per-table) avoids the
--     "cannot alter type of a column used in a foreign key constraint" error
--     when the same FK touches two tables we're both modifying.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname, conrelid::regclass AS tbl
      FROM pg_constraint
     WHERE contype = 'f'
       AND conname IN (
         'ticket_legs_ticket_id_fkey',
         'ledger_entries_ticket_id_fkey',
         'ledger_entries_player_id_fkey',
         'ledger_entries_club_id_fkey',
         'tickets_player_id_fkey',
         'tickets_club_id_fkey',
         'club_members_player_id_fkey'
         -- VERIFY: if your FKs use different names (e.g. fk_ticket_legs_ticket),
         -- list them here. Run:
         --   SELECT conname, conrelid::regclass FROM pg_constraint
         --    WHERE contype='f' AND conrelid::regclass::text
         --       IN ('tickets','ticket_legs','ledger_entries','club_members');
       )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.tbl, r.conname);
    RAISE NOTICE 'Dropped FK % on %', r.conname, r.tbl;
  END LOOP;
END$$;


-- ============================================================================
-- §1. ledger_entries
-- ============================================================================
-- id is the idempotency anchor used by place_bet_tx / cancel_bet_tx /
-- grade_ticket_tx. JS passes 'idempotencyKey' style strings ('SG_won_T_...',
-- 'WK_won_T_...', 'MANUAL_won_T_...'). MUST be text.
--
-- Confirmed today: the PK is contype='p' on (id), so the type change
-- preserves PK identity. We still defensively recreate the PK at the bottom
-- of this section in case the constraint name varies across environments.
-- ----------------------------------------------------------------------------

-- 1a. Type changes
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ledger_entries' AND column_name='id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.ledger_entries
      ALTER COLUMN id TYPE text USING id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ledger_entries' AND column_name='player_id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.ledger_entries
      ALTER COLUMN player_id TYPE text USING player_id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ledger_entries' AND column_name='club_id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.ledger_entries
      ALTER COLUMN club_id TYPE text USING club_id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ledger_entries' AND column_name='ticket_id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.ledger_entries
      ALTER COLUMN ticket_id TYPE text USING ticket_id::text;
  END IF;
END$$;

-- 1b. Missing columns referenced by place_bet_tx + the JS mirror
--     (index.js mirrorLedgerEntry @ ~1610 and the place/cancel handlers
--      send these every time; if they're missing on the DB the upsert
--      silently drops them).
ALTER TABLE public.ledger_entries
  ADD COLUMN IF NOT EXISTS balance_before numeric,
  ADD COLUMN IF NOT EXISTS balance_after  numeric,
  ADD COLUMN IF NOT EXISTS final_score    text,
  ADD COLUMN IF NOT EXISTS created_by     text,
  ADD COLUMN IF NOT EXISTS reason         text,
  ADD COLUMN IF NOT EXISTS amount         numeric;

-- 1c. Defensively (re)affirm the PK on (id). If it already exists with the
--     same definition this is a no-op via the catalog check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ledger_entries'::regclass
       AND contype = 'p'
  ) THEN
    ALTER TABLE public.ledger_entries
      ADD CONSTRAINT ledger_entries_pkey PRIMARY KEY (id);
    RAISE NOTICE 'Recreated PK on ledger_entries(id)';
  END IF;
END$$;


-- ============================================================================
-- §2. tickets
-- ============================================================================
-- id is generated JS-side as 'T_<ms>_<rand>' (index.js ~7216). All FK
-- children (ticket_legs.ticket_id, ledger_entries.ticket_id) must be text
-- to match.
--
-- place_bet_tx also INSERTs into: player_username, type, status, risk_amount,
-- potential_profit, estimated_payout, placed_at. Add any that are missing.
-- ----------------------------------------------------------------------------

-- 2a. Type changes
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tickets' AND column_name='id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.tickets
      ALTER COLUMN id TYPE text USING id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tickets' AND column_name='player_id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.tickets
      ALTER COLUMN player_id TYPE text USING player_id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tickets' AND column_name='club_id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.tickets
      ALTER COLUMN club_id TYPE text USING club_id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tickets' AND column_name='player_username'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.tickets
      ALTER COLUMN player_username TYPE text USING player_username::text;
  END IF;
END$$;

-- 2b. Missing columns referenced by place_bet_tx INSERT + JS handlers
--     (index.js ~1525 ticket mirror upsert; ~7216 place_bet_tx call params).
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS player_username   text,
  ADD COLUMN IF NOT EXISTS type              text,
  ADD COLUMN IF NOT EXISTS status            text,
  ADD COLUMN IF NOT EXISTS risk_amount       numeric,
  ADD COLUMN IF NOT EXISTS potential_profit  numeric,
  ADD COLUMN IF NOT EXISTS estimated_payout  numeric,
  ADD COLUMN IF NOT EXISTS odds              text,
  ADD COLUMN IF NOT EXISTS placed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS graded_at         timestamptz,
  ADD COLUMN IF NOT EXISTS grading_source    text,
  ADD COLUMN IF NOT EXISTS grading_snapshot  jsonb,
  ADD COLUMN IF NOT EXISTS raw_local         jsonb,
  ADD COLUMN IF NOT EXISTS mirrored_at       timestamptz;

-- 2c. Defensively re-affirm the PK on (id). Without a PK the
--     ticket_legs.ticket_id FK in §5 has nothing to point at.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tickets'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE public.tickets ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);
    RAISE NOTICE 'Recreated PK on tickets(id)';
  END IF;
END$$;


-- ============================================================================
-- §3. ticket_legs
-- ============================================================================
-- id is JS-generated ('<ticketId>_leg<i>') and ticket_id mirrors tickets.id.
-- Both MUST be text.
--
-- Phase K + priority #11 columns: the handler at index.js ~7290 has a
-- fallback that strips canonical/snapshot columns if the DB rejects them,
-- but we want the canonical shape persisted so SGP grading + cashout can
-- rely on it.
-- ----------------------------------------------------------------------------

-- 3a. Type changes
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ticket_legs' AND column_name='id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.ticket_legs
      ALTER COLUMN id TYPE text USING id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ticket_legs' AND column_name='ticket_id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.ticket_legs
      ALTER COLUMN ticket_id TYPE text USING ticket_id::text;
  END IF;
END$$;

-- 3b. Missing columns referenced by leg insert (index.js ~7230) and grading.
ALTER TABLE public.ticket_legs
  ADD COLUMN IF NOT EXISTS leg_index               int,
  ADD COLUMN IF NOT EXISTS provider_name           text,
  ADD COLUMN IF NOT EXISTS provider_game_id        text,
  ADD COLUMN IF NOT EXISTS canonical_game_key      text,
  ADD COLUMN IF NOT EXISTS sport                   text,
  ADD COLUMN IF NOT EXISTS home_team               text,
  ADD COLUMN IF NOT EXISTS away_team               text,
  ADD COLUMN IF NOT EXISTS scheduled_start         timestamptz,
  ADD COLUMN IF NOT EXISTS market                  text,
  ADD COLUMN IF NOT EXISTS pick                    text,
  ADD COLUMN IF NOT EXISTS odds                    numeric,
  ADD COLUMN IF NOT EXISTS line                    numeric,
  ADD COLUMN IF NOT EXISTS side                    text,
  ADD COLUMN IF NOT EXISTS game_status             text,
  ADD COLUMN IF NOT EXISTS leg_result              text,
  -- Phase K snapshot fields
  ADD COLUMN IF NOT EXISTS accepted_odds_american  numeric,
  ADD COLUMN IF NOT EXISTS accepted_odds_decimal   numeric,
  ADD COLUMN IF NOT EXISTS accepted_point_line     numeric,
  ADD COLUMN IF NOT EXISTS odds_snapshot_id        text,
  ADD COLUMN IF NOT EXISTS accepted_at             timestamptz,
  -- Canonical identity (priority #11)
  ADD COLUMN IF NOT EXISTS market_type             text,
  ADD COLUMN IF NOT EXISTS canonical_market_key    text,
  ADD COLUMN IF NOT EXISTS canonical_selection_key text,
  ADD COLUMN IF NOT EXISTS player_name_normalized  text,
  ADD COLUMN IF NOT EXISTS prop_type_normalized    text,
  ADD COLUMN IF NOT EXISTS prop_side               text;

-- VERIFY: the task brief mentioned a possible `american_odds` column —
-- grep of index.js shows only `odds` (numeric) and `accepted_odds_american`
-- (numeric), no plain `american_odds`. Not adding it. If you find the name
-- elsewhere (worker?), add it here.

-- 3c. Affirm PK on (id).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ticket_legs'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE public.ticket_legs ADD CONSTRAINT ticket_legs_pkey PRIMARY KEY (id);
    RAISE NOTICE 'Recreated PK on ticket_legs(id)';
  END IF;
END$$;


-- ============================================================================
-- §4. club_members
-- ============================================================================
-- place_bet_tx does `SELECT ... FOR UPDATE WHERE player_id = p_player_id`
-- with p_player_id as text (signature in 2026-05-23_place_bet_tx.sql).
-- If this column is uuid the lookup silently never matches and we fall back
-- to the 1000 default — which means the per-player serialization lock is
-- effectively disabled. Critical to convert.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='club_members' AND column_name='player_id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.club_members
      ALTER COLUMN player_id TYPE text USING player_id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='club_members' AND column_name='club_id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.club_members
      ALTER COLUMN club_id TYPE text USING club_id::text;
  END IF;
END$$;

-- VERIFY: club_members may have its own id PK + member_role / balance_start
-- columns. We're only touching player_id + club_id because those are the
-- ones the RPC depends on. Confirm the rest of the table is healthy from
-- the existing schema. If balance_start is missing the RPC silently uses
-- the 1000 default (intentional fallback, not a bug).


-- ============================================================================
-- §5. Re-attach foreign keys
-- ============================================================================
-- Now that all sides are `text`, restore the relational integrity that §0
-- dropped. ON DELETE behavior is preserved as the prior default (NO ACTION)
-- because:
--   • tickets are never hard-deleted in normal flow — they're status-flipped
--     to 'canceled'/'voided' by cancel_bet_tx.
--   • ledger_entries are append-only, so cascading a ticket delete would be
--     wrong — keep the ledger row even if the ticket row vanishes (manual
--     cleanup territory; see scripts/cleanup-orphan-tickets.js for the
--     intentional ordered delete).
-- ----------------------------------------------------------------------------

-- 5a. ticket_legs.ticket_id → tickets.id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ticket_legs_ticket_id_fkey'
       AND conrelid = 'public.ticket_legs'::regclass
  ) THEN
    ALTER TABLE public.ticket_legs
      ADD CONSTRAINT ticket_legs_ticket_id_fkey
      FOREIGN KEY (ticket_id) REFERENCES public.tickets (id);
    RAISE NOTICE 'Reattached FK ticket_legs.ticket_id → tickets.id';
  END IF;
END$$;

-- 5b. ledger_entries.ticket_id → tickets.id (nullable FK; some ledger rows
--     are not ticket-bound, e.g. settlement deposits, host adjustments).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ledger_entries_ticket_id_fkey'
       AND conrelid = 'public.ledger_entries'::regclass
  ) THEN
    ALTER TABLE public.ledger_entries
      ADD CONSTRAINT ledger_entries_ticket_id_fkey
      FOREIGN KEY (ticket_id) REFERENCES public.tickets (id);
    RAISE NOTICE 'Reattached FK ledger_entries.ticket_id → tickets.id';
  END IF;
END$$;

-- VERIFY: tickets.player_id / tickets.club_id and ledger_entries.player_id /
-- ledger_entries.club_id were FKs into a `players` / `clubs` table in some
-- environments and free-text in others. We are NOT re-adding those FKs here
-- because:
--   (a) Today's session didn't drop them with a known name (the §0 list
--       includes the obvious candidates but if your env uses a non-default
--       FK name they survived).
--   (b) The JS layer treats player_id / club_id as opaque text identifiers
--       already (see _resolvedPlayerId in /api/bets/place), so missing FK
--       integrity here is not load-bearing for the bet placement path.
-- If you want them back, add them in a follow-up migration after confirming
-- the parent tables (`players`, `clubs`) also have text PKs.


-- ============================================================================
-- §6. Verification — proof the SQL editor will print
-- ============================================================================
-- Run order: this commits the work, then reads back the canonical shape so
-- the editor output is the "proof of land". If any row below shows
-- data_type other than the expected one, the migration didn't take —
-- copy the offending row and we'll diagnose.
-- ----------------------------------------------------------------------------

COMMIT;

-- 6a. Type proof for every column we touched
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema='public'
  AND (
       (table_name='ledger_entries' AND column_name IN
          ('id','player_id','club_id','ticket_id',
           'balance_before','balance_after','final_score','created_by','reason','amount'))
    OR (table_name='tickets' AND column_name IN
          ('id','player_id','club_id','player_username',
           'type','status','risk_amount','potential_profit','estimated_payout',
           'odds','placed_at','graded_at','grading_source','grading_snapshot',
           'raw_local','mirrored_at'))
    OR (table_name='ticket_legs' AND column_name IN
          ('id','ticket_id','leg_index','provider_name','provider_game_id',
           'canonical_game_key','sport','home_team','away_team','scheduled_start',
           'market','pick','odds','line','side','game_status','leg_result',
           'accepted_odds_american','accepted_odds_decimal','accepted_point_line',
           'odds_snapshot_id','accepted_at','market_type','canonical_market_key',
           'canonical_selection_key','player_name_normalized','prop_type_normalized',
           'prop_side'))
    OR (table_name='club_members' AND column_name IN ('player_id','club_id'))
  )
ORDER BY table_name, column_name;

-- 6b. FK proof — the two relational anchors must be present and pointing
--     at text columns.
SELECT
  conname                              AS fk_name,
  conrelid::regclass                   AS from_table,
  a.attname                            AS from_column,
  confrelid::regclass                  AS to_table,
  af.attname                           AS to_column
FROM pg_constraint c
JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum  = ANY (c.conkey)
JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = ANY (c.confkey)
WHERE c.contype = 'f'
  AND c.conname IN ('ticket_legs_ticket_id_fkey','ledger_entries_ticket_id_fkey')
ORDER BY conname;

-- 6c. PK proof — ledger_entries.id MUST be the PK (idempotency anchor).
SELECT
  conrelid::regclass AS tbl,
  conname            AS pk_name,
  contype
FROM pg_constraint
WHERE contype='p'
  AND conrelid::regclass IN (
    'public.ledger_entries'::regclass,
    'public.tickets'::regclass,
    'public.ticket_legs'::regclass
  )
ORDER BY tbl;

-- ============================================================================
-- END
-- ============================================================================
