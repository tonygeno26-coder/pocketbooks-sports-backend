'use strict';

const assert = require('assert');
const daily = require('../lib/daily-audit');

function mockSb(tables) {
  return {
    from: function(name) {
      const rows = tables[name] || [];
      let filters = [];
      const api = {
        select: function() { return api; },
        eq: function(col, val) { filters.push(function(r) { return String(r[col]) === String(val); }); return api; },
        in: function(col, vals) {
          const set = {};
          (vals || []).forEach(function(v) { set[String(v)] = true; });
          filters.push(function(r) { return !!set[String(r[col])]; });
          return api;
        },
        gte: function(col, val) { filters.push(function(r) { return String(r[col] || '') >= String(val); }); return api; },
        order: function() { return api; },
        limit: function() { return api; },
        range: function(from, to) {
          let out = rows.slice();
          filters.forEach(function(fn) { out = out.filter(fn); });
          return Promise.resolve({ data: out.slice(from, to + 1), error: null });
        },
        insert: function(row) {
          const saved = Object.assign({ id: 'AUD_TEST' }, row);
          return {
            select: function() {
              return {
                limit: function() {
                  return Promise.resolve({ data: [saved], error: null });
                }
              };
            }
          };
        }
      };
      return api;
    }
  };
}

test('msUntilNext4amUtc waits until today 4:00 when before 4am', function() {
  const now = Date.UTC(2026, 7, 30, 3, 0, 0, 0);
  const delay = daily.msUntilNext4amUtc(now);
  assert.strictEqual(delay, 60 * 60 * 1000);
});

test('msUntilNext4amUtc waits until tomorrow when after 4am', function() {
  const now = Date.UTC(2026, 7, 30, 5, 0, 0, 0);
  const delay = daily.msUntilNext4amUtc(now);
  assert.strictEqual(delay, 23 * 60 * 60 * 1000);
});

test('msUntilNext4amUtc is 0 at exactly 4:00 UTC', function() {
  const now = Date.UTC(2026, 7, 30, 4, 0, 0, 0);
  assert.strictEqual(daily.msUntilNext4amUtc(now), 0);
});

test('placement check flags ticket without BET_PLACED/bet_placed', function() {
  const tickets = [{ id: 'T1', player_id: 'p1', club_id: 'c1', risk_amount: 100, status: 'active' }];
  const r = daily.checkBetPlacement(tickets, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.critical, 1);
  assert.strictEqual(r.issues[0].code, 'missing_placement_debit');
});

test('placement check accepts BET_PLACED or bet_placed', function() {
  const tickets = [{ id: 'T1', player_id: 'p1', club_id: 'c1', risk_amount: 50, status: 'active' }];
  const okCanon = daily.checkBetPlacement(tickets, { T1: [{ ticket_id: 'T1', event_type: 'BET_PLACED', amount: -50 }] });
  const okOps = daily.checkBetPlacement(tickets, { T1: [{ ticket_id: 'T1', type: 'bet_placed', amount: -50 }] });
  assert.strictEqual(okCanon.ok, true);
  assert.strictEqual(okOps.ok, true);
});

test('grading check matches win/loss/push/void event types', function() {
  const won = daily.checkGrading(
    [{ id: 'W', status: 'won', risk_amount: 100, potential_profit: 90 }],
    { W: [{ ticket_id: 'W', type: 'bet_won', amount: 190 }] }
  );
  const lost = daily.checkGrading(
    [{ id: 'L', status: 'lost', risk_amount: 100, potential_profit: 90 }],
    { L: [{ ticket_id: 'L', type: 'BET_GRADED_LOSS', amount: 0 }] }
  );
  const push = daily.checkGrading(
    [{ id: 'P', status: 'push', risk_amount: 100, potential_profit: 0 }],
    { P: [{ ticket_id: 'P', type: 'bet_push', amount: 100 }] }
  );
  const canceled = daily.checkGrading(
    [{ id: 'C', status: 'canceled', risk_amount: 25, potential_profit: 0 }],
    { C: [{ ticket_id: 'C', type: 'BET_CANCELED_REFUND', amount: 25 }] }
  );
  assert.strictEqual(won.ok, true);
  assert.strictEqual(lost.ok, true);
  assert.strictEqual(push.ok, true);
  assert.strictEqual(canceled.ok, true);
});

