# Bet Placement Idempotency Design

**Date:** 2026-09-09  
**FE:** `pocketbooks-sports` (`cursor/away-financial-audits`)  
**BE:** `pocketbooks-sports-backend`  
**Constraint:** Design + docs only for money RPCs. **Do not apply** production financial SQL/migrations.

---

## Verdict

**YES / MAYBE — the same intended wager can become two tickets.**

Same-key replays are largely protected. **Different keys for one human intent** (timeout → retry, second-precision key rollover, odds-accept `_oa`) are **not** collapsed. Double-click while in-flight is mitigated by FE busy guard; it is **not** a full server intent lock.

Corrects the shallow overnight note in `BET_DOUBLE_CLICK_AUDIT.md` (“not a P0 accounting hole”): that note assumed header auto-inject + pending-key reuse work. They currently do **not** (see Gap A).

---

## Current architecture (as implemented)

| Layer | Mechanism | What it keys |
|-------|-----------|--------------|
| FE `confirmBet` | `idempotencyKey = 'BET_'+playerId+'_'+timestamp(14 digits ≈ seconds)` | One attempt per second bucket |
| FE `_pbFetch` | Intended `Idempotency-Key` header + `_pendingIdemKeys` | Broken for absolute API URLs (Gap A) |
| FE | `_confirmBetInFlight` / button busy | UX double-click while awaiting |
| BE `requireIdempotency({required:true})` | `idempotency_keys` table (or mem fallback); header **or** body key; hash of endpoint+actor+club+body; 24h TTL; replay completed responses | Request fingerprint, not wager intent |
| BE `place_bet_tx` / `place_rr_tx` | `ledger_entries.id = p_idempotency_key` UNIQUE; replay returns existing `ticket_id` | Money write atomicity **per key** |
| Ticket id | Server `T_`+`Date.now()`+random (not derived from key) | New id every **execution** |

Middleware comment in `/api/bets/place`: idempotency is middleware + RPC unique constraint — no second preflight.

---

## Failure modes (duplicate tickets)

| ID | Scenario | Duplicate? | Severity |
|----|----------|------------|----------|
| **A** | `_pbFetch` checks `_MONEY_ENDPOINTS.has(absoluteUrl)` → never matches `/api/bets/place` → header inject + `_pendingIdemKeys` dead; only body key used | Double-click relies on busy flag only | **P1** (mitigated) |
| **B** | Place succeeds server-side; FE 10s timeout / network error; user retries → **new** second → **new** `BET_…` key → second `place_bet_tx` | **YES** | **P0** |
| **C** | Two concurrent requests, same key, race in `_idemCheck` load-then-save before DB row visible | Usually **NO** (ledger UNIQUE); rare mem-store split-brain | **P1** |
| **D** | Key expired (24h) then reused with same key | Middleware re-executes; new `ticket_id` | **P1** |
| **E** | Two distinct bets same player same second → same key → second is **replay** of first | Wrong UX / lost second bet | **P1** |
| **F** | Odds-changed accept appends `_oa` | Intentional new key / new ticket | Expected |
| **G** | RR path: one group idempotency key for RPC; combo ticket ids still random | Same as B if group key changes on retry | **P0** if B |

---

## Design proposal (do not apply until owner sign-off)

### Principles

1. **Client key** is required and opaque (`uuid` / 128-bit).
2. **Uniqueness scope:** `(club_id, player_id, client_key)` — never global bare key across clubs.
3. **Replay:** same scope + same body hash → return original `ticket_id` / `group_id` + balances (200).
4. **Conflict:** same key, different body hash → 409 `idempotency_conflict` (no second ticket).
5. **Ticket id:** derive deterministically from scope, e.g. `T_` + first 26 hex of `sha256(club|player|client_key)`, so RPC insert + ON CONFLICT is content-addressed.
6. **Uncertain FE retry:** keep the **same** client key until success or definitive business rejection (insufficient_balance, risk codes). Clear key only then.

### FE changes (safe, non-SQL — partial can ship early)

1. Fix `_pbFetch`: match `_MONEY_ENDPOINTS` on **`path`**, not absolute URL; prefer `body.idempotencyKey` for header so middleware and RPC share one key; key `_pendingIdemKeys` by `path`.
2. Hold `_pendingPlaceIdemKey` across timeout/uncertain retries for the open confirm; clear on success / hard reject.
3. Replace second-precision `BET_pid_time` with `_generateIdemKey('BET')` (or `crypto.randomUUID()`).

### BE changes (migration required — **DO NOT APPLY** in this package)

```sql
-- PROPOSED ONLY — not applied
-- 1) Ensure idempotency_keys exists (DDL already embedded in index.js as IDEMPOTENCY_TABLE_DDL)
CREATE TABLE IF NOT EXISTS idempotency_keys ( ... );

-- 2) Optional stronger placement uniqueness (prefer ticket id = hash of key)
-- ALTER TABLE tickets ADD COLUMN IF NOT EXISTS client_idempotency_key text;
-- CREATE UNIQUE INDEX IF NOT EXISTS tickets_club_player_client_idem_uidx
--   ON tickets (club_id, player_id, client_idempotency_key)
--   WHERE client_idempotency_key IS NOT NULL;

-- 3) place_bet_tx: keep ledger_entries.id = p_idempotency_key;
--    set p_ticket_id from deterministic hash of (club, player, key) in app or RPC.
```

Also: treat expired keys as **replay-if-ledger-exists** else reject with `idempotency_key_expired` (do not silently re-execute money).

Middleware race: use `INSERT … ON CONFLICT` / advisory lock instead of load-then-save.

### Header vs body

**Canonical rule:** one key. Prefer `Idempotency-Key` header; body must match if both present; mismatch → 400. Today header wins when set, body used by RPC — dual keys must never diverge.

---

## Test plan (automated + manual)

| # | Test | Expect |
|---|------|--------|
| T1 | Two POSTs same key+body concurrent | One ticket; second `idempotent:true` or replay |
| T2 | Same key, mutated stake | 409 conflict; one ticket |
| T3 | FE timeout then retry **same** key | One ticket; second replay |
| T4 | FE timeout then retry **new** key (current prod) | **Two tickets** — documents Gap B until FE fix |
| T5 | Double-click confirm | One request / one ticket |
| T6 | Odds-accept `_oa` | Second ticket allowed (new odds intent) |
| T7 | Cross-club same bare key | No collision after club-scoped uniqueness |
| T8 | Key TTL expiry with existing ledger | Replay ticket; no new debit |

Unit anchors: `tests/idempotency.test.js`, `tests/bet-placement.test.js`, BE `tests/place-bet-contract.test.js`.

---

## Migration gate

| Artifact | Status |
|----------|--------|
| `IDEMPOTENCY_TABLE_DDL` in `index.js` | Reference only — confirm applied in prod before relying on DB store |
| Ticket `client_idempotency_key` unique index | **Proposed — not applied** |
| `place_bet_tx` changes | **Owner approval required** |

---

## Owner checklist

- [ ] Ship FE path+body key alignment + sticky uncertain-retry key (no SQL)
- [ ] Confirm `idempotency_keys` present in prod Supabase
- [ ] Approve deterministic ticket id + optional unique index
- [ ] Add T1–T8 to CI
- [ ] Retire/supersede `BET_DOUBLE_CLICK_AUDIT.md` verdict after FE fix lands
