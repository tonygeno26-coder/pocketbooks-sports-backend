'use strict';

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'expected true');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'values differ') +
      ' - got ' + JSON.stringify(actual) + ' expected ' + JSON.stringify(expected));
  }
}

const ROLE_RANK = {
  owner:5,
  full_admin:4,
  settlement_manager:3,
  risk_viewer:2,
  player:1,
  view_only:0
};

const ACTION_MIN_RANK = {
  place_bet:-1,
  cancel_bet:-1,
  view_player_dashboard:-1
};

function getRoleRank(role) {
  return ROLE_RANK[role] != null ? ROLE_RANK[role] : -99;
}

function checkPermission(actor, action, targetPlayerId) {
  const minRank = ACTION_MIN_RANK[action];
  const rank = getRoleRank(actor.role);
  if (minRank === -1) {
    const isSelf = targetPlayerId && String(actor.actorId) === String(targetPlayerId);
    if (action === 'place_bet') {
      if (!isSelf) return { allowed:false, reason:'not_own_account', status:403 };
      if (actor.role !== 'player') {
        return { allowed:false, reason:'host_betting_disabled', status:403 };
      }
      return { allowed:true };
    }
    const isPrivileged = rank >= ROLE_RANK.full_admin;
    if (!isSelf && !isPrivileged) {
      return { allowed:false, reason:'not_own_account', status:403 };
    }
    return { allowed:true };
  }
  return { allowed:rank >= minRank };
}

console.log('\n-- Host placement permission containment --');

test('player can place own bet in selected player club', function() {
  const r = checkPermission({ actorId:'u1', role:'player' }, 'place_bet', 'u1');
  assert(r.allowed, 'expected player self-placement to pass');
});

test('owner cannot place own bet in hosted club', function() {
  const r = checkPermission({ actorId:'u1', role:'owner' }, 'place_bet', 'u1');
  assert(!r.allowed, 'expected owner placement to reject');
  assertEq(r.reason, 'host_betting_disabled');
});

test('cohost/admin roles cannot place own bet in hosted club', function() {
  ['full_admin', 'settlement_manager', 'risk_viewer'].forEach(function(role) {
    const r = checkPermission({ actorId:'u1', role }, 'place_bet', 'u1');
    assert(!r.allowed, 'expected '+role+' placement to reject');
    assertEq(r.reason, 'host_betting_disabled');
  });
});

test('host placement hardening does not remove privileged cancel behavior', function() {
  const r = checkPermission({ actorId:'host1', role:'full_admin' }, 'cancel_bet', 'player1');
  assert(r.allowed, 'expected full_admin cancel privilege to remain');
});

console.log('\nHost placement permission tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
