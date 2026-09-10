# Authorization Audit — PLAYER / HOST / CLUB

**Date:** 2026-09-09  
**Branch:** BE `cursor/pre-beta-authz-club` (reconciles `cursor/idor-audit-wave` @ `f40e470` / `ab3e044`)  
**Prior:** `cursor/away-red-team`, `cursor/away-authz-survivor` → `main` @ `f33e0e0`; remote `origin/cursor/authz-p0-merged`  
**Constraint:** Code-only / fixtures. Settlement OFF. No prod financial SQL. Cancel isolation **DO NOT APPLY**.

---

## Verdict

Player self-scope, host club-scope, and survivor creator-only boundaries from red-team + survivor are intact. Remaining **HTTP IDOR P0s** (cash-out ticket club bind, dashboard soft filters, join queues, settlement period/payment IDs, mirror audit/tickets) are **FIXED** on this lineage. Residual money P0 is **owner-gated** (`cancel_bet_tx` soft club + phantom $1000).

---

## PLAYER

| Surface | Gate | Status |
|---------|------|--------|
| `GET /api/player/dashboard` | `requireCanonicalClubId` + `requirePermissionScoped(-1 self)` + hard `.eq('club_id')` + missing club → 400 | **FIXED** |
| `POST /api/bets/place` / `cancel` | Club + self / host cancel ownership vs `actor.actorId` | **OK** (prior) |
| Cash-out accept/decline | `ticket.club_id` vs actor club + owner | **FIXED** |
| Notifications read/list | Always pin `playerId` to actor | **OK** (survivor) |
| Mirror tickets (player) | `requireActor` + pin to self + require club | **FIXED** |

Multi-club same player (`PLY_MULTI` @ Club A vs B): fixtures assert no cash-out / dashboard resource bleed across clubs.

---

## HOST

| Surface | Gate | Status |
|---------|------|--------|
| `GET /api/host/dashboard` | Canonical club + hard eq tickets/ledger/memberships | **FIXED** |
| Settlements preview | Fail-closed missing club + hard eq | **FIXED** |
| Offer cash-out | Ticket club bind + update `.eq('club_id')` | **FIXED** |
| Join request queues | Host role + `_checkClubScope` | **FIXED** |
| Settlement snapshots/payments/confirm/void | Period/payment `club_id` vs actor | **FIXED** |
| Rollover / week-snapshot / diamonds | `requireCanonicalClubId` + scoped perm | **OK** (red-team) |
| Legacy `player_limits` routes | Host + club scope | **OK** (red-team) |
| Survivor approve/deny/grade | Creator + `platform_admin` only (no `full_admin` bypass) | **OK** (survivor) |

---

## CLUB

| Rule | Status |
|------|--------|
| Token `_clubId` is authoritative for money routes via `requireCanonicalClubId` | **OK** |
| Cross-club host mutation → `club_scope_mismatch` | **OK** (fixtures) |
| Soft `if (clubId) .eq(...)` on player/host dashboards | **REMOVED** |
| `_ledgerAvailableForPlayer` / `_creditPlayerAccount` without club | **FIXED** (fail closed / hard eq) on this branch |
| Grade worker `_runGradeCore` optional club (ops all-clubs) | **P1** intentional worker; not player HTTP |
| Notifications lack `club_id` column | **P1** — money actions club-bound on ticket |
| `platform_admin` cross-club escape | **Intentional** |

---

## P0 register

| ID | Issue | Status |
|----|-------|--------|
| AUTHZ-P0-1 | Mirror tickets unauthenticated | **FIXED** (survivor → main) |
| AUTHZ-P0-2 | Notifications host foreign `playerId` | **FIXED** (survivor → main) |
| AUTHZ-P0-3 | Survivor `full_admin` pool runner | **FIXED** (survivor → main) |
| AUTHZ-P0-4 | Unauth host rollover/week-snapshot; limits IDOR; cancel actor; stake NaN | **FIXED** (red-team → main) |
| AUTHZ-P0-5 | Cash-out / dashboard / join / settlement / mirror audit IDOR | **FIXED** (IDOR wave → this branch) |
| AUTHZ-P0-6 | Ledger helper soft club → multi-club blend | **FIXED** (this branch additive) |
| AUTHZ-P0-7 | Prod `cancel_bet_tx` soft club + phantom $1000 | **OWNER-GATED** — do not apply |

---

## Owner-gated (DO NOT APPLY)

- `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql` (+ rollback / precheck / verify) — see `docs/CANCEL_BET_TX_PROD_GATE.md`
- Settlement recording / grading settlement flags remain OFF

---

## FE note

FE survivor hardening (`loadPlayerDashboardFromDb` prefers JWT `sub`) remains on deferred `cursor/away-authz-survivor`. FE docs + fixtures mirrored on FE `cursor/pre-beta-authz-club`.

---

## Tests

```bash
node tests/idor-audit-wave.test.js
node tests/multi-club-isolation.test.js
node tests/authz-idor.test.js
node tests/red-team-authz.test.js
```

## Companion docs

- `docs/CLUB_ISOLATION_AUDIT.md` — club hard/soft matrix
- `docs/IDOR_AUDIT_WAVE.md` — wave changelog
- `docs/FINANCIAL_AUTHORITY_AUDIT.md` — money SoT (no SQL apply)
