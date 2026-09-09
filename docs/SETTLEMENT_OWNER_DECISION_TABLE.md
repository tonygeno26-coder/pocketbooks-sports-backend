# Owner Settlement Decision Table (Category C + A reconfirm)

**Status:** READ-ONLY evidence refresh — **no production writes**  
**Refreshed:** 2026-09-09 (post-inventory SELECT on `padgicwrrzmukahfsyhk`)  
**BE tip:** `cursor/settlement-option-a` (this doc + cash-flag scaffolding default OFF)  
**T0:** **NOT APPROVED.** Do **not** use `2026-09-09T08:00:00.000Z`. Re-pick immediately before actual bootstrap.

Hard rules honored: no invented financial amounts; lifetime / bankroll are **context only**. **Owner morning-gate (2026-09-09):** Category C all three approved **OPEN AT $0** for settlement position planning only — **NOT WRITTEN**; do not change bankroll/balance_start/tickets/P&L/historical ledger.

---

## CATEGORY C — Owner decision required (3)

### 1) Test Club / test-player-001

| Field | Value |
|---|---|
| Club | Test Club / `d616dc2a-95a6-473a-97b1-7da330878479` |
| Player | `test-player-001` / `0a1885b8-0fe3-4e75-aeda-f89662c87d49` |
| Current bankroll (betting SoT, not debt) | ≈ **2037.85** (`balance_start` 1000.00 + lifetime ticket net) |
| Current-period ticket net | = lifetime (0 epoch markers) → **+1037.85** (diagnostic) |
| Lifetime ticket net (context ONLY) | **+1037.85** (5 won / 0 lost / 12 canceled; last grade 2026-05-28) |
| Null-club involvement | **Yes — 2** `bet_canceled` smoke rows (2026-09-01); excluded by club-eq settlement math; evidence noise only |
| Last activity | Club tickets last grade **2026-05-28**; null-club smoke **2026-09-01** |
| Why Ambiguous | Non-trivial lifetime (+1037.85); **no** settlement records / opening / epoch / legacy settlement rows; bankroll ≠ cash carry; null-club smoke does not prove square or a signed residue |
| Evidence square vs owed | **Neither proven.** No cash ledger proves $0 square; lifetime must **not** be treated as host-owes +1037.85 |
| Recommended Owner Decision | **OPEN AT $0** (owner morning-gate 2026-09-09). Settlement position ONLY — no bankroll/balance_start/tickets/P&L/ledger changes. **NOT WRITTEN.** |

`OWNER CHOICE: $0` ✅ **approved (planning only — NOT WRITTEN)**

---

### 2) Test Club / Test Player 2

| Field | Value |
|---|---|
| Club | Test Club / `d616dc2a-95a6-473a-97b1-7da330878479` |
| Player | Test Player 2 (`testplayer2`) / `12bb68f1-bcca-4e63-8ae4-7065dbb19172` |
| Current bankroll (betting SoT, not debt) | ≈ **1176.43** |
| Current-period ticket net | = lifetime → **+176.43** (diagnostic) |
| Lifetime ticket net (context ONLY) | **+176.43** (2 won / 4 lost; last grade 2026-09-06) |
| Null-club involvement | **None** (0 rows) |
| Last activity | Last grade **2026-09-06T00:30:20Z**; last place 2026-09-05 |
| Why Ambiguous | \|lifetime\| ≥ 100 bootstrap heuristic; 0 epoch / 0 settlement records / 0 legacy settlements; no signed cash residue |
| Evidence square vs owed | **Neither proven.** Not square by record; not an explicit owed amount |
| Recommended Owner Decision | **OPEN AT $0** (owner morning-gate 2026-09-09). Settlement position ONLY — no bankroll/balance_start/tickets/P&L/ledger changes. **NOT WRITTEN.** |

`OWNER CHOICE: $0` ✅ **approved (planning only — NOT WRITTEN)**

---

### 3) Test Club / Test Player 1

| Field | Value |
|---|---|
| Club | Test Club / `d616dc2a-95a6-473a-97b1-7da330878479` |
| Player | Test Player 1 (`testplayer1`) / `2a3e6819-be2f-4df3-8112-54ce19d0929e` |
| Current bankroll (betting SoT, not debt) | ≈ **836.06** |
| Current-period ticket net | = lifetime → **−163.94** (diagnostic) |
| Lifetime ticket net (context ONLY) | **−163.94** (4 won / 12 lost / 2 canceled; last grade 2026-09-09 01:40Z) |
| Null-club involvement | **None** (0 rows) |
| Last activity | Last grade **2026-09-09T01:40:02Z**; last place 2026-09-08 22:15Z |
| Why Ambiguous | \|lifetime\| ≥ 100; recent graded play; 0 epoch / 0 settlement records / 0 legacy settlements; must not infer player-owes from P&L |
| Evidence square vs owed | **Neither proven.** Do **not** treat −163.94 as opening debt |
| Recommended Owner Decision | **OPEN AT $0** (owner morning-gate 2026-09-09). Settlement position ONLY — no bankroll/balance_start/tickets/P&L/ledger changes. **NOT WRITTEN.** |

`OWNER CHOICE: $0` ✅ **approved (planning only — NOT WRITTEN)**

---

## CATEGORY A — Still qualify for tentative $0 (2)

Reconfirmed on live SELECT (active/open **0** globally; epoch markers **0**; legacy `settlements` rows **0**; settlement_records / opening tables **absent**).

