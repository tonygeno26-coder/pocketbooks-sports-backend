'use strict';

// Regression tests for RR backend combo expansion (Phase 2).
//
// Validates the JS-layer RR path in /api/bets/place that is wired but gated
// behind the containment block during Phase 2. Tests confirm the combo
// generation logic, total stake sanity, leg row construction, HAB-once
// behavior, rollback on leg insert failure, and idempotency shape.
//
// These tests exercise the extracted helper functions (_getRrCombos,
// _buildRrComboPayloads) and the full place_rr_tx + leg insert flow as a
// harness — no live DB or HTTP server.
//
// Coverage:
//   A. Combo expansion correctness (3-pick/4-pick/multi-size)
//   B. Per-combo payout from server-accepted odds
//   C. Total stake sanity check (sum of combo stakes = totalStake)
//   D. Leg row construction (N combos × K legs each, correct ticket_id / rr_group_id)
//   E. place_rr_tx call — correct params, one call only
//   F. HAB charged exactly once after RPC + leg insert succeed
//   G. Rollback: leg insert failure cancels all combo tickets, HAB not charged
//   H. Rollback: HAB failure cancels all combo tickets
//   I. Idempotency replay from place_rr_tx — returns groupId, no second inserts
//   J. Response shape: groupId, comboCount, balanceAfter, ledgerEntryId

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
    pass++;
  } catch(e) {
    console.error('  FAIL ' + name + '\n     ' + e.message);
    fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'expected true');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected)
    throw new Error((msg||'values differ')+' — got '+JSON.stringify(actual)+' expected '+JSON.stringify(expected));
}

function assertClose(actual, expected, tol, msg) {
  tol = tol == null ? 0.005 : tol;
  if (Math.abs(actual - expected) > tol)
    throw new Error((msg||'not close')+' — got '+actual+' expected '+expected+' tol='+tol);
}

// ────────────────────────────────────────────────────────────────────────────
// Mirrors of backend helper functions (same logic as added to index.js)
// ────────────────────────────────────────────────────────────────────────────

function _getRrCombos(arr, size) {
  if (!Array.isArray(arr) || size < 1 || size > arr.length) return [];
  if (size === 1) return arr.map(function(x){ return [x]; });
  var out = [];
  arr.forEach(function(x, i) {
    _getRrCombos(arr.slice(i+1), size-1).forEach(function(rest){ out.push([x].concat(rest)); });
  });
  return out;
}

function _sgAmToDecimal(o) {
  var n = parseInt(String(o||0).replace('+',''));
  if (!n || isNaN(n)) return 1;
  return n > 0 ? n/100+1 : 100/Math.abs(n)+1;
}

function rnd(v) { return Math.round((isNaN(v)?0:v)*100)/100; }

// Build combo payloads from enriched legs + rrStakes map.
// Each enriched leg has accepted_odds_american set.
function buildRrComboPayloads(groupId, legsArr, rrStakesMap) {
  var combos = [];
  Object.keys(rrStakesMap).forEach(function(k) {
    var sz = parseInt(k);
    var stakePerCombo = rnd(parseFloat(rrStakesMap[k])||0);
    if (!stakePerCombo || isNaN(sz) || sz < 2) return;
    var comboPacks = _getRrCombos(legsArr, sz);
    comboPacks.forEach(function(comboLegs) {
      var decProduct = comboLegs.reduce(function(acc,leg) {
        return acc * _sgAmToDecimal(leg.accepted_odds_american||leg.odds||0);
      }, 1.0);
      var comboPayout = rnd(stakePerCombo * decProduct);
      var comboProfit = rnd(comboPayout - stakePerCombo);
      combos.push({
        id:               groupId + '_c' + combos.length,
        stake:            stakePerCombo,
        potential_profit: comboProfit,
        estimated_payout: comboPayout,
        legs:             comboLegs
      });
    });
  });
  return combos;
}

// Build leg rows for all combo tickets (mirrors the index.js logic)
function buildAllLegRows(combos) {
  var rows = [];
  combos.forEach(function(combo) {
    combo.legs.forEach(function(leg, legIdx) {
      rows.push({
        id:                     combo.id + '_leg' + legIdx,
        ticket_id:              combo.id,
        leg_index:              legIdx,
        canonical_game_key:     leg.canonicalGameKey,
        sport:                  leg.sport||null,
        market:                 leg.market,
        pick:                   leg.pick,
        odds:                   leg.accepted_odds_american || leg.odds,
        accepted_odds_american: leg.accepted_odds_american||null,
        accepted_odds_decimal:  leg.accepted_odds_decimal||null
      });
    });
  });
  return rows;
}

