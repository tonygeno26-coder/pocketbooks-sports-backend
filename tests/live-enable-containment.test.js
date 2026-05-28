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

const NOW_MS = new Date('2026-05-28T18:00:00Z').getTime();
const LIVE_TTL_MS = 10 * 1000;

function snap(overrides) {
  return Object.assign({
    fetched_at:new Date(NOW_MS - 1000).toISOString(),
    commence_time:new Date(NOW_MS - 60 * 1000).toISOString(),
    event_status:'live',
    market_status:'active',
    odds_american:-110,
    odds_decimal:1.9091,
    point_line:null,
    suspended:false
  }, overrides || {});
}

function leg(overrides) {
  return Object.assign({
    pick:'Home',
    market:'moneyline',
    sport:'nba',
    odds:-110,
    line:null,
    canonicalGameKey:'basketball_nba|Away|Home|2026-05-28'
  }, overrides || {});
}

function classifyMarket(s, nowMs) {
  const ageMs = nowMs - new Date(s.fetched_at).getTime();
  const ev = String(s.event_status || '').toLowerCase();
  const mk = String(s.market_status || '').toLowerCase();
  if (ev === 'final' || mk === 'closed') return 'final';
  if (ev === 'canceled' || ev === 'cancelled' || ev === 'postponed') return 'canceled';
  if (s.suspended === true || mk === 'suspended' || mk === 'paused') return 'suspended';
  const live = ev === 'live' || ev === 'in_play' || ev === 'in_progress' ||
    new Date(s.commence_time).getTime() <= nowMs;
  if (ageMs > (live ? LIVE_TTL_MS : 120000)) return 'stale';
  return live ? 'live' : 'active';
}

function verifySnapshot(s, l, opts) {
  opts = opts || {};
  const state = classifyMarket(s, NOW_MS);
  if (state === 'stale') return { ok:false, code:'odds_stale' };
  if (state === 'suspended') return { ok:false, code:'market_unavailable', reason:'suspended' };
  if (state === 'final') return { ok:false, code:'market_unavailable', reason:'game_final' };
  if ((state === 'live' || new Date(s.commence_time).getTime() <= NOW_MS) && !opts.liveBettingEnabled) {
    return { ok:false, code:'live_betting_disabled', reason:'server_live' };
  }
  if (Number(l.odds) !== Number(s.odds_american)) {
    return { ok:false, code:'odds_changed', submittedOdds:Number(l.odds), serverOdds:Number(s.odds_american) };
  }
  const needsLine = String(l.market||'').toLowerCase().includes('spread') ||
    String(l.market||'').toLowerCase().includes('total');
  if (needsLine && Number(l.line) !== Number(s.point_line)) {
    return { ok:false, code:'line_changed', submittedPointLine:Number(l.line), serverPointLine:Number(s.point_line) };
  }
  return { ok:true, legs:[Object.assign({}, l, { server_is_live:state === 'live' })] };
}

function checkRisk(cs, params) {
  const legs = params.legs || [];
  const liveLegs = legs.filter(function(l){ return l.server_is_live; });
  if (!liveLegs.length) return { ok:true };
  if (cs.allow_live_betting !== true) return { ok:false, code:'live_betting_disabled' };
  if (params.betType !== 'Single' && cs.allow_live_parlays !== true) return { ok:false, code:'live_parlays_disabled' };
  if (liveLegs.length > 1 && cs.allow_live_parlays !== true) return { ok:false, code:'live_parlays_disabled' };
  if (params.stake > cs.max_live_stake) return { ok:false, code:'live_stake_above_max' };
  if (params.payout > cs.max_live_payout) return { ok:false, code:'live_payout_above_max' };
  const enabled = (cs.live_enabled_sports || []).map(function(s){ return String(s).toLowerCase(); });
  if (!enabled.includes(String(liveLegs[0].sport||'').toLowerCase())) return { ok:false, code:'live_sport_disabled' };
  return { ok:true };
}

