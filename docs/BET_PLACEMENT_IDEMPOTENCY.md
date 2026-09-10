# Bet Placement Idempotency

**Date:** 2026-09-09 (P3+P4 verify)  
**FE:** `pocketbooks-sports`  
**BE:** `pocketbooks-sports-backend`  
**Constraint:** Design + docs only. **Do not apply** production financial SQL/migrations.

---

## Verdict

**YES — the same intended wager can become two server tickets today (on `main`).**

| Scope | Duplicate tickets possible? |
|-------|----------------------------|
| Same idempotency key + same body | **Usually NO** — middleware replay + `ledger_entries.id = p_idempotency_key` UNIQUE |
| Same human intent, **new** key (timeout/retry on `main`) | **YES — P0** |
| After FE sticky fix (feature branches only) | **Mostly NO** for timeout retry; still YES if client clears key or uses `_oa` / distinct UUID |

---

## Key support (what exists)

| Layer | Mechanism | Scope / constraint |
|-------|-----------|-------------------|
| BE middleware `requireIdempotency({required:true})` on `/api/bets/place` | Header `Idempotency-Key` **or** body `idempotencyKey`; stores endpoint+actor+club+body hash; 24h TTL; replay / 409 conflict | Request fingerprint, **not** wager intent |
| BE table `idempotency_keys` | DDL embedded as `IDEMPOTENCY_TABLE_DDL` in `index.js`; upsert on `idempotency_key` PK | **NOT present in prod** (`padgicwrrzmukahfsyhk` — `to_regclass` null). Middleware falls back to **in-memory** store (lost on restart / multi-instance) |
| RPC `place_bet_tx` / `place_rr_tx` | Replay if `ledger_entries.id = p_idempotency_key`; insert ledger with that id; UNIQUE on `ledger_entries.id` is the atomic guard | **Per key only** |
| Ticket id | Server `T_` + `Date.now()` + random (passed as `p_ticket_id`) | New id every **execution** with a new key |
| Tickets table | No `client_idempotency_key` column / unique index | No intent-level UNIQUE |

---

## FE sticky key status

| Branch | Sticky `_pendingPlaceIdemKey` + path-matched `_pbFetch` | On `main`? |
|--------|---------------------------------------------------------|------------|
| `main` | **NO** — still `BET_'+pid+'_'+secondBucket`; `_MONEY_ENDPOINTS.has(absoluteUrl)` Gap A | — |
| `cursor/away-financial-audits` | **YES** @ `20f90ec` | **NO** |
| `cursor/pre-beta-trust-stack-clean` | **YES** @ `7a5ffa3` (same fix lineage) | **NO** |

**Sticky behavior (feature branches):** reuse `_pendingPlaceIdemKey || _generateIdemKey('BET')` across timeout/uncertain retries; clear on success / hard reject; odds-accept uses distinct `_oa` key (intentional new intent). `_pbFetch` matches money endpoints by **path**, prefers `body.idempotencyKey` for header.

**Note for trust-clean agent:** sticky FE is already on `cursor/pre-beta-trust-stack-clean` — prefer merge/cherry-pick that path rather than re-implementing on another branch. Do **not** treat sticky as landed on `main` until merge.

---

## Timeout retry safety

| Client | Timeout → user retries | Outcome |
|--------|------------------------|---------|
| `main` | New second → new `BET_…` key → new `place_bet_tx` | **Second ticket** |
| Sticky FE branch | Same `_pendingPlaceIdemKey` | Replay / same ledger key → **one ticket** (if key still in mem middleware or ledger UNIQUE hits) |
| Sticky FE + BE restart mid-flight (no `idempotency_keys` table) | Mem store empty; same key still hits ledger UNIQUE | Safe if first RPC committed; racey if both in-flight before ledger row |

---

## Failure modes

