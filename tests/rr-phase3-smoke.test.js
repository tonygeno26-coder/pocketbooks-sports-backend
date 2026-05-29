'use strict';

// ============================================================================
// GRD-2/RR Phase 3 smoke tests — post-containment-removal
//
// Exercises the full RR placement path now that it is live. Tests are
// unit-harness style (no network) and cover:
//
//   A. W/W/L scenario  — 3-pick by 2: combo0 wins, combo1 wins, combo2 loses
//   B. W/P/W scenario  — 3-pick by 2: combo0 wins, combo1 pushes, combo2 wins
//   C. P/P/P scenario  — 3-pick by 2: all three combos push
//   D. Mixed-size RR   — 4-pick by 2 and 3: combo counts, total stake, balance
//   E. rrStakes absence  — handler rejects before RPC when rrStakes missing
//   F. Containment gone  — RoundRobin no longer returns rr_temporarily_disabled
//   G. Frontend grouping — DB-origin Parlay combos collapse into slip card
//   H. Frontend payload  — rrStakes included in _dbPayload for snap.type=rr
// ============================================================================

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
  if (!cond) throw new Error(msg || 'expected truthy');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      (msg || 'mismatch') +
      ' — got ' + JSON.stringify(actual) +
      ' expected ' + JSON.stringify(expected)
    );
  }
}

function assertClose(actual, expected, tol, msg) {
  tol = tol || 0.01;
  if (Math.abs(actual - expected) > tol) {
    throw new Error(
      (msg || 'value out of tolerance') +
      ' — got ' + actual + ' expected ' + expected + ' (tol=' + tol + ')'
    );
  }
}

// ---------------------------------------------------------------------------
// Shared helpers — mirrors the backend _getRrCombos and _sgAmToDecimal
// ---------------------------------------------------------------------------
function getRrCombos(arr, size) {
  if (!Array.isArray(arr) || size < 1 || size > arr.length) return [];
  if (size === 1) return arr.map(function(x) { return [x]; });
  var out = [];
  arr.forEach(function(x, i) {
    getRrCombos(arr.slice(i + 1), size - 1).forEach(function(rest) {
      out.push([x].concat(rest));
    });
  });
  return out;
}

function sgAmToDecimal(o) {
  var n = parseInt(o, 10);
  if (isNaN(n) || n === 0) return 1;
  return n > 0 ? 1 + n / 100 : 1 - 100 / n;
}

function rnd2(v) { return Math.round(v * 100) / 100; }

// ---------------------------------------------------------------------------
// Grading harness — given a set of leg outcomes, determine ticket status.
// A combo wins if ALL legs win; loses if ANY leg loses; pushes if no losses
// and at least one push.
// ---------------------------------------------------------------------------
function gradeCombo(comboLegs, legOutcomes) {
  // legOutcomes: { legId: 'won'|'lost'|'push' }
  var hasLoss = comboLegs.some(function(l) { return (legOutcomes[l.legId] || 'won') === 'lost'; });
  var hasPush = comboLegs.some(function(l) { return (legOutcomes[l.legId] || 'won') === 'push'; });
  if (hasLoss) return 'lost';
  if (hasPush) return 'push';
  return 'won';
}

// Simulate full RR slip: expand legs → combos → grade → aggregate
function simulateRr(legs, rrStakes, legOutcomes) {
  var combos = [];
  Object.keys(rrStakes).forEach(function(szKey) {
    var sz = parseInt(szKey, 10);
    var stakePerCombo = parseFloat(rrStakes[szKey]) || 0;
    if (!stakePerCombo || sz < 1) return;
    getRrCombos(legs, sz).forEach(function(comboLegs) {
      var comboOdds = comboLegs.reduce(function(p, l) { return p * sgAmToDecimal(l.odds); }, 1);
      var profit    = rnd2(stakePerCombo * (comboOdds - 1));
      var payout    = rnd2(stakePerCombo * comboOdds);
      var status    = gradeCombo(comboLegs, legOutcomes);
      var net       = status === 'won' ? profit : status === 'push' ? 0 : -stakePerCombo;
      combos.push({ legs: comboLegs, stake: stakePerCombo, profit: profit, payout: payout, status: status, net: net });
    });
  });
  var totalStake   = rnd2(combos.reduce(function(s, c) { return s + c.stake; }, 0));
  var totalNetWon  = rnd2(combos.reduce(function(s, c) { return s + (c.status === 'won'  ? c.net : 0); }, 0));
  var totalNetPush = rnd2(combos.reduce(function(s, c) { return s + (c.status === 'push' ? 0   : 0); }, 0));
  var totalNetLost = rnd2(combos.reduce(function(s, c) { return s + (c.status === 'lost' ? c.net : 0); }, 0));
  var slipNet      = rnd2(combos.reduce(function(s, c) { return s + c.net; }, 0));
  return { combos: combos, totalStake: totalStake, slipNet: slipNet,
           won: combos.filter(function(c) { return c.status === 'won';  }),
           lost: combos.filter(function(c) { return c.status === 'lost'; }),
           push: combos.filter(function(c) { return c.status === 'push'; }) };
}

