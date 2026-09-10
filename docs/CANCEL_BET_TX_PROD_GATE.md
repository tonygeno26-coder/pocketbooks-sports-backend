# CANCEL_BET_TX — Production Isolation Gate (READ-ONLY PREP)

**Status:** `CANCEL ISOLATION PROD GATE READY`  
**Branch:** `cursor/cancel-isolation-prod-gate` (@ `c0958d4`; docs alias also on `cursor/pre-beta-idempotency-docs`)  
**Alias doc:** [`docs/CANCEL_ISOLATION_PROD_GATE.md`](./CANCEL_ISOLATION_PROD_GATE.md)  
**Supabase project:** `padgicwrrzmukahfsyhk`  
**Precheck date:** 2026-09-09 (inventory rechecked same day)  
**PRODUCTION DATA TOUCHED:** **NO** (this package does not apply)  
**Settlement:** **OFF**  
**SAFE TO REQUEST OWNER APPLY:** **YES** (function replace only; no row backfill)

---

## STATUS: CANCEL ISOLATION PROD GATE READY

### CURRENT FUNCTION

Live prod (`padgicwrrzmukahfsyhk`) still has the **soft-club + phantom $1000** body  
(re-verified read-only: `has_soft_club=true`, `mentions_1000=true`, `has_hard_member_reject=false`):

| Marker | Live value |
|---|---|
| Signature | `cancel_bet_tx(text,text,text,text,text,text)` |
| Soft club | `v_effective_club_id := coalesce(nullif(p_club_id,''), v_ticket.club_id)` |
| Soft member OR | `(v_effective_club_id IS NULL OR club_id = v_effective_club_id)` |
| Phantom1000 | `SELECT coalesce(balance_start, 1000)` + `IF NOT FOUND THEN v_start_balance := 1000` |
| Ticket UPDATE | `WHERE id = p_ticket_id` only (no club/player predicate) |
| Grants | `EXECUTE` → `service_role`, `postgres` |
| Triggers on tickets/club_members/ledger_entries | **none** cancel-specific |

Exact restore body: `migrations/ROLLBACK_cancel_bet_tx_club_isolation.sql`  
(captured via `pg_get_functiondef` on 2026-09-09).

### RISK

| Risk | Severity | Mitigated by proposed? |
|---|---|---|
| Cancel with missing `club_members` invents **$1000** presentation bankroll | **P0** | Yes — `no_club_member_balance_found` |
| Soft club OR allows cross-club member/ticket aggregate bleed | **P0** | Yes — hard `club_id = p_club_id` |
| Empty `p_club_id` falls back to ticket club / NULL effective club | **P0** | Yes — `missing_club_id` |
| Settled ticket incorrectly refunded | High | Yes — `invalid_transition` (active/open only) |
| Double-refund on already-canceled (new key) | Medium | Yes — idempotent `already_canceled`, refund 0 |
| Apply-time data mutation | Low | N/A — `CREATE OR REPLACE FUNCTION` only |
| Lock contention during apply | Low | Catalog lock on function replace; ms-scale |

### SQL

Apply file (owner only, after backup):

- **`migrations/PROPOSED_cancel_bet_tx_club_isolation.sql`**

Guarantees:

1. Scope = **`club_id + player_id + ticket_id`**
2. Missing membership → reject (never `$1000`)
3. Wrong club / wrong player / missing ticket → reject
4. Already canceled/voided → safe idempotent (no second refund)
5. Settled → reject (no incorrect refund)
6. Ledger + ticket UPDATE hard-scoped to requested club/player
7. Refund math unchanged: `refund = round(risk_amount, 2)`

### ROLLBACK

- **`migrations/ROLLBACK_cancel_bet_tx_club_isolation.sql`** — restores exact pre-gate prod body (includes phantom1000; only use to undo).
- Also re-capture before apply:
  ```sql
  SELECT pg_get_functiondef(
    'public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure
  );
  ```

### PRECHECK

Read-only queries: `migrations/CANCEL_BET_TX_PRECHECK_READONLY.sql`

**Captured results (2026-09-09 morning → same-day recheck):**

| Check | Morning | Recheck |
|---|---|---|
| Active/open tickets | **0** | **2** (membership present) |
| Canceled/voided | **27** | **27** |
| Settled-like (won/lost/push) | **37** | **37** |
| Total tickets | **64** | **66** |
| Active tickets missing `club_members` | **0** | **0** |
| Any-status tickets missing membership | **11** | **14** (non-active smoke/legacy) |
| NULL `tickets.club_id` | **3** (all already canceled; 0 active) | **3** |
| NULL `tickets.player_id` | **0** | **0** |
| `bet_canceled` ledger NULL club | **3** (known smoke voids; see `docs/NULL_CLUB_LEDGER_AUDIT.md` on settlement branch) | unchanged expectation |
| `bet_canceled` amount = 1000 | **0** | not re-scanned; prior = 0 |
| `club_members.balance_start IS NULL` | **0** | not blocking |
| Dependent triggers | **none** | unchanged expectation |

### DATA ANOMALIES

| Anomaly | Count | Impact on apply |
|---|---|---|
| Historical tickets without matching `club_members` | 14 (recheck) | **None for apply** — non-active; future cancel would correctly reject `no_club_member_balance_found` |
| NULL-club canceled tickets | 3 | Future cancel attempts with a real club id → `ticket_club_mismatch` (correct). Do not backfill in this gate. |
| NULL-club cancel ledger rows | 3 | Historical only; club-eq reads exclude them |
| Active orphans | **0** (2 actives both have members) | Gate can apply without blocking cleanup |

