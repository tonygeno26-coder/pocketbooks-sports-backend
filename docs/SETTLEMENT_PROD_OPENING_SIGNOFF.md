# Production Settlement Opening Sign-Off

**Status:** READ-ONLY inventory complete — **no production writes**  
**Date (inventory):** 2026-09-09 ~08:07 UTC  
**BE:** `d839449` on `cursor/settlement-option-a`  
**FE:** `46da895` on `cursor/settlement-option-a`  
**Supabase:** `padgicwrrzmukahfsyhk` — SELECT only  

**Hard rules**
- Account key = `(club_id, player_id)` — never player alone  
- Proposed openings are **not** lifetime ticket P&L and **not** bankroll  
- Checkboxes below are **documentation only** — not actual owner approval  
- Do **not** apply bootstrap / migrations / settle until owner decisions below are recorded elsewhere  

---

## Recommended single T0 (do not write)

| Field | Value |
|---|---|
| **T0** | `2026-09-09T08:00:00.000Z` |
| Rule | `gradeMs <= T0` → **excluded**; `gradeMs > T0` → **included** |
| Why safe | At inventory time: **0** active/open tickets; last grade `2026-09-09T01:46:56.843Z`; last place `2026-09-08T22:16:26.713Z`. T0 sits in the quiet window after last grade and close to activation — avoids a long T0→go-live gap. |
| Activation | Run bootstrap **immediately** after schema+RPC deploy for signed accounts (same hour). If go-live slips >2h or any active tickets appear, **re-pick T0** at activation wall-clock instead of this stamp. |

Quiet-window ops tip: freeze new placements for ~5–10 minutes around bootstrap; re-check `active/open = 0`.

---

## Production account inventory (active = `club_members`)

Club: **Test Club** `d616dc2a-95a6-473a-97b1-7da330878479` (only UUID club with members).  
`settlement_payments` / `settlement_opening_balances` / settle+bootstrap RPCs: **absent** in prod.  
Epoch markers: **0**. Legacy `settlements` rows: **0**. Multi-club members: **none**.

| Club | Player | balance_start | Approx available bankroll¹ | Active exposure | Lifetime ticket net² (diagnostic) | Current-period settled net³ | Epoch markers | Recent activity | Role note |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| Test Club `d616…8479` | `0a1885b8-…7d49` (smoketest) | 1000.00 | 2037.85 | 0 | **+1037.85** | = lifetime (no epoch) | 0 | Last grade 2026-05-28; null-club smoke voids 2026-09-01 | player |
| Test Club `d616…8479` | `12bb68f1-…9172` | 1000.00 | 1176.43 | 0 | **+176.43** | = lifetime | 0 | Last grade 2026-09-06 | player |
| Test Club `d616…8479` | `16` | 0.00 | 0.00 | 0 | 0 | 0 | 0 | No tickets | **host** in `club_memberships` |
| Test Club `d616…8479` | `2a3e6819-…929e` | 1000.00 | 836.06 | 0 | **−163.94** | = lifetime | 0 | Last grade 2026-09-09 01:40Z | player |
| Test Club `d616…8479` | `bc767309-…df13` | 1000.00 | 955.30 | 0 | −44.70 | = lifetime | 0 | Last grade 2026-09-09 01:46Z | player |

¹ Bankroll ≈ `balance_start + lifetime_ticket_net − active_risk` (betting SoT). **Not** settlement debt.  
² Diagnostic only — **must never** be copied into `opening_balance` unless owner explicitly chooses that product rule (they should not for Option A default).  
³ With no epoch, “current period” = all graded history. After T0 bootstrap + opening 0, pre-T0 nets drop out.

**Out of scope for openings (not in `club_members`):** `demo-club` tickets (`P1001`, `1`); null-club tickets (3 canceled).

---

## Classification legend

