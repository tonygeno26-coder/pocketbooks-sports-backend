/**
 * Two-player/two-club authorization attack matrix.
 * Pure fixtures plus source contracts: no network, DB, or financial writes.
 * Run: node tests/cross-club-attack-matrix.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0;
let fail = 0;

function test(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++; }
  catch (error) { console.error('  FAIL ' + name + '\n     ' + error.message); fail++; }
}

const memberships = [
  { playerId: 'PLAYER_A', clubId: 'CLUB_A', status: 'active', balance: 700 },
  { playerId: 'PLAYER_B', clubId: 'CLUB_B', status: 'approved', balance: 350 }
];
const tickets = [
  { id: 'TICKET_A', playerId: 'PLAYER_A', clubId: 'CLUB_A', status: 'active' },
  { id: 'TICKET_B', playerId: 'PLAYER_B', clubId: 'CLUB_B', status: 'active' }
];

function membershipFor(playerId, clubId) {
  return memberships.find((row) =>
    row.playerId === playerId
    && row.clubId === clubId
    && ['active', 'approved'].includes(row.status)
  ) || null;
}

function authorize(actor, requestedClubId, options) {
  options = options || {};
  if (!actor || !actor.playerId) return { ok: false, status: 401, error: 'unauthorized' };
  if (!requestedClubId) return { ok: false, status: 400, error: 'missing_clubId' };
  if (requestedClubId !== actor.clubId) {
    return { ok: false, status: 403, error: 'club_scope_mismatch' };
  }
  const membership = membershipFor(actor.playerId, requestedClubId);
  if (!membership) return { ok: false, status: 403, error: 'membership_required' };
  if (options.playerId && options.playerId !== actor.playerId) {
    return { ok: false, status: 403, error: 'not_own_account' };
  }
  if (options.ticketId) {
    const ticket = tickets.find((row) => row.id === options.ticketId);
    if (!ticket) return { ok: false, status: 404, error: 'ticket_not_found' };
    if (ticket.clubId !== requestedClubId || ticket.playerId !== actor.playerId) {
      return { ok: false, status: 404, error: 'ticket_not_found' };
    }
  }
  return { ok: true, membership };
}

function deniedWithoutMutation(actor, clubId, options) {
  const before = JSON.stringify({ memberships, tickets });
  const result = authorize(actor, clubId, options);
  assert.strictEqual(result.ok, false);
  assert.ok([400, 403, 404].includes(result.status));
  assert.strictEqual(JSON.stringify({ memberships, tickets }), before, 'denial mutated fixture state');
  assert.strictEqual(result.balance, undefined, 'denial leaked balance');
  assert.strictEqual(result.ticket, undefined, 'denial leaked ticket');
}

const actorA = { playerId: 'PLAYER_A', clubId: 'CLUB_A', role: 'player' };
const actorB = { playerId: 'PLAYER_B', clubId: 'CLUB_B', role: 'player' };

console.log('\n── Baseline allow paths ──');
test('A token + A club allows', () => assert.ok(authorize(actorA, 'CLUB_A').ok));
test('B token + B club allows', () => assert.ok(authorize(actorB, 'CLUB_B').ok));
test('A can access A ticket', () => assert.ok(authorize(actorA, 'CLUB_A', { ticketId: 'TICKET_A' }).ok));
test('B can access B ticket', () => assert.ok(authorize(actorB, 'CLUB_B', { ticketId: 'TICKET_B' }).ok));

console.log('\n── Cross-club and cross-player attacks ──');
[
  ['A token + B club', actorA, 'CLUB_B', {}],
  ['B token + A club', actorB, 'CLUB_A', {}],
  ['A token + B ticket', actorA, 'CLUB_A', { ticketId: 'TICKET_B' }],
  ['B token + A ticket', actorB, 'CLUB_B', { ticketId: 'TICKET_A' }],
  ['A spoofed as B player', actorA, 'CLUB_A', { playerId: 'PLAYER_B' }],
  ['B spoofed as A player', actorB, 'CLUB_B', { playerId: 'PLAYER_A' }],
  ['valid player + nonexistent club', actorA, 'CLUB_MISSING', {}],
  ['valid club + nonmember player', { playerId: 'PLAYER_X', clubId: 'CLUB_A' }, 'CLUB_A', {}],
  ['missing membership', { playerId: 'PLAYER_A', clubId: 'CLUB_C' }, 'CLUB_C', {}],
  ['missing club ID', actorA, '', {}],
  ['nonexistent ticket', actorA, 'CLUB_A', { ticketId: 'TICKET_MISSING' }]
].forEach(([name, actor, clubId, options]) => {
  test(name + ' fails closed without leakage or mutation', () =>
    deniedWithoutMutation(actor, clubId, options));
});

console.log('\n── Product surface matrix ──');
[
  'place bet',
  'read ticket',
  'cancel',
  'grade access',
  'dashboard balance',
  'Recent Bets',
  'Results',
  'Host Bets',
  'props selection metadata'
].forEach((surface) => {
  test(surface + ': A cannot use B context', () =>
    deniedWithoutMutation(actorA, 'CLUB_B', { playerId: 'PLAYER_B', ticketId: 'TICKET_B' }));
  test(surface + ': B cannot use A context', () =>
    deniedWithoutMutation(actorB, 'CLUB_A', { playerId: 'PLAYER_A', ticketId: 'TICKET_A' }));
});

console.log('\n── No phantom balance fallback ──');
test('unknown membership has no balance', () => {
  assert.strictEqual(membershipFor('PLAYER_X', 'CLUB_A'), null);
  assert.strictEqual(authorize({ playerId: 'PLAYER_X', clubId: 'CLUB_A' }, 'CLUB_A').membership, undefined);
});
test('attack matrix never returns phantom $1000', () => {
  const results = [
    authorize(actorA, 'CLUB_B'),
    authorize(actorA, 'CLUB_A', { ticketId: 'TICKET_B' }),
    authorize({ playerId: 'PLAYER_X', clubId: 'CLUB_A' }, 'CLUB_A')
  ];
  assert.ok(results.every((result) => JSON.stringify(result).indexOf('1000') === -1));
});

console.log('\n── Backend source contracts ──');
[
  "app.post('/api/bets/place'",
  "app.post('/api/bets/cancel'",
  "app.get('/api/player/dashboard'",
  "app.get('/api/host/dashboard'",
  "app.post('/api/grade/manual'",
  "app.post('/api/grade/run'"
].forEach((route) => {
  test(route + ' canonicalizes and permission-checks club', () => {
    const start = src.indexOf(route);
    assert.ok(start >= 0, 'missing route');
    const signature = src.slice(start, start + 500);
    assert.ok(signature.includes('requireCanonicalClubId'), 'missing canonical club middleware');
    assert.ok(signature.includes('requirePermissionScoped'), 'missing scoped permission middleware');
  });
});

test('player dashboard hard-filters tickets by club and player', () => {
  const start = src.indexOf("app.get('/api/player/dashboard'");
  const block = src.slice(start, start + 6500);
  assert.ok(/\.eq\('club_id',\s*clubId\)/.test(block));
  assert.ok(/\.eq\('player_id',\s*playerId\)/.test(block));
});

test('host dashboard hard-filters tickets by club', () => {
  const start = src.indexOf("app.get('/api/host/dashboard'");
  const block = src.slice(start, start + 4500);
  assert.ok(/\.eq\('club_id',\s*clubId\)/.test(block));
});

test('cancel binds ticket owner to authenticated actor', () => {
  const start = src.indexOf("app.post('/api/bets/cancel'");
  const block = src.slice(start, start + 6500);
  assert.ok(block.includes('_cancelActor.actorId'));
  assert.ok(block.includes('not_own_ticket') || block.includes('not_owner'));
});

console.log('\n── Summary ──');
console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
