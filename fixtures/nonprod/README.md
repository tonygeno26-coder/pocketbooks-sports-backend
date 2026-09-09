# Non-prod settlement fixture

Isolated local Postgres DB for Option A validation.

- **DB name:** `pb_settlement_nonprod` (localhost)
- **Never:** `padgicwrrzmukahfsyhk` / production Supabase
- **Apply:** `NONPROD_DATABASE_URL=postgres://localhost:5432/pb_settlement_nonprod node fixtures/nonprod/apply_and_test.js`
- **SQL:** `schema_minimal.sql` + `migrations/PROPOSED_settlement_payments.sql` + `migrations/PROPOSED_cancel_bet_tx_club_isolation.sql`
- **Evidence:** `LAST_APPLY.json` after a successful run
- **JS fallback:** `cancel_bet_tx_sim.js` + `tests/cancel-bet-tx-isolation-matrix.test.js` (no Postgres required)
