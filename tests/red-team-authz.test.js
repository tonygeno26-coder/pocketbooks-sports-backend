'use strict';
/**
 * Red-team authz / financial integrity regressions (fixtures + source contracts).
 * Run: node tests/red-team-authz.test.js
 * No production DB / settlement writes.
 */
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
  return src.slice(start, next === -1 ? start + 2500 : next);
}

console.log('\n── P0: unauthenticated host financial reads ──');

test('rollover-history requires permission middleware', function () {
  const r = sliceRoute("get('/api/host/rollover-history'");
  assert.ok(r.indexOf('requirePermissionScoped') !== -1, 'must use requirePermissionScoped');
  assert.ok(r.indexOf('requireCanonicalClubId') !== -1, 'must canonicalize club');
  assert.ok(!/^app\.get\('\/api\/host\/rollover-history',\s*async/.test(r),
    'must not be bare async handler');
});

test('week-snapshot requires permission middleware', function () {
  const r = sliceRoute("get('/api/host/week-snapshot'");
  assert.ok(r.indexOf('requirePermissionScoped') !== -1, 'must use requirePermissionScoped');
  assert.ok(r.indexOf('requireCanonicalClubId') !== -1, 'must canonicalize club');
});

test('rollover-history uses req._clubId not raw query alone', function () {
  const r = sliceRoute("get('/api/host/rollover-history'");
  assert.ok(r.indexOf('req._clubId') !== -1, 'must prefer req._clubId');
  assert.ok(r.indexOf("error:'missing_clubId'") !== -1 || r.indexOf('missing_clubId') !== -1,
    'missing club must 400');
});

console.log('\n── P0: host diamond cross-club query trust ──');

['diamond-invoice', 'diamond-weekly-report', 'diamond-usage'].forEach(function (name) {
  test('/api/host/' + name + ' enforces club scope via middleware or _checkClubScope', function () {
    const r = sliceRoute("get('/api/host/" + name + "'");
    const scoped = r.indexOf('requirePermissionScoped') !== -1
      || r.indexOf('_checkClubScope') !== -1
      || r.indexOf('club_scope_mismatch') !== -1;
    assert.ok(scoped, name + ' must enforce club scope');
    assert.ok(r.indexOf('req._clubId') !== -1, name + ' must use req._clubId');
  });
});

console.log('\n── P0: notifications IDOR ──');

test('GET /api/notifications pins playerId to actor (ignores query playerId)', function () {
  const r = sliceRoute("get('/api/notifications'");
  assert.ok(r.indexOf('Always pin') !== -1 || r.indexOf('actor.actorId') !== -1);
  assert.ok(!/playerId\s*=\s*String\(\(req\.query\s*&&\s*req\.query\.playerId\)/.test(r),
    'must not trust query.playerId as primary');
});

test('POST /api/notifications/read pins playerId to actor', function () {
  const r = sliceRoute("post('/api/notifications/read'");
  assert.ok(!/playerId\s*=\s*String\(\(req\.body\s*&&\s*req\.body\.playerId\)/.test(r),
    'must not trust body.playerId as primary');
  assert.ok(r.indexOf('actor.actorId') !== -1);
});

console.log('\n── P0: legacy player_limits IDOR ──');

test('PUT /api/clubs/:id/limits/:userId is host-scoped (not bare auth)', function () {
  const r = sliceRoute("put('/api/clubs/:id/limits/:userId'");
  assert.ok(r.indexOf('requireActor') !== -1 || r.indexOf('requirePermissionScoped') !== -1,
    'must not be auth-only write');
  assert.ok(r.indexOf('full_admin') !== -1 || r.indexOf('insufficient_role') !== -1
    || r.indexOf('requirePermissionScoped') !== -1,
    'must require host/admin role');
  assert.ok(r.indexOf('club_scope_mismatch') !== -1 || r.indexOf('_checkClubScope') !== -1
    || r.indexOf('actor.clubId') !== -1,
    'must bind club from actor');
});

test('GET /api/clubs/:id/limits/:userId is club-scoped', function () {
  const r = sliceRoute("get('/api/clubs/:id/limits/:userId'");
  assert.ok(r.indexOf('requireActor') !== -1 || r.indexOf('requirePermissionScoped') !== -1);
});

console.log('\n── P0: financial stake validation ──');

test('place bet rejects non-finite stake (NaN/Infinity)', function () {
  const start = src.indexOf("app.post('/api/bets/place'");
  const end = src.indexOf("app.post('/api/bets/cancel'", start);
  const place = src.slice(start, end);
  assert.ok(place.indexOf('Number.isFinite') !== -1, 'must use Number.isFinite on stake');
  assert.ok(/invalid_stake/.test(place));
});

console.log('\n── P0: cancel ownership uses actor (defense in depth) ──');

test('cancel compares ticket owner to actor.actorId for non-privileged', function () {
  const start = src.indexOf("app.post('/api/bets/cancel'");
  const end = src.indexOf("function _cashoutPickLabel", start);
  const cancel = src.slice(start, end);
  assert.ok(cancel.indexOf('_cancelActor.actorId') !== -1
    || cancel.indexOf('ticket.player_id !== _cancelActor.actorId') !== -1
    || /ticket\.player_id\s*!==\s*.*actorId/.test(cancel),
    'must compare ticket.player_id to actor, not only body.playerId');
});

test('cancel idempotent ledger replay checks club+player+ticket', function () {
  const start = src.indexOf("app.post('/api/bets/cancel'");
  const end = src.indexOf("function _cashoutPickLabel", start);
  const cancel = src.slice(start, end);
  assert.ok(cancel.indexOf('existLedger') !== -1 || cancel.indexOf('idempotent') !== -1);
  // Early success on foreign idempotency key is a P0 integrity hole
  assert.ok(!/if \(existLedger && existLedger\[0\]\)\s*\n\s*return res\.json\(\{ ok:true, idempotent:true/.test(cancel)
    || cancel.indexOf('ticket_id') !== -1,
    'idempotent replay must validate ledger row scope');
  assert.ok(
    cancel.indexOf('existLedger[0].ticket_id') !== -1
      || cancel.indexOf('existLedger[0].player_id') !== -1
      || cancel.indexOf('idempotency_key_conflict') !== -1
      || cancel.indexOf('ledger_scope_mismatch') !== -1,
    'must validate existing ledger against request ticket/player/club'
  );
});

console.log('\n── P0 owner-gated: cancel_bet_tx SQL still proposed ──');

test('PROPOSED cancel_bet_tx club isolation package present (DO NOT APPLY)', function () {
  const proposed = path.join(__dirname, '..', 'migrations', 'PROPOSED_cancel_bet_tx_club_isolation.sql');
  const gate = path.join(__dirname, '..', 'docs', 'CANCEL_BET_TX_PROD_GATE.md');
  assert.ok(fs.existsSync(proposed), 'proposed SQL missing');
  assert.ok(fs.existsSync(gate), 'owner gate doc missing');
  const sql = fs.readFileSync(proposed, 'utf8');
  assert.ok(sql.indexOf('DO NOT APPLY') !== -1);
  assert.ok(sql.indexOf('ticket_player_mismatch') !== -1);
  assert.ok(sql.indexOf('no_club_member_balance_found') !== -1);
  assert.ok(sql.indexOf('PHANTOM') !== -1 || sql.indexOf('1000') !== -1);
});

console.log('\n── Pure validation helpers ──');

function validateStake(stake) {
  const stakeAmt = typeof stake === 'number' ? stake : parseFloat(stake);
  if (!Number.isFinite(stakeAmt) || stakeAmt <= 0) return { ok: false, error: 'invalid_stake' };
  return { ok: true, stakeAmt: Math.round(stakeAmt * 100) / 100 };
}

function resolveNotifPlayerId(actor, queryPlayerId) {
  const playerId = String((actor && actor.actorId) || '');
  if (queryPlayerId && String(queryPlayerId) !== playerId) {
    return playerId; // ignore foreign
  }
  return playerId;
}

function cancelOwnerOk(actor, ticket, bodyPlayerId) {
  const rank = { owner: 5, full_admin: 4, player: 1 }[actor.role] || 0;
  const privileged = rank >= 4 || actor.platformRole === 'platform_admin';
  if (privileged) return { ok: true, effectivePlayerId: ticket.player_id };
  if (String(ticket.player_id) !== String(actor.actorId)) {
    return { ok: false, error: 'not_owner' };
  }
  if (bodyPlayerId && String(bodyPlayerId) !== String(actor.actorId)) {
    return { ok: false, error: 'not_own_account' };
  }
  return { ok: true, effectivePlayerId: actor.actorId };
}

test('stake Infinity/NaN/0/negative rejected', function () {
  assert.strictEqual(validateStake(Infinity).ok, false);
  assert.strictEqual(validateStake(-Infinity).ok, false);
  assert.strictEqual(validateStake(NaN).ok, false);
  assert.strictEqual(validateStake(0).ok, false);
  assert.strictEqual(validateStake(-5).ok, false);
  assert.strictEqual(validateStake('1e309').ok, false); // parses to Infinity
  assert.strictEqual(validateStake(25).ok, true);
});

test('notification foreign playerId ignored', function () {
  assert.strictEqual(resolveNotifPlayerId({ actorId: 'A' }, 'B'), 'A');
  assert.strictEqual(resolveNotifPlayerId({ actorId: 'A' }, 'A'), 'A');
});

test('player cannot cancel other player ticket even with matching body.playerId', function () {
  const r = cancelOwnerOk(
    { actorId: 'A', role: 'player' },
    { player_id: 'B', id: 'T1' },
    'B'
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'not_owner');
});

test('host full_admin can cancel club player ticket', function () {
  const r = cancelOwnerOk(
    { actorId: 'H1', role: 'full_admin' },
    { player_id: 'B', id: 'T1' },
    'B'
  );
  assert.strictEqual(r.ok, true);
});

console.log('\n── Summary ──');
console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
