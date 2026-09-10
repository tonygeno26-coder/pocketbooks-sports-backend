# IDEMPOTENCY FINAL OWNER REVIEW

**STATUS:** `IDEMPOTENCY REMEDIATION FINAL`  
**Date:** 2026-09-10  
**BE branch:** `cursor/idempotency-remediation` (NOT merged to main)  
**FE prod SHA (stated):** `0e1d678` (sticky key via ancestor `7a5ffa3`)  
**cancel_bet_tx isolation:** APPLIED + VERIFIED (per owner; this review does not re-apply)  
**settlement recording:** OFF  
**PRODUCTION DATA TOUCHED:** **NO**  
**PRODUCTION SQL APPLIED:** **NO**  
**Owner order:** DO NOT APPLY until explicit `APPLY IDEMPOTENCY MIGRATION`  
**SAFE TO APPLY NOW:** **NO**

---

## Verdict

Package is a **production-safe design** in code + proposed SQL. It is **not** apply-ready until Path A SQL lands and owner says APPLY. Money paths are **fail-closed** if `idempotency_keys` is missing (503) — application mutex / process-local mem is **not** treated as sufficient for multi-instance money safety.

| Remediation | Status |
|-------------|--------|
| Dual-read/write scoped `(club_id, player_id, client_key)` | **DONE** |
| INSERT ON CONFLICT reserve (insert-if-absent) | **DONE** |
| Deterministic `ticket_id` / RR `groupId` | **DONE** |
| Status `processing` / `completed` / `failed` (+ legacy `pending`) | **DONE** |
| Stale processing reclaim / ledger replay (no second ticket) | **DONE** |
| Expired key → ledger replay else `idempotency_key_expired` | **DONE** |
| Ledger id scoping `scoped_hash_v1` | **DONE** |
| Fail-closed missing club/player + missing durable store | **DONE** |
| Concurrent 2x / 10x race tests (ticket delta=1) | **DONE** |
| Response-loss / restart / multi-instance / TX rollback tests | **DONE** |
| Retention job (code-only, unscheduled) | **DONE** |
| Prod SQL apply | **NOT DONE** — PROPOSED |
| Explicit `APPLY IDEMPOTENCY MIGRATION` | **PENDING owner** |

**SAFE TO APPLY NOW: NO** — P0 remaining: durable PK not in prod DB (table ABSENT). Code alone cannot claim DB UNIQUE guarantee in production until SQL.

---

## 1. Blockers (P0 / P1 / P2)

| ID | Sev | Layer | Failure scenario | Dup ticket? | Stuck? | 2nd wager? | Status |
|----|-----|-------|------------------|-------------|--------|------------|--------|
| B0 | **P0** | SQL | `idempotency_keys` ABSENT in prod → no DB UNIQUE on scope | Possible under multi-instance without ledger hit | Place 503 fail-closed when store probed missing | Mitigated by fail-closed + ledger UNIQUE when RPC reached | **OPEN** until Path A SQL |
| B1 | P1 | Atomicity | Middleware `idemComplete` best-effort after money RPC | No (ledger dual-read / deterministic ticket) | No | No | Residual by design |
| B2 | P1 | FE | Non-sticky new key on timeout (pre-0e1d678) | YES | No | YES | **CLOSED** on FE sticky lineage |
| B3 | P2 | Ops | Retention not scheduled | N/A growth | N/A | N/A | Packaged; schedule after SQL |
| B4 | P2 | Optional | Tickets `client_idempotency_key` unique index commented | Defense-in-depth only | No | No | Optional after smoke |

---

## 2. True DB-backed scope

| Case | Behavior |
|------|----------|
| Same club+player+key, same request | Reserve once; replay completed / in_progress / ledger |
| Same club+player+key, different body hash | 409 `body_mismatch` |
| Different player, same bare key | Separate PK rows; distinct scoped ledger/ticket ids |
| Different club, same bare key | Separate PK rows; distinct scoped ledger/ticket ids |

**Proposed PK:** `PRIMARY KEY (club_id, player_id, client_key)` — **not applied**.

---

## 3. Failure windows A–F

| ID | Window | Closure |
|----|--------|---------|
| A | FE path/header mismatch | FE sticky path-matched (0e1d678); BE accepts header or body |
| B | Response loss / timeout retry new key | FE sticky + BE ledger dual-read + deterministic ticket |
| C | Concurrent same key race | DB insert-if-absent + ledger UNIQUE + deterministic ticket |
| D | Expired key silent re-place | Ledger replay else `400 idempotency_key_expired` |
| E | Same key different body | 409 `body_mismatch` |
| F | Odds-accept `_oa` new key | Intentional new ticket (documented) |

---

## 4. Atomicity

- Money write: single `place_bet_tx` / `place_rr_tx` TX (PASS).
- Idempotency row complete: best-effort after response; **DB-level proof** for no double debit = `ledger_entries.id` UNIQUE on scoped `IK_` id + deterministic `ticket_id` PK collision.
- Prefer future one-TX embedding of idempotency complete inside RPC (not in this PROPOSED file).

**ATOMICITY: PASS** (money TX + ledger UNIQUE proof); residual middleware complete = P1.

---

## 5. Concurrent races

Unit/sim (shared UNIQUE map): **2x PASS**, **10x PASS** — ticket delta=1, same deterministic ticket.

Live Postgres concurrent smoke: recommended after SQL apply (designated account).

---

## 6. Request fingerprint

