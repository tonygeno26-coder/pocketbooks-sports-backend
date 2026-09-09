# Null-club `ledger_entries` audit (READ ONLY)

**Date:** 2026-09-08  
**Project:** `padgicwrrzmukahfsyhk`  
**Action taken:** NONE — no backfill, no UPDATE, no DELETE  
**Scope:** Classify the 36 rows where `ledger_entries.club_id IS NULL`

## Summary counts

| Metric | Value |
|---|---|
| Total `ledger_entries` | 133 |
| NULL `club_id` | **36** |
| Earliest NULL row | 2026-05-17 |
| Latest NULL row | 2026-09-01 |
| Reconstructable via ticket.club_id | **18** |
| Ambiguous (no ticket or ticket.club_id NULL) | **18** |

### By type

| type | n |
|---|---|
| `bet_placed` | 13 |
| `BET_PLACED` | 12 |
| `bet_won` | 5 |
| `bet_lost` | 3 |
| `bet_canceled` | 3 |

## Classification legend

| Class | Meaning |
|---|---|
| **SAFE LEGACY** | Predates club isolation; club-scoped reads exclude them; not used as bankroll SoT by money RPCs |
| **RECONSTRUCTABLE** | `ticket_id` joins a ticket with non-null `club_id` (almost always `demo-club`) |
| **AMBIGUOUS** | No ticket, missing ticket, or ticket also NULL club — cannot safely assign club |
| **CURRENT RISK** | Could contaminate *today’s* club-scoped financial display if queries omit `club_id` or OR-in NULL |

## Do they contaminate display today?

**Under club-scoped queries (`.eq('club_id', clubId)`): NO.**  
NULL club rows are excluded from host dashboard, player dashboard, settlements preview, and reconciliation after Option A club-required fixes.

**Under player-only / missing-clubId queries (pre-fix): YES — risk.**  
Those paths are now rejected with `missing_clubId` on financial endpoints.

**Money RPCs (`place_bet_tx` / `grade_ticket_tx`):** bankroll SoT is `balance_start + tickets`, not these ledger rows — cancel presentation balances still wrote ledger_entries historically.

## Row classes (36)

### SAFE LEGACY + RECONSTRUCTABLE (18)

May-era demo/smoke rows whose ticket has `club_id = 'demo-club'` (or similar non-null). Examples:

- `BET_PLACED` / `bet_won` / `bet_lost` tied to `T1779…` tickets under `demo-club`
- Players: `P1001`, `1`, and some NULL player_id on early AG-prefixed grade mirrors

**Backfill not recommended in this phase** — demo-club is not the production UUID club; reconstructing into live club scope would be wrong.

### SAFE LEGACY + AMBIGUOUS (15 early / orphan)

- Early `L1779…` `bet_placed` rows with **NULL player_id and NULL ticket_id** (2026-05-17–18)
- `DIAG-1779088715-001` diagnostic row (`player_id=p1`, no ticket)
- Grade mirrors with NULL player_id and tickets that themselves have NULL club
- Ticket `T17790050699837358` appears in both ambiguous and canceled paths with NULL ticket club

### CURRENT RISK (narrow) — 3 rows on 2026-09-01

| id | type | player_id | ticket_id | ticket.club_id |
|---|---|---|---|---|
| `VOID_SMOKE_T17790050699837358` | bet_canceled | `P1001` | `T17790050699837358` | NULL |
| `VOID_SMOKE_GRD5_D_1779874408210` | bet_canceled | `0a1885b8-…` | `GRD5_D_1779874408210` | NULL |
| `VOID_SMOKE_GRD5_D_1779874439486` | bet_canceled | `0a1885b8-…` | `GRD5_D_1779874439486` | NULL |

These are **smoke void** cancel mirrors written **after** isolation work began, but with NULL club on both ledger and ticket. They do **not** enter club-eq displays. They evidence soft-club cancel / cleanup paths — addressed by proposed `PROPOSED_cancel_bet_tx_club_isolation.sql` (not applied).

## Verdict table

| Class | Count (approx) | Contaminates club display today? | Action |
|---|---|---|---|
| SAFE LEGACY | 33 | No (with club-required API) | Leave |
| RECONSTRUCTABLE | 18 (subset) | No | Do **not** backfill to prod UUID |
| AMBIGUOUS | 18 | No under club eq | Leave |
| CURRENT RISK | 3 smoke voids | No under club eq; signals soft cancel | Fix cancel RPC (proposed); no ledger backfill |

## Recommendations

1. **Do not backfill** NULL `club_id` in this phase.  
2. Keep financial reads **strict** `.eq('club_id', …)`.  
3. Apply `PROPOSED_cancel_bet_tx_club_isolation.sql` only after approval (stops new NULL-club cancels / phantom1000).  
4. Optional later: quarantine/archive smoke void rows — still not a money mutation of live bankroll.