// ────────────────────────────────────────────────────────────────────────────
// Full placement harness (mirrors index.js RR path flow)
// ────────────────────────────────────────────────────────────────────────────

function makePlacementHarness(opts) {
  opts = opts || {};
  var state = {
    rrRpcCalls:        0,
    rrRpcResult:       opts.rrRpcResult  || { ok:true, idempotent:false, replayed:false,
                                               balance_after:170, total_stake:30, group_id:'RRG_T' },
    legInsertCalls:    0,
    legInsertFail:     opts.legInsertFail || false,
    cancelCalls:       [],
    habCalls:          0,
    habResult:         opts.habResult     || { ok:true },
    auditCalls:        0
  };

  function placeRrBet(params) {
    params = params || {};
    var groupId      = params.groupId;
    var legsArr      = params.legsArr;
    var rrStakesMap  = params.rrStakesMap || {};
    var stakeAmt     = params.stakeAmt;
    var idempKey     = params.idempotencyKey;
    var playerId     = params.playerId || 'P1';
    var clubId       = params.clubId   || 'club1';

    // Validate rrStakes
    var activeSizes = Object.keys(rrStakesMap).filter(function(k) {
      return (parseFloat(rrStakesMap[k])||0) > 0;
    });
    if (!activeSizes.length)
      return { ok:false, error:'missing_rrStakes' };

    // Build combo payloads from enriched legs
    var rrCombos = buildRrComboPayloads(groupId, legsArr, rrStakesMap);
    if (!rrCombos.length)
      return { ok:false, error:'rr_no_combos_generated' };

    // Sanity: total stake check
    var verifiedStake = rnd(rrCombos.reduce(function(s,c){ return s+c.stake; }, 0));
    if (Math.abs(verifiedStake - stakeAmt) > 0.01)
      return { ok:false, error:'rr_stake_mismatch', computed:verifiedStake, submitted:stakeAmt };

    // Call place_rr_tx
    state.rrRpcCalls++;
    var rrRpcResult = state.rrRpcResult;
    if (!rrRpcResult.ok && !rrRpcResult.idempotent)
      return { ok:false, error:rrRpcResult.error||'rr_placement_failed' };

    // If idempotency replay, short-circuit
    if (rrRpcResult.idempotent) {
      return { ok:true, groupId, comboCount:rrCombos.length,
               balanceAfter:rrRpcResult.balance_after, ledgerEntryId:idempKey, idempotent:true };
    }

    // Insert ticket_legs for all combos
    state.legInsertCalls++;
    if (state.legInsertFail) {
      // Compensation: cancel every combo ticket
      rrCombos.forEach(function(c, ci) {
        state.cancelCalls.push({ comboId:c.id, reason:'rr_ticket_legs_insert_failed' });
      });
      return { ok:false, error:'rr_ticket_legs_insert_failed' };
    }

    // HAB charge (once)
    state.habCalls++;
    var habResult = state.habResult;
    if (!habResult.ok) {
      // Compensation
      rrCombos.forEach(function(c) {
        state.cancelCalls.push({ comboId:c.id, reason:'rr_active_bettor_charge_failed' });
      });
      return { ok:false, error:'rr_active_bettor_charge_failed' };
    }

    // Audit (fire-and-forget)
    state.auditCalls++;

    return { ok:true, groupId, comboCount:rrCombos.length,
             balanceAfter:rrRpcResult.balance_after, ledgerEntryId:idempKey };
  }

  return { state, placeRrBet };
}

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

function enrichedLeg(id, odds) {
  return { id:id, canonicalGameKey:'sport|A|B|2026-05-30', sport:'mlb',
           market:'moneyline', pick:'Home', odds:odds,
           accepted_odds_american:odds,
           accepted_odds_decimal:_sgAmToDecimal(odds),
           homeTeam:'Home', awayTeam:'Away' };
}

var L3 = [enrichedLeg('L1',-110), enrichedLeg('L2',-110), enrichedLeg('L3',-110)];
var L4 = [enrichedLeg('L1',-110), enrichedLeg('L2',-110),
          enrichedLeg('L3',-110), enrichedLeg('L4',-110)];

