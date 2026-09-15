/**
 * Beta — Insufficient funds / place-bet status contract
 * Run: node tests/insufficient-funds-status-contract.test.js
 *
 * Asserts:
 *  - insufficient_balance is always HTTP 400 (never 401/403)
 *  - player_suspended is 422 (not 403) so FE never session-wipes
 * Pure static checks against index.js — no network / no DB.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var _pass = 0, _fail = 0;

function test(name, fn) {
  try { fn(); console.log('  ✅ ' + name); _pass++; }
  catch (e) { console.error('  ❌ ' + name + '\n     ' + e.message); _fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'Expected true'); }

var indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

console.log('\n── Place-bet insufficient funds status contract ──');

test('RISK_CODE_STATUS.player_suspended is 422 (not 403)', function() {
  var m = indexSrc.match(/player_suspended:\s*(\d+)/);
  assert(m, 'player_suspended missing from RISK_CODE_STATUS');
  assert(m[1] === '422', 'player_suspended must be 422 — got ' + m[1]);
});

test('JS precheck returns status 400 for insufficient_balance', function() {
  assert(
    /status\(400\)\.json\(\{\s*ok:false,\s*error:'insufficient_balance'/.test(indexSrc) ||
    /res\.status\(400\)\.json\(\{\s*ok:false,\s*error:'insufficient_balance'/.test(indexSrc),
    'precheck must return 400 insufficient_balance'
  );
});

test('RR RPC insufficient_balance returns 400', function() {
  var rrIdx = indexSrc.indexOf("rrRpcResult.error === 'insufficient_balance'");
  assert(rrIdx !== -1, 'RR insufficient_balance branch missing');
  var slice = indexSrc.slice(rrIdx, rrIdx + 280);
  assert(/status\(400\)/.test(slice), 'RR path must use 400');
  assert(!/status\(401\)/.test(slice) && !/status\(403\)/.test(slice),
    'RR insufficient_balance must not be 401/403');
});

test('Single/parlay RPC insufficient_balance returns 400', function() {
  var idx = indexSrc.indexOf("rpcResult.error==='insufficient_balance'");
  if (idx === -1) idx = indexSrc.indexOf('rpcResult.error === \'insufficient_balance\'');
  assert(idx !== -1, 'RPC insufficient_balance branch missing');
  var slice = indexSrc.slice(idx, idx + 280);
  assert(/status\(400\)/.test(slice), 'RPC path must use 400');
  assert(!/status\(401\)/.test(slice) && !/status\(403\)/.test(slice),
    'RPC insufficient_balance must not be 401/403');
});

test('no place-bet path maps insufficient_balance to 401 or 403', function() {
  // Scan every occurrence of insufficient_balance near a status()
  var re = /insufficient_balance[\s\S]{0,160}?status\((\d+)\)|status\((\d+)\)[\s\S]{0,160}?insufficient_balance/g;
  var m;
  var found = 0;
  while ((m = re.exec(indexSrc)) !== null) {
    found++;
    var st = m[1] || m[2];
    assert(st === '400', 'insufficient_balance paired with status ' + st + ' (must be 400)');
  }
  assert(found >= 2, 'expected multiple insufficient_balance+status pairs, found ' + found);
});

console.log('\n' + '─'.repeat(56));
if (_fail === 0) {
  console.log('  🟢 PASS — ' + _pass + ' status-contract checks');
  process.exit(0);
} else {
  console.log('  🔴 FAIL — ' + _fail + ' failed, ' + _pass + ' passed');
  process.exit(1);
}