`sha256(JSON.stringify({ endpoint, actorId, clubId, body: sortKeys(body) })).hex[0:32]` — PASS.

---

## 7. In-progress recovery

| State | Behavior |
|-------|----------|
| `processing` / legacy `pending` (fresh) | 409 `request_in_progress` |
| Stale processing + ledger | Replay; no second ticket |
| Stale processing + no ledger | Reclaim same scope → execute; deterministic ticket + ledger UNIQUE |
| `completed` | Replay stored response |
| `failed` | Replay failure (no second ticket; new key for deliberate retry) |

---

## 8. Retention (conservative)

- TTL: 24h on rows  
- Purge: `expires_at < now() - 7 days` via `purge_expired_idempotency_keys()`  
- **NOT scheduled** on prod  

---

## 9. Zero-breakage deploy order

1. Confirm cancel isolation healthy (owner: done).
2. Deploy this BE branch (fail-closed if table missing — places return 503 on money until SQL).
3. Read-only preflight — **DONE**: table ABSENT → **Path A**.
4. Owner: `APPLY IDEMPOTENCY MIGRATION` → Path A CREATE.
5. Confirm places succeed; dual-mode if any legacy rows.
6. Schedule retention function (optional nightly).
7. Designated-account smoke T1–T10 + concurrent.

**Note:** Deploy BE before SQL means money place **503** until Path A — intentional fail-closed, not soft mem-primary.

---

## 10. Rollback safety

- `migrations/ROLLBACK_idempotency_keys_scoped.sql` + pre-apply schema dump  
- Revert BE branch deploy  
- Keep FE sticky (safe)  
- No ticket/ledger rewrite required for table drop on greenfield Path A  

---

## 11. Test matrix (non-prod)

| Case | Result |
|------|--------|
| Concurrent 2x | PASS |
| Concurrent 10x | PASS |
| Same request replay | PASS |
| Changed request conflict | PASS |
| Response loss (ledger-only) | PASS |
| Restart / stale+ledger | PASS |
| Multi-instance (shared UNIQUE) | PASS |
| Stale processing reclaim | PASS |
| TX rollback + reclaim | PASS |
| Cross-player / cross-club | PASS |
| Fail-closed store missing | PASS |
| Retention helper | PASS |

---

## 12. No financial side effects

This package does **not** place prod wagers, change balances, alter tickets, enable settlement, or apply SQL.

---

## 13. Branch

Commit + push `cursor/idempotency-remediation` only — **NOT main**.

---

## Ledger id scoping

`LEDGER_ID_SCOPING = scoped_hash_v1` → `IK_<sha256(club|player|client_key)[0:40]>` with dual-read bare key + club/player match.

---

## Exact STATUS block

```
STATUS: IDEMPOTENCY REMEDIATION FINAL
BRANCH: cursor/idempotency-remediation
SQL APPLIED: NO
SQL: migrations/PROPOSED_idempotency_keys_scoped.sql (PRIMARY KEY (club_id, player_id, client_key)); NOT APPLIED
RETENTION SQL: migrations/PROPOSED_idempotency_keys_retention.sql; NOT SCHEDULED
PROD TABLE PREFLIGHT: ABSENT → Path A when APPLY
DB UNIQUE GUARANTEE: PASS (code+proposed SQL) / FAIL (prod DB until SQL)
ATOMICITY: PASS (money RPC + ledger UNIQUE proof)
SAME REQUEST REPLAY: PASS
CHANGED REQUEST CONFLICT: PASS
CONCURRENT 2X: PASS
CONCURRENT 10X: PASS
RESPONSE LOSS: PASS
RESTART: PASS
MULTI-INSTANCE: PASS (code when table present) / FAIL closed if table missing
STALE PROCESSING: PASS
CROSS-PLAYER: PASS
CROSS-CLUB: PASS
RETENTION: 24h TTL; 7d grace purge packaged; NOT scheduled
DEPLOYMENT ORDER: FE sticky → deploy BE → Path A SQL on APPLY → retention schedule → smoke
ROLLBACK: ROLLBACK_idempotency_keys_scoped.sql + dump; revert BE; keep FE sticky
EXACT SQL FILE: migrations/PROPOSED_idempotency_keys_scoped.sql
TESTS: remediation FINAL matrix (see test run); place_rr_tx / HAB unchanged
SAFE TO APPLY NOW: NO
REMAINING BLOCKERS: (P0) Path A SQL not applied; (ops) owner APPLY; retention schedule; designated smoke
PRODUCTION SQL APPLIED: NO
PRODUCTION FINANCIAL DATA TOUCHED: NO
SETTLEMENT RECORDING: OFF
```

---

## Package index

| Artifact | Role |
|----------|------|
| `docs/IDEMPOTENCY_FINAL_OWNER_REVIEW.md` | This review |
| `docs/BET_PLACEMENT_IDEMPOTENCY_PROD_GATE.md` | Gate package |
| `lib/idempotency-engine.js` | Scoped engine |
| `migrations/PROPOSED_idempotency_keys_scoped.sql` | Exact proposed SQL — **DO NOT APPLY** |
| `migrations/PROPOSED_idempotency_keys_retention.sql` | Purge function — **DO NOT SCHEDULE YET** |
| `migrations/ROLLBACK_idempotency_keys_scoped.sql` | Rollback companion |
| `tests/idempotency-remediation.test.js` | Non-prod FINAL matrix |

**SETTLEMENT RECORDING:** OFF — untouched.  
**PRODUCTION DATA TOUCHED:** NO.
