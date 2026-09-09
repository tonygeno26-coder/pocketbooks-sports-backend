# Settlement Option A — redesign (ready for review)

**Branch:** `cursor/settlement-option-a`  
**Date:** 2026-09-09  
**Supabase:** READ ONLY during this work — **no migrations applied**, **no prod money mutations**

## Product meaning (critical)

PocketBooks does **NOT** process settlement money. No cash/crypto/bank/card flows through the app.
The host **records** that an **off-platform** settlement occurred; PocketBooks only updates **ledger position** toward zero.

Example: Player owes $500 → pays host $200 outside → host records $200 settled → ledger shows owes $300. PocketBooks never handled the $200.

| PocketBooks ONLY | PocketBooks NEVER |
|---|---|
| Calculate ledger position from wager results | Initiate / receive / send / hold funds |
| Carry unresolved (outstanding) | Store payment credentials or payment rails |
| Host **record** external settlement | Claim to process settlement money |
| Reduce toward zero | Assume money moved just because UI was clicked |
| Audit / settlement history | |

## Bankroll vs settlement

| Concern | Source of truth | Settlement effect |
|---|---|---|
| Betting available / bankroll | `club_members.balance_start` + club-scoped tickets (`place`/`grade`/`cancel` RPCs) | **None** — settlement records do not rewrite tickets or `balance_start` |
| Host↔player ledger position (outstanding) | Derived settlement position (below) | Append-only `settlement_records` |

Product default confirmed: settlement tracks **recorded** off-platform amounts toward zero; it does **not** rewrite ticket-derived bankroll and does **not** move funds.

## Settlement / ledger position formula (player POV)

```
sign: − player owes host · + host owes player · 0 settled

settlementBalance =
  openingBalance                          # explicit bootstrap only (default 0)
  + ticketSettledNet(after historical epoch)
  + Σ confirmed player_paid_host (after epoch)   # amounts settled (recorded)
  − Σ confirmed host_paid_player (after epoch)

ticketSettledNet(after historical epoch) =
  Σ potential_profit(won) − Σ risk(lost)
  for tickets in (club_id, player_id) with grade time > epoch
  (each ticket counted exactly once)

record(amountSettled):
  reject if amount ≤ 0 or balance == 0
  reject if amount > |balance|   # never cross zero via recorded settlement
  newBalance = sign(balance) * max(|balance| − amount, 0)
```

- **Tickets counted once** via ticket net; settlement records never re-open ticket grades.  
- **Carry** survives weekly rollover (rollover must not write new `SETTLEMENT_APPLIED` epoch markers).  
- Historical rollover markers remain epoch floor (no resurrection of pre-cleared weeks).  
- Betting/ticket nets **may** cross zero; recorded settlements **may not**.

## Terminology (pre-production rename)

| Prefer | Avoid (user-facing) |
|---|---|
| Recorded Settlement, Settlement Record, Amount Settled, Record Settlement | Pay, Send Payment, Receive Payment, Cash Out, Process Payment |
| Outstanding, Ledger Position, Settlement History | |

| Internal (proposed) | Former (do not ship) |
|---|---|
| `settlement_records` | `settlement_payments` |
| `record_settlement_option_a_tx` | `settle_payment_option_a_tx` |
| `SETTLEMENT_RECORDING_ENABLED` | `SETTLEMENT_OPTION_A_CASH_ENABLED` |
| `over_settlement_blocked` | `overpay_blocked` |

## API (backend authoritative)

| Method | Path | Role |
|---|---|---|
| GET | `/api/host/settlements-preview?clubId=` | Preview ledger position (FE preview only) |
| POST | `/api/host/record-settlement` | Record settlement → `settlement_records` (idempotent, club-scoped) |
| POST | `/api/host/settle-player` | **Alias** of record-settlement (legacy path) |
| GET | `/api/host/settlement-records?clubId=&playerId=` | Settlement history |
| GET | `/api/host/settlement-payments?clubId=&playerId=` | **Alias** of settlement-records |
| POST | `/api/host/weekly-rollover` | Snapshot only; `carryPreserved: true` |

Record returns authoritative `balanceBefore` / `balanceAfter`. FE must reconcile to server.
Feature flag default **OFF**: `SETTLEMENT_RECORDING_ENABLED` must equal exact string `true`.

**Removed hard dependency:** `settle_player_tx` (absent in prod). If `settlement_records` table missing → `503 settlement_records_missing` (do not invent RPC).

## Proposed DB

1. `migrations/PROPOSED_settlement_records.sql` — minimal append-only table + rollback  
2. `migrations/PROPOSED_settlement_opening_balances.sql` — explicit opening primitive  
3. `migrations/PROPOSED_record_settlement_option_a_tx.sql` — advisory-lock serialized record  
4. `migrations/PROPOSED_bootstrap_settlement_opening_epoch.sql` — nonprod/approved bootstrap  
5. `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql` — hard club lock + remove phantom `$1000`  
6. ~~`PROPOSED_settle_player_tx_club_scope.sql`~~ — **deleted** (Option A)  
7. ~~`PROPOSED_settlement_payments.sql` / `PROPOSED_settle_payment_option_a_tx.sql`~~ — **renamed** before production schema

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