| Class | Meaning |
|---|---|
| **A OPEN AT ZERO ($0)** | Safe to bootstrap opening `$0` at T0 with short rationale (clean / host / immaterial history). |
| **B KNOWN NONZERO** | Owner has an **explicit** signed cash residue (not inferred). Show signed amount: − player owes host, + host owes player. |
| **C AMBIGUOUS — HUMAN REVIEW** | Non-trivial lifetime ticket history and **no** explicit settlement record. Do **not** infer opening from lifetime or bankroll. |

**This inventory:** B = **0** (no confirmed cash residues; legacy settlements empty).

---

## Sign-off table

| Club | Player | Proposed Opening | Classification | Evidence | Active Risk | Human Approval |
|---|---|---|---|---|---|---|
| Test Club `d616…8479` | `0a1885b8-…7d49` | **PENDING** — candidate `$0` + T0 (NOT +1037.85) | **C AMBIGUOUS** | Lifetime ticket net +1037.85; 0 epoch; 0 payments; 2 null-club smoke void ledger rows (excluded by club eq). Bankroll ≠ settlement. | 0 active tickets | ☐ Approve `$0` + rationale  ☐ Set B amount $____  ☐ Defer |
| Test Club `d616…8479` | `12bb68f1-…9172` | **PENDING** — candidate `$0` + T0 (NOT +176.43) | **C AMBIGUOUS** | Lifetime +176.43; \|net\|≥100 bootstrap heuristic; no markers/payments. | 0 | ☐ `$0` + rationale  ☐ B $____  ☐ Defer |
| Test Club `d616…8479` | `16` | **$0** | **A OPEN AT ZERO** | Host membership; balance_start 0; no tickets/ledger. | 0 | ☐ Confirm (or exclude host from bootstrap) |
| Test Club `d616…8479` | `2a3e6819-…929e` | **PENDING** — candidate `$0` + T0 (NOT −163.94) | **C AMBIGUOUS** | Lifetime −163.94; recent grades through 2026-09-09; no markers/payments. | 0 | ☐ `$0` + rationale  ☐ B $____  ☐ Defer |
| Test Club `d616…8479` | `bc767309-…df13` | **$0** | **A OPEN AT ZERO** | Lifetime −44.70 (diagnostic only, \|net\|<100); propose clean T0 open at 0 — **not** converting bankroll/P&L to debt. | 0 | ☐ Confirm `$0` |

**Counts:** total=**5** · A zero=**2** · B nonzero=**0** · C ambiguous=**3**

---

## Multi-club proof

- `club_members`: single club UUID; **0** players with `count(DISTINCT club_id) > 1`.  
- Settlement APIs require `clubId` (`missing_clubId` on preview / settle / payments / rollover).  
- Ticket/payment loads use `.eq('club_id', clubId)` then group by `player_id` **within that club** — not global player aggregation.  
- SQL helpers `_settlement_cutoff_ms` / `_settlement_recompute_carry` / `settle_payment_option_a_tx` all take `(club_id, player_id)`.

## Null-club ledger (36 rows)

| Fact | Value |
|---|---|
| NULL `ledger_entries.club_id` | **36** (unchanged; no backfill) |
| Overlap with live member | 2 smoke `bet_canceled` rows for `0a1885b8-…` (2026-09-01) |
| Contaminates club-eq settlement math? | **No** (strict `.eq('club_id', …)` / RPC filters) |
| Opening impact | Does **not** invent B amounts; reinforces C review for that player only as evidence noise |

## Active ticket cutover risk

| Metric | Value |
|---|---|
| Active/open at inventory | **0** |
| Accounts with active | **0** |
| Exposure | **$0** |
| Recommendation | Bootstrap in quiet window; if any `active`/`open` appear, wait for grade/cancel or choose T0 after they clear — do **not** alter tickets for cutover |

---

## Feature flag (design only — **DO NOT ENABLE**)

Missing today. Smallest gate:

| Layer | Flag | Default | Effect when false |
|---|---|---|---|
| BE | `SETTLEMENT_OPTION_A_CASH_ENABLED=false` | **false** | `/api/host/settle-player` → `503 settlement_cash_disabled`; hide apply path |
| BE | (same flag) | | Optional: settlements-preview returns `settlementCashEnabled:false` and zeros cash fields until bootstrap complete |
| FE | `window.__PB_SETTLEMENT_OPTION_A_CASH__ !== true` (or env off) | **off** | Hide Settle / payment controls in host UI |

