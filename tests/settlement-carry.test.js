'use strict';
/**
 * Settlement partial-carry matrix tests.
 * Run: node tests/settlement-carry.test.js
 */
const assert = require('assert');
const sc = require('../lib/settlement-carry');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.error('  ❌ ' + name + '\n     ' + e.message); fail++; }
}

console.log('\n── Partial settlement toward zero ──');

test('-500 + 200 → -300', function() {
  var r = sc.applyPartialSettlement(-500, 200);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.after, -300);
  assert.strictEqual(r.direction, 'player_paid_host');
});

test('-500 + 500 → 0', function() {
  var r = sc.applyPartialSettlement(-500, 500);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.after, 0);
});

test('-500 + 600 never +100 (reject)', function() {
  var r = sc.applyPartialSettlement(-500, 600);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'over_settlement_blocked');
  assert.strictEqual(r.maxAmount, 500);
  assert.strictEqual(r.before, -500);
});

test('+500 + 200 → +300', function() {
  var r = sc.applyPartialSettlement(500, 200);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.after, 300);
  assert.strictEqual(r.direction, 'host_paid_player');
});

test('+500 + 500 → 0', function() {
  var r = sc.applyPartialSettlement(500, 500);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.after, 0);
});

test('+500 + 600 never -100 (reject)', function() {
  var r = sc.applyPartialSettlement(500, 600);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'over_settlement_blocked');
  assert.strictEqual(r.maxAmount, 500);
});

test('0 + settlement → no meaningful tx', function() {
  var r = sc.applyPartialSettlement(0, 50);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'balance_already_zero');
});

test('blank/$0 → no op', function() {
  assert.strictEqual(sc.applyPartialSettlement(-100, 0).ok, false);
  assert.strictEqual(sc.applyPartialSettlement(-100, '').error, 'no_op_zero_or_blank');
  assert.strictEqual(sc.applyPartialSettlement(-100, null).error, 'no_op_zero_or_blank');
});

console.log('\n── Derive carry + week roll ──');

test('derive: ticketNet -500 + paid 200 → -300', function() {
  assert.strictEqual(sc.deriveSettlementCarry(-500, 200, 0), -300);
});

test('derive: ticketNet +500 - hostPaid 200 → +300', function() {
  assert.strictEqual(sc.deriveSettlementCarry(500, 0, 200), 300);
});

test('no settlement carries unchanged into next week + new net', function() {
  // prior -500, no settle, week2 net +200 → -300
  assert.strictEqual(sc.carryIntoNextWeek(-500, 200), -300);
  // prior +300, week net -500 → -200 (betting may cross zero)
  assert.strictEqual(sc.carryIntoNextWeek(300, -500), -200);
});

test('partial then rollover: carry preserved mathematically', function() {
  var afterPartial = sc.applyPartialSettlement(-500, 200).after; // -300
  var afterWeek = sc.carryIntoNextWeek(afterPartial, -100); // -400
  assert.strictEqual(afterWeek, -400);
});

test('rollover then partial', function() {
  var afterWeek = sc.carryIntoNextWeek(-200, -300); // -500
  var afterPartial = sc.applyPartialSettlement(afterWeek, 150);
  assert.strictEqual(afterPartial.after, -350);
});

test('splitOwes mirrors signed carry', function() {
  assert.deepStrictEqual(sc.splitOwes(-300), { owesHost: 300, hostOwes: 0, settlementBalance: -300 });
  assert.deepStrictEqual(sc.splitOwes(300), { owesHost: 0, hostOwes: 300, settlementBalance: 300 });
  assert.deepStrictEqual(sc.splitOwes(0), { owesHost: 0, hostOwes: 0, settlementBalance: 0 });
});

test('historical epoch marker detects rollover SETTLEMENT_APPLIED only', function() {
  assert.strictEqual(sc.isHistoricalEpochMarker({
    id: 'SETTLEMENT_APPLIED_club_2026-W01_p1', type: 'SETTLEMENT_APPLIED', reason: 'weekly_rollover:2026-W01'
  }), true);
  assert.strictEqual(sc.isHistoricalEpochMarker({
    id: 'SETTLE_abc', type: 'settlement', reason: 'player_paid_host'
  }), false);
  assert.strictEqual(sc.isHistoricalEpochMarker({
    id: 'LE_SE_xyz', type: 'SETTLEMENT_APPLIED', reason: 'settlement:player_owes_host'
  }), false);
  assert.strictEqual(sc.isHistoricalEpochMarker({ type: 'weekly_rollover' }), true);
});

test('multi-player isolation (pure): separate balances', function() {
  var a = sc.applyPartialSettlement(-500, 200).after;
  var b = sc.applyPartialSettlement(400, 100).after;
  assert.strictEqual(a, -300);
  assert.strictEqual(b, 300);
});

console.log('\n── Source wiring guards ──');

test('index.js stops writing SETTLEMENT_APPLIED on weekly-rollover', function() {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.indexOf('DO NOT write SETTLEMENT_APPLIED epoch markers on rollover') !== -1);
  assert.ok(src.indexOf("require('./lib/settlement-carry')") !== -1);
  assert.ok(src.indexOf('carryPreserved: true') !== -1);
  // Ensure the old upsert block for rollover SETTLEMENT_APPLIED id pattern is gone from active path
  const rolloverFn = src.slice(src.indexOf("app.post('/api/host/weekly-rollover'"), src.indexOf("app.get('/api/host/rollover-history'"));
  assert.ok(rolloverFn.indexOf("id: entryId") === -1 || rolloverFn.indexOf('SETTLEMENT_APPLIED_') === -1);
  assert.ok(rolloverFn.indexOf("type: 'SETTLEMENT_APPLIED'") === -1);
});

test('record-settlement uses serialized RPC + over_settlement_blocked', function() {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const start = src.indexOf('async function _handleRecordSettlement');
  const end = src.indexOf("app.post('/api/host/weekly-rollover'");
  assert.ok(start !== -1 && end !== -1 && end > start);
  const settleFn = src.slice(start, end);
  assert.ok(settleFn.indexOf("record_settlement_option_a_tx") !== -1);
  assert.ok(settleFn.indexOf('balanceBefore') !== -1);
  assert.ok(settleFn.indexOf('over_settlement_blocked') !== -1);
  assert.ok(settleFn.indexOf('serialized: true') !== -1);
  assert.ok(settleFn.indexOf('lock_timeout') !== -1);
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'settlement-carry.js'), 'utf8');
  assert.ok(lib.indexOf('function applyPartialSettlement') !== -1);
});

console.log('\n── Results: ' + pass + ' passed, ' + fail + ' failed ──');
process.exit(fail ? 1 : 0);
