# BETA RELEASE CHECKLIST — FINAL CORE / IDEMPOTENCY CUTOVER

**Date:** 2026-09-10  
**Settlement recording:** OFF  
**SGP pricing:** OFF  

Use only: `PASS` | `FAIL` | `BLOCKED` | `NOT TESTED` | `NOT RUN`

| Gate | Result | Notes |
|------|--------|-------|
| Prod table `idempotency_keys` present | PASS | Migration `20260910073233` / `idempotency_keys_scoped` |
| Schema match Path A `(club_id,player_id,client_key)` PK | PASS | + expires_at index + status CHECK |
| Railway BE tip `91ebca0` pre-fix | PASS | Health `gitSha` matched before cutover fix deploy |
| Idempotency remediation integrated on main lineage | PASS | `40e7f1f` ancestor of main |
| Correlation reject → no completed row to nonexistent ticket | PASS | Unit + middleware; code fix omits phantom ticket_id on non-2xx |
| Concurrent 2x / 10x (ticket delta=1) | PASS | `tests/idempotency-remediation.test.js` |
| Exact retry same key | PASS | Unit matrix |
| Changed request same key → conflict | PASS | Unit matrix |
| Response loss / restart / stale reclaim | PASS | Unit matrix |
| Parlay correlation unit gate | PASS | `tests/parlay-correlation.test.js` 29/29 |
| Authz / IDOR unit red-team | PASS | `tests/red-team-authz.test.js` |
| Designated-account live smoke A–D | NOT RUN | Pending post-deploy (this cutover) |
| Auth A↔B live | NOT TESTED | Pending designated tokens / mint |
| Cross-club live | NOT TESTED | Pending |
| Cancel lifecycle live | NOT RUN | Pending designated only |
| Bet lifecycle PLACE→grade→Results | NOT RUN | Pending designated only |
| Retention scheduled | NOT TESTED | Documented; not a beta blocker |
| Settlement recording | OFF | Must stay OFF |
| Safe for wider beta | BLOCKED | Until live designated smoke + Railway cutover-fix SHA |

## Retention (not blocker)

- Code: `purgeExpiredKeys` / `PROPOSED_idempotency_keys_retention.sql`
- Prod schedule: **NOT** enabled
- Owner may schedule after wider beta; not required to claim cutover complete once smoke passes

## Hard rules

- Do NOT drop/rollback `idempotency_keys`
- Do NOT re-apply migration if present
- Do NOT enable settlement
- Ordinary-user financial mutations forbidden; designated Test Club only