test('dashboard available formula matches player dashboard', function() {
  const tickets = [
    { status: 'active', risk_amount: 40, potential_profit: 36 },
    { status: 'won', risk_amount: 100, potential_profit: 90 },
    { status: 'lost', risk_amount: 20, potential_profit: 18 },
    { status: 'push', risk_amount: 10, potential_profit: 0 },
    { status: 'canceled', risk_amount: 5, potential_profit: 0 }
  ];
  const r = daily.dashboardAvailable(1000, tickets);
  assert.strictEqual(r.available, 1000 - 40 - 20 + 90);
});

test('balance check flags dashboard vs ledger mismatch', function() {
  const members = [{ club_id: 'c1', player_id: 'p1', balance_start: 1000 }];
  const tickets = [{ club_id: 'c1', player_id: 'p1', status: 'lost', risk_amount: 100, potential_profit: 0 }];
  const ledger = [{ club_id: 'c1', player_id: 'p1', type: 'bet_placed', amount: -50 }];
  const r = daily.checkBalances(members, tickets, ledger);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.issues[0].code, 'balance_mismatch');
});

test('diamond check compares stored balance to credits minus debits', function() {
  const empty = daily.checkDiamonds(
    [{ club_id: 'c1', balance_diamonds: 500 }],
    []
  );
  assert.strictEqual(empty.warning, 1);
  assert.strictEqual(empty.issues[0].code, 'diamond_ledger_empty');

  const matched = daily.checkDiamonds(
    [{ club_id: 'c1', balance_diamonds: 85 }],
    [
      { club_id: 'c1', amount_diamonds: 100, direction: 'credit' },
      { club_id: 'c1', amount_diamonds: 15, direction: 'debit' }
    ]
  );
  assert.strictEqual(matched.ok, true);
});

test('orphan check flags ledger ticket_id with no ticket', function() {
  const r = daily.checkOrphans(
    [{ id: 'LE1', ticket_id: 'MISSING', type: 'bet_placed', amount: -10 }],
    new Set(['T1'])
  );
  assert.strictEqual(r.warning, 1);
  assert.strictEqual(r.issues[0].code, 'orphan_ledger_ticket');
});

test('duplicate check flags repeated idempotency keys', function() {
  const r = daily.checkDuplicates(
    [{ id: 'IK1' }, { id: 'IK1' }],
    [],
    []
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.issues[0].code, 'duplicate_idempotency_key');
});

test('runAndPersist is read-only and writes audit_log only', async function() {
  const sb = mockSb({
    tickets: [{ id: 'T1', club_id: 'c1', player_id: 'p1', status: 'active', risk_amount: 10, potential_profit: 9, placed_at: new Date().toISOString() }],
    club_members: [{ club_id: 'c1', player_id: 'p1', balance_start: 1000, status: 'approved' }],
    ledger_entries: [{ id: 'IK1', club_id: 'c1', player_id: 'p1', ticket_id: 'T1', type: 'bet_placed', amount: -10, created_at: new Date().toISOString() }],
    host_diamond_balances: [{ club_id: 'c1', host_actor_id: 'h1', balance_diamonds: 0 }],
    host_diamond_ledger: []
  });
  const out = await daily.runAndPersist(sb, { auditType: 'manual', triggeredBy: 'actor-1' });
  assert.strictEqual(out.summary.auditType, 'manual');
  assert.strictEqual(out.summary.triggeredBy, 'actor-1');
  assert.strictEqual(out.summary.checksRun, 6);
  assert.strictEqual(out.summary.id, 'AUD_TEST');
  assert.strictEqual(out.result.results.readOnly, true);
});
