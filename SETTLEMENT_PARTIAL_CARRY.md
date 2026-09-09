# Settlement Partial Carry — Audit & Implementation

**Date:** 2026-09-08  
**Branch:** `cursor/settlement-partial-carry`  
**Club fixture (tests only):** `d616dc2a-95a6-473a-97b1-7da330878479`  
**Supabase project:** `padgicwrrzmukahfsyhk` — READ-ONLY during audit; no production balance/ledger mutations

---

## 1. Current flow discovered (pre-change)

```
tickets (won/lost)
    ↓ cutoff filter (_loadSettlementCutoffs)
settlements-preview → owesHost / hostOwes / currentBalance(bankroll)
    ↓
Host Settlements UI → openSettlePlayerModal
    ↓
POST /api/host/settle-player
    → settle_player_tx (canonical ledger SETTLEMENT_APPLIED debit/credit)
    → settlement_payments (confirmed)
    → ledger_entries type=settlement (mirror)
    → audit_events settlement_executed
    ↓
POST /api/host/weekly-rollover
    → weekly_rollovers + weekly_player_snapshots
    → weekly_rollover_tx (neutral WEEKLY_ROLLOVER)
    → ledger_entries SETTLEMENT_APPLIED_*  ← AUTO-ZEROED next preview via cutoff
```

### Storage vs derived
| Concept | Source | Notes |
|---|---|---|
| Betting bankroll | `club_members.balance_start` + `ledger` / `ledger_entries` | Players tab / bet gate |
| Credit limit | `club_members.balance_start` via player-credit | Distinct from settlement cash |
| Settlement owed (old) | Derived: ticket nets after cutoff | Cutoff treated rollover ≈ settled |
| Prior payments | `settlement_payments` status=confirmed | Used in settle-player max, not always in preview |

### Old formulas
```
preview.settledNet = Σ won profit − Σ lost risk   (tickets after last settlement/rollover cutoff)
preview.owesHost / hostOwes = split(|settledNet|)
preview.currentBalance = ledger bankroll

settle-player max = all-time ticket net − prior payments in direction
  (INCONSISTENT with preview cutoff)

rollover → writes SETTLEMENT_APPLIED cutoff → next week preview excludes prior tickets
  (End of week acted like settlement — WRONG for carry model)
```

### settle-player (old)
- Required direction + amount > 0
- Overpay rejected vs max remaining
- Assumed partial via payment subtraction, but preview cutoff after any settlement zeroed display
- Idempotency via `requireIdempotency` + `settle_player_tx` settlement_id

### Conflict (would require historical reconstruction if naively fixed)
Switching cutoffs off entirely would **resurrect** unpaid weeks previously cleared by rollover `SETTLEMENT_APPLIED_*` markers.

**Resolution (forward-safe, no rewrite history):**
- Keep historical rollover `SETTLEMENT_APPLIED_*` / `weekly_rollover` ledger markers as epoch floor
- Stop writing new epoch markers on weekly rollover
- Cash settle adjusts via `settlement_payments` only (does not advance ticket epoch)
- Carry = `ticketNet(after epoch) + playerPaidHost − hostPaidPlayer`

---

## 2. New authoritative formula

**Sign (player POV):** − player owes host · + host owes player · 0 settled

```
settlementBalance = ticketSettledNet(after historical epoch)
                  + Σ confirmed player_paid_host (after epoch)
                  − Σ confirmed host_paid_player (after epoch)

apply(amount):
  if amount ≤ 0 → no-op
  if balance = 0 → reject
  if amount > |balance| → REJECT overpay_blocked (prefer reject over silent cap)
  newBalance = sign(balance) * max(|balance| − amount, 0)

week carry (betting may cross zero):
  next = priorCarried + newWeekNet
  (implemented by NOT clearing tickets on rollover; new tickets accumulate in ticketNet)
```

Starting credit (`balance_start`) remains **bankroll/credit**, not settlement carry.

---

## 3. UX choice: overpayment
**Reject** with `overpay_blocked` + max message (“Settlement cannot cross zero…”). Matches existing API pattern; FE mirrors the message.

---

## 4. Tables / routes / files

**DB tables:** `tickets`, `settlement_payments`, `ledger` (settle_player_tx), `ledger_entries` (mirror/audit), `weekly_rollovers`, `weekly_player_snapshots`, `audit_events`, `club_members`

**API:**  
`GET /api/host/settlements-preview` · `POST /api/host/settle-player` · `POST /api/host/weekly-rollover`

**BE:** `lib/settlement-carry.js`, `index.js`, `tests/settlement-carry.test.js`  
**FE:** `index.html`, `tests/settlement-partial-carry-ui.test.js`

**Migrations:** none applied. Proposed (not applied): `migrations/PROPOSED_settle_player_tx_club_scope.sql` — add `club_id` to RPC settlement_id idempotency lookup (app already prefixes `clubId::key`).

---

## 5. Cross-club isolation (MERGE BLOCKER)

**Invariant:** all financial state scoped by `club_id + player_id`.

### Unsafe queries found + fixed
| Location | Issue | Fix |
|---|---|---|
| `_ledgerAvailableForPlayer` | `club_id` optional | Require both; always `.eq(club_id).eq(player_id)` |
| `_creditPlayerAccount` ledger read | optional club | Require club; dual eq |
| `_deriveAvailableBalance` tickets | **player_id only** | Add `.eq('club_id', clubId)` |
| `_calcTotalPaid` | period+player, no club | Require clubId; refuse if missing |
| `requireIdempotency` storage | global key | Store as `clubId::clientKey` |
| settle-player settlement/payment ids | bare idempotencyKey | `clubId::key` / `SETTLE_DIRECT_${club}_${key}` |
| settle-player auth | no membership check | Reject `player_not_in_club` |
| settlements-preview / player dashboard tickets | optional club | Hard-require clubId |
| period payment | no period.club check | `period_club_mismatch` |

### DB constraints (existing)
- `club_members` / memberships: `UNIQUE(club_id, player_id)`
- canonical `ledger`: `UNIQUE(club_id, idempotency_key, event_type)`
- `idempotency_keys`: still PK on key alone — mitigated by club-prefixed storage key
- `settlement_payments.payment_id` PK — mitigated by club-prefixed payment_id

### Rollover proven (post-change)
- Does **NOT** write `SETTLEMENT_APPLIED` epoch markers
- Returns `carryPreserved: true`
- Snapshots outstanding carry; tickets continue to count post-rollover
- Historical `SETTLEMENT_APPLIED_*` markers still act as epoch floor (no resurrection)

---

## 6. Safety
- No production financial row mutations for debug
- No history rewrite; historical epoch markers retained
- No Diamonds/grading/tickets/odds/placement changes
- Dedicated branch only — do not merge to main without host review
- **Do not merge while origin/main still contains incomplete orphan commit `0fb6a6b` (lib/tests without index wiring) — revert that main commit separately**
