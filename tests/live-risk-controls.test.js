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

function checkRisk(cs, params) {
  cs = cs || {};
  params = params || {};
  const stake = Number(params.stake || 0);
  const payout = Number(params.potentialPayout || 0);
  const type = String(params.betType || 'Single').toLowerCase();
  const legs = params.legs || [];
  const liveLegs = legs.filter(function(l){ return !!l.server_is_live; });

  if (liveLegs.length > 0) {
    if (cs.allow_live_betting !== true) return { ok:false, code:'live_betting_disabled' };
    if (liveLegs.length > 1 && cs.allow_live_parlays !== true) return { ok:false, code:'live_parlays_disabled' };
    if ((type === 'parlay' || type === 'roundrobin') && cs.allow_live_parlays !== true) {
      return { ok:false, code:'live_parlays_disabled' };
    }
    if (cs.max_live_stake && stake > Number(cs.max_live_stake)) {
      return { ok:false, code:'live_stake_above_max', max:cs.max_live_stake, stake };
    }
    if (cs.max_live_payout && payout > Number(cs.max_live_payout)) {
      return { ok:false, code:'live_payout_above_max', max:cs.max_live_payout, payout };
    }
    const enabledSports = Array.isArray(cs.live_enabled_sports)
      ? cs.live_enabled_sports.map(function(s){ return String(s || '').toLowerCase(); }).filter(Boolean)
      : [];
    if (enabledSports.length === 0) return { ok:false, code:'live_sport_disabled' };
    for (let i = 0; i < liveLegs.length; i++) {
      const sport = String(liveLegs[i].sport || '').toLowerCase();
      if (!enabledSports.includes(sport)) return { ok:false, code:'live_sport_disabled', sport };
    }
  }

  return { ok:true };
}

function liveLeg(overrides) {
  return Object.assign({
    sport:'nba',
    market:'moneyline',
    canonicalGameKey:'basketball_nba|A|B|2026-05-28',
    server_is_live:true
  }, overrides || {});
}

const LIVE_ON = {
  allow_live_betting:true,
  allow_live_parlays:false,
  live_enabled_sports:['nba'],
  max_live_stake:50,
  max_live_payout:500
};

console.log('\n-- Live risk controls --');

test('live straight under caps passes risk stage', function() {
  const r = checkRisk(LIVE_ON, {
    stake:25,
    potentialPayout:45,
    betType:'Single',
    legs:[liveLeg()]
  });
  assert(r.ok, 'expected pass: ' + JSON.stringify(r));
});

test('live straight over stake cap rejects', function() {
  const r = checkRisk(LIVE_ON, {
    stake:75,
    potentialPayout:120,
    betType:'Single',
    legs:[liveLeg()]
  });
  assert(!r.ok, 'expected rejection');
  assertEq(r.code, 'live_stake_above_max');
});

test('live payout over cap rejects', function() {
  const r = checkRisk(LIVE_ON, {
    stake:25,
    potentialPayout:600,
    betType:'Single',
    legs:[liveLeg()]
  });
  assert(!r.ok, 'expected rejection');
  assertEq(r.code, 'live_payout_above_max');
});

test('live parlay rejects when allow_live_parlays=false', function() {
  const r = checkRisk(LIVE_ON, {
    stake:25,
    potentialPayout:120,
    betType:'Parlay',
    legs:[liveLeg(), liveLeg({ canonicalGameKey:'basketball_nba|C|D|2026-05-28' })]
  });
  assert(!r.ok, 'expected rejection');
  assertEq(r.code, 'live_parlays_disabled');
});

test('disabled live sport rejects', function() {
  const r = checkRisk(LIVE_ON, {
    stake:25,
    potentialPayout:45,
    betType:'Single',
    legs:[liveLeg({ sport:'mlb' })]
  });
  assert(!r.ok, 'expected rejection');
  assertEq(r.code, 'live_sport_disabled');
});

test('empty live_enabled_sports rejects even when live betting is allowed', function() {
  const r = checkRisk(Object.assign({}, LIVE_ON, { live_enabled_sports:[] }), {
    stake:25,
    potentialPayout:45,
    betType:'Single',
    legs:[liveLeg()]
  });
  assert(!r.ok, 'expected rejection');
  assertEq(r.code, 'live_sport_disabled');
});

console.log('\nLive risk controls tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
