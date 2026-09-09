'use strict';
/**
 * P0 cancel_bet_tx isolation matrix + phantom1000 (JS sim of proposed SQL).
 * Run: node tests/cancel-bet-tx-isolation-matrix.test.js
 */
const assert = require('assert');
const sim = require('../fixtures/nonprod/cancel_bet_tx_sim');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.error('  ❌ ' + name + '\n     ' + e.message); fail++; }
}

function baseSeed() {
  return sim.createStore({
    club_members: [
      { club_id: 'clubA', player_id: 'p1', balance_start: 1000 },
      { club_id: 'clubB', player_id: 'p1', balance_start: 500 }
    ],
    tickets: [
      { id: 'tA1', club_id: 'clubA', player_id: 'p1', status: 'active', risk_amount: 100, potential_profit: 91 },
      { id: 'tB1', club_id: 'clubB', player_id: 'p1', status: 'active', risk_amount: 50, potential_profit: 45 },
      { id: 'tA_won', club_id: 'clubA', player_id: 'p1', status: 'won', risk_amount: 20, potential_profit: 18 },
      { id: 'tA_lost', club_id: 'clubA', player_id: 'p1', status: 'lost', risk_amount: 30, potential_profit: 0 }
    ],
    ledger_entries: []
  });
}

console.log('\n── cancel_bet_tx isolation matrix (proposed) ──');

test('valid: same club+player+ticket cancels and refunds risk', function() {
  var store = baseSeed();
  var r = sim.cancelBetTx(store, {
    ticketId: 'tA1', clubId: 'clubA', playerId: 'p1',
    idempotencyKey: 'CAN_A1', reason: 'test'
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.refund, 100);
  assert.strictEqual(r.status, 'canceled');
  assert.strictEqual(store.tickets.find(function(t){ return t.id === 'tA1'; }).status, 'canceled');
  // bankroll presentation: start 1000 - open(100+0 after cancel still counts before update...)
  // Before cancel: open = tA1(100)+ (only active in A) = 100; gains=18; losses=30
  // balance_before = 1000 - 100 - 30 + 18 = 888; after = 888 + 100 = 988
  assert.strictEqual(r.balance_before, 888);
  assert.strictEqual(r.balance_after, 988);
});

test('wrong club rejected (ticket_club_mismatch)', function() {
  var store = baseSeed();
  var r = sim.cancelBetTx(store, {
    ticketId: 'tA1', clubId: 'clubB', playerId: 'p1', idempotencyKey: 'CAN_WRONG_CLUB'
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'ticket_club_mismatch');
  assert.strictEqual(store.tickets.find(function(t){ return t.id === 'tA1'; }).status, 'active');
});

test('wrong player rejected (ticket_player_mismatch)', function() {
  var store = baseSeed();
  var r = sim.cancelBetTx(store, {
    ticketId: 'tA1', clubId: 'clubA', playerId: 'p2', idempotencyKey: 'CAN_WRONG_P'
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'ticket_player_mismatch');
});

test('missing membership → no_club_member_balance_found (no phantom1000)', function() {
  var store = sim.createStore({
    club_members: [],
    tickets: [{ id: 'tX', club_id: 'clubA', player_id: 'orphan', status: 'active', risk_amount: 25, potential_profit: 20 }],
    ledger_entries: []
  });
  var phantom = sim.cancelBetTxLegacyPhantom(store, { clubId: 'clubA', playerId: 'orphan' });
  assert.strictEqual(phantom.usedPhantom, true);
  assert.strictEqual(phantom.phantomStart, 1000);

  var r = sim.cancelBetTx(store, {
    ticketId: 'tX', clubId: 'clubA', playerId: 'orphan', idempotencyKey: 'CAN_ORPHAN'
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no_club_member_balance_found');
  assert.ok(r.phantomStart === undefined);
});

test('two clubs: cancel in B does not touch A ticket or A balance math', function() {
  var store = baseSeed();
  var r = sim.cancelBetTx(store, {
    ticketId: 'tB1', clubId: 'clubB', playerId: 'p1', idempotencyKey: 'CAN_B1'
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.refund, 50);
  assert.strictEqual(store.tickets.find(function(t){ return t.id === 'tA1'; }).status, 'active');
  // Club B: start 500 - open 50 = 450 before; after 500
  assert.strictEqual(r.balance_before, 450);
  assert.strictEqual(r.balance_after, 500);
});

test('duplicate cancel / idempotent replay', function() {
  var store = baseSeed();
  var r1 = sim.cancelBetTx(store, {
    ticketId: 'tA1', clubId: 'clubA', playerId: 'p1', idempotencyKey: 'CAN_DUP'
  });
  var r2 = sim.cancelBetTx(store, {
    ticketId: 'tA1', clubId: 'clubA', playerId: 'p1', idempotencyKey: 'CAN_DUP'
  });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.idempotent, false);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.idempotent, true);
  assert.strictEqual(r2.refund, 100);
  assert.strictEqual(store.ledger_entries.filter(function(e){ return e.id === 'CAN_DUP'; }).length, 1);
});

test('already canceled → invalid_transition', function() {
  var store = baseSeed();
  sim.cancelBetTx(store, {
    ticketId: 'tA1', clubId: 'clubA', playerId: 'p1', idempotencyKey: 'CAN1'
  });
  var r = sim.cancelBetTx(store, {
    ticketId: 'tA1', clubId: 'clubA', playerId: 'p1', idempotencyKey: 'CAN2'
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'invalid_transition');
});

test('already graded (won) → invalid_transition', function() {
  var store = baseSeed();
  var r = sim.cancelBetTx(store, {
    ticketId: 'tA_won', clubId: 'clubA', playerId: 'p1', idempotencyKey: 'CAN_WON'
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'invalid_transition');
});

test('cancel economics unchanged: refund equals risk_amount only', function() {
  var store = baseSeed();
  var r = sim.cancelBetTx(store, {
    ticketId: 'tA1', clubId: 'clubA', playerId: 'p1', idempotencyKey: 'CAN_ECON'
  });
  assert.strictEqual(r.refund, 100);
  assert.ok(r.balance_after === r.balance_before + r.refund);
});

console.log('\n── Results: ' + pass + ' passed, ' + fail + ' failed ──');
process.exit(fail ? 1 : 0);
