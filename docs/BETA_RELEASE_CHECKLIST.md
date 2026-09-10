# BETA RELEASE CHECKLIST — FINAL CORE / IDEMPOTENCY CUTOVER

**Date:** 2026-09-10  
**Settlement recording:** OFF  
**SGP pricing:** OFF  
**Railway cutover SHA:** `55b52d1`  
**Prod SQL:** `idempotency_keys_scoped` APPLIED (`20260910073233`) — do not re-apply / do not drop

Use only: `PASS` | `FAIL` | `BLOCKED` | `NOT TESTED` | `NOT RUN`

| Gate | Result | Notes |
|------|--------|-------|
| Prod table present + scoped PK | PASS | `(club_id,player_id,client_key)` + expires_at idx |
| Schema match Path A | PASS | |
| Railway deploy cutover SHA | PASS | `55b52d1` SUCCESS |
| Unit concurrent 2x / 10x | PASS | ticket delta=1 |
| Live exact retry | PASS | same ticket |
| Live concurrent 2x | PASS | uniqueTickets=1 |
| Live concurrent 10x | PASS | uniqueTickets=1 |
| Live changed request | PASS | 409 idempotency_conflict |
| Unit response-loss / restart / stale | PASS | |
| Correlation reject + retry | PASS | 422; DB `failed` + `ticket_id` NULL |
| Cancel lifecycle (designated) | PASS | cancel 200 |
| Auth A→B dashboard IDOR | PASS | 403 permission_denied |
| Auth B→A dashboard IDOR | PASS | 403 permission_denied |
| Cross-club live | NOT TESTED | same Test Club only |
| Full PLACE→grade→Results | NOT RUN | smoke stopped at place/cancel |
| Retention scheduled | NOT TESTED | documented; not blocker |
| Settlement recording | OFF | |
| Legacy orphan failed rows w/ MISSING ticket_id | PASS* | 12 pre-fix orphans remain; no new phantoms post-`55b52d1` |
| Safe for wider beta | PASS | Settlement OFF; designated smoke green; no double-ticket |

\* Pre-cutover phantom `ticket_id` on failed rows are metadata-only; post-fix failed rows use `ticket_id` NULL.
