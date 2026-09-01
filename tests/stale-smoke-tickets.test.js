'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try { fn(); console.log('  OK ' + name); pass++; }
  catch (e) { console.error('  FAIL ' + name + '\n     ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'expected true'); }

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const cleanupSource = fs.readFileSync(path.join(__dirname, '..', 'scripts/cleanup-orphan-tickets.js'), 'utf8');

function isSmokeTestTicketId(id) {
  return /^(SMOKE_|GRD\d+_)/i.test(String(id || ''));
}

console.log('\n-- Stale smoke-test tickets --');

test('SMOKE_ and GRD* prefixes are proven smoke IDs', function() {
  assert(isSmokeTestTicketId('SMOKE_T4_1779871272739'));
  assert(isSmokeTestTicketId('SMOKE_CRS_1779871637327'));
  assert(isSmokeTestTicketId('GRD5_A_1779874408210'));
  assert(isSmokeTestTicketId('GRD2_T4_1779963330855'));
  assert(!isSmokeTestTicketId('T_1779619640332_g2rktl'));
  assert(!isSmokeTestTicketId('T1778994496338761'));
});

test('privileged force cancel skips game_already_started', function() {
  assert(indexSource.includes('const _forceCancel = _isPrivilegedCancel && (force === true || force === \'true\')'),
    'force cancel flag missing');
  assert(indexSource.includes('if (!_forceCancel)'),
    'game-start check must still run unless force cancel');
  assert(indexSource.includes("error:'game_already_started:'"),
    'player cancel after kickoff must still be blocked');
});

test('cancel still settles through cancel_bet_tx, never deletes tickets', function() {
  const cancelBlock = indexSource.slice(indexSource.indexOf("app.post('/api/bets/cancel'"));
  const end = cancelBlock.indexOf("app.get('/api/player/dashboard'");
  const src = end > 0 ? cancelBlock.slice(0, end) : cancelBlock.slice(0, 8000);
  assert(src.includes("_callMoneyRpc('cancel_bet_tx'"), 'cancel path must call cancel_bet_tx');
  assert(!/\.from\('tickets'\)\s*\.delete\(/.test(src), 'cancel path must not delete tickets');
});

test('cleanup script voids via cancel_bet_tx and never deletes', function() {
  assert(cleanupSource.includes("sb.rpc('cancel_bet_tx'"), 'cleanup must call cancel_bet_tx');
  assert(cleanupSource.includes("p_reason: 'stale_smoke_void'"));
  assert(!cleanupSource.includes(".delete({ count: 'exact' })"), 'cleanup must not delete rows');
  assert(!/from\('tickets'\)\.delete/.test(cleanupSource), 'cleanup must not delete tickets');
  assert(cleanupSource.includes('Tickets are never deleted') || cleanupSource.includes('never deleted'));
});

test('cleanup only voids proven smoke/QA tickets', function() {
  assert(cleanupSource.includes('function isProvenSmokeTicket'));
  assert(cleanupSource.includes("club_id === 'demo-club'"));
  assert(cleanupSource.includes('SMOKE_|GRD'));
  assert(cleanupSource.includes('0a1885b8-0fe3-4e75-aeda-f89662c87d49'));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
