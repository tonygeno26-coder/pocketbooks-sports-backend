# IDEMPOTENCY FINAL OWNER REVIEW

**STATUS:** `IDEMPOTENCY CUTOVER IN PROGRESS → COMPLETE pending live smoke`  
**Date:** 2026-09-10  
**BE branch:** `cursor/idempotency-cutover-complete` (correlation phantom-ticket fix on Path A schema)  
**Prior remediation:** `40e7f1f` already ancestor of main `91ebca0`  
**FE prod SHA (stated):** `8bbff41`  
**cancel_bet_tx isolation:** APPLIED (`20260910062602`) — do not re-apply  
**idempotency_keys_scoped:** **APPLIED** (`20260910073233`) — do not re-apply / do not drop  
**settlement recording:** OFF  
**PRODUCTION SQL THIS CUTOVER:** **NO** (already present)

---

## Verdict

| Item | State |
|------|-------|
| Prod table + scoped PK `(club_id, player_id, client_key)` | **MATCH** Path A |
| Railway pre-fix | `91ebca0` |
| Unit matrix 2x/10x/conflict/response-loss/restart/stale/parlay | **PASS** |
| Correlation reject → `failed` row, **no** ticket_id to nonexistent ticket | **FIXED** in cutover branch (middleware) |
| Pre-fix orphan `failed` rows with MISSING ticket_id | **Observed** from old middleware on 409 conflict paths — fixed going forward |
| Retention | Documented; **not scheduled**; not blocker |
| Designated live smoke | Required before SAFE FOR WIDER BETA = YES |

**SAFE TO RE-APPLY SQL:** **NO** — already applied. Do not re-apply.

---

## Correlation × idempotency (mandatory)

1. `requireIdempotency` reserves `processing` before place handler.
2. Correlation gate returns `422` with `financialMutation: NONE` before money RPC.
3. Middleware `res.json` override must mark row `failed` **without** attaching pre-reserved `req._idemTicketId`.
4. Exact retry of same key+body replays `422` / stays rejected — never `completed` with phantom ticket.

---

## Retention (section 11)

- `migrations/PROPOSED_idempotency_keys_retention.sql` + `purgeExpiredKeys`
- **Not** a cutover blocker; schedule post-beta at owner discretion

## Do not touch

- Rollback / drop of `idempotency_keys`
- Settlement recording
- Ordinary-user wagers
