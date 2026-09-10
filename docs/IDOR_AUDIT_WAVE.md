# IDOR Audit Wave — Resource Authorization

**Date:** 2026-09-09  
**Branches:** BE+FE `cursor/idor-audit-wave`  
**Constraint:** Local/fixtures + safe read-only inspection only. Settlement OFF. No prod financial SQL applied.

## Prior work reconciled (no regress)

- BE `main` @ `f33e0e0` — survivor host-scope + mirror/notif IDOR (`cursor/away-authz-survivor`, `cursor/away-red-team`, `origin/cursor/authz-p0-merged`)
- FE deferred `cursor/away-authz-survivor` @ `9652a24` + red-team fixtures `9d2385b`
- Complementary reconcile branch: `cursor/pre-beta-authz-club` (docs + ledger helper hard-club + multi-club tests) — additive only vs this wave

## P0 findings (this wave)

| ID | Issue | Status |
|----|--------|--------|
| **IDOR-P0-1** | Cash-out offer/accept/decline loaded ticket by id without `ticket.club_id` vs actor club | **FIXED** |
| **IDOR-P0-2** | Player/host dashboard soft-filtered `if (clubId)` → multi-club bleed when club omitted | **FIXED** (fail closed + hard `.eq`) |
| **IDOR-P0-3** | Join request list (`/api/clubs/:id/requests`, `/api/club/pending-requests`) auth-only | **FIXED** (host role + `_checkClubScope`) |
| **IDOR-P0-4** | Settlement snapshots/payments/confirm/void by periodId/paymentId without club bind | **FIXED** |
| **IDOR-P0-5** | Mirror audit tickets/legs/ledger unauthenticated global dump | **FIXED** (privileged + club-scoped) |
| **IDOR-P0-6** | Mirror tickets soft club filter | **FIXED** (require clubId + hard eq) |

## Verified OK (prior + fixtures)

- Player self-scope on dashboard / place / cancel / notifications
- Survivor creator-only pool runner
- Diamond host endpoints use `requireCanonicalClubId` + `req._clubId`
- Player limits legacy routes club+role gated
- Multi-club fixture: same `PLY_MULTI` Club A vs B — no cash-out / settlement / join bleed

## Owner-gated (DO NOT APPLY)

- `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql` — soft club + phantom $1000 in prod cancel RPC
- Settlement recording remains OFF / gated

## P1 residual

- Notifications are player-global (no `club_id` column); cash-out actions now club-bound on ticket
- Privileged in-club host may view member dashboards (intentional)
- `platform_admin` remains cross-club escape hatch

## Tests

```bash
# BE
node tests/idor-audit-wave.test.js
node tests/multi-club-isolation.test.js
node tests/authz-idor.test.js
node tests/red-team-authz.test.js

# FE
node tests/authz-idor.test.js
node tests/red-team-authz.test.js
node tests/multi-club-isolation.test.js
```
