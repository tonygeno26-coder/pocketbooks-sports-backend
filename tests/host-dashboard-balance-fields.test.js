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

test('host dashboard uses shared per-player ledger helper', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.indexOf('async function _ledgerAvailableForPlayer') !== -1, 'helper defined');
  assert.ok(src.indexOf('_ledgerAvailableForPlayer(sb, clubId, pid, start)') !== -1, 'host dashboard calls helper');
  assert.ok(src.indexOf("await _ledgerAvailableForPlayer(sb, clubId, playerId, startingBalance)") !== -1
    || src.indexOf('_ledgerAvailableForPlayer(sb, clubId, playerId, startingBalance)') !== -1,
    'player dashboard reuses helper');
  assert.ok(!/from\('ledger_entries'\)[\s\S]{0,220}\.in\('player_id',\s*balPids\)/.test(src),
    'host dashboard no longer batches ledger by balPids');
});

test('multi-player ledger map keeps distinct balances', function () {
  var ledgerBalByPid = {
    '2a3e6819-be2f-4df3-8112-54ce19d0929e': 705.19,
    '12bb68f1-bcca-4e63-8ae4-7065dbb19172': 1176.43,
    'bc767309-6fc7-4585-9077-3de7b898df13': 1042.30,
    '0a1885b8-0fe3-4e75-aeda-f89662c87d49': 1807.85
  };
  Object.keys(ledgerBalByPid).forEach(function (pid) {
    assert.ok(ledgerBalByPid[pid] > 0);
  });
  assert.notStrictEqual(
    ledgerBalByPid['2a3e6819-be2f-4df3-8112-54ce19d0929e'],
    ledgerBalByPid['12bb68f1-bcca-4e63-8ae4-7065dbb19172']
  );
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
