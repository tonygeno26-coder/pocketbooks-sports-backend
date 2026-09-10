# IDEMPOTENCY FINAL OWNER REVIEW

**STATUS:** `IDEMPOTENCY FINAL OWNER REVIEW`  
**Date:** 2026-09-10  
**BE prod SHA (stated):** `ae1d18d` (workspace HEAD matches)  
**FE prod SHA (stated):** `0e1d678` (sticky key via ancestor `7a5ffa3`; workspace tip may be ahead)  
**cancel_bet_tx isolation:** APPLIED + VERIFIED (per owner; this review does not re-apply)  
**settlement recording:** OFF  
**PRODUCTION DATA TOUCHED:** **NO**  
**Owner order:** DO NOT APPLY until explicit `APPLY IDEMPOTENCY MIGRATION`  
**SAFE TO APPLY NOW:** **NO**

---

## Verdict

Package is **review-complete but not apply-ready**. FE sticky key on the `0e1d678` lineage closes Gap B (timeout → new key → second ticket) at the client. The **proposed** scoped SQL is written as an artifact, but **BE middleware still implements bare-key load-then-save**, random ticket ids remain, expired-key re-execute remains, and ledger uniqueness is still global on bare `p_idempotency_key`. Applying SQL alone would break or no-op current BE writers.

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
--
-- Preconditions (owner must confirm before apply):
--   1) Explicit owner message: APPLY IDEMPOTENCY MIGRATION
--   2) cancel_bet_tx isolation already APPLIED + VERIFIED
--   3) Read-only preflight of current public.idempotency_keys shape
--   4) BE dual-read/write code for scoped rows deployed OR deployed in same window
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

Legacy path (section B in the same file) and optional tickets unique index remain **commented** until preflight + deterministic ticket id land.

**Current BE reference DDL (live code path today — bare PK):** `index.js` `IDEMPOTENCY_TABLE_DDL`:

```sql
CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key  TEXT PRIMARY KEY,
  actor_id         TEXT NOT NULL,
  club_id          TEXT NOT NULL DEFAULT '',
  endpoint         TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  response_status  INTEGER,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at ON idempotency_keys(expires_at);
```

---

## 2. Uniqueness proof — `club_id + player_id + idempotency_key`

| Layer | Mechanism | Enforced today? |
|-------|-----------|-----------------|
| Proposed table | `PRIMARY KEY (club_id, player_id, client_key)` | **NO** — not applied; code still upserts `onConflict:'idempotency_key'` |
| App middleware | Soft checks `actor_id` / `club_id` after load by bare key | Partial — not DB-unique; not `player_id` column |
| Money RPC | `ledger_entries.id = p_idempotency_key` UNIQUE | Yes — **global bare key**, not club+player scoped |

**Proof (proposed):** Postgres rejects a second insert with the same `(club_id, player_id, client_key)` via PK violation. Distinct clubs or players may reuse the same opaque `client_key`.

**Gap:** Until BE writes the scoped triple and drops bare-key PK dependence, uniqueness is **not** proven in production.

**UNIQUE SCOPE: FAIL** (design specified; DB+code not aligned for apply)

---

## 3. Request fingerprint — exact computation

From `index.js` (`_hashRequest` / `_sortKeys`):

```
canonical = JSON.stringify({
  endpoint,                    // req.path, e.g. "/api/bets/place"
  actorId,                     // req._actor.actorId || "anon"
  clubId: clubId || "",        // req._clubId || ""
  body: sortKeys(body || {})   // deep key-sorted req.body
})
request_hash = sha256(utf8(canonical)).hexdigest()[0:32]
```

`sortKeys`: arrays map recursively; objects rebuild with `Object.keys(...).sort()`.

**Included in hash:** full body (including `idempotencyKey`, stake, legs, etc.).  
**Not separately keyed:** `player_id` beyond whatever is in `actorId` / body.  
**Conflict rule (today):** same bare key + different hash → `409 idempotency_conflict` / `body_mismatch`.

