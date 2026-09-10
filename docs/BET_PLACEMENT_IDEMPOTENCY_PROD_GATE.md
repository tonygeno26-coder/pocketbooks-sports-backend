# BET PLACEMENT IDEMPOTENCY — Production Migration Gate (DO NOT APPLY)

**Status:** `IDEMPOTENCY REMEDIATION FINAL`  
**Date:** 2026-09-10  
**BE remediation branch:** `cursor/idempotency-remediation` (NOT merged to main)  
**FE clean main:** `0e1d678` (sticky path-matched Idempotency-Key already present via `7a5ffa3`)  
**PRODUCTION DATA TOUCHED:** **NO**  
**PRODUCTION SQL APPLIED:** **NO**  
**Owner order:** DO NOT APPLY until explicit `APPLY IDEMPOTENCY MIGRATION`  
**SAFE TO APPLY (now):** **NO**  
**Prod preflight:** `idempotency_keys` **ABSENT** → **Path A** (greenfield CREATE)  
**Canonical review:** `docs/IDEMPOTENCY_FINAL_OWNER_REVIEW.md`

---

## CURRENT STATE

| Layer | Today | Gap |
|-------|-------|-----|
| FE sticky key + path match | On clean FE `0e1d678` | None for Gap B |
| BE `requireIdempotency` | Dual-read/write scoped + insert-if-absent; **503 fail-closed** if table missing | Prod Path A SQL not applied |
| Money RPC ledger id | `scoped_hash_v1` + dual-read bare | Durable multi-instance after SQL |
| Ticket id | Deterministic `T_<digest>` / `RRG_<digest>` | Optional tickets unique index still commented |
| In-progress | `processing` (+ legacy `pending`); stale reclaim / ledger replay | — |
| Retention | `PROPOSED_idempotency_keys_retention.sql` + JS purge | **Not scheduled** on prod |

Hard rule: application-level mutex / process-local mem is **not** sufficient for money. Missing durable store → fail closed.

---

## TARGET DESIGN (club + player + key)

```sql
-- PROPOSED ONLY — DO NOT APPLY
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  club_id          text NOT NULL,
  player_id        text NOT NULL,
  client_key       text NOT NULL,
  endpoint         text NOT NULL,
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'processing'
                   CHECK (status IN ('pending','processing','completed','failed')),
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
```

Exact file: `migrations/PROPOSED_idempotency_keys_scoped.sql`

---

## COMPAT / ZERO-BREAKAGE DEPLOY ORDER

1. Confirm cancel isolation healthy (owner: done).
2. Deploy BE branch (money **503** until SQL — intentional fail-closed).
3. Read-only preflight — ABSENT → Path A (**done**).
4. Owner message `APPLY IDEMPOTENCY MIGRATION` → Path A CREATE.
5. Verify places; optional scoped-only cutover.
6. Schedule retention purge.
7. Designated-account smoke (incl. concurrent).

**ROLLBACK:** `ROLLBACK_idempotency_keys_scoped.sql` + pre-apply dump; revert BE; keep FE sticky.

---

## SAFE TO REQUEST OWNER APPLY

**NO.** Remaining:

1. Explicit owner `APPLY IDEMPOTENCY MIGRATION`.
2. Path A SQL apply (P0 — DB UNIQUE not live).
3. Retention schedule after SQL.
4. Designated-account smoke.

**SAFE TO APPLY:** **NO**

---

## PACKAGE INDEX

| File | Role |
|------|------|
| `docs/IDEMPOTENCY_FINAL_OWNER_REVIEW.md` | Final owner review |
| `docs/BET_PLACEMENT_IDEMPOTENCY_PROD_GATE.md` | This gate |
| `lib/idempotency-engine.js` | Scoped engine |
| `migrations/PROPOSED_idempotency_keys_scoped.sql` | Exact SQL — **DO NOT APPLY** |
| `migrations/PROPOSED_idempotency_keys_retention.sql` | Purge — **DO NOT SCHEDULE YET** |
| `migrations/ROLLBACK_idempotency_keys_scoped.sql` | Rollback |
| `tests/idempotency-remediation.test.js` | Non-prod FINAL matrix |

**PRODUCTION DATA TOUCHED:** NO  
**SETTLEMENT RECORDING:** OFF
