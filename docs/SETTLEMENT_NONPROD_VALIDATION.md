# Settlement Option A — Non-Production Validation

**Branch:** `cursor/settlement-option-a`  
**Date:** 2026-09-08  
**Production Supabase `padgicwrrzmukahfsyhk`:** NOT touched · NO migrations · NO merges to main

Formula (authoritative):

```
settlementBalance = openingBalance + ticketSettledNet(after epoch) + playerPaid − hostPaid
```

Toward zero only; reject overpay; tickets may cross zero; settlement does **not** rewrite bankroll; `settlement_payments` is SoT for cash; bankroll = `balance_start` + tickets.
`openingBalance` comes only from explicit `settlement_opening_balances` bootstrap (default 0).

---

## 1. EPOCH — exact definition

### What “after epoch” means

| Dimension | Definition |
|---|---|
| **DB value** | Per-player cutoff timestamp (ms) = `max(created_at)` among **historical epoch markers** in `ledger_entries` for that `(club_id, player_id)`. Loaded by `_loadSettlementCutoffs`. |
| **Scope** | **Per club + player** (not account-wide, not club-global week alone). Same human in two clubs → two independent epochs. |
| **Week** | Not a calendar week by itself. Past **weekly rollover** wrote markers that act as the floor; **new** rollovers must **not** write markers (`carryPreserved: true`). |
| **Immutable?** | Historical markers are retained and never rewritten by Option A cash settle. New cash settle writes `settlement_payments` (+ optional audit `ledger_entries.type='settlement_payment'`) and must **not** create `SETTLEMENT_APPLIED_*` / `weekly_rollover` epoch markers. |
| **First launch / no markers** | `cutoffMs = 0` → **every** graded ticket for that club+player counts (lifetime net). **Never** treat “lifetime” as intentional without an explicit epoch (bootstrap or historical marker). |
| **Ticket inclusion** | Graded ticket enters net iff `gradeMs = Date(graded_at \|\| placed_at) > cutoffMs`. Boundary `gradeMs <= cutoffMs` is **excluded** (at-boundary = before epoch). |
| **Cancelled / void / push** | Statuses `canceled`, `voided`, `deleted`, `push`, `pushed` are **excluded** from ticketSettledNet and openRisk (cancel refund is bankroll, not settlement). |
| **Active / open** | Contribute to `openRisk` only; not to ticketSettledNet. |
| **Payments after epoch** | Confirmed `settlement_payments` with `confirmed_at \|\| created_at > cutoff` count toward `playerPaid` / `hostPaid`. |

### Marker recognition (`isHistoricalEpochMarker`)

Counts as epoch floor when:

- `type ∈ {weekly_rollover, WEEKLY_ROLLOVER}`, **or**
- `type ∈ {SETTLEMENT_APPLIED, settlement_applied}` **and** (`id` starts with `SETTLEMENT_APPLIED_` **or** `reason` starts with `weekly_rollover:`)

Cash settlement ledger rows (`settlement` / `settlement_payment` / non-rollover `SETTLEMENT_APPLIED`) do **not** advance epoch.

### Hard rule

**NEVER** derive settlement from arbitrary lifetime betting history unless epoch is explicitly established (historical marker present, or documented go-live bootstrap that writes a marker / opening payment).

---

## 2. GO-LIVE OPENING POSITION (document only — do not execute on prod)

Goal: existing players must not silently inherit unintended lifetime nets.

| Scenario | Intended opening | Safest bootstrap (doc only) |
|---|---|---|
| Lifetime ticket net ≈ −$12k, host does **not** want that as opening | Opening ≈ `$0` (or agreed amount) | At go-live `T0`, write one **historical epoch marker** per `(club_id, player_id)` with `created_at = T0` (same shape as legacy rollover `SETTLEMENT_APPLIED_*`). Pre-`T0` tickets drop out. Do **not** set opening = lifetime unless product explicitly chooses that. |
| +$300 unresolved graded after intended epoch | Enters as `ticketSettledNet = +300` | Ensure those tickets have `graded_at > T0` (or no marker and they are the only graded tickets you intend to count). |
| Already `$0` / fully settled historically | Stays `$0`; old tickets do not reappear | Epoch marker at/after last clear; no post-epoch graded tickets; no post-epoch payments. |
| Intentional carry-in of prior debt (e.g. −$500) | Opening = that amount | Prefer: epoch at `T0` **plus** one confirmed `settlement_payments` opening row **or** leave matching post-epoch tickets. Avoid mutating `balance_start` for settlement. |

### Safest bootstrap order (non-prod rehearsal → later prod)

1. Snapshot read-only: per club/player lifetime net, last epoch marker, open tickets.  
2. Product sign-off: opening = `$0` vs intentional carry.  
3. In a **transaction on non-prod first**: insert epoch markers at `T0` for all active members (or only clubs flipping on).  
4. Optionally insert opening `settlement_payments` if carry-in ≠ ticket residual after epoch.  
5. Verify preview: `$0` players stay `$0`; intentional residues match; bankroll unchanged.  
6. **Rollback plan:** delete go-live markers / opening payments by known id prefix; never delete historical pre-`T0` markers.

**Do not** equate `club_members.balance_start` with settlement opening.

---

## 3. SIGN CONVENTION (canonical — single source)

**Player POV (signed `settlementBalance`):**

| Sign | Meaning |
|---|---|
| **−** | Player owes host |
| **+** | Host owes player |
| **0** | Settled |

```
ticketSettledNet = Σ potential_profit(won) − Σ risk(lost)   // after epoch, once per ticket
playerPaid       = Σ confirmed player_paid_host             // after epoch
hostPaid         = Σ confirmed host_paid_player             // after epoch
settlementBalance = ticketSettledNet + playerPaid − hostPaid
```