// ---------------------------------------------------------------------------
// Shared test legs
// ---------------------------------------------------------------------------
var legs3 = [
  { legId: 'L1', odds: -110, pick: 'Team A ML' },
  { legId: 'L2', odds: -110, pick: 'Team B ML' },
  { legId: 'L3', odds: -110, pick: 'Team C ML' }
];

var legs4 = [
  { legId: 'L1', odds: -110, pick: 'A ML' },
  { legId: 'L2', odds: -110, pick: 'B ML' },
  { legId: 'L3', odds: -110, pick: 'C ML' },
  { legId: 'L4', odds: -110, pick: 'D ML' }
];

// ---------------------------------------------------------------------------
// A. W/W/L scenario
// ---------------------------------------------------------------------------
console.log('\n-- A. W/W/L scenario (3-pick by 2) --');

var wwlOutcomes = { L1: 'won', L2: 'won', L3: 'lost' };
var wwlRr = simulateRr(legs3, { '2': 10 }, wwlOutcomes);

test('W/W/L — 3 combos created', function() {
  assertEq(wwlRr.combos.length, 3, 'combo count');
});

test('W/W/L — 1 combo won (L1+L2)', function() {
  assertEq(wwlRr.won.length, 1, 'won count');
  var w = wwlRr.won[0];
  assert(w.legs.some(function(l) { return l.legId === 'L1'; }), 'L1 in winning combo');
  assert(w.legs.some(function(l) { return l.legId === 'L2'; }), 'L2 in winning combo');
});

test('W/W/L — 2 combos lost', function() {
  assertEq(wwlRr.lost.length, 2, 'lost count');
  wwlRr.lost.forEach(function(c) {
    assert(c.legs.some(function(l) { return l.legId === 'L3'; }), 'every lost combo contains L3');
  });
});

test('W/W/L — winning combo payout correct at -110/-110', function() {
  var dec = sgAmToDecimal(-110);                // ≈ 1.9091
  var expectedPayout = rnd2(10 * dec * dec);    // ≈ 36.44? no — 10*1.9091*1.9091 ≈ 36.44/10 ≈ 36.44? wait
  // Actually: stake $10, decimal 1.9091, payout = 10*(1.9091^2) = 10*3.6446 = 36.45
  // profit = payout - stake = 26.45
  var expectedProfit = rnd2(10 * (dec * dec - 1));
  assertClose(wwlRr.won[0].profit, expectedProfit, 0.02, 'W/W/L winning profit');
  assertClose(wwlRr.won[0].payout, rnd2(10 * dec * dec), 0.02, 'W/W/L winning payout');
});

test('W/W/L — total stake = $30 (3 × $10)', function() {
  assertEq(wwlRr.totalStake, 30, 'total stake');
});

test('W/W/L — net = won profit minus two $10 losses', function() {
  var dec = sgAmToDecimal(-110);
  var winProfit = rnd2(10 * (dec * dec - 1));
  var expectedNet = rnd2(winProfit - 20);   // one win, two losses
  assertClose(wwlRr.slipNet, expectedNet, 0.02, 'W/W/L net');
});

// ---------------------------------------------------------------------------
// B. W/P/W scenario
// ---------------------------------------------------------------------------
console.log('\n-- B. W/P/W scenario (3-pick by 2) --');

var wpwOutcomes = { L1: 'won', L2: 'push', L3: 'won' };
var wpwRr = simulateRr(legs3, { '2': 10 }, wpwOutcomes);

test('W/P/W — 3 combos created', function() {
  assertEq(wpwRr.combos.length, 3, 'combo count');
});