**REQUEST FINGERPRINT: PASS** (algorithm exact and stable; FE sticky preserves body+key on uncertain retry)

---

## 4. Concurrency proof — one ticket

**Desired DB mechanism (proposed, not coded):**

1. `INSERT … ON CONFLICT (club_id, player_id, client_key) DO NOTHING` — winner executes; loser re-reads.
2. Optional `pg_advisory_xact_lock(hashtext(club||player||key))`.
3. `ledger_entries.id = p_idempotency_key` UNIQUE as second line of defense.
4. Deterministic `ticket_id` from `sha256(club|player|client_key)` so concurrent same-key cannot insert two ticket rows.

**Actual today:**

1. `_idemCheck` **load-then-save** — two workers can both miss and both `execute`.
2. Handler builds `ticketId = 'T_' + Date.now() + '_' + random` **before** RPC (`index.js` ~14642).
3. `place_bet_tx` inserts ticket then ledger; ledger unique_violation returns the **winning** ledger’s ticket — the **losing** concurrent call may leave an **orphan ticket** with no ledger.

Ledger UNIQUE prevents **double debit** for the same bare key; it does **not** yet prove **one ticket row**.

**CONCURRENT DUPLICATE: FAIL**

---

## 5. Restart / multi-instance safety

| Concern | Today | Proposed |
|---------|-------|----------|
| Process restart mid-flight | Row may stay `pending` until TTL; client gets `409 request_in_progress` | Same unless pending-wait/replay or lease TTL |
| Durable store | DB upsert if table exists; else **per-process `_idemMemStore`** | Must require DB; fail closed if table missing on money routes |
| Multi-instance | Mem fallback **split-brain**; DB bare key OK for replay if table present | Scoped PK + no mem-primary on money |
| Money after crash | `place_bet_tx` ledger UNIQUE → RPC replay `idempotent:true` | Keep + align ledger id to scoped key or hash |

**RESTART SAFETY: FAIL** (pending stuck + expired re-execute; mem path)  
**MULTI-INSTANCE: FAIL** (mem fallback; reservation race)

---

## 6. Failure windows A–E — recovery

| ID | Window | Recovery today | Target recovery |
|----|--------|----------------|-----------------|
| **A** | Concurrent same key+body | Ledger blocks 2nd debit; possible orphan ticket; middleware race | INSERT ON CONFLICT + deterministic ticket id |
| **B** | FE timeout / uncertain → retry | **Mitigated on FE `0e1d678` lineage:** sticky `_pendingPlaceIdemKey` + path-matched header | Keep sticky; BE replay completed/ledger |
| **C** | Crash after money, before `_idemComplete` | Next retry may re-enter handler; RPC returns idempotent | Complete row from ledger/`ticket_id` on replay |
| **D** | Key TTL expired, reused | **Re-executes** (`key_expired_reused`) — can create **new** ticket if new random id | If ledger exists → 200 replay; else `400 idempotency_key_expired` |
| **E** | Same key, different body (stake/legs) | `409 body_mismatch` | Keep; no second ticket |

**TIMEOUT RETRY: PASS** (FE sticky on stated prod FE lineage; BE ledger same-key safe)  
**Caveat:** Pass assumes sticky key retained; new-key retry still creates a second ticket by design.

---

## 7. Atomicity

| Boundary | Atomic? |
|----------|---------|
| `place_bet_tx` ticket + ledger | YES (single PG function / txn) |
| Middleware reserve → money → `_idemComplete` | **NO** — three phases; complete is best-effort `res.json` monkey-patch |
| Ticket + `ticket_legs` | **NO** — legs after RPC; compensate cancel on leg failure |
| Money + FE success toast | **NO** — network/timeout; sticky key closes duplicate-intent |

**ATOMICITY: FAIL** (money RPC OK; end-to-end place path + middleware not one txn; orphan-ticket race)

