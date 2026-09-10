# CANCEL ISOLATION — Production Gate (READ-ONLY PREP)

**Alias of:** [`docs/CANCEL_BET_TX_PROD_GATE.md`](./CANCEL_BET_TX_PROD_GATE.md)  
**Canonical package commit:** `c0958d4` on `cursor/cancel-isolation-prod-gate`  
**Status:** `CANCEL ISOLATION PROD GATE READY`  
**Supabase project:** `padgicwrrzmukahfsyhk`  
**Verified (read-only):** 2026-09-09 (re-check same day)  
**PRODUCTION DATA TOUCHED:** **NO**  
**Settlement:** **OFF** (this gate does not touch grading/settlement)  
**SAFE TO REQUEST OWNER APPLY:** **YES**

---

## What this gate does

Owner-ready `CREATE OR REPLACE FUNCTION public.cancel_bet_tx(...)` only:

1. Hard scope = **`club_id + player_id + ticket_id`**
2. Remove soft club (`v_effective_club_id` / NULL-OR) and **phantom `$1000`**
3. Missing membership → `no_club_member_balance_found` (never invent balance)
4. Already canceled → idempotent (`refund=0`); settled → `invalid_transition`
5. No row backfill / no DML at apply time

---

## CURRENT FUNCTION (live prod, re-verified)

| Marker | Live value (2026-09-09 recheck) |
|---|---|
| Signature | `cancel_bet_tx(text,text,text,text,text,text)` |
| Soft club | **YES** — `v_effective_club_id` still present |
| Phantom1000 | **YES** — body still mentions `1000` |
| Hard member reject | **NO** — `no_club_member_balance_found` absent |
| `missing_club_id` | **NO** |
| Ticket club mismatch string | present (soft path) |
| Grants | `EXECUTE` → `service_role`, `postgres` (unchanged expectation) |

Exact restore body: `migrations/ROLLBACK_cancel_bet_tx_club_isolation.sql`

---

## SQL / rollback / locks

| Artifact | Role |
|---|---|
| `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql` | **Apply** (owner only) |
| `migrations/ROLLBACK_cancel_bet_tx_club_isolation.sql` | Rollback to pre-gate prod body |
| `migrations/CANCEL_BET_TX_PRECHECK_READONLY.sql` | Read-only preflight |
| `migrations/CANCEL_BET_TX_POST_VERIFY.sql` | Post-apply verify |
| `migrations/CANCEL_BET_TX_TEST_QUERIES.sql` | Designated-account test matrix |

**Lock / downtime:** brief function catalog replace (`ACCESS EXCLUSIVE` on function object); typical **&lt; 1s**; no table rewrite; **no downtime**.

**Backup before apply:**

```sql
SELECT pg_get_functiondef(
  'public.cancel_bet_tx(text,text,text,text,text,text)'::regprocedure
);
```

---

## PREFLIGHT inventory (recheck)

| Check | 2026-09-09 morning | Recheck (same day) |
|---|---|---|
| Active/open tickets | 0 | **2** (both have `club_members`) |
| Active orphans (no member) | 0 | **0** |
| Canceled/voided | 27 | 27 |
| Settled-like | 37 | 37 |
| Total tickets | 64 | **66** |
| Any-status missing membership | 11 | **14** (non-active; no apply block) |
| NULL `tickets.club_id` | 3 | 3 |
| NULL `tickets.player_id` | 0 | 0 |

**No row remediation required before function replace.** Active tickets are membership-backed; historical orphans remain non-active.

---

## POSTFLIGHT

Run `migrations/CANCEL_BET_TX_POST_VERIFY.sql` after owner apply. Expect:

- Soft markers gone (`v_effective_club_id`, phantom `1000` assign)
- Hard rejects present (`missing_club_id`, `no_club_member_balance_found`, hard `ticket_club_mismatch` / `ticket_player_mismatch`)
- Designated-account matrix green (see test plan below)

---

## TEST PLAN (designated accounts only)

| # | Case | Expect |
|---|---|---|
| 1 | Correct club + player + active + membership | `ok=true`, refund=`risk_amount`, ticket `canceled`, one `bet_canceled` ledger |
| 2 | Wrong club | `ticket_club_mismatch`; no mutation |
| 3 | Wrong player | `ticket_player_mismatch`; no mutation |
| 4 | Missing `club_members` | `no_club_member_balance_found`; **no phantom $1000** |
| 5 | Nonexistent ticket | `ticket_not_found` |
| 6 | Already canceled (new key) | `ok=true`, `idempotent=true`, `refund=0` |
| 7 | Settled | `invalid_transition` |
| 8 | Same idempotency key replay | idempotent; single ledger |
| 9 | Cross-club proof | Club A risk/member unchanged after wrong-club reject |

---

## SAFE TO REQUEST OWNER APPLY

**YES**

Conditions:

- Apply **only** `PROPOSED_cancel_bet_tx_club_isolation.sql`
- Capture `pg_get_functiondef` first; keep ROLLBACK ready
- Settlement remains OFF / unrelated
- Designated-account tests after apply
- **Do not** backfill tickets/ledger in this gate

**PRODUCTION DATA TOUCHED by this package:** **NO** (docs + proposed SQL files only until owner applies)

---

## Full narrative

See **`docs/CANCEL_BET_TX_PROD_GATE.md`** for call-site inventory, risk table, and proof matrix (kept in sync; this file is the `CANCEL_ISOLATION_PROD_GATE` alias requested by verify workflows).
