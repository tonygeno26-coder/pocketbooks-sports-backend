'use strict';

// Smoke tests for place_rr_tx — Phase 1 RPC contract + JS combo generation.
//
// These tests validate the harness logic that mirrors the PL/pgSQL function
// contract without a live database. Every branch in place_rr_tx has a
// corresponding test here. The SQL file implements the same invariants so
// regressions show in both.
//
// Coverage areas:
//   A. Combo generation math (JS helper — nCr, buildCombos)
//   B. Total stake calculation (sum of stakePerCombo × comboCount)
//   C. place_rr_tx param validation (group_id, player_id, idempotency_key,
//      total_stake, combos array, combo stake sum)
//   D. Balance check (insufficient funds → rejection before any insert)
//   E. Ticket insertion (N tickets created, each type=Parlay, with rr_group_id)
//   F. Ledger entry (one entry for total_stake, ticket_id=null)
//   G. Idempotency (replay returns correct shape, no second ledger insert)
//   H. Return shape on success (ok, idempotent, group_id, combo_count,
//      balance_after, available, total_stake)

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
    throw new Error(
      (msg || 'values differ') +
      ' — got ' + JSON.stringify(actual) +
      ' expected ' + JSON.stringify(expected)
    );
  }
}

function assertClose(actual, expected, tol, msg) {
  tol = tol == null ? 0.005 : tol;
  if (Math.abs(actual - expected) > tol) {
    throw new Error(
      (msg || 'values not close') +
      ' — got ' + actual + ' expected ' + expected + ' (tol=' + tol + ')'
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers — mirror the JS combo math that the handler will use
// ────────────────────────────────────────────────────────────────────────────

function nCr(n, r) {
  if (r > n) return 0;
  if (r === 0 || r === n) return 1;
  var num = 1, den = 1;
  for (var i = 0; i < r; i++) { num *= (n - i); den *= (i + 1); }
  return Math.round(num / den);
}

function getCombos(arr, size) {
  if (size === 1) return arr.map(function(x) { return [x]; });
  var out = [];
  arr.forEach(function(x, i) {
    getCombos(arr.slice(i + 1), size - 1).forEach(function(rest) {
      out.push([x].concat(rest));
    });
  });
  return out;
}

function amToDecimal(o) {
  var n = parseInt(String(o).replace('+', ''));
  if (!n || isNaN(n)) return 1;
  return n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1;
}

// Compute per-combo payout from leg odds (no SGP adjustment here — pure math)
function comboPayout(stake, comboLegs) {
  var d = comboLegs.reduce(function(p, leg) { return p * amToDecimal(leg.odds); }, 1);
  return Math.round(stake * d * 100) / 100;
}

function comboProfit(stake, comboLegs) {
  return Math.round((comboPayout(stake, comboLegs) - stake) * 100) / 100;
}

// Build the p_combos array the JS handler will pass to place_rr_tx.
// rrStakes = { '2': 10, '3': 5 } — keyed by combo size string.
// legs = all N legs, each with { id, odds, canonicalGameKey, ... }
// Returns: { combos, totalStake, groupId }
function buildRrPayload(groupId, legs, rrStakes) {
  var combos = [];
  var totalStake = 0;
  var comboIndex = 0;
  Object.keys(rrStakes).forEach(function(k) {
    var sz = parseInt(k);
    var stakePerCombo = rrStakes[k] || 0;
    if (!stakePerCombo) return;
    var slices = getCombos(legs, sz);
    slices.forEach(function(comboLegs) {
      var payout = comboPayout(stakePerCombo, comboLegs);
      var profit = comboProfit(stakePerCombo, comboLegs);
      combos.push({
        id: groupId + '_c' + comboIndex,
        stake: stakePerCombo,
        potential_profit: profit,
        estimated_payout: payout
      });
      totalStake += stakePerCombo;
      comboIndex++;
    });
  });
  totalStake = Math.round(totalStake * 100) / 100;
  return { combos: combos, totalStake: totalStake, groupId: groupId };
}

// ────────────────────────────────────────────────────────────────────────────
// place_rr_tx harness
// Mirrors the PL/pgSQL function's step sequence:
//   §0  param validation
//   §0b combo validation + stake sum
//   §1  idempotency check
//   §2  player lock + balance_start read
//   §3  balance derivation from tickets
//   §4  combo ticket inserts
//   §5  single ledger debit
//   §6  success return
// ────────────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  opts = opts || {};
  // Simulated state
  var state = {
    tickets:       opts.tickets       || [],   // existing tickets (for balance calc)
    ledger:        {},                          // ledger_entries keyed by id
    clubMembers:   opts.clubMembers   || null,  // { balance_start } or null
    inserted:      [],                          // tickets inserted this call
    ledgerInserts: []                           // ledger entries inserted this call
  };
  return state;
}

function placeRrTx(db, params) {
  params = params || {};
  var p_group_id        = params.p_group_id;
  var p_club_id         = params.p_club_id        || 'club1';
  var p_player_id       = params.p_player_id;
  var p_player_username = params.p_player_username || 'player1';
  var p_total_stake     = params.p_total_stake;
  var p_idempotency_key = params.p_idempotency_key;
  var p_created_by      = params.p_created_by     || 'player1';
  var p_combos          = params.p_combos;

  // §0. Param sanity
  if (!p_group_id || p_group_id.length === 0)
    return { ok:false, error:'missing_group_id' };
  if (!p_player_id || p_player_id.length === 0)
    return { ok:false, error:'missing_player_id' };
  if (!p_idempotency_key || p_idempotency_key.length === 0)
    return { ok:false, error:'missing_idempotency_key' };
  if (!p_total_stake || p_total_stake <= 0)
    return { ok:false, error:'invalid_total_stake' };
  if (!Array.isArray(p_combos))
    return { ok:false, error:'invalid_combos' };
  if (p_combos.length === 0)
    return { ok:false, error:'empty_combos' };

  // §0b. Validate combo elements + stake sum
  var stakeSum = 0;
  for (var i = 0; i < p_combos.length; i++) {
    var c = p_combos[i];
    if (!c.id || c.id.length === 0)
      return { ok:false, error:'combo_missing_id', combo_index:i };
    if (!c.stake || c.stake <= 0)
      return { ok:false, error:'combo_invalid_stake', combo_id:c.id };
    stakeSum += c.stake;
  }
  stakeSum = Math.round(stakeSum * 100) / 100;
  if (Math.abs(stakeSum - Math.round(p_total_stake * 100) / 100) > 0.01)
    return { ok:false, error:'combo_stake_sum_mismatch',
             total_stake:p_total_stake, combo_sum:stakeSum };

  // §1. Idempotency check
  var existing = db.ledger[p_idempotency_key];
  if (existing) {
    return {
      ok:            true,
      idempotent:    true,
      replayed:      true,
      group_id:      p_group_id,
      combo_count:   p_combos.length,
      balance_after: existing.balance_after
    };
  }

  // §2. Player lock + balance_start read
  var member = db.clubMembers;
  if (!member || member.balance_start == null)
    return { ok:false, error:'insufficient_balance',
             code:'no_club_member_balance_found' };

  var startBal = parseFloat(member.balance_start) || 0;

  // §3. Balance derivation from existing tickets (club-scoped)
  var openRisk      = 0;
  var settledGains  = 0;
  var settledLosses = 0;
  (db.tickets || []).forEach(function(t) {
    if (t.club_id !== p_club_id) return; // club scope
    var s = (t.status || '').toLowerCase();
    if (s === 'active' || s === 'open')  openRisk      += parseFloat(t.risk_amount) || 0;
    if (s === 'won')                     settledGains  += parseFloat(t.potential_profit) || 0;
    if (s === 'lost')                    settledLosses += parseFloat(t.risk_amount) || 0;
  });
  var available = Math.round((startBal - openRisk - settledLosses + settledGains) * 100) / 100;

  if (p_total_stake > available + 0.005)
    return { ok:false, error:'insufficient_balance',
             available:available, stake:p_total_stake };

  // §4. Insert combo ticket rows
  var now = new Date().toISOString();
  p_combos.forEach(function(combo) {
    var row = {
      id:               combo.id,
      club_id:          p_club_id || null,
      player_id:        p_player_id,
      player_username:  p_player_username,
      type:             'Parlay',
      status:           'active',
      risk_amount:      Math.round(combo.stake * 100) / 100,
      potential_profit: Math.round((combo.potential_profit || 0) * 100) / 100,
      estimated_payout: Math.round((combo.estimated_payout || 0) * 100) / 100,
      placed_at:        now,
      rr_group_id:      p_group_id
    };
    db.inserted.push(row);
  });

  // §5. Single ledger debit
  var balanceAfter = Math.round((available - p_total_stake) * 100) / 100;
  var ledgerEntry = {
    id:             p_idempotency_key,
    club_id:        p_club_id || null,
    player_id:      p_player_id,
    ticket_id:      null,     // nullable — slip-level entry
    type:           'bet_placed',
    amount:         Math.round(-p_total_stake * 100) / 100,
    balance_before: available,
    balance_after:  balanceAfter,
    reason:         'bet_placed:RoundRobin:' + p_group_id,
    created_at:     now,
    created_by:     p_created_by || p_player_id
  };
  db.ledger[p_idempotency_key] = ledgerEntry;
  db.ledgerInserts.push(ledgerEntry);

  // §6. Success
  return {
    ok:            true,
    idempotent:    false,
    replayed:      false,
    group_id:      p_group_id,
    combo_count:   p_combos.length,
    balance_after: balanceAfter,
    available:     available,
    total_stake:   p_total_stake
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────────────────

function makeLeg(id, odds) {
  return { id:id, canonicalGameKey:'sport|A|B|2026-05-30', odds:odds,
           sport:'mlb', homeTeam:'Home', awayTeam:'Away' };
}

// 3 legs at -110 each
var LEGS3 = [makeLeg('L1', -110), makeLeg('L2', -110), makeLeg('L3', -110)];
// 4 legs at -110 each
var LEGS4 = [makeLeg('L1', -110), makeLeg('L2', -110),
             makeLeg('L3', -110), makeLeg('L4', -110)];

var MEMBER_200 = { balance_start: 200 };

function freshDb(opts) {
  return makeDb(Object.assign({ clubMembers: MEMBER_200 }, opts || {}));
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION A — Combo generation math
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- A. Combo generation math --');

test('nCr(3,2) = 3', function() { assertEq(nCr(3,2), 3); });
test('nCr(4,2) = 6', function() { assertEq(nCr(4,2), 6); });
test('nCr(4,3) = 4', function() { assertEq(nCr(4,3), 4); });
test('nCr(5,2) = 10', function() { assertEq(nCr(5,2), 10); });
test('nCr(3,3) = 1', function() { assertEq(nCr(3,3), 1); });

test('getCombos(3 legs, 2) returns 3 combos of length 2', function() {
  var c = getCombos(LEGS3, 2);
  assertEq(c.length, 3, 'combo count');
  c.forEach(function(combo, i) { assertEq(combo.length, 2, 'combo ' + i + ' length'); });
});

test('getCombos(4 legs, 2) returns 6 unique combos', function() {
  var c = getCombos(LEGS4, 2);
  assertEq(c.length, 6, 'combo count');
  // All pairs should be unique
  var seen = new Set(c.map(function(pair) {
    return [pair[0].id, pair[1].id].sort().join(':');
  }));
  assertEq(seen.size, 6, 'unique pair count');
});

test('getCombos(4 legs, 3) returns 4 combos', function() {
  var c = getCombos(LEGS4, 3);
  assertEq(c.length, 4, 'combo count');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION B — Total stake calculation
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- B. Total stake calculation --');

test('3-pick by 2, $10/combo: totalStake = 30.00', function() {
  var payload = buildRrPayload('RRG_test', LEGS3, { '2': 10 });
  assertEq(payload.totalStake, 30, 'totalStake');
  assertEq(payload.combos.length, 3, 'combo count');
});

test('4-pick by 2, $10/combo: totalStake = 60.00', function() {
  var payload = buildRrPayload('RRG_test', LEGS4, { '2': 10 });
  assertEq(payload.totalStake, 60, 'totalStake');
  assertEq(payload.combos.length, 6, 'combo count');
});

test('4-pick multi-size by 2+3, $10+$5: totalStake = 80.00', function() {
  // 6 two-leg combos × $10 + 4 three-leg combos × $5 = $60 + $20 = $80
  var payload = buildRrPayload('RRG_test', LEGS4, { '2': 10, '3': 5 });
  assertEq(payload.totalStake, 80, 'totalStake');
  assertEq(payload.combos.length, 10, 'combo count (6 + 4)');
});

test('combo IDs are unique within a slip', function() {
  var payload = buildRrPayload('RRG_test', LEGS4, { '2': 10, '3': 5 });
  var ids = payload.combos.map(function(c) { return c.id; });
  var unique = new Set(ids);
  assertEq(unique.size, ids.length, 'all combo IDs are unique');
});

test('each combo profit is computed from leg odds only', function() {
  // -110 decimal = 100/110 + 1 = 1.9091
  // 2-leg parlay at -110/-110: d = 1.9091² = 3.6443
  // profit on $10 = $10 × 3.6443 - $10 = $26.45
  var payload = buildRrPayload('RRG_test', LEGS3, { '2': 10 });
  payload.combos.forEach(function(c, i) {
    assert(c.potential_profit > 0, 'combo ' + i + ' profit must be > 0');
    assert(c.estimated_payout > c.stake, 'combo ' + i + ' payout must exceed stake');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION C — Param validation
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- C. Param validation --');

test('missing group_id returns missing_group_id', function() {
  var db = freshDb();
  var r = placeRrTx(db, { p_player_id:'P1', p_idempotency_key:'IK1',
    p_total_stake:30, p_combos:[{id:'c1',stake:30,potential_profit:1,estimated_payout:31}] });
  assert(!r.ok); assertEq(r.error, 'missing_group_id');
});

test('missing player_id returns missing_player_id', function() {
  var db = freshDb();
  var r = placeRrTx(db, { p_group_id:'RRG1', p_idempotency_key:'IK1',
    p_total_stake:30, p_combos:[{id:'c1',stake:30,potential_profit:1,estimated_payout:31}] });
  assert(!r.ok); assertEq(r.error, 'missing_player_id');
});

test('missing idempotency_key returns missing_idempotency_key', function() {
  var db = freshDb();
  var r = placeRrTx(db, { p_group_id:'RRG1', p_player_id:'P1',
    p_total_stake:30, p_combos:[{id:'c1',stake:30,potential_profit:1,estimated_payout:31}] });
  assert(!r.ok); assertEq(r.error, 'missing_idempotency_key');
});

test('zero total_stake returns invalid_total_stake', function() {
  var db = freshDb();
  var r = placeRrTx(db, { p_group_id:'RRG1', p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:0,
    p_combos:[{id:'c1',stake:10,potential_profit:1,estimated_payout:11}] });
  assert(!r.ok); assertEq(r.error, 'invalid_total_stake');
});

test('non-array p_combos returns invalid_combos', function() {
  var db = freshDb();
  var r = placeRrTx(db, { p_group_id:'RRG1', p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:30, p_combos:null });
  assert(!r.ok); assertEq(r.error, 'invalid_combos');
});

test('empty p_combos array returns empty_combos', function() {
  var db = freshDb();
  var r = placeRrTx(db, { p_group_id:'RRG1', p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:30, p_combos:[] });
  assert(!r.ok); assertEq(r.error, 'empty_combos');
});

test('combo missing id returns combo_missing_id', function() {
  var db = freshDb();
  var r = placeRrTx(db, { p_group_id:'RRG1', p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:30,
    p_combos:[{id:'', stake:30, potential_profit:1, estimated_payout:31}] });
  assert(!r.ok); assertEq(r.error, 'combo_missing_id');
});

test('combo stake zero returns combo_invalid_stake', function() {
  var db = freshDb();
  var r = placeRrTx(db, { p_group_id:'RRG1', p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:30,
    p_combos:[{id:'c1', stake:0, potential_profit:1, estimated_payout:31}] });
  assert(!r.ok); assertEq(r.error, 'combo_invalid_stake');
});

test('combo stake sum mismatch returns combo_stake_sum_mismatch', function() {
  var db = freshDb();
  // 3 combos at $10 = $30, but p_total_stake says $25
  var r = placeRrTx(db, { p_group_id:'RRG1', p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:25,
    p_combos:[
      {id:'c1',stake:10,potential_profit:8,estimated_payout:18},
      {id:'c2',stake:10,potential_profit:8,estimated_payout:18},
      {id:'c3',stake:10,potential_profit:8,estimated_payout:18}
    ]
  });
  assert(!r.ok); assertEq(r.error, 'combo_stake_sum_mismatch');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION D — Balance check
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- D. Balance check --');

test('missing club_members row returns no_club_member_balance_found', function() {
  var db = makeDb({ clubMembers: null });
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  var r = placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assert(!r.ok); assertEq(r.code, 'no_club_member_balance_found');
});

test('stake exactly equal to available is accepted (+0.005 tolerance)', function() {
  // balance_start = 30, no open risk → available = 30; total_stake = 30
  var db = makeDb({ clubMembers:{ balance_start:30 } });
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  var r = placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assert(r.ok, 'should accept: ' + JSON.stringify(r));
});

test('stake exceeding available by >$0.005 is rejected', function() {
  // balance = $29.99, want to bet $30
  var db = makeDb({ clubMembers:{ balance_start:29.99 } });
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  var r = placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assert(!r.ok); assertEq(r.error, 'insufficient_balance');
  assertClose(r.available, 29.99, 0.01, 'available in error response');
});

test('open risk from existing tickets reduces available balance', function() {
  // balance_start=200, already 1 active ticket risking 150 → available=50
  // 3-pick RR at $10/combo = $30 total — should be accepted
  var db = makeDb({ clubMembers:{ balance_start:200 } });
  db.tickets.push({ club_id:'club1', player_id:'P1', status:'active',
    risk_amount:150, potential_profit:200 });
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  var r = placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assert(r.ok, 'should succeed with $50 available vs $30 bet: ' + JSON.stringify(r));
  assertClose(r.available, 50, 0.01, 'available');
});

test('won tickets increase available balance', function() {
  // balance_start=100, won ticket profit=50 → available=150
  // 4-pick by 2, $20/combo = $120 — should be accepted
  var db = makeDb({ clubMembers:{ balance_start:100 } });
  db.tickets.push({ club_id:'club1', player_id:'P1', status:'won',
    risk_amount:20, potential_profit:50 });
  var payload = buildRrPayload('RRG1', LEGS4, { '2': 20 });
  var r = placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assert(r.ok, 'should succeed with $150 available vs $120 bet: ' + JSON.stringify(r));
  assertClose(r.available, 150, 0.01, 'available includes won profit');
});

test('balance from another club does not affect this club', function() {
  // balance_start=200; lost ticket in club2 for $190 should not reduce club1 available
  var db = makeDb({ clubMembers:{ balance_start:200 } });
  db.tickets.push({ club_id:'club2', player_id:'P1', status:'lost',
    risk_amount:190, potential_profit:0 });
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  var r = placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assert(r.ok, 'cross-club ticket should not block placement: ' + JSON.stringify(r));
  assertClose(r.available, 200, 0.01, 'available unaffected by other club');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION E — Ticket insertion
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- E. Ticket insertion --');

test('3-pick by 2 creates exactly 3 ticket rows', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  var r = placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assert(r.ok, JSON.stringify(r));
  assertEq(db.inserted.length, 3, 'inserted ticket count');
});

test('4-pick multi-size (2+3) creates 10 ticket rows', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG1', LEGS4, { '2': 10, '3': 5 });
  var r = placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assert(r.ok, JSON.stringify(r));
  assertEq(db.inserted.length, 10, '6 two-leg + 4 three-leg = 10 combos');
});

test('every inserted ticket has type = Parlay', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  db.inserted.forEach(function(t, i) {
    assertEq(t.type, 'Parlay', 'ticket ' + i + ' type');
  });
});

test('every inserted ticket has status = active', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  db.inserted.forEach(function(t, i) {
    assertEq(t.status, 'active', 'ticket ' + i + ' status');
  });
});

test('every inserted ticket has rr_group_id = the group ID', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG_xyz', LEGS3, { '2': 10 });
  placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  db.inserted.forEach(function(t, i) {
    assertEq(t.rr_group_id, 'RRG_xyz', 'ticket ' + i + ' rr_group_id');
  });
});

test('inserted ticket IDs are unique within the slip', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG1', LEGS4, { '2': 10 });
  placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  var ids = db.inserted.map(function(t) { return t.id; });
  assertEq(new Set(ids).size, ids.length, 'all ticket IDs unique');
});

test('combo count in return matches ticket insert count', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG1', LEGS4, { '2': 10, '3': 5 });
  var r = placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assertEq(r.combo_count, db.inserted.length, 'combo_count matches inserted');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION F — Ledger entry
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- F. Ledger entry --');

test('exactly one ledger entry is created per placement', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assertEq(db.ledgerInserts.length, 1, 'ledger insert count');
});

test('ledger entry amount equals negative total_stake', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  var entry = db.ledgerInserts[0];
  assertClose(entry.amount, -30, 0.01, 'ledger amount = -totalStake');
});

test('ledger ticket_id is null (slip-level entry)', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  var entry = db.ledgerInserts[0];
  assertEq(entry.ticket_id, null, 'ticket_id must be null for RR placement');
});

test('ledger reason embeds group_id', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG_abc123', LEGS3, { '2': 10 });
  placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  var entry = db.ledgerInserts[0];
  assert(entry.reason.includes('RRG_abc123'), 'reason must include group_id: ' + entry.reason);
});

test('balance_after in ledger = available - total_stake', function() {
  var db = makeDb({ clubMembers:{ balance_start:200 } });
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });  // $30 total
  placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  var entry = db.ledgerInserts[0];
  assertClose(entry.balance_after, 170, 0.01, 'balance_after = 200 - 30');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION G — Idempotency
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- G. Idempotency --');

test('second call with same idempotency key returns idempotent:true replayed:true', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  var args = { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos };
  var r1 = placeRrTx(db, args);
  var r2 = placeRrTx(db, args);
  assert(r1.ok && !r1.idempotent, 'first call should succeed non-idempotently');
  assert(r2.ok && r2.idempotent && r2.replayed, 'second call should replay');
});

test('idempotent replay does NOT insert additional ledger entry', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  var args = { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos };
  placeRrTx(db, args);
  placeRrTx(db, args);
  assertEq(db.ledgerInserts.length, 1, 'only one ledger entry ever');
});

test('idempotent replay returns correct balance_after from original ledger', function() {
  var db = makeDb({ clubMembers:{ balance_start:200 } });
  var payload = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  var args = { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos };
  var r1 = placeRrTx(db, args);
  var r2 = placeRrTx(db, args);
  assertClose(r1.balance_after, r2.balance_after, 0.01, 'balance_after consistent across replay');
  assertClose(r2.balance_after, 170, 0.01, 'balance_after = 200 - 30');
});

test('idempotent replay returns correct group_id', function() {
  var db = freshDb();
  var payload = buildRrPayload('RRG_replay_test', LEGS3, { '2': 10 });
  var args = { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK_replay', p_total_stake:payload.totalStake,
    p_combos:payload.combos };
  placeRrTx(db, args);
  var r2 = placeRrTx(db, args);
  assertEq(r2.group_id, 'RRG_replay_test', 'group_id preserved on replay');
});

test('different idempotency keys are independent — both succeed', function() {
  var db = freshDb();
  var p1 = buildRrPayload('RRG1', LEGS3, { '2': 10 });
  var p2 = buildRrPayload('RRG2', LEGS3, { '2': 10 });
  var r1 = placeRrTx(db, { p_group_id:p1.groupId, p_player_id:'P1',
    p_idempotency_key:'IK_A', p_total_stake:p1.totalStake, p_combos:p1.combos });
  var r2 = placeRrTx(db, { p_group_id:p2.groupId, p_player_id:'P1',
    p_idempotency_key:'IK_B', p_total_stake:p2.totalStake, p_combos:p2.combos });
  assert(r1.ok && !r1.idempotent, 'first slip');
  assert(r2.ok && !r2.idempotent, 'second slip');
  assertEq(db.ledgerInserts.length, 2, 'two independent slips = two ledger entries');
  assertEq(db.inserted.length, 6, '3+3 combo tickets');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION H — Return shape
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- H. Return shape --');

test('successful placement returns all required fields', function() {
  var db = makeDb({ clubMembers:{ balance_start:200 } });
  var payload = buildRrPayload('RRG_shape', LEGS3, { '2': 10 });
  var r = placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assert(r.ok === true,           'ok');
  assert(r.idempotent === false,  'idempotent=false on first call');
  assert(r.replayed === false,    'replayed=false on first call');
  assertEq(r.group_id,  'RRG_shape', 'group_id');
  assertEq(r.combo_count, 3,         'combo_count');
  assertClose(r.balance_after, 170, 0.01, 'balance_after');
  assertClose(r.available,     200, 0.01, 'available');
  assertClose(r.total_stake,    30, 0.01, 'total_stake');
});

test('balance_after decrements by total_stake on 4-pick multi-size', function() {
  var db = makeDb({ clubMembers:{ balance_start:500 } });
  var payload = buildRrPayload('RRG_multi', LEGS4, { '2': 10, '3': 5 });
  // 6×$10 + 4×$5 = $80 total
  var r = placeRrTx(db, { p_group_id:payload.groupId, p_player_id:'P1',
    p_idempotency_key:'IK1', p_total_stake:payload.totalStake,
    p_combos:payload.combos });
  assert(r.ok, JSON.stringify(r));
  assertClose(r.balance_after, 420, 0.01, '500 - 80 = 420');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\nplace_rr_tx smoke tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