**No row remediation required before function replace.**

### CALL SITES (read-only inventory)

**Backend** (`pocketbooks-sports-backend`):

| Site | Path |
|---|---|
| Primary API | `POST /api/bets/cancel` → `_callMoneyRpc('cancel_bet_tx', { p_ticket_id, p_club_id, p_player_id, ... })` |
| Place compensation | ticket_legs insert fail / HAB fail / RR compensate — same RPC with derived idempotency keys |
| Ops script | `scripts/cleanup-orphan-tickets.js` → `sb.rpc('cancel_bet_tx', …)` |

BE already pre-checks: wrong club → 403; already canceled → JSON idempotent; settled → 400. After apply, RPC enforces the same hard rules even if a caller bypasses the HTTP layer.

**Frontend** (`pocketbooks-sports`, call sites only):

| Site | Path |
|---|---|
| Player cancel | `player.html` → `POST /api/bets/cancel` with `ticketId`, `playerId`, `clubId`, `idempotencyKey` |
| Host cancel | `index.html` → `POST /api/bets/cancel` (permission-gated `cancelBet`) |

FE never calls the RPC directly.

### TEST PLAN

Designated test accounts **only**. Template: `migrations/CANCEL_BET_TX_TEST_QUERIES.sql`

| # | Case | Expect |
|---|---|---|
| 1 | Correct club + player + active ticket + valid membership | `ok=true`, `refund=risk_amount`, ticket → `canceled`, one `bet_canceled` ledger |
| 2 | Wrong club | `ticket_club_mismatch`; no ticket/ledger change; other club bankroll unchanged |
| 3 | Wrong player | `ticket_player_mismatch`; no mutation |
| 4 | Missing `club_members` | `no_club_member_balance_found`; **no phantom $1000** in response or ledger |
| 5 | Nonexistent ticket | `ticket_not_found` |
| 6 | Already canceled (new key) | `ok=true`, `idempotent=true`, `refund=0`, no new ledger |
| 7 | Settled (won/lost/push) | `invalid_transition`; no refund |
| 8 | Same idempotency key replay | `ok=true`, `idempotent=true`, single ledger row |
| 9 | Cross-club proof | After rejected wrong-club call, Club A open risk + member row unchanged |

Post-apply SELECT checks: `migrations/CANCEL_BET_TX_POST_VERIFY.sql`

### EXPECTED DOWNTIME / LOCK

| Item | Expectation |
|---|---|
| Downtime | **None** (no table rewrite) |
| Lock | Brief `ACCESS EXCLUSIVE` on the function catalog object during `CREATE OR REPLACE FUNCTION` |
| Runtime | **&lt; 1 second** typical |
| Concurrent cancels | In-flight RPC uses old or new body atomically per call; no mixed body mid-statement |
| Backup | Save `pg_get_functiondef` output + keep `ROLLBACK_*.sql` handy before apply |

### BACKUP / RECOVERY REQUIREMENTS

1. Before apply: run `pg_get_functiondef` and store in ops notes / ticket.
2. Keep `migrations/ROLLBACK_cancel_bet_tx_club_isolation.sql` ready.
3. Optional: `pg_dump --schema-only` for `public` functions (defense in depth).
4. No table backup required for this gate (no DML at migrate time).
5. If post-apply tests fail: apply ROLLBACK SQL immediately; re-verify soft markers return (documents intentional regression of phantom path).

### SAFE TO REQUEST OWNER APPLY

**YES**

Conditions:

- Owner applies **only** `PROPOSED_cancel_bet_tx_club_isolation.sql`
- Backup `pg_get_functiondef` taken first
- Designated-account test plan executed after
- No ordinary-user destructive cancels
- No ledger/ticket backfill in this change

### PRODUCTION DATA TOUCHED

**NO** (prep branch / docs / SQL files only; this document’s precheck was SELECT-only)

---

## Package file index

| File | Role |
|---|---|
| `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql` | Apply SQL |
| `migrations/ROLLBACK_cancel_bet_tx_club_isolation.sql` | Rollback to pre-gate prod |
| `migrations/CANCEL_BET_TX_PRECHECK_READONLY.sql` | Re-runnable read precheck |
| `migrations/CANCEL_BET_TX_POST_VERIFY.sql` | Post-apply verification |
| `migrations/CANCEL_BET_TX_TEST_QUERIES.sql` | Designated-account matrix |
| `docs/CANCEL_BET_TX_PROD_GATE.md` | This owner package |
| `docs/CANCEL_ISOLATION_PROD_GATE.md` | Alias / verify-workflow entrypoint |

---

## Proof matrix (proposed SQL guarantees)

| Scenario | Result |
|---|---|
| Correct player + club + ticket | Allowed; refund = risk |
| Wrong club | `ticket_club_mismatch` |
| Wrong player | `ticket_player_mismatch` |
| Nonexistent membership | `no_club_member_balance_found` |
| Nonexistent ticket | `ticket_not_found` |
| Already-canceled ticket | Idempotent / safe (`already_canceled`) |
| Settled ticket | `invalid_transition` (no refund) |
| Phantom `$1000` | Impossible (no coalesce/assign 1000) |
| Cross-club balance mutation | Impossible (member + aggregate + UPDATE hard-scoped) |
