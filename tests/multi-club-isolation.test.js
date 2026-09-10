/**
 * Multi-club isolation contracts (complementary to idor-audit-wave).
 * Run: node tests/multi-club-isolation.test.js
 * No production DB / settlement writes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const INDEX = path.join(__dirname, '..', 'index.js');
const src = fs.readFileSync(INDEX, 'utf8');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++; }
  catch (e) { console.error('  FAIL ' + name + '\n     ' + e.message); fail++; }
}

function sliceFn(name) {
  const start = src.indexOf('async function ' + name);
  assert.ok(start !== -1, 'missing ' + name);
  const next = src.indexOf('\nasync function ', start + 1);
  const next2 = src.indexOf('\nfunction ', start + 1);
  let end = src.length;
  if (next !== -1) end = Math.min(end, next);
  if (next2 !== -1 && next2 > start) end = Math.min(end, next2);
  return src.slice(start, Math.min(end, start + 2500));
}

// Pure multi-club balance blend model
function filterLedgerByClub(rows, clubId) {
  if (!clubId) return [];
  return (rows || []).filter(function (r) { return String(r.club_id) === String(clubId); });
}

function availableFromLedger(start, rows, clubId) {
  const scoped = filterLedgerByClub(rows, clubId);
  if (!scoped.length) return start;
  const last = scoped[scoped.length - 1];
  if (last.balance_after != null) return last.balance_after;
  return scoped.reduce(function (b, r) { return b + (r.amount || 0); }, start);
}

const rowsMulti = [
  { club_id: 'CLUB_A', amount: -50, balance_after: 950 },
  { club_id: 'CLUB_B', amount: -200, balance_after: 800 },
  { club_id: 'CLUB_A', amount: 100, balance_after: 1050 }
];

console.log('\n── Multi-club ledger blend (PLY_MULTI) ──');

test('Club A ledger ignores Club B rows', function () {
  assert.strictEqual(availableFromLedger(1000, rowsMulti, 'CLUB_A'), 1050);
  assert.strictEqual(filterLedgerByClub(rowsMulti, 'CLUB_A').length, 2);
});

test('Club B ledger ignores Club A rows', function () {
  assert.strictEqual(availableFromLedger(1000, rowsMulti, 'CLUB_B'), 800);
});

test('Missing clubId yields no blended rows', function () {
  assert.strictEqual(filterLedgerByClub(rowsMulti, null).length, 0);
  assert.strictEqual(filterLedgerByClub(rowsMulti, '').length, 0);
});

console.log('\n── Source: ledger helpers hard-require club ──');

test('_ledgerAvailableForPlayer hard-eq club_id and fails closed', function () {
  const fn = sliceFn('_ledgerAvailableForPlayer');
  assert.ok(fn.indexOf("!clubId") !== -1 || fn.indexOf('!clubId') !== -1, 'must guard missing club');
  assert.ok(/\.eq\('club_id',\s*clubId\)/.test(fn), 'must hard-filter club_id');
  assert.ok(!/if\s*\(clubId\)\s*lq\s*=\s*lq\.eq\('club_id'/.test(fn), 'must not soft-filter');
});

test('_creditPlayerAccount requires clubId and hard-eq ledger', function () {
  const fn = sliceFn('_creditPlayerAccount');
  assert.ok(fn.indexOf('missing_clubId_or_playerId') !== -1);
  assert.ok(/\.eq\('club_id',\s*clubId\)/.test(fn));
  assert.ok(!/club_id:\s*clubId\|\|null/.test(fn), 'must not write null club_id');
});

console.log('\n── Source: join + survivor not regressed ──');

test('pending-requests still host+club scoped', function () {
  const start = src.indexOf("app.get('/api/club/pending-requests'");
  const block = src.slice(start, start + 900);
  assert.ok(block.indexOf('_checkClubScope') !== -1);
  assert.ok(block.indexOf('insufficient_role') !== -1);
});

test('_survivorIsHost still creator-only (no full_admin bypass)', function () {
  const m = src.match(/function _survivorIsHost\([\s\S]*?\n\}/);
  assert.ok(m);
  assert.ok(m[0].includes('created_by'));
  assert.ok(!/full_admin/.test(m[0]));
});

console.log('\n── Owner-gated cancel SQL untouched ──');

test('PROPOSED cancel isolation still DO NOT APPLY', function () {
  const proposed = path.join(__dirname, '..', 'migrations', 'PROPOSED_cancel_bet_tx_club_isolation.sql');
  assert.ok(fs.existsSync(proposed));
  assert.ok(fs.readFileSync(proposed, 'utf8').indexOf('DO NOT APPLY') !== -1);
});

console.log('\n── Summary ──');
console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