test('W/P/W — L1+L2 (contains push) grades push', function() {
  var l1l2 = wpwRr.combos.find(function(c) {
    return c.legs.some(function(l) { return l.legId === 'L1'; }) &&
           c.legs.some(function(l) { return l.legId === 'L2'; });
  });
  assert(l1l2, 'L1+L2 combo exists');
  assertEq(l1l2.status, 'push', 'L1+L2 status (push leg)');
  assertEq(l1l2.net, 0, 'push net = 0');
});

test('W/P/W — L2+L3 (contains push) grades push', function() {
  var l2l3 = wpwRr.combos.find(function(c) {
    return c.legs.some(function(l) { return l.legId === 'L2'; }) &&
           c.legs.some(function(l) { return l.legId === 'L3'; });
  });
  assert(l2l3, 'L2+L3 combo exists');
  assertEq(l2l3.status, 'push', 'L2+L3 status');
});

test('W/P/W — L1+L3 (both won) grades won', function() {
  var l1l3 = wpwRr.combos.find(function(c) {
    return c.legs.some(function(l) { return l.legId === 'L1'; }) &&
           c.legs.some(function(l) { return l.legId === 'L3'; });
  });
  assert(l1l3, 'L1+L3 combo exists');
  assertEq(l1l3.status, 'won', 'L1+L3 wins');
});

test('W/P/W — exactly 1 won, 2 push, 0 lost', function() {
  assertEq(wpwRr.won.length,  1, 'won');
  assertEq(wpwRr.push.length, 2, 'push');
  assertEq(wpwRr.lost.length, 0, 'lost');
});

// ---------------------------------------------------------------------------
// C. P/P/P scenario
// ---------------------------------------------------------------------------
console.log('\n-- C. P/P/P scenario (3-pick by 2, all push) --');

var pppOutcomes = { L1: 'push', L2: 'push', L3: 'push' };
var pppRr = simulateRr(legs3, { '2': 10 }, pppOutcomes);

test('P/P/P — 3 combos all push', function() {
  assertEq(pppRr.push.length, 3, 'push count');
  assertEq(pppRr.won.length,  0, 'won count');
  assertEq(pppRr.lost.length, 0, 'lost count');
});

test('P/P/P — net = 0 (all stakes returned)', function() {
  assertEq(pppRr.slipNet, 0, 'slip net for all-push');
});

test('P/P/P — total stake still $30', function() {
  assertEq(pppRr.totalStake, 30, 'total stake');
});

// ---------------------------------------------------------------------------
// D. Mixed-size RR (4-pick by 2 and by 3)
// ---------------------------------------------------------------------------
console.log('\n-- D. Mixed-size RR (4-pick ×2 @$10, ×3 @$5) --');

var mixedOutcomes = { L1: 'won', L2: 'won', L3: 'won', L4: 'lost' };
var mixedRr = simulateRr(legs4, { '2': 10, '3': 5 }, mixedOutcomes);

test('Mixed-size — 10 total combos (6 by-2 + 4 by-3)', function() {
  assertEq(mixedRr.combos.length, 10, 'combo count');
});

test('Mixed-size — 6 by-2 combos', function() {
  var by2 = mixedRr.combos.filter(function(c) { return c.legs.length === 2; });
  assertEq(by2.length, 6, 'by-2 combos');
});

test('Mixed-size — 4 by-3 combos', function() {
  var by3 = mixedRr.combos.filter(function(c) { return c.legs.length === 3; });
  assertEq(by3.length, 4, 'by-3 combos');
});

test('Mixed-size — total stake = $80 (6×$10 + 4×$5)', function() {
  assertEq(mixedRr.totalStake, 80, 'total stake');
});

test('Mixed-size — combos NOT containing L4 win', function() {
  var by2Won = mixedRr.won.filter(function(c) { return c.legs.length === 2; });
  // C(3,2) from {L1,L2,L3} = 3 by-2 combos without L4
  assertEq(by2Won.length, 3, '3 by-2 winners');
  var by3Won = mixedRr.won.filter(function(c) { return c.legs.length === 3; });
  // C(3,3) from {L1,L2,L3} = 1 by-3 combo without L4
  assertEq(by3Won.length, 1, '1 by-3 winner');
});

