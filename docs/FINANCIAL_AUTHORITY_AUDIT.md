# Financial Authority Audit

**Date:** 2026-09-09  
**FE:** `pocketbooks-sports` / branch `cursor/away-financial-audits`  
**BE:** `pocketbooks-sports-backend` (read-only for money SQL)  
**Related:** `docs/CLIENT_TRUST_BOUNDARY_AUDIT.md`, `docs/BET_PLACEMENT_IDEMPOTENCY.md`  
**Constraint:** No production financial SQL/migrations. Settlement recording stays gated OFF. Safe FE fail-closed only.

---

## Classification key

| Class | Meaning |
|-------|---------|
| **SAFE UI** | Display/cache only; cannot invent bankroll/tickets when DB-primary is on |
| **TEST ONLY** | Tests, fixtures, `?testUser` / `?preview=1` / `test-dashboard.html` |
| **DEAD** | Code path that never runs in production (broken match, unreachable) |
| **P1** | Misleading display, dual SoT drift, or non-money leakage — fix soon |
| **P0** | Browser or soft server path can create/mutate authoritative money incorrectly |

---

## Executive summary

DB-primary + phantom-ledger fail-closed on the trust stack removed the worst **client invents ticket/ledger success** paths. Residual **P0**s are mostly **server soft club / phantom $1000 on cancel** (see club isolation doc) and **placement retry with a new idempotency key**. Remaining FE `|| 1000` / `pb-balance-start` usages are **SAFE UI** or **TEST ONLY** when display is fail-closed and placement refuses local authority.

---

## Search results

### localStorage / sessionStorage (financial-adjacent)

| Location | Pattern | Class | Notes |
|----------|---------|-------|-------|
| `player.html` `pb-tickets` / `pb-ledger` / `pb-balance-start` | Cache + legacy offline | **SAFE UI** under DB-primary for display; writes after failed place/cancel **blocked** (P0 fixed) | Confirm path returns on API failure |
| `player.html` `_BASE_BALANCE = 1000` + `_getStartingBalance()` | Default / migrate | **P1** residual for legacy offline; **SAFE UI** when `_liveAvailableBalance` returns NaN / `—` under DB-primary | Do not use for signed-in display |
| `player.html` boot signed-in skip local flash | Fail-closed | **SAFE UI** | Trust-stack P0.5 |
| `player.html` `?testUser` / `_installDevSession` sets `pb-balance-start` = 1000 | Dev seed | **TEST ONLY** | |
| `index.html` `pb-balance-start:<pid>`, settlements, diamonds caches | Host UI cache | **SAFE UI** / **P1** if shown as SoT without `balanceSource` | Host dashboard prefers API |
| `index.html` `adminCreditPurchase` local diamond credit | Local diamond ledger | **P1** if treated as prod diamond SoT — diamonds have separate host APIs | |
| `sessionStorage` `pb-nav-ui`, `pb-force-lobby-home` | Nav only | **SAFE UI** | Nav tests assert no financial LS writes |
| `team-logos.js` / `player-photos.js` LS caches | Media TTL | **SAFE UI** | |
| `collabhub` theme/lang LS | Unrelated product | **SAFE UI** / out of scope | |
| `diamonds.js` token + JSON helpers | Reads tokens | **SAFE UI** | |

### `|| 1000` / `?? 1000` / defaultBalance / mockBalance / fakeBalance

| Location | Class | Notes |
|----------|-------|-------|
| `player.html` `_BASE_BALANCE` / `_getStartingBalance` fallback | **P1** offline / **SAFE UI** DB-primary display | |
| `tests/*.test.js` many `\|\|1000` | **TEST ONLY** | |
| `index.html` `cc-maxparlay` default 1000 | **SAFE UI** | Risk limit form default, not bankroll |
| BE `place_bet_tx` historical `COALESCE(balance_start,1000)` | Fixed in v2 migration for place | Prod place path rejects missing member |
| BE **live** `cancel_bet_tx` `coalesce(balance_start, 1000)` | **P0** | Soft club + phantom 1000 — see `CLUB_ISOLATION_AUDIT.md`; PROPOSED fix **not applied** |
| BE `grade_ticket_tx` older migrations with coalesce 1000 | Superseded by club-isolation / balance-fix migrations if applied | Verify prod function body separately |

