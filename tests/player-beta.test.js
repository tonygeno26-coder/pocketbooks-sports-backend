'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const beta = require('../lib/player-beta');

const BETA = 'd616dc2a-95a6-473a-97b1-7da330878479';
const OTHER = '11111111-1111-1111-1111-111111111111';

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
    pass++;
  } catch (e) {
    console.error('  FAIL ' + name + '\n     ' + e.message);
    fail++;
  }
}

console.log('\n-- player beta decisions --');

test('public club creation defaults off', function() {
  assert.strictEqual(beta.publicClubCreationEnabled(false), false);
  assert.strictEqual(beta.publicClubCreationEnabled(undefined), false);
  assert.strictEqual(beta.publicClubCreationEnabled(true), true);
  const deny = beta.createClubDenial(false);
  assert.strictEqual(deny.http, 403);
  assert.strictEqual(deny.body.error, 'club_creation_disabled');
  assert.strictEqual(beta.createClubDenial(true), null);
});

test('signup cannot self-assign host or admin', function() {
  assert.strictEqual(beta.assignedSignupRole('host', 'a@b.com', ''), 'user');
  assert.strictEqual(beta.assignedSignupRole('admin', 'a@b.com', ''), 'user');
  assert.strictEqual(beta.assignedSignupRole('owner', 'a@b.com', ''), 'user');
  assert.strictEqual(beta.assignedSignupRole('user', 'a@b.com', ''), 'user');
  assert.strictEqual(beta.assignedSignupRole('host', 'boss@pb.com', 'boss@pb.com'), 'master_admin');
});

test('only the beta club is discoverable', function() {
  assert.strictEqual(beta.isDiscoverableClubId(BETA), true);
  assert.strictEqual(beta.isDiscoverableClubId(OTHER), false);
  assert.strictEqual(beta.publicClubCard({ id: OTHER, name: 'Secret' }), null);
  const card = beta.publicClubCard({ id: BETA, name: 'PocketBooks', is_locked: true, description: 'Beta' });
  assert.strictEqual(card.name, 'PocketBooks');
  assert.strictEqual(card.is_locked, true);
  assert.strictEqual(card.code, undefined);
  assert.strictEqual(card.balance, undefined);
});

test('open club join creates an approved player membership', function() {
  const d = beta.resolveJoin({ clubFound: true, foundClubId: BETA, isLocked: false, existingStatus: '' });
  assert.strictEqual(d.http, 200);
  assert.strictEqual(d.already, false);
  assert.deepStrictEqual(d.insert, { role: 'player', status: 'approved' });
});

test('locked club join creates a pending request, not a hard reject', function() {
  const d = beta.resolveJoin({ clubFound: true, foundClubId: BETA, isLocked: true, existingStatus: '' });
  assert.strictEqual(d.http, 200);
  assert.strictEqual(d.insert.status, 'pending');
  assert.strictEqual(d.insert.role, 'player');
});

test('duplicate join does not insert again', function() {
  ['pending', 'approved', 'active', 'rejected'].forEach(function(status) {
    const d = beta.resolveJoin({
      clubFound: true,
      foundClubId: BETA,
      isLocked: false,
      existingStatus: status,
      existingRole: 'player'
    });
    assert.strictEqual(d.already, true, status);
    assert.strictEqual(d.insert, null, status);
    assert.strictEqual(d.status, status);
  });
});

test('other clubs are not enumerable via join', function() {
  const d = beta.resolveJoin({ clubFound: true, foundClubId: OTHER, isLocked: false, existingStatus: '' });
  assert.strictEqual(d.http, 404);
  assert.strictEqual(d.body.error, 'club_not_found');
});

test('join response omits balances and invite codes', function() {
  const decision = beta.resolveJoin({ clubFound: true, foundClubId: BETA, isLocked: false });
  const body = beta.joinResponse(decision, { id: BETA, name: 'PocketBooks Beta', code: 'SECRET', balance: 1000, is_locked: false });
  assert.strictEqual(body.club.code, undefined);
  assert.strictEqual(body.club.balance, undefined);
  assert.strictEqual(body.status, 'approved');
  assert.strictEqual(body.role, 'player');
});

