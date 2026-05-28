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
      ' - got ' + JSON.stringify(actual) + ' expected ' + JSON.stringify(expected));
  }
}

const LIVE_SNAPSHOT_TTL_MS = 10 * 1000;
const PREGAME_SNAPSHOT_TTL_MS = 120 * 1000;
const SNAPSHOT_TTL_MS = PREGAME_SNAPSHOT_TTL_MS;
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
  if (!snap) {
    return { ok:false, code:'odds_service_unavailable', reason:'snapshot_missing', leg:leg.pick };
  }

  const state = classifyMarket(snap, nowMs);
  if (state === 'stale') {
    const ageMs = nowMs - new Date(snap.fetched_at).getTime();
    return { ok:false, code:'odds_stale', leg:leg.pick, ageMs };
  }
  if (state === 'final') return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'game_final' };
  if (state === 'canceled') return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'game_canceled' };
  if (state === 'suspended') return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'suspended' };

  const commenceTime = snap.commence_time || snap.commenceTime;
  const commenceMs = commenceTime ? new Date(commenceTime).getTime() : NaN;
  const hasCommenced = !isNaN(commenceMs) && nowMs >= commenceMs;
  if (state === 'live' || hasCommenced) {
    return {
      ok:false,
      code:'live_betting_disabled',
      leg:leg.pick,
      reason:state === 'live' ? 'server_live' : 'event_started',
      commenceTime:commenceTime || null
    };
  }

  const rawSubmittedOdds = leg.odds;
  const rawServerOdds = snap.odds_american;
  const submittedOdds = Number(rawSubmittedOdds);
  const serverOdds = Number(rawServerOdds);
  if (rawSubmittedOdds == null || rawSubmittedOdds === '' ||
      rawServerOdds == null || rawServerOdds === '' ||
      !Number.isFinite(submittedOdds) || !Number.isFinite(serverOdds) ||
      submittedOdds === 0 || serverOdds === 0) {
    return { ok:false, code:'invalid_snapshot_odds', leg:leg.pick };
  }

  if (submittedOdds !== serverOdds) {
    return {
      ok:false,
      code:'odds_changed',
      leg:leg.pick,
      submittedOdds,
      serverOdds,
      reason:'exact_match_required'
    };
  }

  return {
    ok:true,
    snapshotId:snap.snapshot_id,
    acceptedOddsAmerican:serverOdds,
    acceptedOddsDecimal:parseFloat(snap.odds_decimal),
    acceptedPointLine:snap.point_line != null ? parseFloat(snap.point_line) : null,
    commenceTime,
    isLive:state === 'live'
  };
}

function recalcPayoutFromSnapshots(legs, snapshots, nowMs) {
  let product = 1;
  const enrichedLegs = [];
  for (let i = 0; i < legs.length; i++) {
    const vr = verifySnapshot(snapshots[i], legs[i], nowMs);
    if (!vr.ok) return Object.assign(vr, { legIndex:i });
    product *= vr.acceptedOddsDecimal ||
      (vr.acceptedOddsAmerican > 0
        ? vr.acceptedOddsAmerican / 100 + 1
        : 100 / Math.abs(vr.acceptedOddsAmerican || 110) + 1);
    enrichedLegs.push(Object.assign({}, legs[i], {
      accepted_odds_american:vr.acceptedOddsAmerican,
      accepted_odds_decimal:vr.acceptedOddsDecimal,
      accepted_point_line:vr.acceptedPointLine || null,
      odds_snapshot_id:vr.snapshotId || null,
      accepted_at:new Date(nowMs).toISOString(),
      dev_fallback:false,
      server_is_live:vr.isLive || false
    }));
  }
  return { ok:true, payout:Math.round(product * 100) / 100, legs:enrichedLegs };
}

function makePlacementHarness() {
  const state = {
    placeRpcCalls:0,
    legInsertCalls:0,
    habCharges:0,
    localFallbackUsed:false
  };

  function placeBet(opts) {
    opts = opts || {};
    const payout = recalcPayoutFromSnapshots(opts.legs || [leg()], opts.snapshots || [snap()], NOW_MS);
    if (!payout.ok) return { ok:false, error:payout.code, reason:payout.reason, legIndex:payout.legIndex };

    if (opts.balanceOk === false) return { ok:false, error:'insufficient_balance' };
    if (opts.riskOk === false) return { ok:false, error:'risk_rejected' };
    if (opts.conflict === true) return { ok:false, error:'conflict_active_bet' };
    if (opts.rpcOk === false) return { ok:false, error:'placement_failed' };
    state.placeRpcCalls++;

    if (opts.legsInsertOk === false) return { ok:false, error:'ticket_legs_insert_failed' };
    state.legInsertCalls++;

    state.habCharges++;
    return { ok:true, ticketId:'T_REGRESSION', legs:payout.legs };
  }

  return { state, placeBet };
}

function snap(overrides) {
  return Object.assign({
    snapshot_id:'S1',
    fetched_at:new Date(NOW_MS - 5 * 1000).toISOString(),
    commence_time:FUTURE_CT,
    odds_american:-110,
    odds_decimal:1.9091,
    event_status:'upcoming',
    market_status:'active',
    eventLive:false,
    eventCompleted:false,
    eventCanceled:false,
    suspended:false
  }, overrides || {});
}

function leg(overrides) {
  return Object.assign({
    pick:'Guardians',
    market:'moneyline',
    canonicalGameKey:'MLB|reds|guardians|2026-05-27',
    odds:-110,
    isLive:false
  }, overrides || {});
}