| ID | Scenario | Duplicate? | Severity |
|----|----------|------------|----------|
| **A** | `main` `_pbFetch` absolute URL vs `_MONEY_ENDPOINTS` path set → header inject dead | Relies on body key + busy flag | **P1** (fixed on sticky branches) |
| **B** | Place succeeds; FE timeout; retry with **new** key (`main`) | **YES** | **P0** |
| **C** | Concurrent same key; `_idemCheck` load-then-save race | Usually **NO** (ledger UNIQUE); mem-only worsens | **P1** |
| **D** | Key expired (24h) then reused | Middleware re-executes; new `ticket_id` if ledger gone | **P1** |
| **E** | Two distinct bets same player same second (`main` time-bucket key) | Second becomes **replay** of first | **P1** |
| **F** | Odds-accept `_oa` | New key / new ticket | Expected |
| **G** | RR group key changes on retry | Same as B | **P0** if B |

---

## Exact proposal if insufficient (DO NOT APPLY)

### A. FE (safe, no SQL) — ship sticky from trust-clean / away-financial

Already implemented on those branches. Merge to `main`:

1. Path-matched `_MONEY_ENDPOINTS` + body key → header
2. `_pendingPlaceIdemKey` sticky until success / hard reject
3. Opaque `_generateIdemKey('BET')` (not second-precision)

### B. BE non-money-schema (owner DDL — still financial-adjacent; **do not apply in this package**)

```sql
-- PROPOSED ONLY — creates middleware durability (not place_bet_tx body change)
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

Also harden `_idemCheck` to `INSERT … ON CONFLICT` / advisory lock (code change).

### C. Strong placement uniqueness (financial migration — **DO NOT APPLY**)

```sql
-- PROPOSED ONLY — owner sign-off required
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS client_idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS tickets_club_player_client_idem_uidx
  ON tickets (club_id, player_id, client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;
-- Optionally: derive p_ticket_id = 'T_' || left(encode(sha256(...), 'hex'), 26)
-- Keep ledger_entries.id = p_idempotency_key as money-write guard.
```

Expired keys: replay if ledger exists; else `idempotency_key_expired` (do not silently re-debit).

### Canonical header/body rule

One key. Prefer header; body must match if both present; mismatch → 400. Sticky FE aligns them.

---

## Test plan

| # | Test | Expect |
|---|------|--------|
| T1 | Two POSTs same key+body concurrent | One ticket; second replay / idempotent |
| T2 | Same key, mutated stake | 409 conflict; one ticket |
| T3 | FE timeout then retry **same** sticky key | One ticket |
| T4 | FE timeout then retry **new** key (`main`) | **Two tickets** — documents Gap B |
| T5 | Double-click confirm | One request / one ticket |
| T6 | Odds-accept `_oa` | Second ticket allowed |
| T7 | Cross-club same bare key | No collision after club-scoped uniqueness (post C) |
| T8 | Key TTL expiry with existing ledger | Replay; no new debit |

Anchors: FE `tests/idempotency.test.js`, `tests/bet-placement.test.js`; BE place contract tests.

---

## Migration gate

| Artifact | Status |
|----------|--------|
| `IDEMPOTENCY_TABLE_DDL` in `index.js` | Reference only — **not in prod** |
| Sticky FE | On `away-financial-audits` / `pre-beta-trust-stack-clean` — **not on main** |
| Ticket `client_idempotency_key` unique index | **Proposed — not applied** |
| `place_bet_tx` body changes | **Owner approval required — not in this package** |

---

## Owner checklist

- [ ] Merge FE sticky from `cursor/pre-beta-trust-stack-clean` (prefer) or `cursor/away-financial-audits`
- [ ] Create `idempotency_keys` in prod (DDL above) when owner approves non-RPC durability
- [ ] Approve optional deterministic ticket id + unique index (financial migration — separate gate)
- [ ] Add T1–T8 to CI
- [ ] Supersede shallow `BET_DOUBLE_CLICK_AUDIT.md` after sticky lands on `main`