---

## 8. Cleanup / retention

| Policy (proposed) | Implemented? |
|-------------------|--------------|
| TTL 24h (`KEY_TTL_MS`) | YES in middleware |
| Nightly `DELETE WHERE expires_at < now() - interval '7 days'` | **NO** job/cron in repo |
| Do not log full keys | Partial — logs include key substrings today |

**RETENTION:** Proposed 24h TTL + 7-day purge after expiry; **purge not scheduled**. Growth O(places/day).

---

## 9. Backward compatibility / deploy order

**Required order (do not skip):**

1. Confirm cancel isolation remains healthy (owner: done).
2. Read-only preflight prod `idempotency_keys` shape + row counts.
3. Deploy **BE dual-read/write** (legacy bare key **or** scoped triple); fail closed if club/player missing on place.
4. Apply SQL (`PROPOSED_idempotency_keys_scoped.sql` path A or B per preflight).
5. Flip BE to scoped-only writers; implement INSERT ON CONFLICT reservation.
6. Ship deterministic ticket id (+ optional tickets unique index).
7. Expire-path: ledger replay / `idempotency_key_expired`.
8. Schedule retention DELETE.
9. Designated-account T1–T10 smoke.

**FE sticky may remain** through rollback of SQL/BE (safe).

**DEPLOYMENT ORDER:** FE sticky (done) → BE dual-read code → SQL scoped PK → BE fail-closed scoped + reservation → deterministic ticket id → retention job → smoke.

**ROLLBACK:** `migrations/ROLLBACK_idempotency_keys_scoped.sql` + restore pre-apply dump; revert BE dual-write commit; leave FE sticky.

---

## 10. Security — cross-player / cross-club

| Attack | Today | Proposed |
|--------|-------|----------|
| Player B replays Player A’s key in same club | Soft `actor_mismatch` if `actor_id` differs | PK includes `player_id`; plus authz |
| Same bare key across clubs | Soft `club_mismatch`; global ledger id **collision** risk if keys collide | Scoped PK; **ledger id must become `club|player|key` hash or equivalent** (undecided — open remediation) |
| Missing club on place | Soft empty string allowed in middleware | Fail closed 400 |

**CROSS-PLAYER ISOLATION: FAIL** (app soft-check only; not DB PK; actor≠player edge cases)  
**CROSS-CLUB ISOLATION: FAIL** (app soft-check; ledger global bare id undecided)

---

## 11. Non-prod test matrix

| # | Case | Expect | Ran this review? |
|---|------|--------|------------------|
| T1 | Concurrent same key+body | One ticket; replay | Logic/smoke only — **no live concurrent DB proof** |
| T2 | Same key, different stake | 409; one ticket | FE `idempotency.test.js` body_mismatch ✅ |
| T3 | Timeout retry same key | One ticket | FE sticky code review ✅; not live E2E |
| T4 | Retry new key (legacy) | Two tickets | Documented residual if sticky cleared |
| T5 | Double-click | One request/ticket | UX busy + sticky |
| T6 | Odds-accept `_oa` | New ticket OK | Code path present |
| T7 | Cross-club same bare key | No collision under scoped PK | **Blocked** — scoped PK not applied |
| T8 | Expired + ledger exists | Replay; no debit | **FAIL today** — re-executes |
| T9 | Missing club on place | 400; no write | Not fail-closed in middleware |
| T10 | Cancel isolation | Unaffected | Owner verified separately |

**Tests executed (practical, non-prod):**

- `pocketbooks-sports/tests/idempotency.test.js` — **25 passed**
- `pocketbooks-sports-backend/tests/place-rr-tx-smoke.test.js` — **47 passed** (incl. RPC same-key replay)
- `pocketbooks-sports-backend/tests/hab-placement-order.test.js` — **6 passed**
- `middleware-order.test.js` — harness error (`test is not defined`); not used as evidence

