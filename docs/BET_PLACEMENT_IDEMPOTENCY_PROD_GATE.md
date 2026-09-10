# BET PLACEMENT IDEMPOTENCY — Production Migration Gate

**Status:** `IDEMPOTENCY SQL APPLIED — CUTOVER CODE FIX`  
**Date:** 2026-09-10  
**BE cutover branch:** `cursor/idempotency-cutover-complete`  
**Prior remediation:** `cursor/idempotency-remediation` @ `40e7f1f` (already on main lineage)  
**FE:** `8bbff41`  
**PRODUCTION SQL APPLIED:** **YES** — `20260910073233` `idempotency_keys_scoped`  
**DO NOT RE-APPLY / DO NOT DROP**  
**settlement recording:** OFF  
**Canonical review:** `docs/IDEMPOTENCY_FINAL_OWNER_REVIEW.md`  
**Checklist:** `docs/BETA_RELEASE_CHECKLIST.md`

---

## CURRENT STATE

| Layer | Today |
|-------|-------|
| Prod `idempotency_keys` | Present; PK `(club_id, player_id, client_key)`; expires_at index; status CHECK |
| BE money path | Fail-closed durable store; scoped ledger `scoped_hash_v1` |
| Correlation × idem | Error responses must not write phantom `ticket_id` (cutover fix) |
| Retention | Packaged; **not scheduled** (not blocker) |

## Apply order (historical — already done)

1. cancel_bet_tx club isolation (`20260910062602`)
2. Path A `idempotency_keys_scoped` (`20260910073233`)
3. BE code with durable store + dual-read (on `91ebca0` lineage)
4. Cutover fix: middleware omits deterministic ticket on non-success JSON

## Rollback

**Do not rollback table during this cutover.** Companion file remains `ROLLBACK_idempotency_keys_scoped.sql` for emergency owner-only use — not authorized here.
