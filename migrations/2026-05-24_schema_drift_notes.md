# 2026-05-24 — Schema drift notes (NOT applied)

Things noticed while writing `2026-05-24_id_columns_text.sql` that look
like drift between `index.js` expectations and likely DB shape. None of
them blocked Phase A bet placement today, so they're flagged here for a
follow-up pass rather than crammed into one giant migration.

---

## 1. `audit_events` — never migrated

`index.js` writes to `audit_events` in 8+ places (bet place, cancel,
grade, manual override, etc.) with this shape:

```js
{
  event_type:  text,
  player_id:   text,
  club_id:     text,
  ticket_id:   text,
  payload:     jsonb
}
```

No migration in `migrations/` creates this table. It almost certainly
exists in the live DB (the inserts succeed), but the schema is not
codified anywhere we control. A reset-and-replay from git alone would
break.

**Action:** dump the current schema via `\d audit_events` in the SQL
editor and add a `2026-05-2X_audit_events.sql` migration.

---

## 2. `grade_overrides` — likely same story

Used at `index.js:6010`:

```js
await sb.from('grade_overrides').insert({
  ticket_id, player_id, club_id,
  result, override_code, reason,
  created_by, actor_role
});
```

No migration creates it. Same fix as `audit_events`.

---

## 3. `result_snapshots`, `prop_results`, `odds_snapshots` ID columns

Phase A bet placement doesn't touch the id types on these, so I left
them alone. But:

- `odds_snapshots` is the grading anchor for cashout (Phase B).
  Today's session noted props don't write to it — that's a *content*
  bug, not a type bug, but worth verifying the `id` column type matches
  whatever the cashout RPC will declare.
- `result_snapshots` is being populated by the worker. Confirm its
  `ticket_id` column (if any) is `text` — if it's still `uuid`, the
  grade pipeline will silently miss every JS-generated ticket.

**Action:** quick `information_schema.columns` audit on these three
tables. Add to the next migration if any column is still `uuid`.

---

## 4. `player_limits`, `club_risk_settings`

Read at `index.js:~4200` (risk check) and `~7113` (odds change policy):

- `club_risk_settings.club_id` — likely needs to be `text` to match
  `tickets.club_id`. JS does `.eq('club_id', clubId)` where `clubId` is
  the same opaque string that goes into tickets.
- `player_limits.player_id` / `club_id` — same story.

If these are still `uuid`, the lookup silently returns nothing and the
risk check falls back to defaults (allow-all). That's a real risk-bypass
hole worth checking before going live.

---

## 5. `worker_jobs` / job queue

Worker loop at `index.js:~6000`. Schema not in git. Same drill.

---

## 6. FK names

The §0 block in `2026-05-24_id_columns_text.sql` enumerates likely FK
names (e.g. `ticket_legs_ticket_id_fkey`). Postgres auto-names FKs based
on table + column, so these should match on a vanilla Supabase, but if
the Supabase UI was used to create them with custom names, the drop
will silently miss them.

**Action when applying:** before running the migration, run this in the
SQL editor and post the output:

```sql
SELECT conname, conrelid::regclass AS tbl, contype
  FROM pg_constraint
 WHERE contype='f'
   AND conrelid::regclass::text
       IN ('tickets','ticket_legs','ledger_entries','club_members');
```

If any FK name in the result isn't in the migration's §0 list, add it
before running, or the ALTER TYPE will fail.

---

## 7. The `american_odds` mention in the task brief

Task brief said to check for an `american_odds` column on `ticket_legs`.
Grep of `index.js` shows only:

- `odds` (numeric, legacy)
- `accepted_odds_american` (numeric, Phase K snapshot)

No bare `american_odds` anywhere. Possibly a name from an earlier draft.
I didn't add it. If it shows up in a worker or grading script not in
`index.js`, add it as a separate one-line ALTER TABLE.

---

## 8. `tickets.odds` column type

`index.js:1540` writes `odds: ticket.odds ? String(ticket.odds) : null`,
i.e. a string. So `tickets.odds` is `text` (not numeric). The migration
codifies it as `text`. But `ticket_legs.odds` is numeric (JS writes
`typeof sel.odds === 'number' ? sel.odds : null`). Different types on
purpose — don't "normalize" them.

---

## TL;DR for next session

The Phase A money path is clean after `2026-05-24_id_columns_text.sql`.
The drift above is "stuff that will bite us when we ship Phase B
(cashout) or when we onboard a brand-new Supabase from scratch." None of
it is a fire today.
