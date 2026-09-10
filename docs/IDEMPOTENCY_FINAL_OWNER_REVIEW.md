# IDEMPOTENCY FINAL OWNER REVIEW

**STATUS:** `IDEMPOTENCY REMEDIATION`  
**Date:** 2026-09-10  
**BE branch:** `cursor/idempotency-remediation` (remediations)  
**BE base review SHA:** `34b0142`  
**FE prod SHA (stated):** `0e1d678` (sticky key via ancestor `7a5ffa3`)  
**cancel_bet_tx isolation:** APPLIED + VERIFIED (per owner; this review does not re-apply)  
**settlement recording:** OFF  
**PRODUCTION DATA TOUCHED:** **NO**  
**Owner order:** DO NOT APPLY until explicit `APPLY IDEMPOTENCY MIGRATION`  
**SAFE TO APPLY NOW:** **NO**

---

## Verdict (post-remediation)

Blocking **BE code remediations are implemented** on `cursor/idempotency-remediation`. The package is **ready to deploy BE first**, then for owner preflight + explicit apply of SQL — **not** apply-ready today.

| Remediation | Status |
|-------------|--------|
| Dual-read/write scoped `(club_id, player_id, client_key)` | **DONE** — `lib/idempotency-engine.js` + `index.js` |
| INSERT ON CONFLICT reserve (insert-if-absent) | **DONE** |
| Deterministic `ticket_id` / RR `groupId` | **DONE** |
| Expired key → ledger replay else `idempotency_key_expired` | **DONE** |
| Ledger id scoping decision | **DONE** — `scoped_hash_v1` (see § Ledger) |
| Fail-closed missing club/player on money place | **DONE** |
| No mem-primary on money paths | **DONE** — 503 if store missing |
| Retention job (code-only) | **DONE** — `migrations/PROPOSED_idempotency_keys_retention.sql` + `purgeExpiredIdempotencyKeys()`; **not scheduled** |
| Non-prod test matrix | **DONE** — `tests/idempotency-remediation.test.js` 16/16 |
| Prod SQL apply | **NOT DONE** — still PROPOSED |
| Read-only prod preflight of table shape | **PENDING owner** |
| Explicit `APPLY IDEMPOTENCY MIGRATION` | **PENDING owner** |

**SAFE TO APPLY NOW: NO** — remaining blockers are operational (deploy this BE → preflight → owner APPLY → SQL → schedule retention → smoke), not missing BE remediation code.

---

## Ledger id scoping decision

**Decision:** `LEDGER_ID_SCOPING = scoped_hash_v1`

- HTTP layer keeps FE sticky **client_key** (`Idempotency-Key` / `idempotencyKey`).
- Money RPC `p_idempotency_key` for **new** place/RR writes:
  `IK_<sha256(club_id|player_id|client_key).hex[0:40]>`
- Dual-read on expire / sticky replay: scoped id first, then bare `client_key` with **club_id+player_id match** required.
- Closes cross-club bare-key collision on `ledger_entries.id` UNIQUE without a ledger rewrite migration.
- Cancel / settle keep their existing key→ledger conventions (out of place-path scope).

---

## 1. Exact full SQL for `idempotency_keys`

Canonical apply artifact (PROPOSED ONLY — **not applied**):

**File:** `migrations/PROPOSED_idempotency_keys_scoped.sql`

```sql
-- ============================================================================
-- PROPOSED ONLY — DO NOT APPLY
-- ============================================================================
-- Idempotency keys scoped uniqueness: (club_id, player_id, client_key)
-- Owner apply gate: docs/IDEMPOTENCY_FINAL_OWNER_REVIEW.md
-- Companion rollback: migrations/ROLLBACK_idempotency_keys_scoped.sql
-- Retention: migrations/PROPOSED_idempotency_keys_retention.sql
--
-- Preconditions (owner must confirm before apply):
--   1) Explicit owner message: APPLY IDEMPOTENCY MIGRATION
--   2) cancel_bet_tx isolation already APPLIED + VERIFIED
--   3) Read-only preflight of current public.idempotency_keys shape
--   4) BE dual-read/write code for scoped rows deployed (this branch)
--   5) FE sticky path-matched Idempotency-Key on prod lineage (0e1d678 / 7a5ffa3)
--
-- PRODUCTION DATA TOUCHED if applied: schema only (table/index); no ticket/ledger rewrite
-- ============================================================================

BEGIN;

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

COMMIT;
```

