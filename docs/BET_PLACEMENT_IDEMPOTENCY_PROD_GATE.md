# BET PLACEMENT IDEMPOTENCY — Production Migration Gate (DO NOT APPLY)

**Status:** `IDEMPOTENCY PROD GATE READY` (package only)  
**Date:** 2026-09-10  
**BE main:** `ae1d18d`  
**FE clean main:** `0e1d678` (sticky path-matched Idempotency-Key already present via `7a5ffa3`)  
**PRODUCTION DATA TOUCHED:** **NO**  
**Owner order:** apply **cancel isolation first**, then idempotency — **only after explicit owner apply message**.  
**SAFE TO APPLY (now):** **NO** (owner has not approved; cancel isolation not yet applied; prod table shape must be confirmed first)

---

## CURRENT STATE

| Layer | Today | Gap |
|-------|-------|-----|
| FE sticky key + path match | On clean FE `0e1d678` | Contaminated `20f90ec` tip is redundant vs `7a5ffa3` |
| BE `requireIdempotency` | `idempotency_keys` keyed primarily by bare `idempotency_key` PK; mem fallback if table missing | Scope is not enforced as unique `(club_id, player_id, key)` |
| Money RPC | `ledger_entries.id = p_idempotency_key` UNIQUE | Protects same-key double debit; not different-key retry |
| Ticket id | `T_` + time/random | Not content-addressed → retry with new key → second ticket |

Reference DDL already embedded in `index.js` as `IDEMPOTENCY_TABLE_DDL` (docs only / bootstrap reference — **not** an applied migration artifact in this gate).

---

## TARGET DESIGN (club + player + key)

### Store

```sql
-- PROPOSED ONLY — DO NOT APPLY
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  club_id          text NOT NULL,
  player_id        text NOT NULL,
  client_key       text NOT NULL,
  endpoint         text NOT NULL,
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','completed','failed')),
  response_status  integer,
  response_body    jsonb,
  ticket_id        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (club_id, player_id, client_key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx
  ON public.idempotency_keys (expires_at);

-- Optional defense-in-depth once FE always sends client_key:
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS client_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS tickets_club_player_client_idem_uidx
  ON public.tickets (club_id, player_id, client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;
```

### Conflict behavior

| Case | HTTP | Effect |
|------|------|--------|
| Same `(club,player,key)` + same `request_hash` + completed | 200 | Replay stored response / existing `ticket_id` |
| Same scope + different `request_hash` | 409 `idempotency_conflict` | No second ticket |
| Same scope + `pending` in-flight | 409 `idempotency_in_flight` or wait+replay | No double execute |
| Expired row, ledger row still exists for key | 200 replay | Do **not** re-debit |
| Expired row, no ledger | 400 `idempotency_key_expired` | Client must mint new key deliberately |

### Concurrency / locking

1. Prefer `INSERT … ON CONFLICT (club_id, player_id, client_key) DO NOTHING` returning whether insert won.
2. Winner executes money RPC; loser re-reads row and replays or 409s.
3. Keep `ledger_entries.id = p_idempotency_key` UNIQUE as second line of defense (key still globally unique at ledger layer **or** migrate ledger id to `club|player|key` hash — decide before apply).
4. Optional `pg_advisory_xact_lock(hashtext(club||player||key))` around place path for mem-fallback hosts.

### Retention / growth

| Policy | Value |
|--------|-------|
| TTL | 24h default (match current middleware) |
| Cleanup | Nightly `DELETE WHERE expires_at < now() - interval '7 days'` |
| Growth | Expect O(places/day); PK is narrow text triple; monitor row count monthly |
| PII | Keys are opaque client tokens; do not log full key in app logs |

---

## COMPAT ORDER (code + SQL)

**Do not apply until owner message.** Recommended sequence after cancel isolation:

1. **Confirm** current prod `idempotency_keys` shape (`\d idempotency_keys` / `list_tables`) — read-only.
2. **FE** already sticky on `0e1d678` — verify prod FE build includes path-matched header + sticky uncertain retry.
3. **BE code** dual-read: accept legacy bare PK **or** scoped triple; write scoped rows.
4. **SQL** add scoped PK / unique (migrate data if legacy table exists: backfill `club_id`/`player_id` from columns, drop old PK carefully).
5. **BE code** fail closed if club/player missing on money idempotency.
6. **Optional** tickets unique index + deterministic ticket id.
7. **Tests** T1–T8 below in CI + designated-account prod smoke.

Rollback: restore prior table DDL from backup; revert BE dual-write commit; FE sticky can remain (safe).

---

## ROLLBACK

| Artifact | Action |
|----------|--------|
| New unique index on tickets | `DROP INDEX IF EXISTS tickets_club_player_client_idem_uidx` |
| New scoped table | Restore prior `idempotency_keys` from schema dump taken pre-apply |
| Code | Revert middleware/RPC commit; leave FE sticky |

No ticket/ledger row rewrite required for rollback of the index/table alone.

---

## TEST PLAN

| # | Case | Expect |
|---|------|--------|
| T1 | Concurrent same key+body | One ticket; second replay |
| T2 | Same key, different stake | 409; one ticket |
| T3 | Timeout retry same key | One ticket |
| T4 | Retry **new** key (legacy) | Two tickets — document until sticky FE proven |
| T5 | Double-click | One ticket |
| T6 | Odds-accept `_oa` new key | New ticket OK |
| T7 | Cross-club same bare key | No collision under scoped PK |
| T8 | Expired + ledger exists | Replay; no debit |
| T9 | Missing club on place | 400; no write |
| T10 | Cancel isolation still owner-gated | Unaffected |

Designated accounts only. No destructive prod cancels/places on ordinary users.

---

## PREFLIGHT (read-only)

```sql
-- PROPOSED preflight — SELECT only
SELECT to_regclass('public.idempotency_keys');
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='idempotency_keys'
ORDER BY ordinal_position;
SELECT count(*) FROM public.idempotency_keys;
SELECT count(*) FROM public.idempotency_keys WHERE expires_at < now();
```

---

## SAFE TO REQUEST OWNER APPLY

**NO — not yet.** Package is ready for review, but apply is blocked until:

1. Owner explicitly messages apply for **this** migration (separate from cancel).
2. Cancel isolation apply completed first (owner preference).
3. Read-only preflight confirms current table / no surprise dual schema.
4. Prod FE SHA includes sticky idempotency (`0e1d678` lineage).
5. Designated-account test plan scheduled.

**SAFE TO APPLY:** **NO**

---

## PACKAGE INDEX

| File | Role |
|------|------|
| `docs/BET_PLACEMENT_IDEMPOTENCY.md` | Design / failure-mode analysis |
| `docs/BET_PLACEMENT_IDEMPOTENCY_PROD_GATE.md` | This owner gate |
| `index.js` `IDEMPOTENCY_TABLE_DDL` | Reference DDL only |

No `migrations/PROPOSED_idempotency_*.sql` applied. Create dated PROPOSED/ROLLBACK SQL files only when owner schedules apply window.
