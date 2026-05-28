'use strict';

let _pass = 0;
let _fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
    _pass++;
  } catch (e) {
    console.error('  FAIL ' + name + '\n     ' + e.message);
    _fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'expected true');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'values differ') +
      ' — got ' + JSON.stringify(actual) + ' expected ' + JSON.stringify(expected));
  }
}

const LIVE_SNAPSHOT_TTL_MS = 10 * 1000;
const PREGAME_SNAPSHOT_TTL_MS = 120 * 1000;
const NOW_MS = new Date('2026-05-27T20:00:00Z').getTime();
const FUTURE_CT = '2026-05-27T23:00:00Z';
const PAST_CT = '2026-05-27T19:00:00Z';

function classifyMarket(snap, nowMs) {
  nowMs = nowMs || Date.now();
  if (!snap) return 'suspended';
  const fetchedMs = new Date(snap.fetched_at || snap.fetchedAt).getTime();
  const ageMs = nowMs - fetchedMs;

  const evStatus = String(snap.event_status || snap.eventStatus || snap.gameStatus || '').toLowerCase();
  const mkStatus = String(snap.market_status || snap.marketStatus || '').toLowerCase();

  if (snap.eventCompleted === true || evStatus === 'final' || evStatus === 'completed' ||
      mkStatus === 'final' || mkStatus === 'closed' || mkStatus === 'settled') return 'final';
  if (snap.eventCanceled === true || evStatus === 'canceled' || evStatus === 'cancelled' ||
      evStatus === 'postponed' || evStatus === 'abandoned') return 'canceled';
  if (snap.suspended === true || mkStatus === 'suspended' || mkStatus === 'paused') return 'suspended';

  const ct = snap.commence_time || snap.commenceTime;
  let isLiveSnapshot = snap.eventLive === true || evStatus === 'live' || evStatus === 'in_play' || evStatus === 'in_progress';
  if (ct) {
    const ms = new Date(ct).getTime();
    if (!isNaN(ms) && nowMs >= ms) isLiveSnapshot = true;
  }
  const ttlMs = isLiveSnapshot ? LIVE_SNAPSHOT_TTL_MS : PREGAME_SNAPSHOT_TTL_MS;
  if (!Number.isFinite(fetchedMs) || ageMs > ttlMs) return 'stale';
  if (isLiveSnapshot) return 'live';
  return 'active';
}

function verifySnapshot(snap, leg, nowMs) {
  nowMs = nowMs || Date.now();
  const state = classifyMarket(snap, nowMs);
  if (state === 'stale') return { ok:false, code:'odds_stale' };
  if (state === 'final') return { ok:false, code:'market_unavailable', reason:'game_final' };
  if (state === 'canceled') return { ok:false, code:'market_unavailable', reason:'game_canceled' };
  if (state === 'suspended') return { ok:false, code:'market_unavailable', reason:'suspended' };

  const commenceTime = snap.commence_time || snap.commenceTime;
  const commenceMs = commenceTime ? new Date(commenceTime).getTime() : NaN;
  const hasCommenced = !isNaN(commenceMs) && nowMs >= commenceMs;
  if (state === 'live' || hasCommenced) {
    return {
      ok:false,
      code:'live_betting_disabled',
      reason: state === 'live' ? 'server_live' : 'event_started',
      commenceTime: commenceTime || null
    };
  }

  const submittedOdds = Number(leg.odds);
  const serverOdds = Number(snap.odds_american);
  if (!Number.isFinite(submittedOdds) || !Number.isFinite(serverOdds)) {
    return { ok:false, code:'invalid_snapshot_odds' };
  }
  if (submittedOdds !== serverOdds) {
    return { ok:false, code:'odds_changed', submittedOdds, serverOdds };
  }
  return { ok:true, isLive:state === 'live', commenceTime };
}

function snap(overrides) {
  return Object.assign({
    fetched_at: new Date(NOW_MS - 5 * 1000).toISOString(),
    commence_time: FUTURE_CT,
    odds_american: -110,
    event_status: 'upcoming',
    market_status: 'active',
    eventLive: false,
    eventCompleted: false,
    eventCanceled: false,
    suspended: false
  }, overrides || {});
}

function leg(overrides) {
  return Object.assign({ pick:'Guardians', odds:-110, isLive:false }, overrides || {});
}

console.log('\n-- Backend live placement hard gate --');

test('pregame future commence passes', function() {
  const r = verifySnapshot(snap({ commence_time:FUTURE_CT, event_status:'upcoming' }), leg(), NOW_MS);
  assert(r.ok, 'expected pregame snapshot to pass: ' + JSON.stringify(r));
});

test('live classified snapshot rejects', function() {
  const r = verifySnapshot(snap({ event_status:'live', commence_time:FUTURE_CT }), leg(), NOW_MS);
  assert(!r.ok, 'expected rejection');
  assertEq(r.code, 'live_betting_disabled');
  assertEq(r.reason, 'server_live');
});

test('commence_time in past rejects', function() {
  const r = verifySnapshot(snap({ event_status:'upcoming', commence_time:PAST_CT }), leg(), NOW_MS);
  assert(!r.ok, 'expected rejection');
  assertEq(r.code, 'live_betting_disabled');
});

test('live snapshot older than 10 seconds rejects as stale', function() {
  const r = verifySnapshot(snap({
    event_status:'live',
    fetched_at:new Date(NOW_MS - LIVE_SNAPSHOT_TTL_MS - 1).toISOString()
  }), leg(), NOW_MS);
  assert(!r.ok, 'expected rejection');
  assertEq(r.code, 'odds_stale');
});

test('pregame snapshot older than 120 seconds rejects as stale', function() {
  const r = verifySnapshot(snap({
    event_status:'upcoming',
    commence_time:FUTURE_CT,
    fetched_at:new Date(NOW_MS - PREGAME_SNAPSHOT_TTL_MS - 1).toISOString()
  }), leg(), NOW_MS);
  assert(!r.ok, 'expected rejection');
  assertEq(r.code, 'odds_stale');
});

test('client isLive:false cannot bypass server live state', function() {
  const r = verifySnapshot(snap({ eventLive:true, commence_time:FUTURE_CT }), leg({ isLive:false }), NOW_MS);
  assert(!r.ok, 'expected rejection');
  assertEq(r.code, 'live_betting_disabled');
});

test('client isLive:true on pregame still follows server state', function() {
  const r = verifySnapshot(snap({ event_status:'upcoming', eventLive:false, commence_time:FUTURE_CT }), leg({ isLive:true }), NOW_MS);
  assert(r.ok, 'client live flag must not force rejection without server-live state');
});

console.log('\nLive placement gate tests: ' + _pass + ' passed, ' + _fail + ' failed');
if (_fail > 0) process.exit(1);
