# Settlement Option A — redesign (ready for review)

**Branch:** `cursor/settlement-option-a`  
**Date:** 2026-09-08  
**Supabase:** READ ONLY during this work — **no migrations applied**, **no prod money mutations**

## Bankroll vs settlement

| Concern | Source of truth | Settlement effect |
|---|---|---|
| Betting available / bankroll | `club_members.balance_start` + club-scoped tickets (`place`/`grade`/`cancel` RPCs) | **None** — payments do not rewrite tickets or `balance_start` |
| Host↔player cash owed | Derived settlement position (below) | Append-only `settlement_payments` |

Product default confirmed: settlement tracks cash toward zero; it does **not** rewrite ticket-derived bankroll.

## Settlement position formula (player POV)

```
sign: − player owes host · + host owes player · 0 settled

settlementBalance =
  openingBalance                          # explicit bootstrap only (default 0)
  + ticketSettledNet(after historical epoch)
  + Σ confirmed player_paid_host (after epoch)
  − Σ confirmed host_paid_player (after epoch)

ticketSettledNet(after historical epoch) =
  Σ potential_profit(won) − Σ risk(lost)
  for tickets in (club_id, player_id) with grade time > epoch
  (each ticket counted exactly once)

apply(payment):
  reject if payment ≤ 0 or balance == 0
  reject if payment > |balance|   # never cross zero via payment
  newBalance = sign(balance) * max(|balance| − payment, 0)
```

- **Tickets counted once** via ticket net; payments never re-open ticket grades.  
- **Carry** survives weekly rollover (rollover must not write new `SETTLEMENT_APPLIED` epoch markers).  
- Historical rollover markers remain epoch floor (no resurrection of pre-cleared weeks).  
- Betting/ticket nets **may** cross zero; payments **may not**.

## API (backend authoritative)

| Method | Path | Role |
|---|---|---|
| GET | `/api/host/settlements-preview?clubId=` | Preview carry (FE preview only) |
| POST | `/api/host/settle-player` | Apply payment → `settlement_payments` (idempotent, club-scoped) |
| GET | `/api/host/settlement-payments?clubId=&playerId=` | Payment history |
| POST | `/api/host/weekly-rollover` | Snapshot only; `carryPreserved: true` |

Apply returns authoritative `balanceBefore` / `balanceAfter`. FE must reconcile to server.

**Removed hard dependency:** `settle_player_tx` (absent in prod). If `settlement_payments` table missing → `503 settlement_payments_missing` (do not invent RPC).

## Proposed DB

1. `migrations/PROPOSED_settlement_payments.sql` — minimal append-only table + rollback  
2. `migrations/PROPOSED_settlement_opening_balances.sql` — explicit opening primitive  
3. `migrations/PROPOSED_settle_payment_option_a_tx.sql` — advisory-lock serialized settle  
4. `migrations/PROPOSED_bootstrap_settlement_opening_epoch.sql` — nonprod/approved bootstrap  
5. `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql` — hard club lock + remove phantom `$1000`  
6. ~~`PROPOSED_settle_player_tx_club_scope.sql`~~ — **deleted** (Option A)

**Non-prod apply status:** proposed files applied to local Postgres fixture `pb_settlement_nonprod` via `fixtures/nonprod/apply_and_test.js` + `concurrency_and_bootstrap_rehearsal.js`. **Not** applied to production `padgicwrrzmukahfsyhk`.

Final gate: `docs/SETTLEMENT_FINAL_NONPROD_GATE.md`.

Formula:

```
settlementBalance = openingBalance + ticketSettledNet(after epoch) + playerPaid − hostPaid
```

## P0 club isolation (this branch)

- Financial helpers require `clubId`+`playerId`  
- Host dashboard / settlements-preview / player dashboard / reconciliation reject missing `clubId`  
- Idempotency keys stored as `clubId::clientKey`  
- Null-club ledger audit: `docs/NULL_CLUB_LEDGER_AUDIT.md` (no backfill)

## bdee035 reuse

**Kept:** carry formula, rollover non-zeroing, cross-club tests, club-scoped IDs, membership check, useful preview math.  
**Removed:** `settle_player_tx` await-before-commit, settle_player_tx proposed stub.
