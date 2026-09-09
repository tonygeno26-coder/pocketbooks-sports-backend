# STATUS: SETTLEMENT FINAL NON-PROD GATE

**Date:** 2026-09-09  
**Branch:** `cursor/settlement-option-a`  
**Production Supabase `padgicwrrzmukahfsyhk`:** NOT touched

---

```
STATUS: SETTLEMENT FINAL NON-PROD GATE
BRANCHES: BE `48c89f6` on cursor/settlement-option-a · FE `46da895` on cursor/settlement-option-a
ADVISORY LOCK: YES — pg_advisory_xact_lock(key1,key2) inside record_settlement_option_a_tx (one txn)
LOCK KEY: md5('settle_v1|'||club_id||'|'||player_id) → two signed int4 (lib/settlement-lock.js ↔ SQL settlement_lock_keys). Scope=club_id+player_id NOT global. Different players concurrent; same player×different clubs independent.
CONCURRENT OVERPAY: −500 + concurrent 400+400 → one payment / final −100 (never +300 / never $600). Sequential 200+200 → −100. −500+600 rejected.
IDEMPOTENCY: Same Idempotency-Key concurrent → one payment row + one executed / one idempotent replay. Cross-club same client key independent (SETTLE_DIRECT_{club}_{key}).
LOCK TIMEOUT: Default 3000ms (SETTLEMENT_LOCK_TIMEOUT_MS). Failed acquire → error lock_timeout, HTTP 409, retry{backoffMs:250,maxAttempts:3}, NO payment row / NO partial mutation.
BOOTSTRAP MODEL: Explicit T0 epoch marker + settlement_opening_balances (NOT lifetime-as-debt, NOT fake tickets).
T0 RULE: gradeMs <= T0 excluded (at-boundary = before); gradeMs > T0 included. Deterministic T0 timestamptz.
OPENING BALANCE PRIMITIVE: settlement_opening_balances.opening_balance (signed player POV) + SETTLEMENT_APPLIED_BOOTSTRAP_* ledger epoch marker (reason weekly_rollover:bootstrap_epoch…).
CROSS-CLUB BOOTSTRAP: Independent per (club_id, player_id); Club A −500 does not affect Club B +300.
BOOTSTRAP IDEMPOTENCY: UNIQUE(club_id,player_id) + stable bootstrap/epoch ids → replay idempotent:true.
REHEARSAL RESULTS: 29/29 passed on pb_settlement_nonprod (LAST_REHEARSAL.json). Concurrent 400+400→−100; same-key idempotent; lock_timeout no row; T0 hist excluded / −500+50→−450; Club B +300; ambiguous→needs_human_review; prod bootstrap blocked.
AMBIGUOUS PROD ACCOUNTS: lifetime |net|≥100 with opening 0 and no rationale → needs_human_review (no silent bootstrap).
TEST TOTAL: 246 (BE settlement harness 81 + nonprod apply 11 + rehearsal 29 + FE settlement 125). Prior baseline 88 ⊆ this set.
PRODUCTION DATA TOUCHED: NO
PRODUCTION MIGRATION: NO
MERGED: NO
SAFE FOR STAGED PRODUCTION MIGRATION: YES (code+nonprod green; still requires explicit human approval + runbook below — do NOT auto-apply)
REMAINING BLOCKERS:
  1) Human sign-off on per-club opening balances / ambiguous accounts
  2) Explicit approval to apply proposed SQL to a staging project (not prod) then prod
  3) Feature-flag / UI enable after migrate
EXACT PRODUCTION RUNBOOK:
  0. Freeze openings spreadsheet; resolve needs_human_review rows.
  1. Deploy BE/FE from this branch (no DB migrate yet).
  2. Backup: pg_dump settlement-relevant schema; save pg_get_functiondef for cancel_bet_tx.
  3. Apply in order (staging first): 
     PROPOSED_settlement_records.sql →
     PROPOSED_settlement_opening_balances.sql →
     PROPOSED_record_settlement_option_a_tx.sql →
     PROPOSED_bootstrap_settlement_opening_epoch.sql →
     PROPOSED_cancel_bet_tx_club_isolation.sql
  4. Rehearse bootstrap on staging clone with real anonymized balances; verify audit report.
  5. On prod (separate approval): apply same SQL order; run bootstrap ONLY for signed clubs/players; never lifetime-default.
  6. Smoke: one settle serialized; concurrent over-settlement blocked; bankroll unchanged.
  7. Enable host settle UI.
  ROLLBACK: drop new functions/tables by documented ROLLBACK comments; restore cancel_bet_tx body; do not delete historical ledger markers casually.
```

---

## Formula (authoritative)

```
settlementBalance = openingBalance
                  + ticketSettledNet(after epoch)
                  + playerPaidHost
                  − hostPaidPlayer
```

Toward zero only; reject over-settlement; settle never mutates `balance_start` / tickets.

## Transaction order (record_settlement_option_a_tx)

1. Acquire `pg_advisory_xact_lock(key1,key2)` with `SET LOCAL lock_timeout`
2. Recompute position
3. Validate payment
4. Reject over-settlement / zero / direction mismatch
5. Insert `settlement_records`
6. Return authoritative before/after
7. Commit (end of xact)

## Non-prod evidence

- Apply: `node fixtures/nonprod/apply_and_test.js` → `LAST_APPLY.json`
- Rehearsal: `node fixtures/nonprod/concurrency_and_bootstrap_rehearsal.js` → `LAST_REHEARSAL.json`
- Unit: `settlement-carry`, `settlement-cross-club`, `settlement-option-a-validation`, `settlement-final-gate`, cancel matrix, jest suite