### Optimistic balance / ticket / cancel

| Location | Class | Notes |
|----------|-------|-------|
| `confirmBet` success → `applyDisplayedBalance(balanceAfter)` | **SAFE UI** | Server field only |
| `confirmBet` failure → no local ticket/ledger | **SAFE UI** (was **P0**, fixed) | `phantom_ledger_fallback_blocked` |
| `submitDeleteRequest` cancel fail-closed | **SAFE UI** (was **P0**, fixed) | |
| Uncertain place toast “may or may not” | **SAFE UI** | Still **P0** if user retries with **new** key — idempotency doc Gap B |

### Ledger / settlement fallback

| Location | Class | Notes |
|----------|-------|-------|
| BE place precheck: ledger then tickets | **SAFE** server | Club-scoped |
| BE player/host dashboard: ledger preferred, tickets fallback | **SAFE** display | Null start → warn / null available |
| FE settlement preview / carry localStorage | **P1** / gated | Recording flag OFF |
| `SETTLEMENT_RECORDING_ENABLED` | Must stay **OFF** | **P0** if enabled without bootstrap |

### Client payout / winnings

| Location | Class | Notes |
|----------|-------|-------|
| Bet slip `calcPayout` / confirm modal payout | **SAFE UI** estimate | Server recalculates from snapshots; client payout ignored when snapshot ok |
| `potentialProfit` in place body | **P1** residual | Used only if server snapshot path did not set `serverProfit` |
| My Bets display of `estimatedPayout` | **SAFE UI** | Hydrated from dashboard tickets |
| Browser `_gradeTicket` under DB-primary | **SAFE** (delegates server grade) | Legacy local grade **TEST ONLY** when flag off |

---

## P0 register (financial authority)

| ID | Finding | Status |
|----|---------|--------|
| FA-P0-1 | Phantom local place/cancel success | **Fixed** on trust stack — keep regression `tests/phantom-ledger-fallback.test.js` |
| FA-P0-2 | Dashboard paint local/$1000 on fetch fail | **Fixed** P0.5 fail-closed `—` |
| FA-P0-3 | Placement uncertain → retry new idempotency key → two tickets | **Open** — design in `BET_PLACEMENT_IDEMPOTENCY.md`; FE sticky key fix shippable |
| FA-P0-4 | Prod `cancel_bet_tx` phantom $1000 + soft club | **Open** — PROPOSED package prepared; **do not apply** here |
| FA-P0-5 | Settlement recording without owner bootstrap | **Gated OFF** — keep off |

---

## P1 register

| ID | Finding |
|----|---------|
| FA-P1-1 | `_pbFetch` money-endpoint match uses absolute URL → Idempotency-Key auto-inject **DEAD** |
| FA-P1-2 | Dual SoT: display ledger last vs place RPC ticket formula (ignores some adjustments) |
| FA-P1-3 | Host/local diamond credit helpers vs server diamond ledger |
| FA-P1-4 | Client `potentialProfit` fallback if snapshot recalc skipped |
| FA-P1-5 | Mirror ingest routes optional club filters (not player money UX, but dangerous if exposed) |

---

## Safe FE fixes on this branch

1. **Idempotency `_pbFetch`:** match money endpoints on `path`; prefer body `idempotencyKey` for header; store pending keys by `path` (aligns middleware + RPC; restores double-submit key reuse).
2. **Sticky place key:** reuse `_pendingPlaceIdemKey` across uncertain retries until success or hard reject.

No production SQL. No settlement enablement.

---

## Owner checklist

- [ ] Keep settlement recording OFF
- [ ] Do not apply cancel isolation SQL until explicit owner gate
- [ ] Land FE sticky idempotency key + path fix
- [ ] Re-verify prod `cancel_bet_tx` / `place_bet_tx` function bodies for coalesce-1000
