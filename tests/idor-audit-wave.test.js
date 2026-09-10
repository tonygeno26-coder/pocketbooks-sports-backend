/**
 * IDOR / multi-club authorization wave (fixtures + source contracts).
 * Run: node tests/idor-audit-wave.test.js
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

function sliceRoute(methodPath) {
  const needle = "app." + methodPath;
  const start = src.indexOf(needle);
  assert.ok(start !== -1, 'missing route ' + methodPath);
  const next = src.indexOf('\napp.', start + 1);
  return src.slice(start, next === -1 ? start + 3500 : next);
}

// ── Pure multi-club fixtures (same player, Club A vs Club B) ─────────────────

function authorizeClubResource(actor, resourceClubId) {
  if (!resourceClubId) return { ok: false, error: 'missing_clubId', status: 400 };
  if (actor.platformRole === 'platform_admin') return { ok: true };
  if (actor.clubId && String(actor.clubId) !== String(resourceClubId)) {
    return { ok: false, error: 'club_scope_mismatch', status: 403 };
  }
  if (!actor.clubId) return { ok: false, error: 'missing_clubId', status: 400 };
  return { ok: true };
}

function authorizeTicketAction(actor, ticket, bodyPlayerId) {
  const club = authorizeClubResource(actor, ticket.club_id);
  if (!club.ok) return club;
  const rank = { owner: 5, full_admin: 4, player: 1 }[actor.role] || 0;
  const privileged = rank >= 4 || actor.platformRole === 'platform_admin';
  if (!privileged && String(ticket.player_id) !== String(actor.actorId)) {
    return { ok: false, error: 'not_owner', status: 403 };
  }
  if (!privileged && bodyPlayerId && String(bodyPlayerId) !== String(actor.actorId)) {
    return { ok: false, error: 'not_own_account', status: 403 };
  }
  return { ok: true };
}

function authorizeJoinQueue(actor, clubId) {
  const club = authorizeClubResource(actor, clubId);
  if (!club.ok) return club;
  const rank = { owner: 5, full_admin: 4, player: 1 }[actor.role] || 0;
  if (rank < 4 && actor.platformRole !== 'platform_admin') {
    return { ok: false, error: 'insufficient_role', status: 403 };
  }
  return { ok: true };
}

function authorizeSettlementPeriod(actor, period) {
  return authorizeClubResource(actor, period.club_id);
}

function authorizeNotifRead(actor, notif) {
  if (String(notif.player_id) !== String(actor.actorId)) {
    return { ok: false, error: 'not_owner', status: 403 };
  }
  return { ok: true };
}

const hostA = { actorId: 'HOST_A', role: 'full_admin', clubId: 'CLUB_A' };
const hostB = { actorId: 'HOST_B', role: 'full_admin', clubId: 'CLUB_B' };
const plyMultiA = { actorId: 'PLY_MULTI', role: 'player', clubId: 'CLUB_A' };
const plyMultiB = { actorId: 'PLY_MULTI', role: 'player', clubId: 'CLUB_B' };
const plyA = { actorId: 'PLY_A', role: 'player', clubId: 'CLUB_A' };
const ticketA = { id: 'T_A', player_id: 'PLY_MULTI', club_id: 'CLUB_A' };
const ticketB = { id: 'T_B', player_id: 'PLY_MULTI', club_id: 'CLUB_B' };
const periodA = { period_id: 'P_A', club_id: 'CLUB_A' };
const periodB = { period_id: 'P_B', club_id: 'CLUB_B' };
const notifB = { id: 'N_B', player_id: 'PLY_B' };

console.log('\n── Multi-club same player (no bleed) ──');

test('PLY_MULTI@A cannot cash-out ticket in Club B', function () {
  const r = authorizeTicketAction(plyMultiA, ticketB, 'PLY_MULTI');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'club_scope_mismatch');
});

test('PLY_MULTI@A can act on own Club A ticket', function () {
  assert.strictEqual(authorizeTicketAction(plyMultiA, ticketA, 'PLY_MULTI').ok, true);
});

test('PLY_MULTI@B dashboard club must not accept Club A resource', function () {
  assert.strictEqual(authorizeClubResource(plyMultiB, 'CLUB_A').ok, false);
  assert.strictEqual(authorizeClubResource(plyMultiB, 'CLUB_B').ok, true);
});

test('Host A cannot offer cashout on Club B ticket', function () {
  const r = authorizeTicketAction(hostA, ticketB, null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'club_scope_mismatch');
});

test('Host A cannot read Club B settlement period', function () {
  assert.strictEqual(authorizeSettlementPeriod(hostA, periodB).ok, false);
  assert.strictEqual(authorizeSettlementPeriod(hostA, periodA).ok, true);
});

test('Player cannot list Host B join queue', function () {
  assert.strictEqual(authorizeJoinQueue(plyA, 'CLUB_B').ok, false);
  assert.strictEqual(authorizeJoinQueue(hostB, 'CLUB_B').ok, true);
  assert.strictEqual(authorizeJoinQueue(hostA, 'CLUB_B').ok, false);
});

test('Notification ID for other player rejected', function () {
  assert.strictEqual(authorizeNotifRead(plyA, notifB).ok, false);
});

console.log('\n── Source gates: dashboards fail closed ──');

test('player/dashboard requires clubId and hard-eq club_id', function () {
  const r = sliceRoute("get('/api/player/dashboard'");
  assert.ok(r.indexOf("error:'missing_clubId'") !== -1 || r.indexOf('missing_clubId') !== -1);
  assert.ok(/\.eq\('club_id',\s*clubId\)/.test(r), 'must hard-filter club_id');
  assert.ok(!/if\s*\(clubId\)\s*tq\s*=\s*tq\.eq\('club_id'/.test(r), 'must not soft-filter tickets');
});

test('host/dashboard requires clubId and hard-eq club_id', function () {
  const r = sliceRoute("get('/api/host/dashboard'");
  assert.ok(r.indexOf('missing_clubId') !== -1);
  assert.ok(/\.eq\('club_id',\s*clubId\)/.test(r));
  assert.ok(!/if\s*\(clubId\)\s*tq\s*=\s*tq\.eq\('club_id'/.test(r));
});

console.log('\n── Source gates: cash-out club bind ──');

['offer-cashout', "post('/api/bets/accept-cashout'", "post('/api/bets/decline-cashout'"].forEach(function (key) {
  test(key + ' checks ticket.club_id vs actor club', function () {
    const needle = key.indexOf("post(") === 0 ? key : "post('/api/host/" + key + "'";
    const r = sliceRoute(needle);
    assert.ok(r.indexOf('club_scope_mismatch') !== -1, 'must reject cross-club ticket');
    assert.ok(/ticket\.club_id/.test(r));
  });
});

console.log('\n── Source gates: join requests host+club ──');

test('GET /api/clubs/:id/requests is host+club scoped', function () {
  const r = sliceRoute("get('/api/clubs/:id/requests'");
  assert.ok(r.indexOf('_checkClubScope') !== -1);
  assert.ok(r.indexOf('insufficient_role') !== -1);
  assert.ok(r.indexOf('club_scope_mismatch') !== -1);
});

test('GET /api/club/pending-requests is host+club scoped', function () {
  const r = sliceRoute("get('/api/club/pending-requests'");
  assert.ok(r.indexOf('_checkClubScope') !== -1);
  assert.ok(r.indexOf('insufficient_role') !== -1);
});

console.log('\n── Source gates: settlement period IDOR ──');

test('settlements/:periodId/snapshots binds period.club_id', function () {
  const r = sliceRoute("get('/api/host/settlements/:periodId/snapshots'");
  assert.ok(r.indexOf('club_scope_mismatch') !== -1);
  assert.ok(r.indexOf('settlement_periods') !== -1);
});

test('settlements/:periodId/payments binds period.club_id', function () {
  const r = sliceRoute("get('/api/host/settlements/:periodId/payments'");
  assert.ok(r.indexOf('club_scope_mismatch') !== -1);
});

test('payment-confirm binds pay.club_id', function () {
  const r = sliceRoute("post('/api/host/settlements/payment-confirm'");
  assert.ok(r.indexOf('club_scope_mismatch') !== -1);
  assert.ok(/pay\.club_id/.test(r));
});

console.log('\n── Source gates: mirror audit not public ──');

['audit', 'audit/legs', 'audit/ledger'].forEach(function (name) {
  test('/api/mirror/' + name + ' requires privileged actor', function () {
    const r = sliceRoute("get('/api/mirror/" + name + "'");
    assert.ok(r.indexOf('requireActor') !== -1);
    assert.ok(r.indexOf('insufficient_role') !== -1);
  });
});

test('mirror/tickets hard-requires clubId', function () {
  const r = sliceRoute("get('/api/mirror/tickets'");
  assert.ok(r.indexOf('missing_clubId') !== -1);
  assert.ok(/\.eq\('club_id',\s*clubId\)/.test(r));
});

console.log('\n── Owner-gated cancel SQL untouched ──');

test('PROPOSED cancel isolation still DO NOT APPLY', function () {
  const proposed = path.join(__dirname, '..', 'migrations', 'PROPOSED_cancel_bet_tx_club_isolation.sql');
  assert.ok(fs.existsSync(proposed));
  const sql = fs.readFileSync(proposed, 'utf8');
  assert.ok(sql.indexOf('DO NOT APPLY') !== -1);
});

console.log('\n── Summary ──');
console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
