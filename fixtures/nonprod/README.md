# Non-prod settlement fixture

Isolated local Postgres DB for Option A validation.

- **DB name:** `pb_settlement_nonprod` (localhost)
- **Never:** `padgicwrrzmukahfsyhk` / production Supabase
- **Apply:** `NONPROD_DATABASE_URL=postgres://localhost:5432/pb_settlement_nonprod node fixtures/nonprod/apply_and_test.js`
- **Rehearsal:** `node fixtures/nonprod/concurrency_and_bootstrap_rehearsal.js` → `LAST_REHEARSAL.json`
- **SQL:** `schema_minimal.sql` + proposed settlement_records / opening_balances / record_settlement_option_a_tx / bootstrap_settlement_opening_epoch / cancel_bet_tx isolation
- **Evidence:** `LAST_APPLY.json` after a successful apply
- **JS fallback:** `cancel_bet_tx_sim.js` + `tests/cancel-bet-tx-isolation-matrix.test.js` (no Postgres required)
- **Final gate doc:** `docs/SETTLEMENT_FINAL_NONPROD_GATE.md`