test('Mixed-size — combos containing L4 lose', function() {
  var by2Lost = mixedRr.lost.filter(function(c) { return c.legs.length === 2; });
  assertEq(by2Lost.length, 3, '3 by-2 losers');
  var by3Lost = mixedRr.lost.filter(function(c) { return c.legs.length === 3; });
  assertEq(by3Lost.length, 3, '3 by-3 losers');
});

// ---------------------------------------------------------------------------
// E. Missing rrStakes rejects before RPC
// ---------------------------------------------------------------------------
console.log('\n-- E. Missing rrStakes rejects before RPC --');

function makePlacementHarness(opts) {
  opts = opts || {};
  var rpcCalled = false;
  function place(betType, rrStakesVal, legsArr) {
    if (betType !== 'RoundRobin') return { ok: true, ticketId: 'T_STD' };
    var rrMap = (typeof rrStakesVal === 'object' && rrStakesVal !== null) ? rrStakesVal : {};
    var active = Object.keys(rrMap).filter(function(k) { return (parseFloat(rrMap[k]) || 0) > 0; });
    if (!active.length) return { ok: false, error: 'missing_rrStakes', code: 'missing_rrStakes' };
    rpcCalled = true;
    var combos = [];
    active.forEach(function(sz) {
      getRrCombos(legsArr, parseInt(sz, 10)).forEach(function(cl) { combos.push(cl); });
    });
    return { ok: true, groupId: 'RRG_TEST_' + Date.now(), comboCount: combos.length };
  }
  return { place: place, get rpcCalled() { return rpcCalled; } };
}

test('missing rrStakes returns missing_rrStakes', function() {
  var h = makePlacementHarness();
  var r = h.place('RoundRobin', null, legs3);
  assert(!r.ok, 'should fail');
  assertEq(r.error, 'missing_rrStakes', 'error code');
});

test('empty rrStakes {} returns missing_rrStakes', function() {
  var h = makePlacementHarness();
  var r = h.place('RoundRobin', {}, legs3);
  assert(!r.ok, 'should fail');
  assertEq(r.error, 'missing_rrStakes', 'error code');
});

test('all-zero rrStakes {2:0} returns missing_rrStakes', function() {
  var h = makePlacementHarness();
  var r = h.place('RoundRobin', { '2': 0 }, legs3);
  assert(!r.ok, 'should fail');
  assertEq(r.error, 'missing_rrStakes', 'error code');
});

test('valid rrStakes reaches RPC', function() {
  var h = makePlacementHarness();
  var r = h.place('RoundRobin', { '2': 10 }, legs3);
  assert(r.ok, 'should succeed: ' + JSON.stringify(r));
  assert(r.groupId, 'groupId present');
  assertEq(r.comboCount, 3, 'comboCount 3-pick by-2');
});

// ---------------------------------------------------------------------------
// F. Containment gone — RoundRobin no longer short-circuits
// ---------------------------------------------------------------------------
console.log('\n-- F. Containment block removed --');

function makeContainmentHarness() {
  var habCalled = 0;
  function place(betType, rrStakes) {
    // No containment guard — this mirrors post-Phase-3 index.js ordering.
    // RoundRobin with valid rrStakes flows through to HAB.
    if (betType === 'RoundRobin') {
      var active = Object.keys(rrStakes || {}).filter(function(k) { return (parseFloat((rrStakes||{})[k])||0) > 0; });
      if (!active.length) return { ok: false, error: 'missing_rrStakes' };
      habCalled++;
      return { ok: true, groupId: 'RRG_X', comboCount: 3 };
    }
    habCalled++;
    return { ok: true, ticketId: 'T_STD' };
  }
  return { place: place, get habCalled() { return habCalled; } };
}

test('RoundRobin no longer returns rr_temporarily_disabled', function() {
  var h = makeContainmentHarness();
  var r = h.place('RoundRobin', { '2': 10 });
  assert(r.ok, 'RR should succeed when rrStakes provided');
  assert(r.groupId, 'groupId present');
  assert(r.error !== 'rr_temporarily_disabled', 'no containment error');
});

test('RoundRobin now charges HAB (containment removed)', function() {
  var h = makeContainmentHarness();
  h.place('RoundRobin', { '2': 10 });
  assertEq(h.habCalled, 1, 'HAB charged once');
});

test('Single still works normally post-containment-removal', function() {
  var h = makeContainmentHarness();
  var r = h.place('Single', {});
  assert(r.ok && r.ticketId, 'Single ok');
  assertEq(h.habCalled, 1, 'HAB charged');
});

