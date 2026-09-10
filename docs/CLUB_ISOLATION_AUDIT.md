# Club Isolation Audit (READ-ONLY)

**Date:** 2026-09-09  
**Scope:** Dashboard, tickets, My Bets, Host Bets, limits, notifications, survivor, join requests, cash-out, settlement, diamonds  
**Constraint:** No production data mutation. Cancel isolation package may already be prepared — **do not apply**; refine docs only.  
**Prior:** BE `cursor/financial-architecture-audit` → `docs/FINANCIAL_CLUB_ISOLATION_AUDIT.md` (2026-09-08). This doc refreshes endpoint coverage for Owner-Away Task 17.

---

## Verdict

**No — not every club-owned resource hard-requires `club_id` on every read/write path.**

Money **RPCs** for place/grade (when current migrations are live) generally hard-scope `club_id + player_id`. Several **API handlers** still use **optional** `.eq('club_id')` when `clubId` is present, and **`cancel_bet_tx` in prod (pre-PROPOSED)** remains soft-club + phantom `$1000`. Cross-club financial paths are **P0**.

`requirePermissionScoped` stamps `req._clubId` from the token for protected routes, which **usually** supplies club on host/player dashboard — but code still tolerates missing club on the query builder (`if (clubId) tq = tq.eq(...)`). Any path that skips scope middleware or drops club is unsafe for multi-club players.

---

## Classification

| Verdict | Meaning |
|---------|---------|
| **HARD** | Always filters/locks by `club_id` (+ player where needed); mismatch → reject |
| **CONDITIONAL** | Scoped only when `clubId` provided / token stamped |
| **SOFT** | `club_id IS NULL OR club_id = …` or id-only load |
| **NONE** | No club column / pool-scoped only / global |

---

## Endpoint matrix

### Money & tickets

| Surface | Endpoint / object | Club requirement | Verdict | Sev |
|---------|-------------------|------------------|---------|-----|
| Place bet | `POST /api/bets/place` → `place_bet_tx` | Token scope + RPC `club_id+player_id` | **HARD** (RPC) | OK |
| Place RR | `place_rr_tx` | Same pattern in migration | **HARD** if RPC deployed; else broken | Verify prod |
| Cancel | `POST /api/bets/cancel` → `cancel_bet_tx` | App rejects mismatch if both set; **RPC soft + $1000** | **SOFT** until PROPOSED applied | **P0** |
| Grade | `grade_ticket_tx` (isolation migration) | Hard club match | **HARD** if applied | OK / verify |
| Cash-out offer/accept/decline | `/api/host/offer-cashout`, `/api/bets/accept-cashout`, `decline-cashout` | `requireCanonicalClubId` + scoped perm; ticket by id | **CONDITIONAL** — must verify ticket.club_id vs token | **P1** |
| Player dashboard | `GET /api/player/dashboard` | Tickets `.eq(player_id)` then **if clubId** `.eq(club_id)` | **CONDITIONAL** | **P0** if club omitted (multi-club) |
| Host dashboard | `GET /api/host/dashboard` | Same optional club on tickets/ledger/members | **CONDITIONAL** | **P0** if club omitted |
| My Bets (FE) | Hydrate from player dashboard | Depends on API | **CONDITIONAL** | follows API |
| Host Bets (FE) | Host dashboard tickets + legs | Depends on API | **CONDITIONAL** | follows API |
| Mirror tickets | `GET /api/mirror/tickets*` | Optional player/club; weak/no money auth story | **CONDITIONAL / NONE** | **P1**/ **P0** if public |
| Mirror audit | `GET /api/mirror/audit*` | **No club filter** — recent global rows | **NONE** | **P1** (ops leak) |

### Limits & risk

| Surface | Club requirement | Verdict | Sev |
|---------|------------------|---------|-----|
| `player_limits` upsert/read | `club_id, player_id` conflict key | **HARD** | OK |
| `club_risk_settings` | `eq(club_id)` required | **HARD** | OK |
| `risk_exposure` | `eq(club_id)` | **HARD** | OK |

### Settlement

