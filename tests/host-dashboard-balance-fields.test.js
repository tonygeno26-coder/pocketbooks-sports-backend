#!/usr/bin/env node
/**
 * Host dashboard / settlements-preview balance field contract.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var assert = require('assert');
var pass = 0;
var fail = 0;

function test(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + '\n     ' + (e && e.message)); }
}

function _deriveBalanceFromLedgerEntries(startingBalance, entries) {
  var rows = (entries || []).slice().sort(function (a, b) {
    return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
  });
  if (!rows.length) {
    return startingBalance != null && !isNaN(parseFloat(startingBalance))
      ? Math.round(parseFloat(startingBalance) * 100) / 100
      : null;
  }
  var last = rows[rows.length - 1];
  if (last && last.balance_after != null && !isNaN(parseFloat(last.balance_after))) {
    return Math.round(parseFloat(last.balance_after) * 100) / 100;
  }
  var bal = parseFloat(startingBalance) || 0;
  rows.forEach(function (r) { bal += parseFloat(r.amount) || 0; });
  return Math.round(bal * 100) / 100;
}

console.log('\n── Host dashboard balance fields ──');

test('missing start + empty ledger → null (not 0)', function () {
  assert.strictEqual(_deriveBalanceFromLedgerEntries(null, []), null);
});

test('start 1000 + empty ledger → 1000', function () {
  assert.strictEqual(_deriveBalanceFromLedgerEntries(1000, []), 1000);
});

test('ledger balance_after wins', function () {
  var rows = [
    { created_at: '2026-09-01T00:00:00Z', amount: -10, balance_after: 990 },
    { created_at: '2026-09-05T00:00:00Z', amount: -98, balance_after: 686.99 }
  ];
  assert.strictEqual(_deriveBalanceFromLedgerEntries(1000, rows), 686.99);
});

test('index.js dashboard exposes currentBalance/balance aliases', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.indexOf('p.currentBalance = p.availableBalance') !== -1, 'dashboard currentBalance alias');
  assert.ok(src.indexOf('p.balance = p.availableBalance') !== -1, 'dashboard balance alias');
});

test('settlements-preview no longer defaults missing start to 0', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.indexOf('Missing balance_start must stay null') !== -1, 'null-start comment present');
  assert.ok(src.indexOf('p.availableBalance = p.currentBalance') !== -1, 'settle availableBalance alias');
  assert.ok(!/balance_start!=null\) \? memberMap\[pid\]\.balance_start : 0;/.test(src), 'removed : 0 coerce');
});

console.log('\n──────────────────────────────────────────────────────');
console.log('Host dashboard balance fields: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.error('❌ FAILED'); process.exit(1); }
console.log('✅ All host dashboard balance field rules verified');
