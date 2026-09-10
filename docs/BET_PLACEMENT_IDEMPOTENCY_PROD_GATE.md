# BET PLACEMENT IDEMPOTENCY — Production Migration Gate (DO NOT APPLY)

**Status:** `IDEMPOTENCY REMEDIATION` (BE code ready; SQL still PROPOSED)  
**Date:** 2026-09-10  
**BE remediation branch:** `cursor/idempotency-remediation`  
**FE clean main:** `0e1d678` (sticky path-matched Idempotency-Key already present via `7a5ffa3`)  
**PRODUCTION DATA TOUCHED:** **NO**  
**Owner order:** DO NOT APPLY until explicit `APPLY IDEMPOTENCY MIGRATION`  
**SAFE TO APPLY (now):** **NO**  
**Canonical review:** `docs/IDEMPOTENCY_FINAL_OWNER_REVIEW.md`

---

## CURRENT STATE (post-remediation)

| Layer | Today | Gap |
|-------|-------|-----|
| FE sticky key + path match | On clean FE `0e1d678` | None for Gap B |
| BE `requireIdempotency` | Dual-read/write scoped + insert-if-absent; money fail-closed | Prod SQL PK not applied yet |
| Money RPC ledger id | `scoped_hash_v1` (`IK_<sha256(club\|player\|key)[0:40]>`) + dual-read bare | In-flight legacy bare keys dual-read |
| Ticket id | Deterministic `T_<digest>` / `RRG_<digest>` | Optional tickets unique index still commented in SQL |
| Retention | `PROPOSED_idempotency_keys_retention.sql` + JS purge helper | **Not scheduled** on prod |

Reference DDL: `lib/idempotency-engine.js` `IDEMPOTENCY_TABLE_DDL` (scoped). Apply artifacts: `migrations/PROPOSED_idempotency_keys_scoped.sql` + retention + ROLLBACK.

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

**NO — SQL still gated.** BE remediations are on `cursor/idempotency-remediation`. Apply remains blocked until:

1. This BE branch is **deployed** (dual-read/write live).
2. Owner explicitly messages `APPLY IDEMPOTENCY MIGRATION`.
3. Read-only preflight confirms current table / path A vs B.
4. Prod FE SHA includes sticky idempotency (`0e1d678` lineage).
5. Retention schedule planned **after** SQL (not before).
6. Designated-account smoke T1–T10.

**SAFE TO APPLY:** **NO**

---

## PACKAGE INDEX

| File | Role |
|------|------|
| `docs/IDEMPOTENCY_FINAL_OWNER_REVIEW.md` | Final owner review + remediation status |
| `docs/BET_PLACEMENT_IDEMPOTENCY.md` | Design / failure-mode analysis |
| `docs/BET_PLACEMENT_IDEMPOTENCY_PROD_GATE.md` | This owner gate |
| `lib/idempotency-engine.js` | Scoped dual-mode engine |
| `migrations/PROPOSED_idempotency_keys_scoped.sql` | Exact proposed SQL — **DO NOT APPLY** |
| `migrations/PROPOSED_idempotency_keys_retention.sql` | Purge function — **DO NOT SCHEDULE YET** |
| `migrations/ROLLBACK_idempotency_keys_scoped.sql` | Rollback companion |
| `tests/idempotency-remediation.test.js` | Non-prod matrix |

**PRODUCTION DATA TOUCHED:** NO  
**SETTLEMENT RECORDING:** OFF
