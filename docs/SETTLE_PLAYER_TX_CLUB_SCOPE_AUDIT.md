# settle_player_tx club-scope safety audit

**Date:** 2026-09-08  
**Project:** `padgicwrrzmukahfsyhk` (read-only MCP `execute_sql`)  
**Branch:** `cursor/settlement-partial-carry` @ `bdee035`  
**Migration file:** `migrations/PROPOSED_settle_player_tx_club_scope.sql`  
**Applied to production:** NO

## Decision summary

| Item | Status |
|---|---|
| Live RPC inspected | YES — **ABSENT** |
| Exact CREATE OR REPLACE from live body | **BLOCKED** (no function) |
| DB objects changed | NONE |
| Indexes / constraints added | NONE |
| Caller changes required | NO (BE already club-prefixes keys) |
| Rollback | N/A |
| Migration changes financial values | N/A / zero by design |
| Recommendation | **DO NOT APPLY** |

## Exact diffs (intended, when live body exists)

### 1. Current live idempotency logic
N/A — `pg_get_functiondef` returned 0 rows for `settle_player_tx`.

Documented historical risk:

```sql
PERFORM 1 FROM ledger
  WHERE settlement_id = p_settlement_id
    AND event_type = 'SETTLEMENT_APPLIED'
  LIMIT 1;
```

### 2. Proposed replacement

```sql
PERFORM 1 FROM ledger
  WHERE club_id = p_club_id
    AND settlement_id = p_settlement_id
    AND event_type = 'SETTLEMENT_APPLIED'
  LIMIT 1;
```

Only this lookup changes. Preserve signature, accounting, ledger writes, balances, return schema, security.

### 3. Complete SQL migration
See `migrations/PROPOSED_settle_player_tx_club_scope.sql` — currently a **no-op NOTICE stub** that refuses to invent an RPC. When `settle_player_tx` appears, regenerate full `CREATE OR REPLACE` from live `pg_get_functiondef` + the patch above.

### 4. Why club-safe
`club-a::abc123` and `club-b::abc123` must not collide. RPC lookup on `(club_id, settlement_id)` enforces isolation even if a caller omits the app prefix.

### 5. Callers?
No. BE settle-player already passes `p_club_id` and club-scoped `p_settlement_id` / `p_idempotency_key`.

### 6. Indexes/constraints?
Optional supporting index `(club_id, settlement_id)` filtered to `SETTLEMENT_APPLIED`. Do **not** unique on `settlement_id` alone. Not required for this step; do not apply without reviewed live schema.

### 7. Existing rows?
No `public.ledger` on this project. `ledger_entries.id` already receives club-prefixed settlement mirrors from the app.

### 8. Rollback
Nothing applied. Future rollback = restore pre-apply `pg_get_functiondef` snapshot (never DROP).

## Cross-club invariant
Same key + same player + different club → independent ops. App `clubId::idempotencyKey` is defense-in-depth; RPC must also be club-scoped when it exists.

## Tests
Not runnable against production RPC (missing). On non-prod after real patch: same-club idempotent; cross-club independent; different player independent unless live design says otherwise; retry no double-apply; before/after balance sums unchanged. Re-run carry / cross-club / UI suites on settlement branch only.

## Next human approval sequence
1. Deploy/confirm `settle_player_tx` + `ledger` exist in target DB  
2. Regenerate migration from live definition + club_id patch  
3. Apply non-prod → tests  
4. Approve production apply → deploy BE `bdee035` → merge FE `6cfe713` → smoke test players only  

**Do not merge settlement branch or push financial-path changes to main until that sequence clears.**