Legacy path (section B in the same file) and optional tickets unique index remain **commented** until preflight + deterministic ticket id land (ticket id code is ready).

**BE reference DDL (post-remediation):** `idempotencyEngine.IDEMPOTENCY_TABLE_DDL` / scoped DDL above. Dual-mode still reads legacy bare PK when present.

---

## 2. Uniqueness proof — `club_id + player_id + idempotency_key`

| Layer | Mechanism | Enforced today? |
|-------|-----------|-----------------|
| Proposed table | `PRIMARY KEY (club_id, player_id, client_key)` | **NO** — SQL not applied |
| App middleware | Dual-read/write + mem-scoped triple; insert-if-absent | **YES in code** (awaiting SQL for DB PK) |
| Money RPC | `ledger_entries.id = scoped IK_ hash` (new) + dual-read bare | **YES in code** |

**UNIQUE SCOPE: PASS (code)** / **FAIL (prod DB until SQL)**

---

## 3. Request fingerprint — exact computation

Unchanged — PASS. Canonical sha256 of `{endpoint, actorId, clubId, body:sortKeys}` → 32 hex.

---

## 4. Concurrency proof — one ticket

**Coded:**

1. `insertIfAbsent` (ON CONFLICT DO NOTHING semantics) — winner executes; loser re-reads.
2. Deterministic `ticket_id` / `RRG_` group id from `sha256(club|player|client_key)`.
3. Ledger UNIQUE on scoped (or legacy bare) id.

**CONCURRENT DUPLICATE: PASS (unit matrix T1)** — live Postgres concurrent proof still recommended at smoke.

---

## 5. Restart / multi-instance safety

| Concern | Post-remediation |
|---------|------------------|
| Durable store | Money: fail closed if `idempotency_keys` missing (503) |
| Mem | Shadow only; **not** money primary |
| Expired | Ledger replay or `400 idempotency_key_expired` |
| Crash after money | Dual-read ledger before place + expire path |

**RESTART SAFETY: PASS (code)**  
**MULTI-INSTANCE: PASS (code, when table present)**

---

## 6–7. Failure windows / atomicity

| ID | Target recovery | Status |
|----|-----------------|--------|
| A | INSERT reserve + deterministic ticket | **DONE** |
| B | FE sticky + BE replay | **DONE** (FE prior) |
| C | Ledger dual-read replay | **DONE** |
| D | Expired → ledger or `idempotency_key_expired` | **DONE** |
| E | body_mismatch 409 | **DONE** |

Money RPC still one txn; middleware complete remains best-effort (unchanged residual).

---

## 8. Cleanup / retention

| Policy | Status |
|--------|--------|
| TTL 24h | YES |
| `purge_expired_idempotency_keys()` | **Code artifact** — `PROPOSED_idempotency_keys_retention.sql` |
| Nightly schedule | **NOT scheduled** (do not cron prod yet) |
| JS helper | `purgeExpiredIdempotencyKeys()` — not boot-enqueued |

---

## 9. Backward compatibility / deploy order

1. Confirm cancel isolation healthy (owner: done).
2. **Deploy this BE branch** (dual-read/write + money fail-closed).
3. Read-only preflight prod `idempotency_keys` shape.
4. Owner: `APPLY IDEMPOTENCY MIGRATION` → SQL path A or B.
5. Optionally flip writers scoped-only after dual period.
6. Schedule retention DELETE / function.
7. Designated-account T1–T10 smoke.

**ROLLBACK:** `ROLLBACK_idempotency_keys_scoped.sql` + pre-apply dump; revert BE; keep FE sticky.

---

## 10. Security — cross-player / cross-club

| Attack | Post-remediation |
|--------|------------------|
| Cross-player same key | Scoped PK (after SQL) + mem/app scope; ledger scoped hash |
| Cross-club same key | Scoped ledger id; soft club check |
| Missing club/player on place | **400 fail-closed** |

**CROSS-PLAYER / CROSS-CLUB: PASS (code)** — DB PK still pending SQL.

---

## 11. Non-prod test matrix