| Surface | Club requirement | Verdict | Sev |
|---------|------------------|---------|-----|
| Settle / rollover / payments | Intended club-scoped; many tables/RPCs historically absent | **BROKEN / gated** | Keep OFF — **P0** if enabled blindly |
| Settlements preview / reconciliation | Optional club filters on some queries | **CONDITIONAL** | **P1** |
| PROPOSED cancel isolation | Hard club — **not applied** | N/A | Do not apply here |

### Notifications

| Surface | Club requirement | Verdict | Sev |
|---------|------------------|---------|-----|
| `GET /api/notifications` | `player_id` only on `player_notifications` | **NONE** (player-global) | **P1** if notifs carry cross-club cashout CTAs |
| Cashout notif actions | Ticket id → money routes | Must enforce ticket club | **P1** |

### Survivor & join requests

| Surface | Club requirement | Verdict | Sev |
|---------|------------------|---------|-----|
| Survivor pools/entries/picks | **Pool-scoped** (`pool_id`), not sportsbook `club_id` | **NONE** (by product) | OK if survivor ≠ club bankroll |
| Club join / memberships | `club_id + actor_id` | **HARD** | OK |
| Host approve join → `club_members` / limits | Club stamped | **HARD** | OK |

### Diamonds

| Surface | Club requirement | Verdict | Sev |
|---------|------------------|---------|-----|
| Host diamond balance / ledger / invoice | `eq(club_id)` | **HARD** (separate product) | OK |
| FE local diamond credit helpers | localStorage | Not club DB authority | **P1** display |

---

## Cross-club financial P0 register

| ID | Risk | Evidence | Status |
|----|------|----------|--------|
| **CI-P0-1** | `cancel_bet_tx` soft club OR + `coalesce(balance_start,1000)` | Prior prod read + `PROPOSED_cancel_bet_tx_club_isolation.sql` header | Package prepared — **DO NOT APPLY** in this agent |
| **CI-P0-2** | `GET /api/player/dashboard` without club → all clubs’ tickets for player | `if (clubId) tq = tq.eq('club_id', clubId)` | Latent until multi-club; token `_clubId` usually set |
| **CI-P0-3** | `GET /api/host/dashboard` without club → cross-club host aggregate | Same pattern | Same |
| **CI-P0-4** | `ledger_entries` with NULL `club_id` | Prior audit count | Club-scoped balance under/over count |
| **CI-P0-5** | Settlement enablement against missing/soft primitives | Prior architecture audit | Keep recording OFF |

Non-P0 but related: global idempotency key on `ledger_entries.id` (**P1** cross-club key collision).

---

## Does every club-owned resource require `club_id`?

| Resource | Requires club_id? |
|----------|-------------------|
| Tickets / legs / place / grade (RPC) | **Yes** (hard in current place/grade migrations) |
| Cancel (prod RPC) | **Not hard** today |
| Player/host dashboard handlers | **Should** — code is conditional |
| Limits / risk settings / diamonds | **Yes** |
| Notifications | **No** (player-scoped) |
| Survivor | **No** (pool-scoped) |
| Mirror audit | **No** |

---

## Recommendations (no apply)

1. **Do not apply** `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql` until owner prod gate (`docs/CANCEL_BET_TX_PROD_GATE.md` if present / companion scripts).
2. Fail closed: `GET /api/player/dashboard` and `GET /api/host/dashboard` → **400 `missing_clubId`** when club absent after scope middleware (small BE change; owner-approved).
3. Cash-out handlers: always compare `ticket.club_id` to `req._clubId`.
4. Notifications: include `club_id` column long-term; short-term validate ticket club on accept/decline.
5. Mirror routes: auth + required club, or disable in production.
6. Keep settlement gated; align with Option A from prior financial club isolation audit.

---

## Companion artifacts (prepared elsewhere — do not apply)

- `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql`
- `migrations/ROLLBACK_cancel_bet_tx_club_isolation.sql`
- `migrations/CANCEL_BET_TX_PRECHECK_READONLY.sql`
- `migrations/CANCEL_BET_TX_POST_VERIFY.sql`
- `migrations/CANCEL_BET_TX_TEST_QUERIES.sql`
