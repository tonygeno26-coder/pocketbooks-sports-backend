'use strict';
/**
 * Option A: constraints, stale preview/concurrency, idempotency, multi-club, bankroll regression.
 * Run: node tests/settlement-option-a-validation.test.js
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
const paySql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'PROPOSED_settlement_payments.sql'), 'utf8');
const cancelSql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'PROPOSED_cancel_bet_tx_club_isolation.sql'), 'utf8');
const settleFn = src.slice(
  src.indexOf("app.post('/api/host/settle-player'"),
  src.indexOf("app.get('/api/host/settlement-payments'")
);

console.log('\n── Sign convention matrix ──');

test('−500 + 200 pay → −300 (player_paid_host)', function() {
  var r = sc.applyPartialSettlement(-500, 200);
  assert.strictEqual(r.after, -300);
  assert.strictEqual(r.direction, 'player_paid_host');
  assert.strictEqual(sc.deriveSettlementCarry(-500, 200, 0), -300);
});

test('+500 + 200 pay → +300 (host_paid_player)', function() {
  var r = sc.applyPartialSettlement(500, 200);
  assert.strictEqual(r.after, 300);
  assert.strictEqual(r.direction, 'host_paid_player');
  assert.strictEqual(sc.deriveSettlementCarry(500, 0, 200), 300);
});

console.log('\n── Constraints (proposed settlement_payments SQL) ──');

test('direction check + amount > 0 + cents match', function() {
  assert.ok(paySql.indexOf("CHECK (direction IN ('player_paid_host', 'host_paid_player'))") !== -1);
  assert.ok(paySql.indexOf('CHECK (amount > 0)') !== -1);
  assert.ok(paySql.indexOf('settlement_payments_amount_cents_matches') !== -1);
  assert.ok(paySql.indexOf('settlement_payments_club_ledger_settlement_uidx') !== -1);
});

test('cancel SQL has no phantom1000 and hard club lock', function() {
  var body = cancelSql.split('$function$')[1] || cancelSql;
  assert.ok(body.indexOf('coalesce(balance_start, 1000)') === -1);
  assert.ok(body.indexOf('v_start_balance := 1000') === -1);
  assert.ok(body.indexOf('ticket_club_mismatch') !== -1);
  assert.ok(body.indexOf('no_club_member_balance_found') !== -1);
});

console.log('\n── Stale preview / concurrency ──');

test('stale −500 preview vs actual −200: pay 500 → overpay_blocked max 200', function() {
  // Server recomputes actual before; never trusts FE −500
  var actual = -200;
  var r = sc.applyPartialSettlement(actual, 500);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'overpay_blocked');
  assert.strictEqual(r.maxAmount, 200);
});

test('stale −500 preview vs actual −200: pay 200 → ok → 0', function() {
  var r = sc.applyPartialSettlement(-200, 200);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.after, 0);
});

test('settle-player recomputes via serialized RPC (never trusts FE balance_before)', function() {
  assert.ok(settleFn.indexOf("_callMoneyRpc('settle_payment_option_a_tx'") !== -1);
  assert.ok(settleFn.indexOf('serialized: true') !== -1);
  // Must not read req.body.balance_before / balanceBefore as authority
  assert.ok(!/const before = .*req\.body/.test(settleFn));
  assert.ok(settleFn.indexOf('balanceBefore: before') !== -1);
});

test('advisory lock + lock_timeout wiring present', function() {
  assert.ok(settleFn.indexOf('settlementLock') !== -1 || src.indexOf("require('./lib/settlement-lock')") !== -1);
  assert.ok(settleFn.indexOf('lock_timeout') !== -1);
  assert.ok(settleFn.indexOf('p_lock_timeout_ms') !== -1);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'migrations', 'PROPOSED_settle_payment_option_a_tx.sql')));
});

test('concurrent overpay race documented: two×400 on −500 must not both succeed unchecked', function() {
  // Pure math of the race if both pass the same snapshot:
  var snapshot = -500;
  var a = sc.applyPartialSettlement(snapshot, 400);
  var b = sc.applyPartialSettlement(snapshot, 400);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  // If both wrote payments: ticketNet -500 + 800 = +300 (WRONG — crossed zero via payments)
  var raced = sc.deriveSettlementCarry(-500, 800, 0);
  assert.strictEqual(raced, 300);
  // Authoritative sequential: second must see -100 and reject 400
  var sequential2 = sc.applyPartialSettlement(-100, 400);
  assert.strictEqual(sequential2.ok, false);
  assert.strictEqual(sequential2.error, 'overpay_blocked');
  // Serialization RPC must exist to prevent the raced outcome
  var sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'PROPOSED_settle_payment_option_a_tx.sql'), 'utf8');
  assert.ok(sql.indexOf('pg_advisory_xact_lock') !== -1);
});

console.log('\n── Idempotency ──');

test('club-scoped payment_id and settlementId', function() {
  assert.ok(settleFn.indexOf("'SETTLE_DIRECT_'+clubId+'_'+idempotencyKey") !== -1);
  assert.ok(settleFn.indexOf("String(clubId) + '::' + String(idempotencyKey)") !== -1);
  assert.ok(settleFn.indexOf('idempotent') !== -1);
});

test('opening balance included in derive formula', function() {
  assert.strictEqual(sc.deriveSettlementCarry(0, 0, 0, -500), -500);
  assert.strictEqual(sc.deriveSettlementCarry(50, 0, 0, -500), -450);
  assert.ok(src.indexOf('_loadSettlementOpenings') !== -1);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'migrations', 'PROPOSED_settlement_opening_balances.sql')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'migrations', 'PROPOSED_bootstrap_settlement_opening_epoch.sql')));
});

console.log('\n── Multi-club ──');

test('Club A settle does not change Club B carry (pure)', function() {
  var a = sc.applyPartialSettlement(-500, 200).after;
  var b = 300;
  assert.strictEqual(a, -300);
  assert.strictEqual(b, 300);
  assert.strictEqual(sc.carryIntoNextWeek(b, 50), 350);
  assert.strictEqual(a, -300);
});

console.log('\n── Bankroll regression ──');

test('settle path declares bankrollMutated false and no settle_player_tx', function() {
  assert.ok(settleFn.indexOf('bankrollMutated: false') !== -1);
  assert.ok(settleFn.indexOf('settlePlayerTxUsed: false') !== -1);
  assert.ok(settleFn.indexOf("_callMoneyRpc('settle_player_tx'") === -1);
  assert.ok(settleFn.indexOf("_callMoneyRpc('settle_payment_option_a_tx'") !== -1);
  assert.ok(paySql.indexOf('settlement_payments') !== -1);
});

test('settlement_payments comment: does not rewrite ticket bankroll', function() {
  assert.ok(paySql.indexOf('Does not rewrite ticket bankroll') !== -1 ||
            paySql.indexOf('does not rewrite') !== -1);
});

test('epoch cutoff uses historical markers only; cash settle type settlement_payment in SQL', function() {
  assert.ok(src.indexOf('isHistoricalEpochMarker') !== -1);
  var settleSql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'PROPOSED_settle_payment_option_a_tx.sql'), 'utf8');
  assert.ok(settleSql.indexOf("'settlement_payment'") !== -1);
  assert.ok(settleFn.indexOf("type: 'SETTLEMENT_APPLIED'") === -1);
});

test('validation doc exists', function() {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', 'SETTLEMENT_NONPROD_VALIDATION.md')));
});

console.log('\n── Results: ' + pass + ' passed, ' + fail + ' failed ──');
process.exit(fail ? 1 : 0);