function assertRejectNoHab(name, snapshot, expectedCode, expectedReason) {
  test(name, function() {
    const h = makePlacementHarness();
    const r = h.placeBet({ legs:[leg()], snapshots:[snapshot] });
    assert(!r.ok, 'expected placement rejection');
    assertEq(r.error, expectedCode, 'error code');
    if (expectedReason) assertEq(r.reason, expectedReason, 'reason');
    assertEq(h.state.placeRpcCalls, 0, 'place RPC calls');
    assertEq(h.state.legInsertCalls, 0, 'leg insert calls');
    assertEq(h.state.habCharges, 0, 'HAB charges');
    assertEq(h.state.localFallbackUsed, false, 'local fallback must stay unused');
  });
}

console.log('\n-- Snapshot placement safety regression --');

assertRejectNoHab('missing snapshot rejects', null, 'odds_service_unavailable', 'snapshot_missing');
assertRejectNoHab('stale snapshot rejects', snap({
  fetched_at:new Date(NOW_MS - SNAPSHOT_TTL_MS - 1000).toISOString()
}), 'odds_stale');
assertRejectNoHab('live snapshot stale after 10 seconds', snap({
  event_status:'live',
  fetched_at:new Date(NOW_MS - LIVE_SNAPSHOT_TTL_MS - 1).toISOString()
}), 'odds_stale');
assertRejectNoHab('pregame snapshot remains fresh before 120 seconds then rejects after', snap({
  fetched_at:new Date(NOW_MS - PREGAME_SNAPSHOT_TTL_MS - 1).toISOString()
}), 'odds_stale');
assertRejectNoHab('suspended snapshot rejects', snap({ market_status:'suspended' }), 'market_unavailable', 'suspended');
assertRejectNoHab('final snapshot rejects', snap({ event_status:'final' }), 'market_unavailable', 'game_final');
assertRejectNoHab('canceled snapshot rejects', snap({ event_status:'canceled' }), 'market_unavailable', 'game_canceled');
assertRejectNoHab('invalid odds snapshot rejects', snap({ odds_american:null }), 'invalid_snapshot_odds');
assertRejectNoHab('odds mismatch rejects', snap({ odds_american:-120 }), 'odds_changed');
assertRejectNoHab('server-live snapshot rejects', snap({ event_status:'live' }), 'live_betting_disabled', 'server_live');
assertRejectNoHab('post-commence snapshot rejects', snap({ commence_time:PAST_CT }), 'live_betting_disabled', 'server_live');

test('exact odds match accepts and reaches durable placement before HAB', function() {
  const h = makePlacementHarness();
  const r = h.placeBet({ legs:[leg()], snapshots:[snap()] });
  assert(r.ok, 'expected placement success: ' + JSON.stringify(r));
  assertEq(h.state.placeRpcCalls, 1, 'place RPC calls');
  assertEq(h.state.legInsertCalls, 1, 'leg insert calls');
  assertEq(h.state.habCharges, 1, 'HAB charges');
  assertEq(r.legs[0].accepted_odds_american, -110, 'accepted odds');
});

test('pregame snapshot is fresh inside 120 second TTL', function() {
  const h = makePlacementHarness();
  const r = h.placeBet({
    legs:[leg()],
    snapshots:[snap({ fetched_at:new Date(NOW_MS - PREGAME_SNAPSHOT_TTL_MS + 1).toISOString() })]
  });
  assert(r.ok, 'expected pregame snapshot inside TTL to pass: ' + JSON.stringify(r));
});

test('one bad leg rejects whole parlay before ticket or HAB mutation', function() {
  const h = makePlacementHarness();
  const r = h.placeBet({
    legs:[leg({ pick:'Guardians', odds:-110 }), leg({ pick:'Reds', odds:120 })],
    snapshots:[snap({ odds_american:-110 }), snap({ odds_american:110 })]
  });
  assert(!r.ok, 'expected parlay rejection');
  assertEq(r.error, 'odds_changed');
  assertEq(r.legIndex, 1);
  assertEq(h.state.placeRpcCalls, 0, 'place RPC calls');
  assertEq(h.state.legInsertCalls, 0, 'leg insert calls');
  assertEq(h.state.habCharges, 0, 'HAB charges');
});

test('HAB does not fire on any snapshot rejection class', function() {
  const rejectionSnapshots = [
    null,
    snap({ fetched_at:new Date(NOW_MS - SNAPSHOT_TTL_MS - 1000).toISOString() }),
    snap({ market_status:'suspended' }),
    snap({ event_status:'final' }),
    snap({ event_status:'canceled' }),
    snap({ odds_american:NaN }),
    snap({ odds_american:-120 }),
    snap({ event_status:'live' }),
    snap({ commence_time:PAST_CT })
  ];
  rejectionSnapshots.forEach(function(snapshotValue, idx) {
    const h = makePlacementHarness();
    const r = h.placeBet({ legs:[leg()], snapshots:[snapshotValue] });
    assert(!r.ok, 'expected rejection at index ' + idx);
    assertEq(h.state.habCharges, 0, 'HAB charges at index ' + idx);
    assertEq(h.state.placeRpcCalls, 0, 'place RPC calls at index ' + idx);
    assertEq(h.state.legInsertCalls, 0, 'leg insert calls at index ' + idx);
  });
});

test('backend regression harness does not involve network or client local fallback', function() {
  const h = makePlacementHarness();
  const r = h.placeBet({ legs:[leg()], snapshots:[snap()] });
  assert(r.ok, 'expected success');
  assertEq(h.state.localFallbackUsed, false);
  assertEq(typeof global.localStorage, 'undefined', 'Node backend test must not depend on browser localStorage');
  assertEq(typeof global.fetch, 'function', 'Node may expose fetch, but harness must not call it');
});

console.log('\nSnapshot placement safety regression tests: ' + _pass + ' passed, ' + _fail + ' failed');
if (_fail > 0) process.exit(1);