Enable **only after** schema + signed bootstrap.

---

## Revised deployment order (corrects prior “BE first” gate)

1. **Schema first (prod, separate approval):** `PROPOSED_cancel_bet_tx_club_isolation.sql` → `PROPOSED_settlement_payments.sql` → `PROPOSED_settlement_opening_balances.sql` → `PROPOSED_settle_payment_option_a_tx.sql` → `PROPOSED_bootstrap_settlement_opening_epoch.sql`  
2. **Compatible BE/FE** (`d839449` / `46da895`) with **cash flag OFF**  
3. **Owner financial sign-off** on this doc’s C rows  
4. **Bootstrap** signed `(club,player)` at T0 (force+rationale only where required)  
5. **Enable UI/API flag**  

**Can `d839449` deploy before tables?** Technically settle returns `503 settlement_serialize_rpc_missing` / `settlement_payments_missing`, but preview without T0 would surface **lifetime** as carry — **unsafe**. Prefer schema → flagged BE → bootstrap → UI. No window that invites settle against missing primitives or lifetime-as-debt UX.

---

## Final SQL review (no execute)

Exact apply order:

| # | File | Deps | Additive? | Changes existing financial rows? | Txn / rollback |
|---|---|---|---|---|---|
| 1 | `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql` | existing `cancel_bet_tx` | **No** (CREATE OR REPLACE function) | Function body only at apply-time; **runtime** cancel UPDATEs tickets + INSERTs ledger (same refund math; harder club lock; removes phantom $1000) | Backup `pg_get_functiondef` → restore body |
| 2 | `migrations/PROPOSED_settlement_payments.sql` | none | **Yes** CREATE TABLE | No | DROP TABLE/indexes |
| 3 | `migrations/PROPOSED_settlement_opening_balances.sql` | none | **Yes** CREATE TABLE | No | DROP TABLE/index |
| 4 | `migrations/PROPOSED_settle_payment_option_a_tx.sql` | needs `settlement_payments`; optional opening table | New functions | **Runtime** INSERT `settlement_payments` + audit `ledger_entries` (`settlement_payment`). **Does not** mutate `balance_start` / tickets | DROP functions |
| 5 | `migrations/PROPOSED_bootstrap_settlement_opening_epoch.sql` | needs `settlement_opening_balances` | New function | **Runtime** INSERT epoch marker + opening row (blocked for `bootstrap_prod` without `force`) | DROP function; delete bootstrap ids by prefix |

**Highlights — statements that modify existing financial values**
- **cancel_bet_tx (replace):** future cancels rewrite ticket status / bankroll presentation paths; no bulk UPDATE at migrate time.  
- **settle_payment_option_a_tx:** append-only cash; never rewrites ticket nets or `balance_start`.  
- **bootstrap:** inserts only; lifetime P&L not written as debt unless caller passes that opening explicitly (forbidden without human rationale).

---

## Production touch checklist

| Item | Value |
|---|---|
| PRODUCTION DATA TOUCHED | **NO** |
| MIGRATION APPLIED | **NO** |
| BOOTSTRAP APPLIED | **NO** |
| MERGED | **NO** |
| SAFE TO REQUEST OWNER FINANCIAL SIGN-OFF | **YES** (pack ready; bootstrap **not** approved) |

### Owner decisions required

1. Confirm T0 `2026-09-09T08:00:00.000Z` or supply activation-time T0.  
2. For each **C** account: `$0` + written rationale **or** explicit **B** signed amount **or** defer.  
3. Confirm **A** rows (`16`, `bc767309-…`) at `$0`.  
4. Approve schema apply order + later bootstrap (separate from this doc).  
5. Keep `SETTLEMENT_OPTION_A_CASH_ENABLED` false until bootstrap verified.

Companion dry-run: `docs/settlement_prod_opening_dry_run.json`