Apply payment (toward zero only):

- Direction derived from sign: `−` → `player_paid_host`; `+` → `host_paid_player`
- Reject `amount ≤ 0`, balance already `0`, or `amount > |balance|` (`overpay_blocked`)

**Matrix:**

| Before | Pay | After | Direction |
|---|---|---|---|
| −500 | 200 | **−300** | player_paid_host |
| +500 | 200 | **+300** | host_paid_player |

**FE:** `owesHost = abs(balance)` when negative; `hostOwes = balance` when positive. Modal uses signed `settlementBalance` directly — **no sign inversion**.

---

## 4. CANCEL_BET_TX / PHANTOM1000 (P0)

Proposed: `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql`

| Check | Behavior |
|---|---|
| Valid club+player+ticket same relationship | Cancel OK; refund = `risk_amount`; status → `canceled` |
| Wrong club / wrong player | `ticket_club_mismatch` / `ticket_player_mismatch` |
| Missing `club_members` row | `no_club_member_balance_found` — **no phantom $1000** |
| Two clubs | Club B cancel cannot soft-OR into Club A member/tickets |
| Duplicate cancel / idempotent key | Replay `ok:true, idempotent:true` if same ticket+player+type |
| Already graded / cancelled | `invalid_transition` |
| Balance before/after | Presentation only: `balance_start − open − losses + gains`; then `+ refund`. **Cancel economics unchanged** (refund = risk). |

**PHANTOM1000:** live/prod soft path used `coalesce(balance_start,1000)` / `NOT FOUND → 1000`, inventing bankroll presentation when membership missing. Proposed SQL removes both.

---

## 5. NON-PROD MIGRATIONS

Apply **only** to isolated fixture DB (`fixtures/nonprod/`), never to `padgicwrrzmukahfsyhk`.

SQL applied (exact files):

1. `migrations/PROPOSED_settlement_payments.sql`
2. `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql`
3. Fixture schema bootstrap: `fixtures/nonprod/schema_minimal.sql`

Harness: `fixtures/nonprod/apply_and_test.js` (local Postgres) + JS sim fallback `fixtures/nonprod/cancel_bet_tx_sim.js`.

---

## 6. CONSTRAINT AUDIT

| Constraint | Status |
|---|---|
| `settlement_payments.direction` check | `player_paid_host` \| `host_paid_player` |
| `amount > 0`, `amount_cents > 0`, cents match amount | Yes |
| Unique `(club_id, ledger_settlement_id)` when set | Yes |
| Payment PK `payment_id` | Club-prefixed by API (`SETTLE_DIRECT_{club}_{key}`) |
| Settle never mutates `balance_start` / tickets | Yes (`bankrollMutated: false`) |
| Overpay / zero / direction mismatch | API 400 |

---

## 7. STALE PREVIEW / CONCURRENCY

- Backend **recomputes** authoritative `settlementBalance` inside `settle-player`; FE preview amount is not trusted as SoT.
- Stale FE preview −500 with actual −200 and pay 500 → `overpay_blocked` with `maxAmount: 200` (cap/reject against **−200**).
- FE does not send `balance_before` as authority; server returns `balanceBefore` / `balanceAfter`.
- **Remaining race (resolved on this branch):** serialize settle via `settle_payment_option_a_tx` + `pg_advisory_xact_lock(club,player)` with lock_timeout. See `docs/SETTLEMENT_FINAL_NONPROD_GATE.md`.

---

## 8. IDEMPOTENCY

- Client `Idempotency-Key` + body `idempotencyKey`; storage key `clubId::clientKey`.
- Payment id `SETTLE_DIRECT_{clubId}_{key}`; settlement id `{clubId}::{key}`.
- Replay of confirmed payment → `idempotent: true`, recomputed `balanceAfter`, no second economic effect.
- Cross-club: Club A key must not block Club B.

---

## 9. MULTI-CLUB

Independent carry per club. Settling Club A must not change Club B. Cancel hard-scoped by `club_id`. Preview/dashboard require `clubId`.

---

## 10. BANKROLL REGRESSION

Settlement path must not change:

- `club_members.balance_start`
- ticket rows (except cancel’s own status path)
- place/grade available-balance math (`balance_start + tickets`)

Asserted in tests + `bankrollMutated: false` on settle response.

---

## 11. GO-LIVE PLAN (document only — do not execute)

| Stage | Action | Rollback |
|---|---|---|
| **0** | Freeze product sign-off on epoch + openings | N/A |
| **1** | Deploy BE/FE code (feature branch → release) **without** DB migrate | Revert deploy |
| **2** | Apply `settlement_payments` on prod (additive) | `DROP TABLE settlement_payments` (if unused) |
| **3** | Apply `cancel_bet_tx` isolation (replace function; keep backup `pg_get_functiondef`) | Restore prior function body |
| **4** | Bootstrap epoch markers / opening payments per §2 | Delete bootstrap ids by prefix |
| **5** | Enable host settle UI; smoke one club | Disable UI; void mistaken payments |
| **6** | Monitor overpay / missing-table / cancel errors | Hotfix / function restore |

**Never:** merge-main casually; migrate without backup; use lifetime net as opening without sign-off; rewrite bankroll via settlement.

---

## Production safety gates

- `PRODUCTION DATA TOUCHED: NO` (this validation)
- `PRODUCTION MIGRATION: NO`
- Final gate + remaining blockers: `docs/SETTLEMENT_FINAL_NONPROD_GATE.md`