### A1) Host `16`

| Check | Result |
|---|---|
| Club / Player | Test Club `d616…8479` / player_id **`16`** (host in `club_memberships`) |
| Known carry | **None** — no tickets, lifetime net **0**, bankroll **0** |
| Null-club relationship | **None** |
| Unresolved carry  / settlement records | **None** (0 epoch, 0 settlement records, 0 legacy settlements) |
| Active-ticket cutover | **0** active/open |
| Why still $0-eligible | Host membership; empty betting history; no settlement primitives/rows to contradict clean open |

Tentative owner stance (prior): approved at **$0** **if** evidence still confirms above — **still confirms**. Do not write until bootstrap approval.

### A2) Test Player 3 `bc767309-…`

| Check | Result |
|---|---|
| Club / Player | Test Club `d616…8479` / **Test Player 3** (`testplayer3`) / `bc767309-6fc7-4585-9077-3de7b898df13` |
| Known carry | **None on record** — diagnostic lifetime **−44.70** only (\|net\| &lt; 100); not a signed cash residue |
| Null-club relationship | **None** (0 rows) |
| Unresolved carry  / settlement records | **None** (0 epoch, 0 settlement records, 0 legacy settlements) |
| Active-ticket cutover | **0** active/open (last grade 2026-09-09 01:46Z) |
| Why still $0-eligible | Immaterial diagnostic history under bootstrap heuristic; no ambiguous null-club; no active cutover; opening $0 means clean T0 start — **not** converting bankroll/P&L to debt |

Tentative owner stance (prior): approved at **$0** **if** evidence still confirms above — **still confirms**. Do not write until bootstrap approval.

---

## SCHEMA-WITH-FLAG-OFF SAFETY

### What exists now (prod)

| Primitive | Present? |
|---|---|
| `settlement_records` / `settlement_opening_balances` | **No** |
| `record_settlement_option_a_tx` / bootstrap RPC | **No** |
| Legacy `settlements` rows | **0** |
| BE cash flag | Scaffolded on feature branch; **default OFF** (`!== 'true'`) |

### Proposed deploy with `SETTLEMENT_RECORDING_ENABLED=false`

| Concern | Verdict |
|---|---|
| Existing balance changes (`balance_start`, tickets, bankroll) | **Safe** — additive empty tables; settle RPC append-only payments + optional audit ledger type; bootstrap inserts only when **explicitly invoked** (prod blocked without `force`) |
| Settlement calcs suddenly appear as cash **actions** | **Blocked** — `POST /api/host/settle-player` returns **503 `settlement_recording_disabled`** when flag ≠ `true` |
| Host can submit settlement recordingment | **No** while flag off (even if schema+RPC applied) |
| Ticket place / grade | **Unchanged** by settlement migrations |
| Cancel path | Unchanged until `PROPOSED_cancel_bet_tx_club_isolation.sql` applied; then cancel still only via approved `cancel_bet_tx` (harder club lock; no phantom $1000) — **not** a cash-settle path |
| App operates normally | **Yes** — betting SoT unchanged; preview may still show diagnostic carry fields with `settlementRecordingEnabled:false` / `settlementRecordingEnabled:false` (read-only UX signal; no write) |

### Required order (unchanged intent)

1. Schema (additive) **optional early** with flag **off**  
2. Compatible BE/FE with flag **off**  
3. Owner C decisions + T0 re-pick  
4. Bootstrap signed accounts only  
5. Enable flag **last**

**Without the flag gate:** applying settle RPC would make settle-player callable against lifetime-as-carry before bootstrap — **unsafe**. Flag scaffolding closes that hole.

---


---

## MORNING GATE OWNER DECISION — 2026-09-09 (planning only)

Owner approved settlement **opening position $0.00** for all five Test Club accounts below. This is **documentation only**.

| Account | Role | Opening (settlement position) | Written? |
|---|---|---|---|
| host `16` | Category A | $0.00 | **NO** |
| testplayer3 | Category A | $0.00 | **NO** |
| test-player-001 | Category C | $0.00 | **NO** |
| testplayer2 | Category C | $0.00 | **NO** |
| testplayer1 | Category C | $0.00 | **NO** |

**Scope:** settlement opening position ONLY.  
**Do NOT:** bootstrap RPCs, apply migrations, enable `SETTLEMENT_RECORDING_ENABLED`, mutate bankroll / `balance_start` / tickets / P&L / historical ledger.

## STATUS BLOCK

```
STATUS: OWNER SETTLEMENT DECISION TABLE
CATEGORY A: 2 still $0-eligible (host 16; bc767309/testplayer3) — tentative only; not written
CATEGORY C: 3/3 owner-approved OPEN AT $0 (planning only — NOT WRITTEN)
CATEGORY A+C OPENINGS: 5/5 approved at $0 — NOT WRITTEN
BOOTSTRAP/WRITE: DO NOT RUN until separate owner go-ahead + T0 re-pick
SCHEMA-WITH-FLAG-OFF SAFETY: SAFE IF flag remains false (scaffolded default OFF); tables/RPC additive; settle writes gated; place/grade unchanged
PRODUCTION DATA TOUCHED: NO
```

Companion: `docs/SETTLEMENT_PROD_OPENING_SIGNOFF.md`, `docs/settlement_prod_opening_dry_run.json`