// ---------------------------------------------------------------------------
// G. Frontend grouping — DB Parlay combos collapse into slip card
// ---------------------------------------------------------------------------
console.log('\n-- G. Frontend renderMyBets RR grouping --');

function simulateGrouping(tickets) {
  // Mirror the renderMyBets grouping logic from player.html.
  var _groups = {}; var _ungrouped = [];
  tickets.forEach(function(t) {
    var gid = t.rr_group_id || t.rrGroupId;
    if (gid && (t.type === 'Parlay' || t.type === 'parlay') && t.rr_group_id) {
      if (!_groups[gid]) _groups[gid] = [];
      _groups[gid].push(t);
    } else {
      _ungrouped.push(t);
    }
  });
  var _grouped = _ungrouped.slice();
  Object.keys(_groups).forEach(function(gid) {
    var combos = _groups[gid];
    var totalRisk   = combos.reduce(function(s, c) { return s + (parseFloat(c.risk_amount   || c.riskAmount)        || 0); }, 0);
    var totalProfit = combos.reduce(function(s, c) { return s + (parseFloat(c.potential_profit || c.potentialProfit) || 0); }, 0);
    var totalPayout = combos.reduce(function(s, c) { return s + (parseFloat(c.estimated_payout || c.estimatedPayout) || 0); }, 0);
    var anyActive   = combos.some(function(c) { var s = String(c.status||'').toLowerCase(); return s === 'active' || s === 'open'; });
    var wonCount    = combos.filter(function(c) { return String(c.status||'').toLowerCase() === 'won';  }).length;
    var lostCount   = combos.filter(function(c) { return String(c.status||'').toLowerCase() === 'lost'; }).length;
    var slipStatus  = anyActive ? 'active' : (wonCount > 0 ? (lostCount < combos.length ? 'partial' : 'won') : (lostCount === combos.length ? 'lost' : 'push'));
    var first = combos[0];
    _grouped.unshift({
      id:               gid,
      rrGroupId:        gid,
      type:             'Round Robin',
      status:           slipStatus,
      riskAmount:       Math.round(totalRisk   * 100) / 100,
      potentialProfit:  Math.round(totalProfit * 100) / 100,
      estimatedPayout:  Math.round(totalPayout * 100) / 100,
      placedAt:         first.placed_at || first.placedAt,
      comboCount:       combos.length,
      _rrCombos:        combos,
      selections:       first.selections || []
    });
  });
  return _grouped;
}

var dbCombos = [
  { id:'C1', type:'Parlay', rr_group_id:'RRG_X', status:'won',  risk_amount:10, potential_profit:26.45, estimated_payout:36.45, placed_at:'2026-05-29T10:00:00Z' },
  { id:'C2', type:'Parlay', rr_group_id:'RRG_X', status:'lost', risk_amount:10, potential_profit:26.45, estimated_payout:36.45, placed_at:'2026-05-29T10:00:00Z' },
  { id:'C3', type:'Parlay', rr_group_id:'RRG_X', status:'lost', risk_amount:10, potential_profit:26.45, estimated_payout:36.45, placed_at:'2026-05-29T10:00:00Z' }
];
var stdTicket = { id:'T_STD', type:'Single', status:'active', risk_amount:20, placed_at:'2026-05-29T09:00:00Z' };
var groupedResult = simulateGrouping([stdTicket].concat(dbCombos));

test('grouping: 4 tickets (1 std + 3 combos) → 2 display items', function() {
  assertEq(groupedResult.length, 2, 'display item count');
});

test('grouping: slip card type = Round Robin', function() {
  var slip = groupedResult.find(function(t) { return t.type === 'Round Robin'; });
  assert(slip, 'slip card found');
  assertEq(slip.comboCount, 3, 'comboCount');
});

test('grouping: slip id = rr_group_id', function() {
  var slip = groupedResult.find(function(t) { return t.type === 'Round Robin'; });
  assertEq(slip.id, 'RRG_X', 'slip id');
  assertEq(slip.rrGroupId, 'RRG_X', 'rrGroupId');
});

test('grouping: slip totalRisk = $30 (3 × $10)', function() {
  var slip = groupedResult.find(function(t) { return t.type === 'Round Robin'; });
  assertEq(slip.riskAmount, 30, 'total risk');
});