function placeHarness(opts) {
  opts = opts || {};
  const state = { habCharges:0, placeRpcCalls:0 };
  const first = verifySnapshot(opts.initialSnap || snap(), opts.leg || leg(), { liveBettingEnabled:opts.liveBettingEnabled });
  if (!first.ok) return { result:first, state };
  const risk = checkRisk(opts.clubSettings || {}, {
    stake:opts.stake || 1,
    payout:opts.payout || 1.91,
    betType:opts.betType || 'Single',
    legs:first.legs
  });
  if (!risk.ok) return { result:risk, state };
  const final = verifySnapshot(opts.finalSnap || opts.initialSnap || snap(), opts.leg || leg(), { liveBettingEnabled:opts.liveBettingEnabled });
  if (!final.ok) return { result:Object.assign({ finalRecheck:true }, final), state };
  state.placeRpcCalls++;
  state.habCharges++;
  return { result:{ ok:true }, state };
}

const LIVE_CLUB_ON = {
  allow_live_betting:true,
  allow_live_parlays:false,
  live_enabled_sports:['nba'],
  max_live_stake:5,
  max_live_payout:25
};

console.log('\n-- Live enablement containment --');

test('global flag off rejects live', function() {
  const r = placeHarness({ liveBettingEnabled:false, clubSettings:LIVE_CLUB_ON });
  assert(!r.result.ok);
  assertEq(r.result.code, 'live_betting_disabled');
});

test('global flag on + club off rejects', function() {
  const r = placeHarness({ liveBettingEnabled:true, clubSettings:Object.assign({}, LIVE_CLUB_ON, { allow_live_betting:false }) });
  assert(!r.result.ok);
  assertEq(r.result.code, 'live_betting_disabled');
});

test('global flag on + sport disabled rejects', function() {
  const r = placeHarness({ liveBettingEnabled:true, clubSettings:Object.assign({}, LIVE_CLUB_ON, { live_enabled_sports:['mlb'] }) });
  assert(!r.result.ok);
  assertEq(r.result.code, 'live_sport_disabled');
});

test('global flag on + live single moneyline under caps reaches placement path', function() {
  const r = placeHarness({ liveBettingEnabled:true, clubSettings:LIVE_CLUB_ON });
  assert(r.result.ok, 'expected placement path: ' + JSON.stringify(r.result));
  assertEq(r.state.placeRpcCalls, 1);
  assertEq(r.state.habCharges, 1);
});

test('live parlay rejects', function() {
  const r = placeHarness({ liveBettingEnabled:true, clubSettings:LIVE_CLUB_ON, betType:'Parlay' });
  assert(!r.result.ok);
  assertEq(r.result.code, 'live_parlays_disabled');
});

test('final recheck catches changed odds before HAB', function() {
  const r = placeHarness({ liveBettingEnabled:true, clubSettings:LIVE_CLUB_ON, finalSnap:snap({ odds_american:-125 }) });
  assert(!r.result.ok);
  assertEq(r.result.code, 'odds_changed');
  assertEq(r.result.finalRecheck, true);
  assertEq(r.state.placeRpcCalls, 0);
  assertEq(r.state.habCharges, 0);
});

test('final recheck catches changed line before HAB', function() {
  const r = placeHarness({
    liveBettingEnabled:true,
    clubSettings:LIVE_CLUB_ON,
    leg:leg({ market:'spread', pick:'Home -1.5', line:-1.5 }),
    initialSnap:snap({ point_line:-1.5 }),
    finalSnap:snap({ point_line:-2.5 })
  });
  assert(!r.result.ok);
  assertEq(r.result.code, 'line_changed');
  assertEq(r.result.finalRecheck, true);
  assertEq(r.state.placeRpcCalls, 0);
  assertEq(r.state.habCharges, 0);
});

test('final recheck catches suspended market before HAB', function() {
  const r = placeHarness({
    liveBettingEnabled:true,
    clubSettings:LIVE_CLUB_ON,
    finalSnap:snap({ market_status:'suspended', suspended:true })
  });
  assert(!r.result.ok);
  assertEq(r.result.code, 'market_unavailable');
  assertEq(r.result.reason, 'suspended');
  assertEq(r.state.placeRpcCalls, 0);
  assertEq(r.state.habCharges, 0);
});

console.log('\nLive enablement containment tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
