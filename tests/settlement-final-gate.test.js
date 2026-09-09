'use strict';
/**
 * Final non-prod gate: lock keys, opening formula, SQL presence, status shape docs.
 * Run: node tests/settlement-final-gate.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sc = require('../lib/settlement-carry');
const sl = require('../lib/settlement-lock');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.error('  ❌ ' + name + '\n     ' + e.message); fail++; }
}

const root = path.join(__dirname, '..');
const settleSql = fs.readFileSync(path.join(root, 'migrations', 'PROPOSED_settle_payment_option_a_tx.sql'), 'utf8');
const bootSql = fs.readFileSync(path.join(root, 'migrations', 'PROPOSED_bootstrap_settlement_opening_epoch.sql'), 'utf8');
const src = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

console.log('\n── Lock key determinism ──');

test('same club+player → stable keys', function() {
  var a = sl.settlementLockKeys('clubA', 'player1');
  var b = sl.settlementLockKeys('clubA', 'player1');
  assert.strictEqual(a.key1, b.key1);
  assert.strictEqual(a.key2, b.key2);
  assert.strictEqual(a.digest, b.digest);
});

test('different player same club → different keys', function() {
  var a = sl.settlementLockKeys('clubA', 'p1');
  var b = sl.settlementLockKeys('clubA', 'p2');
  assert.ok(a.key1 !== b.key1 || a.key2 !== b.key2);
});

test('same player different club → different keys', function() {
  var a = sl.settlementLockKeys('clubA', 'p1');
  var b = sl.settlementLockKeys('clubB', 'p1');
  assert.ok(a.key1 !== b.key1 || a.key2 !== b.key2);
});

test('default lock timeout 3000ms', function() {
  assert.strictEqual(sl.DEFAULT_LOCK_TIMEOUT_MS, 3000);
  assert.strictEqual(sl.lockTimeoutMs(undefined), 3000);
});

test('SQL uses pg_advisory_xact_lock + lock_timeout', function() {
  assert.ok(settleSql.indexOf('pg_advisory_xact_lock') !== -1);
  assert.ok(settleSql.indexOf('lock_timeout') !== -1);
  assert.ok(settleSql.indexOf("error', 'lock_timeout'") !== -1 || settleSql.indexOf("'lock_timeout'") !== -1);
  assert.ok(settleSql.indexOf('settle_v1|') !== -1);
});

console.log('\n── Opening / bootstrap rules ──');

test('bootstrap refuses prod without force', function() {
  assert.ok(bootSql.indexOf('prod_bootstrap_blocked') !== -1);
  assert.ok(bootSql.indexOf('needs_human_review') !== -1);
});

test('bootstrap writes SETTLEMENT_APPLIED_BOOTSTRAP epoch id', function() {
  assert.ok(bootSql.indexOf('SETTLEMENT_APPLIED_BOOTSTRAP_') !== -1);
  assert.ok(bootSql.indexOf('settlement_opening_balances') !== -1);
});

test('opening + tickets formula', function() {
  assert.strictEqual(sc.deriveSettlementCarry(0, 0, 0, 0), 0);
  assert.strictEqual(sc.deriveSettlementCarry(0, 0, 0, -500), -500);
  assert.strictEqual(sc.deriveSettlementCarry(300, 0, 0, 0), 300);
  assert.strictEqual(sc.deriveSettlementCarry(50, 0, 0, -500), -450);
});

test('API uses serialized RPC only (no unlocked settle write path)', function() {
  var start = src.indexOf("app.post('/api/host/settle-player'");
  var end = src.indexOf("app.get('/api/host/settlement-payments'");
  var fn = src.slice(start, end);
  assert.ok(fn.indexOf("settle_payment_option_a_tx") !== -1);
  assert.ok(fn.indexOf("from('settlement_payments').upsert") === -1);
  assert.ok(fn.indexOf('_callMoneyRpc(\'settle_player_tx\'') === -1);
});

test('final status doc exists', function() {
  assert.ok(fs.existsSync(path.join(root, 'docs', 'SETTLEMENT_FINAL_NONPROD_GATE.md')));
});

console.log('\n── Results: ' + pass + ' passed, ' + fail + ' failed ──');
process.exit(fail ? 1 : 0);