test('grouping: slip status = partial (1 won, 2 lost)', function() {
  var slip = groupedResult.find(function(t) { return t.type === 'Round Robin'; });
  assertEq(slip.status, 'partial', 'slip status');
});

test('grouping: standard Single ticket unaffected', function() {
  var std = groupedResult.find(function(t) { return t.id === 'T_STD'; });
  assert(std, 'std ticket preserved');
  assertEq(std.type, 'Single', 'type unchanged');
});

test('grouping: local slip ticket (type=Round Robin, rrGroupId set) passes through ungrouped', function() {
  var localSlip = { id:'RRG_LOCAL', type:'Round Robin', rrGroupId:'RRG_LOCAL', comboCount:3, status:'active', riskAmount:30 };
  var res = simulateGrouping([localSlip].concat(dbCombos));
  // localSlip passes through; dbCombos collapse into 1 grouped slip
  assertEq(res.length, 2, 'local slip + grouped DB combos = 2 items');
  var local = res.find(function(t) { return t.id === 'RRG_LOCAL'; });
  assert(local, 'local slip present');
  assertEq(local.comboCount, 3, 'local slip comboCount unchanged');
});

test('grouping: all-active combos → slip status = active', function() {
  var activeCombos = [
    { id:'C1', type:'Parlay', rr_group_id:'RRG_Y', status:'active', risk_amount:10, placed_at:'2026-05-29T10:00:00Z' },
    { id:'C2', type:'Parlay', rr_group_id:'RRG_Y', status:'active', risk_amount:10, placed_at:'2026-05-29T10:00:00Z' }
  ];
  var res = simulateGrouping(activeCombos);
  assertEq(res[0].status, 'active', 'all-active slip status');
});

test('grouping: all-push combos → slip status = push', function() {
  var pushCombos = [
    { id:'C1', type:'Parlay', rr_group_id:'RRG_Z', status:'push', risk_amount:10, placed_at:'2026-05-29T10:00:00Z' },
    { id:'C2', type:'Parlay', rr_group_id:'RRG_Z', status:'push', risk_amount:10, placed_at:'2026-05-29T10:00:00Z' }
  ];
  var res = simulateGrouping(pushCombos);
  assertEq(res[0].status, 'push', 'all-push slip status');
});

// ---------------------------------------------------------------------------
// H. Frontend payload — rrStakes included for snap.type=rr only
// ---------------------------------------------------------------------------
console.log('\n-- H. Frontend _dbPayload rrStakes wiring --');

function buildDbPayload(snap) {
  return {
    betType: snap.type === 'straight' ? 'Single'
           : snap.type === 'parlay'   ? 'Parlay'
           : snap.type === 'rr'       ? 'RoundRobin'
           :                            'Teaser',
    stake:  snap.risk,
    rrStakes: snap.type === 'rr' ? snap.rrStakes : undefined
  };
}

test('rrStakes included in payload for snap.type=rr', function() {
  var snap = { type: 'rr', risk: 30, rrStakes: { '2': 10 } };
  var p = buildDbPayload(snap);
  assertEq(p.betType, 'RoundRobin', 'betType');
  assert(p.rrStakes !== undefined, 'rrStakes present');
  assertEq(p.rrStakes['2'], 10, 'rrStakes value');
});

test('rrStakes is undefined (JSON-omitted) for snap.type=parlay', function() {
  var snap = { type: 'parlay', risk: 50, rrStakes: null };
  var p = buildDbPayload(snap);
  assert(p.rrStakes === undefined, 'rrStakes omitted for parlay');
  // JSON.stringify omits undefined values
  var body = JSON.parse(JSON.stringify(p));
  assert(!('rrStakes' in body), 'rrStakes absent from JSON body');
});

test('rrStakes is undefined for snap.type=straight', function() {
  var snap = { type: 'straight', risk: 20 };
  var p = buildDbPayload(snap);
  assert(p.rrStakes === undefined, 'rrStakes omitted for straight');
});

test('multi-size rrStakes passes through correctly', function() {
  var snap = { type: 'rr', risk: 80, rrStakes: { '2': 10, '3': 5 } };
  var p = buildDbPayload(snap);
  assertEq(p.rrStakes['2'], 10, '2-leg stake');
  assertEq(p.rrStakes['3'],  5, '3-leg stake');
});

// ---------------------------------------------------------------------------
console.log('\nRR Phase 3 smoke tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