| # | Case | Result |
|---|------|--------|
| T1 | Concurrent same key+body | **PASS** remediation test |
| T2 | Fingerprint / body_mismatch | **PASS** |
| T3 | Timeout sticky FE notes | **PASS** (deterministic ticket + FE lineage note) |
| T7 | Cross-player/club | **PASS** |
| T8 | Expired + ledger / no ledger | **PASS** |
| Fail-closed club/player | **PASS** |
| No mem-primary money | **PASS** |
| Retention helper | **PASS** |

**TESTS:** `node tests/idempotency-remediation.test.js` → **16 passed**; place_rr_tx **47**; HAB **6**.

---

## 12. Exact STATUS block

```
STATUS: IDEMPOTENCY REMEDIATION
SQL: migrations/PROPOSED_idempotency_keys_scoped.sql (PRIMARY KEY (club_id, player_id, client_key)); NOT APPLIED
RETENTION SQL: migrations/PROPOSED_idempotency_keys_retention.sql; NOT SCHEDULED
UNIQUE SCOPE: PASS (code) / FAIL (prod DB until SQL)
REQUEST FINGERPRINT: PASS
ATOMICITY: PASS (money RPC) / residual middleware complete best-effort
CONCURRENT DUPLICATE: PASS (unit); live PG smoke recommended
TIMEOUT RETRY: PASS
RESTART SAFETY: PASS (code)
MULTI-INSTANCE: PASS (code when table present)
CROSS-PLAYER ISOLATION: PASS (code)
CROSS-CLUB ISOLATION: PASS (code; scoped_hash_v1 ledger)
RETENTION: 24h TTL; purge function packaged; NOT scheduled on prod
LEDGER ID SCOPING: scoped_hash_v1 (IK_<sha256(club|player|key)[0:40]>); dual-read bare
DEPLOYMENT ORDER: FE sticky (done) → deploy BE remediation → preflight → owner APPLY → SQL → retention schedule → smoke
ROLLBACK: migrations/ROLLBACK_idempotency_keys_scoped.sql + pre-apply schema dump; revert BE; keep FE sticky
EXACT MIGRATION FILE: migrations/PROPOSED_idempotency_keys_scoped.sql
BACKEND CHANGES: IMPLEMENTED on cursor/idempotency-remediation
TESTS: remediation 16/16; place_rr_tx 47/47; HAB 6/6
SAFE TO APPLY NOW: NO
REMAINING BLOCKERS: (1) deploy BE branch (2) read-only prod preflight of idempotency_keys shape (3) explicit owner APPLY IDEMPOTENCY MIGRATION (4) schedule retention after SQL (5) designated-account smoke
PRODUCTION DATA TOUCHED: NO
SETTLEMENT RECORDING: OFF
```

---

## Remediations before apply (updated)

1. ~~Implement BE dual-read/write~~ **DONE**
2. ~~Replace load-then-save~~ **DONE**
3. ~~Deterministic ticket_id~~ **DONE**
4. ~~Expired key policy~~ **DONE**
5. ~~Decide ledger id~~ **DONE** (`scoped_hash_v1`)
6. ~~Fail closed club/player~~ **DONE**
7. ~~Disable mem-primary on money~~ **DONE**
8. **Read-only prod preflight** — **PENDING owner**
9. ~~Retention code~~ **DONE**; **schedule** — PENDING after SQL
10. **Owner explicit message:** `APPLY IDEMPOTENCY MIGRATION` — **PENDING**

---

## Package index

| Artifact | Role |
|----------|------|
| `docs/IDEMPOTENCY_FINAL_OWNER_REVIEW.md` | This review |
| `docs/BET_PLACEMENT_IDEMPOTENCY_PROD_GATE.md` | Gate package (updated assessment) |
| `lib/idempotency-engine.js` | Scoped engine |
| `migrations/PROPOSED_idempotency_keys_scoped.sql` | Exact proposed SQL — **DO NOT APPLY** |
| `migrations/PROPOSED_idempotency_keys_retention.sql` | Purge function — **DO NOT SCHEDULE YET** |
| `migrations/ROLLBACK_idempotency_keys_scoped.sql` | Rollback companion |
| `tests/idempotency-remediation.test.js` | Non-prod matrix |

**SETTLEMENT RECORDING:** OFF — untouched.  
**PRODUCTION DATA TOUCHED:** NO.