// ────────────────────────────────────────────────────────────────────────────
// SECTION A — Combo expansion correctness
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- A. Combo expansion --');

test('3-pick by 2 expands to 3 combos', function() {
  var cs = buildRrComboPayloads('G1', L3, { '2':10 });
  assertEq(cs.length, 3);
});
test('4-pick by 2 expands to 6 combos', function() {
  var cs = buildRrComboPayloads('G1', L4, { '2':10 });
  assertEq(cs.length, 6);
});
test('4-pick by 3 expands to 4 combos', function() {
  var cs = buildRrComboPayloads('G1', L4, { '3':5 });
  assertEq(cs.length, 4);
});
test('4-pick multi-size (2+3) expands to 10 combos', function() {
  var cs = buildRrComboPayloads('G1', L4, { '2':10, '3':5 });
  assertEq(cs.length, 10, '6 two-leg + 4 three-leg');
});
test('each 2-leg combo has exactly 2 legs', function() {
  buildRrComboPayloads('G1', L3, { '2':10 }).forEach(function(c,i) {
    assertEq(c.legs.length, 2, 'combo '+i+' leg count');
  });
});
test('combo IDs are unique within a group', function() {
  var cs = buildRrComboPayloads('G1', L4, { '2':10, '3':5 });
  var ids = cs.map(function(c){ return c.id; });
  assertEq(new Set(ids).size, ids.length, 'unique IDs');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION B — Per-combo payout from server-accepted odds
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- B. Per-combo payout --');

test('-110/-110 2-leg combo payout = stake × 1.9091² ≈ 3.64x', function() {
  var cs = buildRrComboPayloads('G1', L3, { '2':10 });
  // decimal = 100/110 + 1 = 1.9091
  // 2-leg product = 1.9091² = 3.6443
  // payout = $10 × 3.6443 = $36.44
  cs.forEach(function(c) {
    assertClose(c.estimated_payout, 36.44, 0.02, 'combo payout');
    assertClose(c.potential_profit, 26.44, 0.02, 'combo profit');
  });
});

test('payout uses accepted_odds_american not raw submitted odds', function() {
  // Set accepted odds different from raw — accepted should win
  var legs = [
    Object.assign({}, enrichedLeg('L1',-110), { accepted_odds_american:-120, accepted_odds_decimal:_sgAmToDecimal(-120) }),
    Object.assign({}, enrichedLeg('L2',-110), { accepted_odds_american:-120, accepted_odds_decimal:_sgAmToDecimal(-120) }),
    Object.assign({}, enrichedLeg('L3',-110), { accepted_odds_american:-120, accepted_odds_decimal:_sgAmToDecimal(-120) })
  ];
  var cs = buildRrComboPayloads('G1', legs, { '2':10 });
  // -120 decimal = 100/120+1 = 1.8333
  // 2-leg product = 1.8333² = 3.3611
  // payout = $10 × 3.3611 = $33.61
  cs.forEach(function(c) {
    assertClose(c.estimated_payout, 33.61, 0.02, 'should use accepted -120 not submitted -110');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION C — Total stake sanity
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- C. Total stake sanity --');

test('3-pick by 2 $10/combo: verifiedStake = $30', function() {
  var cs = buildRrComboPayloads('G1', L3, { '2':10 });
  assertClose(cs.reduce(function(s,c){ return s+c.stake; },0), 30, 0.01);
});
test('4-pick multi-size $10/$5: verifiedStake = $80', function() {
  var cs = buildRrComboPayloads('G1', L4, { '2':10, '3':5 });
  assertClose(cs.reduce(function(s,c){ return s+c.stake; },0), 80, 0.01);
});
test('stake mismatch detected: computed $30 vs submitted $25', function() {
  var h = makePlacementHarness();
  var r = h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:25, idempotencyKey:'IK1' });
  assert(!r.ok); assertEq(r.error, 'rr_stake_mismatch');
});
test('missing rrStakes rejects before RPC', function() {
  var h = makePlacementHarness();
  var r = h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{},
    stakeAmt:30, idempotencyKey:'IK1' });
  assert(!r.ok); assertEq(r.error, 'missing_rrStakes');
  assertEq(h.state.rrRpcCalls, 0, 'RPC not called');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION D — Leg row construction
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- D. Leg row construction --');

test('3-pick by 2: 3 combos × 2 legs = 6 leg rows', function() {
  var cs = buildRrComboPayloads('G1', L3, { '2':10 });
  var rows = buildAllLegRows(cs);
  assertEq(rows.length, 6);
});
test('4-pick by 2: 6 combos × 2 legs = 12 leg rows', function() {
  var cs = buildRrComboPayloads('G1', L4, { '2':10 });
  var rows = buildAllLegRows(cs);
  assertEq(rows.length, 12);
});
test('4-pick multi-size (2+3): 10 combos = 6×2 + 4×3 = 24 leg rows', function() {
  var cs = buildRrComboPayloads('G1', L4, { '2':10, '3':5 });
  var rows = buildAllLegRows(cs);
  assertEq(rows.length, 24, '6 two-leg combos + 4 three-leg combos');
});
test('each leg row has unique id', function() {
  var cs = buildRrComboPayloads('G1', L4, { '2':10, '3':5 });
  var rows = buildAllLegRows(cs);
  var ids = rows.map(function(r){ return r.id; });
  assertEq(new Set(ids).size, ids.length, 'all leg row IDs unique');
});
test('leg row ticket_id matches parent combo id', function() {
  var cs = buildRrComboPayloads('G1', L3, { '2':10 });
  var rows = buildAllLegRows(cs);
  cs.forEach(function(combo) {
    var comboRows = rows.filter(function(r){ return r.ticket_id === combo.id; });
    assertEq(comboRows.length, 2, 'combo '+combo.id+' has 2 leg rows');
  });
});
test('leg row uses accepted_odds_american for the odds column', function() {
  var legs = [
    Object.assign({}, enrichedLeg('L1',-110), { accepted_odds_american:-125 }),
    Object.assign({}, enrichedLeg('L2',-110), { accepted_odds_american:-115 }),
    Object.assign({}, enrichedLeg('L3',-110), { accepted_odds_american:-130 })
  ];
  var cs = buildRrComboPayloads('G1', legs, { '2':10 });
  var rows = buildAllLegRows(cs);
  rows.forEach(function(r) {
    assert(r.odds !== -110, 'leg row odds should be accepted_odds_american not raw: got '+r.odds);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION E — place_rr_tx call
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- E. place_rr_tx call --');

test('place_rr_tx called exactly once on success', function() {
  var h = makePlacementHarness();
  h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assertEq(h.state.rrRpcCalls, 1);
});
test('RPC failure propagates as rr_placement_failed', function() {
  var h = makePlacementHarness({ rrRpcResult:{ ok:false, error:'place_rr_tx_failed' } });
  var r = h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assert(!r.ok); assertEq(r.error, 'place_rr_tx_failed');
});
test('RPC insufficient_balance propagates correctly', function() {
  var h = makePlacementHarness({ rrRpcResult:{ ok:false, error:'insufficient_balance', available:20 } });
  var r = h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assert(!r.ok); assertEq(r.error, 'insufficient_balance');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION F — HAB charged exactly once
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- F. HAB charged once --');

test('HAB charged exactly once for 3-pick by 2 (3 combos)', function() {
  var h = makePlacementHarness();
  var r = h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assert(r.ok, JSON.stringify(r));
  assertEq(h.state.habCalls, 1, 'HAB called exactly once');
});
test('HAB charged exactly once for 4-pick multi-size (10 combos)', function() {
  var h = makePlacementHarness({ rrRpcResult:{ok:true,idempotent:false,replayed:false,balance_after:420,group_id:'G1'} });
  var r = h.placeRrBet({ groupId:'G1', legsArr:L4, rrStakesMap:{'2':10,'3':5},
    stakeAmt:80, idempotencyKey:'IK1' });
  assert(r.ok, JSON.stringify(r));
  assertEq(h.state.habCalls, 1, 'HAB called exactly once regardless of combo count');
});
test('HAB not charged when RPC fails', function() {
  var h = makePlacementHarness({ rrRpcResult:{ ok:false, error:'insufficient_balance' } });
  h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assertEq(h.state.habCalls, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION G — Rollback on leg insert failure
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- G. Rollback on leg insert failure --');

test('leg insert failure returns rr_ticket_legs_insert_failed', function() {
  var h = makePlacementHarness({ legInsertFail:true });
  var r = h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assert(!r.ok); assertEq(r.error, 'rr_ticket_legs_insert_failed');
});
test('leg insert failure compensates all 3 combo tickets (3-pick by 2)', function() {
  var h = makePlacementHarness({ legInsertFail:true });
  h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assertEq(h.state.cancelCalls.length, 3, '3 combos must be canceled');
  h.state.cancelCalls.forEach(function(c) {
    assertEq(c.reason, 'rr_ticket_legs_insert_failed');
  });
});
test('leg insert failure compensates all 10 combo tickets (multi-size)', function() {
  var h = makePlacementHarness({ legInsertFail:true,
    rrRpcResult:{ok:true,idempotent:false,replayed:false,balance_after:420,group_id:'G1'} });
  h.placeRrBet({ groupId:'G1', legsArr:L4, rrStakesMap:{'2':10,'3':5},
    stakeAmt:80, idempotencyKey:'IK1' });
  assertEq(h.state.cancelCalls.length, 10, '10 combos must be canceled');
});
test('leg insert failure: HAB not charged', function() {
  var h = makePlacementHarness({ legInsertFail:true });
  h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assertEq(h.state.habCalls, 0, 'HAB must not charge after leg insert failure');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION H — Rollback on HAB failure
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- H. Rollback on HAB failure --');

test('HAB failure returns rr_active_bettor_charge_failed', function() {
  var h = makePlacementHarness({ habResult:{ ok:false, error:'no_active_bettor_fee', httpStatus:402 } });
  var r = h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assert(!r.ok); assertEq(r.error, 'rr_active_bettor_charge_failed');
});
test('HAB failure compensates all 3 combo tickets', function() {
  var h = makePlacementHarness({ habResult:{ ok:false, error:'no_active_bettor_fee' } });
  h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assertEq(h.state.cancelCalls.length, 3);
  h.state.cancelCalls.forEach(function(c) {
    assertEq(c.reason, 'rr_active_bettor_charge_failed');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION I — Idempotency replay
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- I. Idempotency replay --');

test('idempotent RPC reply returns groupId + idempotent:true', function() {
  var h = makePlacementHarness({
    rrRpcResult:{ ok:true, idempotent:true, replayed:true,
                  balance_after:170, group_id:'G1' }
  });
  var r = h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assert(r.ok && r.idempotent, 'should be ok + idempotent');
  assertEq(r.groupId, 'G1');
});
test('idempotent replay: leg insert not called again', function() {
  var h = makePlacementHarness({
    rrRpcResult:{ ok:true, idempotent:true, replayed:true, balance_after:170, group_id:'G1' }
  });
  h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assertEq(h.state.legInsertCalls, 0, 'leg insert must not re-run on replay');
});
test('idempotent replay: HAB not charged again', function() {
  var h = makePlacementHarness({
    rrRpcResult:{ ok:true, idempotent:true, replayed:true, balance_after:170, group_id:'G1' }
  });
  h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assertEq(h.state.habCalls, 0, 'HAB must not fire on replay');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION J — Response shape
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- J. Response shape --');

test('success response has all required fields', function() {
  var h = makePlacementHarness({
    rrRpcResult:{ ok:true, idempotent:false, replayed:false,
                  balance_after:170, group_id:'G1' }
  });
  var r = h.placeRrBet({ groupId:'G1', legsArr:L3, rrStakesMap:{'2':10},
    stakeAmt:30, idempotencyKey:'IK1' });
  assert(r.ok === true,              'ok');
  assertEq(r.groupId,   'G1',        'groupId');
  assertEq(r.comboCount, 3,          'comboCount');
  assertClose(r.balanceAfter, 170,   0.01, 'balanceAfter');
  assertEq(r.ledgerEntryId, 'IK1',   'ledgerEntryId');
});

test('4-pick multi-size success: comboCount = 10', function() {
  var h = makePlacementHarness({
    rrRpcResult:{ ok:true, idempotent:false, replayed:false, balance_after:420, group_id:'G2' }
  });
  var r = h.placeRrBet({ groupId:'G2', legsArr:L4, rrStakesMap:{'2':10,'3':5},
    stakeAmt:80, idempotencyKey:'IK2' });
  assert(r.ok, JSON.stringify(r));
  assertEq(r.comboCount, 10);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\nRR backend combo expansion tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
