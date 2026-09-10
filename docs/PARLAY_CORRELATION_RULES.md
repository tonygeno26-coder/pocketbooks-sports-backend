# Parlay Correlation Rules (Pre-Beta)

**Status:** Fail-closed on unknown same-event correlation  
**Philosophy:** Detect dangerous combinations → refuse unless an SGP pricing source understands them. Do **not** invent correlation-adjusted odds.

## Relationships

| Code | Meaning | Placement |
|------|---------|-----------|
| `INDEPENDENT` | Different events / no shared outcome dependence | Allowed — product of standalone odds |
| `DUPLICATE` | Same selection twice | Reject |
| `MUTUALLY_EXCLUSIVE` | Both cannot win (e.g. both MLs, Over+Under) | Reject |
| `CORRELATED_SGP_REQUIRED` | Known same-event correlation (ML+spread, side+total, props, alts, period↔FG, total+team total) | Reject unless SGP engine supports |
| `UNSUPPORTED_CORRELATION` | Same-event unknown / unmapped markets | Reject (fail closed) |
| `DEPENDENT_FUTURE` | Futures / outrights in a multi-leg | Reject |

## Central API

```js
classifyLegRelationship(legA, legB) → { relationship, reason, message }
classifyAllPairs(legs)             → pair results
assertParlayCorrelationAllowed(legs, { betType })
sgpEngineSupportsCombination(...) // currently always false
```

Evaluated for **all pairs** on multi-leg tickets (`Parlay`, `RoundRobin`, `Teaser`, `SGP`). Singles are not gated.

## Covered patterns (owner §§1–20 summary)

1. **Duplicates** — same market + same selection  
2. **Mutually exclusive** — opposing MLs, Over/Under, opposite spreads  
3. **Overlapping alts** — same team different spread lines; same-side alt totals  
4. **Same-team / same-game ML + spread**  
5. **Game total + team total**  
6. **Player prop + team/game markets** (and multi-prop same event)  
7. **Unknown same-event** → `UNSUPPORTED_CORRELATION`  
8. **Different events** → `INDEPENDENT`  
9. **Futures** → `DEPENDENT_FUTURE`  
10. **Period ↔ full game**  
11. **Tennis / golf / racing / soccer hooks** — unknown same-event fail closed  
12. **Server authoritative** — `/api/bets/place` enforces before any money RPC  
13. **SGP routing** — only if `sgpEngineSupportsCombination` is true (not wired)  
14. **UX messages** — see `UX` map in module  
15. **Bet slip** — immediate classify on add / footer gate  
16. **Test matrix** — `tests/parlay-correlation.test.js` (FE + BE)  
17. **No fake SGP math** — FE removed 0.70/0.75/0.85 correlation discounts for correlated pricing paths  
18. **Rejected bets** — zero tickets, zero bankroll mutation, zero ledger mutation  
19. **Settlement recording** — OFF for this work; no settlement financial merge  
20. **Docs** — this file

## Hard rules

- Do **not** change grading/accounting formulas  
- Do **not** multiply standalone odds for correlated legs  
- Backend must enforce (client cannot bypass)  
- Prefer fail closed over silent accept  

## Files

| Repo | Path |
|------|------|
| Backend | `lib/parlay-correlation.js` |
| Backend gate | `index.js` → `/api/bets/place` |
| Backend tests | `tests/parlay-correlation.test.js` |
| Frontend | `parlay-correlation.js` |
| Frontend UI | `player.html` (slip + confirm) |
| Frontend tests | `tests/parlay-correlation.test.js` |

## SGP engine hook

`sgpEngineSupportsCombination` returns `false` until a real correlation pricing source is integrated. When that exists, `CORRELATED_SGP_REQUIRED` pairs may be allowed **only** for `betType === 'SGP'` and **only** with prices from that source — never client-invented multipliers.