**TESTS:** Unit/smoke for fingerprint + RPC same-key replay PASS; scoped-PK / concurrent orphan / expired-ledger matrix **not** covered in CI against real Postgres.

---

## 12. Exact STATUS block

```
STATUS: IDEMPOTENCY FINAL OWNER REVIEW
SQL: migrations/PROPOSED_idempotency_keys_scoped.sql (PRIMARY KEY (club_id, player_id, client_key)); see §1 for full text
UNIQUE SCOPE: FAIL
REQUEST FINGERPRINT: PASS
ATOMICITY: FAIL
CONCURRENT DUPLICATE: FAIL
TIMEOUT RETRY: PASS
RESTART SAFETY: FAIL
MULTI-INSTANCE: FAIL
CROSS-PLAYER ISOLATION: FAIL
CROSS-CLUB ISOLATION: FAIL
RETENTION: 24h TTL proposed; DELETE expires_at < now()-7d proposed; purge job NOT implemented
DEPLOYMENT ORDER: FE sticky (done) → BE dual-read → apply scoped SQL → BE fail-closed+ON CONFLICT → deterministic ticket_id → retention → smoke
ROLLBACK: migrations/ROLLBACK_idempotency_keys_scoped.sql + pre-apply schema dump; revert BE; keep FE sticky
EXACT MIGRATION FILE: migrations/PROPOSED_idempotency_keys_scoped.sql
BACKEND CHANGES: REQUIRED before apply — dual-read/write scoped columns; INSERT ON CONFLICT reserve; expired→ledger replay; deterministic ticket_id; fail-closed missing club/player; decide ledger id scoping; disable mem-primary on money
TESTS: FE idempotency 25/25; place_rr_tx smoke 47/47; HAB 6/6; scoped/orphan/expired-ledger matrix PENDING
SAFE TO APPLY NOW: NO
PRODUCTION DATA TOUCHED: NO
SETTLEMENT RECORDING: OFF
```

---

## Remediations before apply (blocking)

1. **Implement BE dual-read/write** for `(club_id, player_id, client_key)` matching proposed DDL; do not apply SQL against current upsert-on-`idempotency_key` alone.
2. **Replace load-then-save** with `INSERT … ON CONFLICT DO NOTHING` (or advisory xact lock) so only one executor runs.
3. **Deterministic `ticket_id`** from scope (and/or tickets unique on `client_idempotency_key`) to eliminate concurrent orphan tickets.
4. **Expired key policy:** if ledger exists for key → replay; else `400 idempotency_key_expired` (never silent re-place).
5. **Decide ledger id:** keep global bare key **or** migrate to scoped hash — document and implement before apply (cross-club collision is P1 today).
6. **Fail closed** when club_id/player_id missing on money idempotency.
7. **Disable mem-store as primary** for money routes when DB unavailable (fail closed).
8. **Read-only prod preflight** of current `idempotency_keys` shape; choose §A vs §B in migration file.
9. **Schedule retention DELETE**; add CI tests for T1/T7/T8 against Postgres.
10. **Owner explicit message:** `APPLY IDEMPOTENCY MIGRATION`.

---

## Package index

| Artifact | Role |
|----------|------|
| `docs/IDEMPOTENCY_FINAL_OWNER_REVIEW.md` | This review |
| `docs/BET_PLACEMENT_IDEMPOTENCY.md` | Design / failure modes |
| `docs/BET_PLACEMENT_IDEMPOTENCY_PROD_GATE.md` | Earlier gate package |
| `migrations/PROPOSED_idempotency_keys_scoped.sql` | Exact proposed SQL — **DO NOT APPLY** |
| `migrations/ROLLBACK_idempotency_keys_scoped.sql` | Rollback companion |
| `index.js` idempotency engine | Current bare-key implementation |

**SETTLEMENT RECORDING:** OFF — untouched.  
**PRODUCTION DATA TOUCHED:** NO.