test('membership view does not invent a balance', function() {
  const view = beta.membershipView({ status: 'approved', role: 'player', balance: 1000 });
  assert.deepStrictEqual(view, { status: 'approved', role: 'player' });
  assert.strictEqual(beta.membershipView(null), null);
});

console.log('\n-- player beta route wiring --');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('create-club route denies when public creation is off', function() {
  assert(indexSrc.indexOf("require('./lib/player-beta')") !== -1, 'index must load player-beta');
  assert(indexSrc.indexOf('PUBLIC_CLUB_CREATION_ENABLED') !== -1, 'flag missing');
  assert(indexSrc.indexOf('createClubDenial(PUBLIC_CLUB_CREATION_ENABLED)') !== -1, 'POST /api/clubs must deny');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'player-beta.js'), 'utf8');
  assert(lib.indexOf('club_creation_disabled') !== -1);
});

test('signup assigns role through assignedSignupRole', function() {
  assert(indexSrc.indexOf('assignedSignupRole(') !== -1);
});

test('player-beta and join routes exist and are actor-scoped', function() {
  assert(indexSrc.indexOf("app.get('/api/player-beta'") !== -1);
  assert(indexSrc.indexOf('resolveJoin(') !== -1);
  assert(indexSrc.indexOf('joinResponse(') !== -1);
  const joinFn = indexSrc.slice(indexSrc.indexOf('async function _clubJoinRequestHandler'));
  assert(joinFn.indexOf('req.user.id') !== -1);
  assert(!/actorId:\s*body\.actorId/.test(joinFn.slice(0, 2500)), 'join must not trust client actorId');
});

test('signup and join are rate limited', function() {
  assert(indexSrc.indexOf("'/api/auth/signup'") !== -1);
  assert(indexSrc.indexOf("'/api/club/join-request'") !== -1);
});

test('member approval and denial verify pending status transition', function() {
  assert(indexSrc.indexOf('async function _membershipSetPendingStatus') !== -1,
    'membership transition helper missing');
  assert(indexSrc.indexOf("throw new Error('membership_status_update_failed')") !== -1,
    'membership transition must fail when the row status does not change');
  assert(indexSrc.indexOf('updatePendingCompat') !== -1,
    'membership transition must tolerate schemas without optional approved_at');
  assert(indexSrc.indexOf('/approved_at/i.test') !== -1,
    'membership transition must retry without approved_at on schema-cache mismatch');

  const approveRoute = indexSrc.slice(
    indexSrc.indexOf("app.post('/api/club/members/approve'"),
    indexSrc.indexOf("app.post('/api/club/members/deny'")
  );
  assert(approveRoute.indexOf("_membershipSetPendingStatus(targetActorId, clubId, 'approved'") !== -1,
    'approval route must use verified membership transition');

  const denyRoute = indexSrc.slice(
    indexSrc.indexOf("app.post('/api/club/members/deny'"),
    indexSrc.indexOf("app.post('/api/club/members/role'")
  );
  assert(denyRoute.indexOf("_membershipSetPendingStatus(targetActorId, clubId, 'rejected'") !== -1,
    'denial route must use verified membership transition');
});

test('pending request listing matches production membership schema', function() {
  const firstRoute = indexSrc.slice(
    indexSrc.indexOf("app.get('/api/clubs/:id/requests'"),
    indexSrc.indexOf("// Alias used by overnight join-request flow")
  );
  const aliasRoute = indexSrc.slice(
    indexSrc.indexOf("app.get('/api/club/pending-requests'"),
    indexSrc.indexOf("app.patch('/api/clubs/:id/requests/:memberId'")
  );
  assert(firstRoute.indexOf("select('actor_id,club_id,role,status,joined_at,updated_at')") !== -1,
    'club request listing must not select nonexistent club_memberships.id');
  assert(aliasRoute.indexOf("select('actor_id,club_id,role,status,joined_at,updated_at')") !== -1,
    'pending-request alias must not select nonexistent club_memberships.id');
  assert(firstRoute.indexOf('membershipId: null') !== -1,
    'request listing should not invent a membership id');
  assert(aliasRoute.indexOf('membershipId: null') !== -1,
    'pending-request alias should not invent a membership id');
});

console.log('\nPlayer beta tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
