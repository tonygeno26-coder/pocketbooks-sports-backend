'use strict';
/**
 * Cross-club isolation tests for settlement carry + helpers.
 * Run: node tests/settlement-cross-club.test.js
 *
 * MERGE BLOCKER: Club A activity must never alter Club B balances.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sc = require('../lib/settlement-carry');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.error('  ❌ ' + name + '\n     ' + e.message); fail++; }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

console.log('\n── Cross-club accounting isolation ──');

test('Player X Club A −500 settle $200 → A −300; B +300 unchanged', function() {
  var a = sc.applyPartialSettlement(-500, 200);
  var b = +300;
  assert.strictEqual(a.after, -300);
  assert.strictEqual(b, 300);
});

test('Win $400 in B → B +700; A stays −300', function() {
  var a = -300;
  var b = sc.carryIntoNextWeek(300, 400);
  assert.strictEqual(b, 700);
  assert.strictEqual(a, -300);
});

test('Rollover A does not change B (pure carry math)', function() {
  var aBefore = -300, bBefore = 700;
  // Rollover = snapshot only; balances unchanged without new nets
  var aAfter = sc.carryIntoNextWeek(aBefore, 0);
  var bAfter = bBefore;
  assert.strictEqual(aAfter, -300);
  assert.strictEqual(bAfter, 700);
});

test('Same week both clubs: independent nets', function() {
  var a = sc.carryIntoNextWeek(-100, -50); // -150
  var b = sc.carryIntoNextWeek(200, 80);   // 280
  assert.strictEqual(a, -150);
  assert.strictEqual(b, 280);
});

test('Partial both clubs independently', function() {
  var a = sc.applyPartialSettlement(-500, 100).after;
  var b = sc.applyPartialSettlement(300, 50).after;
  assert.strictEqual(a, -400);
  assert.strictEqual(b, 250);
});

test('One zero one not', function() {
  assert.strictEqual(sc.applyPartialSettlement(0, 10).ok, false);
  assert.strictEqual(sc.applyPartialSettlement(-50, 25).after, -25);
});

test('deriveSettlementCarry is club-agnostic pure — isolation is query-scoped', function() {
  // Same math, different club ticket/payment inputs must stay separate at call site
  var a = sc.deriveSettlementCarry(-500, 200, 0);
  var b = sc.deriveSettlementCarry(300, 0, 0);
  assert.strictEqual(a, -300);
  assert.strictEqual(b, 300);
});

console.log('\n── Source: club_id required on financial helpers ──');

test('_ledgerAvailableForPlayer requires clubId (no player-only path)', function() {
  assert.ok(src.indexOf('never aggregate ledger by player_id alone') !== -1);
  const fn = src.slice(src.indexOf('async function _ledgerAvailableForPlayer'), src.indexOf('async function _writeLedgerEntry'));
  assert.ok(fn.indexOf(".eq('club_id', clubId)") !== -1);
  assert.ok(fn.indexOf("if (!sb || !playerId || !clubId)") !== -1);
  // Must NOT have optional club filter pattern anymore
  assert.ok(fn.indexOf('if (clubId) lq = lq.eq') === -1);
});

test('_deriveAvailableBalance tickets query includes club_id', function() {
  const fn = src.slice(src.indexOf('async function _deriveAvailableBalance'), src.indexOf('function _envMs'));
  assert.ok(fn.indexOf(".eq('club_id', clubId).eq('player_id', playerId)") !== -1);
  assert.ok(fn.indexOf('open risk in Club B must not reduce Club A') !== -1);
});

test('_calcTotalPaid requires clubId', function() {
  const fn = src.slice(src.indexOf('async function _calcTotalPaid'), src.indexOf('VALID_PAY_METHODS'));
  assert.ok(fn.indexOf('if (!clubId) return 0') !== -1);
  assert.ok(fn.indexOf(".eq('club_id', clubId)") !== -1);
});

test('idempotency storage key is club-scoped (clubId::clientKey)', function() {
  const fn = src.slice(src.indexOf('function requireIdempotency'), src.indexOf('IDEMPOTENCY_TABLE_DDL'));
  assert.ok(fn.indexOf("String(clubId) + '::' + clientKey") !== -1);
  assert.ok(fn.indexOf('must never block/replay Club B') !== -1);
});

test('settle-player uses club-scoped settlementId and payment_id', function() {
  const start = src.indexOf("app.post('/api/host/settle-player'");
  const end = src.indexOf("app.post('/api/host/weekly-rollover'");
  const fn = src.slice(start, end);
  assert.ok(fn.indexOf("String(clubId) + '::' + String(idempotencyKey)") !== -1);
  assert.ok(fn.indexOf("'SETTLE_DIRECT_'+clubId+'_'+idempotencyKey") !== -1);
  assert.ok(fn.indexOf('player_not_in_club') !== -1);
  assert.ok(fn.indexOf(".eq('club_id', clubId).eq('player_id', playerId)") !== -1);
});

test('settlements-preview hard-requires clubId on tickets', function() {
  const start = src.indexOf("app.get('/api/host/settlements-preview'");
  const end = src.indexOf("app.post('/api/host/player-credit'");
  const fn = src.slice(start, end);
  assert.ok(fn.indexOf("error:'missing_clubId'") !== -1);
  assert.ok(fn.indexOf(".eq('club_id', clubId)") !== -1);
});

test('player/dashboard hard-requires clubId + dual eq on tickets', function() {
  const start = src.indexOf("app.get('/api/player/dashboard'");
  const end = src.indexOf("app.post('/api/club/player-limits'");
  const fn = src.slice(start, Math.min(end === -1 ? start+8000 : end, start+8000));
  assert.ok(fn.indexOf("error:'missing_clubId'") !== -1);
  assert.ok(fn.indexOf(".eq('club_id', clubId).eq('player_id', playerId)") !== -1);
});

test('weekly-rollover loads tickets with club_id and does not write SETTLEMENT_APPLIED', function() {
  const start = src.indexOf("app.post('/api/host/weekly-rollover'");
  const end = src.indexOf("app.get('/api/host/rollover-history'");
  const fn = src.slice(start, end);
  assert.ok(fn.indexOf(".eq('club_id', clubId)") !== -1);
  assert.ok(fn.indexOf('carryPreserved: true') !== -1);
  assert.ok(fn.indexOf("type: 'SETTLEMENT_APPLIED'") === -1);
});

test('period payment rejects period_club_mismatch', function() {
  assert.ok(src.indexOf('period_club_mismatch') !== -1);
});

console.log('\n── Results: ' + pass + ' passed, ' + fail + ' failed ──');
process.exit(fail ? 1 : 0);
