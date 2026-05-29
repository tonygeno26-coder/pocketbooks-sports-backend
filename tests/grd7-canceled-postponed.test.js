'use strict';

// ============================================================================
// GRD-7 regression tests — canceled/postponed leg settlement
//
// Before this fix, a leg whose result_snapshot has status='canceled',
// 'postponed', 'abandoned', or 'suspended' would return outcome='pending'
// from _deriveLegOutcome, causing the ticket to stay 'active' forever with
// the player's balance permanently locked.
//
// After the fix:
//   • _upsertResultSnapshots writes status='canceled' when the Odds API
//     signals a canceled/postponed game (game.canceled=true, game.cancelled=true,
//     or game.status ∈ {canceled,cancelled,abandoned,postponed}).
//   • _deriveLegOutcome returns outcome='push' for those statuses so
//     grade_ticket_tx can settle with a full stake refund.
//   • Parlays: canceled legs fall into the GRD-2 push-reduction path —
//     the leg drops out, remaining winning legs pay at reduced odds.
//
// Sections:
//   A. _upsertResultSnapshots status derivation
//   B. _deriveLegOutcome canceled/postponed guard
//   C. Single bet — canceled/postponed → push
//   D. Parlay, one leg canceled → push-reduced
//   E. Parlay, all legs canceled → push
//   F. 2-leg parlay, 1 leg canceled → single-leg payout
//   G. Game removed from feed (no snapshot) → stays pending (GRD-7b, not fixed)
//   H. Edge cases — suspended, abandoned, forfeit
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
// Inline copy of the fixed _upsertResultSnapshots status logic (Change 1).
// We test the status-derivation expression in isolation.
// ---------------------------------------------------------------------------
function deriveSnapshotStatus(game) {
  const rawStatus = String(game.status || game.state || '').toLowerCase();
  const isCanceled = game.canceled === true || game.cancelled === true ||
    /^(canceled|cancelled|abandoned|postponed)$/.test(rawStatus);
  const status = game.completed ? 'final'
               : isCanceled     ? 'canceled'
               : (game.scores && game.scores.length) ? 'live'
               : 'scheduled';
  return status;
}

// ---------------------------------------------------------------------------
// Inline copy of the fixed _deriveLegOutcome (Change 2 guard only).
// ---------------------------------------------------------------------------
function deriveLegOutcome(leg, result) {
  if (!result) return { outcome: 'error', reason: 'result_missing' };
  const canceledStatuses = new Set(['canceled','cancelled','postponed','abandoned','suspended','forfeit']);
  if (canceledStatuses.has(result.status)) {
    return { outcome: 'push', reason: 'event_' + result.status };
  }
  if (result.status !== 'final') return { outcome: 'pending', reason: 'result_not_final', status: result.status };
  // Simplified grading — only moneyline needed for these tests
  const market = (leg.market || 'moneyline').toLowerCase();
  const pick   = (leg.pick   || '').toLowerCase();
  const homeTeam  = (result.home_team  || '').toLowerCase();
  const awayTeam  = (result.away_team  || '').toLowerCase();
  const homeScore = parseInt(result.home_score, 10) || 0;
  const awayScore = parseInt(result.away_score, 10) || 0;
  if (market === 'moneyline' || market === 'h2h') {
    if (homeScore === awayScore) return { outcome: 'push', reason: 'tie' };
    const pickedHome = pick.includes(homeTeam);
    const pickedAway = pick.includes(awayTeam);
    if (result.winner === 'home' && pickedHome) return { outcome: 'won' };
    if (result.winner === 'away' && pickedAway) return { outcome: 'won' };
    return { outcome: 'lost' };
  }
  return { outcome: 'error', reason: 'unsupported_market' };
}

// ---------------------------------------------------------------------------
// Inline copy of _deriveTicketOutcome (unchanged, copied to verify integration)
// ---------------------------------------------------------------------------
function sgAmToDecimal(o) {
  var n = parseInt(String(o || 0).replace('+', ''));
  if (!n || isNaN(n)) return 1;
  return n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1;
}

function deriveTicketOutcome(ticket, legs, resultsByKey) {
  const type = (ticket.type || 'single').toLowerCase();
  if (!legs.length) return { outcome: 'error', reason: 'no_legs' };
  const legOutcomes = legs.map(function(leg) {
    const result = resultsByKey[leg.canonical_game_key || ''] || null;
    return Object.assign({ leg: leg.pick }, deriveLegOutcome(leg, result));
  });
  const pending = legOutcomes.find(function(l) { return l.outcome === 'pending' || l.outcome === 'error'; });
  if (pending) return { outcome: pending.outcome, reason: pending.reason, leg: pending.leg };
  if (type === 'single' || type === 'straight') return legOutcomes[0];
  // Parlay / Teaser — any lost leg loses the whole ticket
  const anyLost = legOutcomes.find(function(l) { return l.outcome === 'lost'; });
  if (anyLost) return { outcome: 'lost' };
  // GRD-2: separate won from pushed
  const wonLegs  = legs.filter(function(_, i) { return legOutcomes[i].outcome === 'won'; });
  const pushLegs = legs.filter(function(_, i) { return legOutcomes[i].outcome === 'push'; });
  if (pushLegs.length > 0 && wonLegs.length > 0) {
    return { outcome: 'won', pushReduced: true, wonLegObjects: wonLegs, pushLegCount: pushLegs.length };
  }
  if (pushLegs.length === legs.length) {
    return { outcome: 'push' };
  }
  return wonLegs.length === legs.length ? { outcome: 'won' } : { outcome: 'lost' };
}

// ---------------------------------------------------------------------------
// A. _upsertResultSnapshots status derivation (Change 1)
// ---------------------------------------------------------------------------
console.log('\n-- A. _upsertResultSnapshots status derivation --');

test('completed=true → "final"', function() {
  assertEq(deriveSnapshotStatus({ completed: true }), 'final');
});

test('game.canceled=true → "canceled"', function() {
  assertEq(deriveSnapshotStatus({ canceled: true }), 'canceled');
});

test('game.cancelled=true (British spelling) → "canceled"', function() {
  assertEq(deriveSnapshotStatus({ cancelled: true }), 'canceled');
});

test('game.status="postponed" → "canceled"', function() {
  assertEq(deriveSnapshotStatus({ status: 'postponed' }), 'canceled');
});

test('game.status="Postponed" (capital) → "canceled"', function() {
  assertEq(deriveSnapshotStatus({ status: 'Postponed' }), 'canceled');
});

test('game.status="abandoned" → "canceled"', function() {
  assertEq(deriveSnapshotStatus({ status: 'abandoned' }), 'canceled');
});

test('game.status="cancelled" → "canceled"', function() {
  assertEq(deriveSnapshotStatus({ status: 'cancelled' }), 'canceled');
});

test('game.status="canceled" → "canceled"', function() {
  assertEq(deriveSnapshotStatus({ status: 'canceled' }), 'canceled');
});

test('scores present but not completed and not canceled → "live"', function() {
  assertEq(deriveSnapshotStatus({ completed: false, scores: [{ name: 'A', score: '3' }] }), 'live');
});

test('no scores, no completion, no cancellation → "scheduled"', function() {
  assertEq(deriveSnapshotStatus({ completed: false }), 'scheduled');
});

test('completed=true beats canceled flag', function() {
  // If both are set (shouldn't happen in practice), completed wins
  assertEq(deriveSnapshotStatus({ completed: true, canceled: true }), 'final');
});

test('game.state="postponed" (alternate field) → "canceled"', function() {
  assertEq(deriveSnapshotStatus({ state: 'postponed' }), 'canceled');
});

// ---------------------------------------------------------------------------
// B. _deriveLegOutcome canceled/postponed guard (Change 2)
// ---------------------------------------------------------------------------
console.log('\n-- B. _deriveLegOutcome canceled/postponed guard --');

var anyLeg = { pick: 'Team A', market: 'moneyline', canonical_game_key: 'MLB|team-a|team-b|2026-05-29' };

test('status="canceled" → push', function() {
  var r = deriveLegOutcome(anyLeg, { status: 'canceled', home_team: 'A', away_team: 'B' });
  assertEq(r.outcome, 'push');
  assertEq(r.reason, 'event_canceled');
});

test('status="cancelled" → push', function() {
  var r = deriveLegOutcome(anyLeg, { status: 'cancelled', home_team: 'A', away_team: 'B' });
  assertEq(r.outcome, 'push');
});

test('status="postponed" → push', function() {
  var r = deriveLegOutcome(anyLeg, { status: 'postponed', home_team: 'A', away_team: 'B' });
  assertEq(r.outcome, 'push');
  assertEq(r.reason, 'event_postponed');
});

test('status="abandoned" → push', function() {
  var r = deriveLegOutcome(anyLeg, { status: 'abandoned', home_team: 'A', away_team: 'B' });
  assertEq(r.outcome, 'push');
});

test('status="suspended" → push', function() {
  var r = deriveLegOutcome(anyLeg, { status: 'suspended', home_team: 'A', away_team: 'B' });
  assertEq(r.outcome, 'push');
});

test('status="forfeit" → push', function() {
  var r = deriveLegOutcome(anyLeg, { status: 'forfeit', home_team: 'A', away_team: 'B' });
  assertEq(r.outcome, 'push');
});

test('status="scheduled" still → pending (not fixed yet)', function() {
  var r = deriveLegOutcome(anyLeg, { status: 'scheduled', home_team: 'A', away_team: 'B' });
  assertEq(r.outcome, 'pending');
  assertEq(r.reason, 'result_not_final');
});

test('status="final" proceeds to grading', function() {
  var r = deriveLegOutcome(
    { pick: 'team a', market: 'moneyline' },
    { status: 'final', home_team: 'team a', away_team: 'team b',
      home_score: 5, away_score: 3, winner: 'home' }
  );
  assertEq(r.outcome, 'won');
});

test('no result → error (unchanged)', function() {
  var r = deriveLegOutcome(anyLeg, null);
  assertEq(r.outcome, 'error');
  assertEq(r.reason, 'result_missing');
});

// ---------------------------------------------------------------------------
// C. Single bet — canceled/postponed game → push
// ---------------------------------------------------------------------------
console.log('\n-- C. Single bet, game canceled/postponed → push --');

var singleTicket = { type: 'single', risk_amount: 20 };
var singleLeg    = [{ canonical_game_key: 'MLB|A|B|2026-05-29', pick: 'team a', market: 'moneyline' }];

test('single — game postponed → ticket outcome push', function() {
  var results = { 'MLB|A|B|2026-05-29': { status: 'postponed', home_team: 'team a', away_team: 'team b' } };
  var o = deriveTicketOutcome(singleTicket, singleLeg, results);
  assertEq(o.outcome, 'push');
  assertEq(o.reason, 'event_postponed');
});

test('single — game canceled → ticket outcome push', function() {
  var results = { 'MLB|A|B|2026-05-29': { status: 'canceled', home_team: 'team a', away_team: 'team b' } };
  var o = deriveTicketOutcome(singleTicket, singleLeg, results);
  assertEq(o.outcome, 'push');
});

test('single — game abandoned → ticket outcome push', function() {
  var results = { 'MLB|A|B|2026-05-29': { status: 'abandoned', home_team: 'team a', away_team: 'team b' } };
  var o = deriveTicketOutcome(singleTicket, singleLeg, results);
  assertEq(o.outcome, 'push');
});

test('single — game cancelled (British) → ticket outcome push', function() {
  var results = { 'MLB|A|B|2026-05-29': { status: 'cancelled', home_team: 'team a', away_team: 'team b' } };
  var o = deriveTicketOutcome(singleTicket, singleLeg, results);
  assertEq(o.outcome, 'push');
});

// ---------------------------------------------------------------------------
// D. Parlay, one leg canceled → push-reduced (remaining legs pay at lower odds)
// ---------------------------------------------------------------------------
console.log('\n-- D. Parlay, one leg canceled → push-reduced --');

var parlayTicket = { type: 'parlay', risk_amount: 20 };
var parlayLegs = [
  { canonical_game_key: 'MLB|A|B|2026-05-29', pick: 'team a', market: 'moneyline', odds: -110 },
  { canonical_game_key: 'MLB|C|D|2026-05-29', pick: 'team c', market: 'moneyline', odds: -110 }
];

test('parlay — leg1 wins, leg2 canceled → pushReduced=true', function() {
  var results = {
    'MLB|A|B|2026-05-29': { status: 'final',    home_team: 'team a', away_team: 'team b', home_score: 5, away_score: 3, winner: 'home' },
    'MLB|C|D|2026-05-29': { status: 'canceled', home_team: 'team c', away_team: 'team d' }
  };
  var o = deriveTicketOutcome(parlayTicket, parlayLegs, results);
  assertEq(o.outcome, 'won', 'outcome');
  assert(o.pushReduced === true, 'pushReduced flag');
  assertEq(o.wonLegObjects.length, 1, 'one winning leg remains');
  assertEq(o.pushLegCount, 1, 'one pushed (canceled) leg');
});

test('parlay — push-reduced profit uses winning leg odds only', function() {
  var results = {
    'MLB|A|B|2026-05-29': { status: 'final',    home_team: 'team a', away_team: 'team b', home_score: 5, away_score: 3, winner: 'home' },
    'MLB|C|D|2026-05-29': { status: 'postponed', home_team: 'team c', away_team: 'team d' }
  };
  var o = deriveTicketOutcome(parlayTicket, parlayLegs, results);
  // For push-reduced: profit = risk × (decOdds - 1) for winning leg only
  var risk = 20;
  var dec = sgAmToDecimal(-110);  // ≈ 1.9091
  var expectedProfit = Math.round(risk * (dec - 1) * 100) / 100;  // ≈ 16.36
  // Verify wonLegObjects has the right leg for downstream profit calculation
  assert(o.wonLegObjects.length === 1, 'one winning leg');
  var wonLeg = o.wonLegObjects[0];
  var computedProfit = Math.round(risk * (sgAmToDecimal(wonLeg.odds) - 1) * 100) / 100;
  assertClose(computedProfit, expectedProfit, 0.02, 'push-reduced profit');
});

test('parlay — leg1 canceled, leg2 loses → outcome lost (canceled leg does not save losing parlay)', function() {
  var results = {
    'MLB|A|B|2026-05-29': { status: 'canceled', home_team: 'team a', away_team: 'team b' },
    'MLB|C|D|2026-05-29': { status: 'final',    home_team: 'team c', away_team: 'team d', home_score: 1, away_score: 5, winner: 'away' }
  };
  // Leg2 pick is 'team c' (home) but away wins → lost
  var legs = [
    { canonical_game_key: 'MLB|A|B|2026-05-29', pick: 'team a', market: 'moneyline', odds: -110 },
    { canonical_game_key: 'MLB|C|D|2026-05-29', pick: 'team c', market: 'moneyline', odds: -110 }
  ];
  var o = deriveTicketOutcome(parlayTicket, legs, results);
  assertEq(o.outcome, 'lost', 'losing leg still kills parlay');
});

test('3-leg parlay — 1 canceled, 2 win → pushReduced with 2 winning legs', function() {
  var legs3 = [
    { canonical_game_key: 'MLB|A|B|2026-05-29', pick: 'team a', market: 'moneyline', odds: -110 },
    { canonical_game_key: 'MLB|C|D|2026-05-29', pick: 'team c', market: 'moneyline', odds: -110 },
    { canonical_game_key: 'MLB|E|F|2026-05-29', pick: 'team e', market: 'moneyline', odds: -110 }
  ];
  var results = {
    'MLB|A|B|2026-05-29': { status: 'final',    home_team: 'team a', away_team: 'team b', home_score:3, away_score:1, winner:'home' },
    'MLB|C|D|2026-05-29': { status: 'postponed', home_team: 'team c', away_team: 'team d' },
    'MLB|E|F|2026-05-29': { status: 'final',    home_team: 'team e', away_team: 'team f', home_score:4, away_score:2, winner:'home' }
  };
  var o = deriveTicketOutcome({ type: 'parlay' }, legs3, results);
  assertEq(o.outcome, 'won', 'outcome');
  assert(o.pushReduced, 'pushReduced');
  assertEq(o.wonLegObjects.length, 2, '2 winning legs in reduced parlay');
  assertEq(o.pushLegCount, 1, '1 pushed leg');
});

// ---------------------------------------------------------------------------
// E. Parlay, all legs canceled → push (full stake refund)
// ---------------------------------------------------------------------------
console.log('\n-- E. Parlay, all legs canceled → push --');

test('2-leg parlay — both canceled → push', function() {
  var results = {
    'MLB|A|B|2026-05-29': { status: 'canceled', home_team: 'team a', away_team: 'team b' },
    'MLB|C|D|2026-05-29': { status: 'postponed', home_team: 'team c', away_team: 'team d' }
  };
  var o = deriveTicketOutcome(parlayTicket, parlayLegs, results);
  assertEq(o.outcome, 'push', 'all-canceled parlay = push');
  assert(!o.pushReduced, 'no pushReduced flag when all legs cancel');
});

test('3-leg parlay — all three canceled → push', function() {
  var legs3 = [
    { canonical_game_key: 'K1', pick: 'team a', market: 'moneyline', odds: -110 },
    { canonical_game_key: 'K2', pick: 'team b', market: 'moneyline', odds: -110 },
    { canonical_game_key: 'K3', pick: 'team c', market: 'moneyline', odds: -110 }
  ];
  var results = {
    K1: { status: 'canceled',  home_team: 'team a', away_team: 'team x' },
    K2: { status: 'postponed', home_team: 'team b', away_team: 'team y' },
    K3: { status: 'abandoned', home_team: 'team c', away_team: 'team z' }
  };
  var o = deriveTicketOutcome({ type: 'parlay' }, legs3, results);
  assertEq(o.outcome, 'push', 'all-canceled 3-leg parlay = push');
});

// ---------------------------------------------------------------------------
// F. 2-leg parlay, 1 leg canceled → effectively a 1-leg bet (single odds)
// ---------------------------------------------------------------------------
console.log('\n-- F. 2-leg parlay, 1 leg canceled → reduced to single-leg odds --');

test('2-leg parlay, 1 canceled, 1 wins → pushReduced, 1 wonLeg', function() {
  var results = {
    'MLB|A|B|2026-05-29': { status: 'canceled', home_team: 'team a', away_team: 'team b' },
    'MLB|C|D|2026-05-29': { status: 'final',    home_team: 'team c', away_team: 'team d', home_score:5, away_score:2, winner:'home' }
  };
  var legs = [
    { canonical_game_key: 'MLB|A|B|2026-05-29', pick: 'team a', market: 'moneyline', odds: -110 },
    { canonical_game_key: 'MLB|C|D|2026-05-29', pick: 'team c', market: 'moneyline', odds: -110 }
  ];
  var o = deriveTicketOutcome(parlayTicket, legs, results);
  assertEq(o.outcome, 'won', 'outcome');
  assert(o.pushReduced, 'pushReduced');
  assertEq(o.wonLegObjects.length, 1, '1 winning leg');
  // Profit should be at single-leg odds (not the 2-leg parlay odds)
  var risk = 20;
  var dec  = sgAmToDecimal(-110);
  var expectedProfit = Math.round(risk * (dec - 1) * 100) / 100;
  var computedProfit = Math.round(risk * (sgAmToDecimal(o.wonLegObjects[0].odds) - 1) * 100) / 100;
  assertClose(computedProfit, expectedProfit, 0.02, 'single-leg equivalent profit');
});

// ---------------------------------------------------------------------------
// G. Game removed from feed — no snapshot at all → stays pending (GRD-7b)
// ---------------------------------------------------------------------------
console.log('\n-- G. Game removed from feed → stays pending (GRD-7b, not fixed) --');

test('no snapshot row → outcome error (result_missing) — unchanged, GRD-7b', function() {
  var results = {};  // no entry for this game's key
  var o = deriveTicketOutcome(singleTicket, singleLeg, results);
  // GRD-7b: ticket stays ungraded until a manual override or timeout logic
  assertEq(o.outcome, 'error', 'no snapshot → error, not push');
  assertEq(o.reason, 'result_missing', 'reason');
});

test('status="scheduled" (game not yet played) → still pending, not push', function() {
  var results = { 'MLB|A|B|2026-05-29': { status: 'scheduled', home_team: 'team a', away_team: 'team b' } };
  var o = deriveTicketOutcome(singleTicket, singleLeg, results);
  assertEq(o.outcome, 'pending', 'scheduled → pending');
});

// ---------------------------------------------------------------------------
// H. Edge cases — additional canceledStatuses values
// ---------------------------------------------------------------------------
console.log('\n-- H. Edge cases --');

test('status="suspended" → push', function() {
  var r = deriveLegOutcome(anyLeg, { status: 'suspended', home_team: 'A', away_team: 'B' });
  assertEq(r.outcome, 'push');
  assertEq(r.reason, 'event_suspended');
});

test('status="forfeit" → push', function() {
  var r = deriveLegOutcome(anyLeg, { status: 'forfeit', home_team: 'A', away_team: 'B' });
  assertEq(r.outcome, 'push');
});

test('status="CANCELED" (uppercase) → does NOT push (status comparison is case-sensitive — Set contains lowercase)', function() {
  // The Set stores lowercase values. result.status should always be stored lowercase
  // via _upsertResultSnapshots. But if somehow a uppercase value slips through,
  // it falls to the != 'final' → pending path (safe: won't incorrectly grade).
  var r = deriveLegOutcome(anyLeg, { status: 'CANCELED', home_team: 'A', away_team: 'B' });
  // CANCELED (uppercase) is NOT in the Set — treated as pending, not push.
  // This is intentional: _upsertResultSnapshots always writes lowercase.
  assertEq(r.outcome, 'pending', 'uppercase CANCELED is not in Set — falls to pending');
});

test('upsertResultSnapshots always produces lowercase status', function() {
  // Verify the mapping function produces lowercase output in all cases
  var s1 = deriveSnapshotStatus({ completed: true });
  var s2 = deriveSnapshotStatus({ canceled: true });
  var s3 = deriveSnapshotStatus({ status: 'Postponed' });
  var s4 = deriveSnapshotStatus({ scores: [{}] });
  var s5 = deriveSnapshotStatus({});
  [s1, s2, s3, s4, s5].forEach(function(s, i) {
    assert(s === s.toLowerCase(), 'status['+i+'] should be lowercase: ' + s);
  });
});

test('snapshotStatus → deriveLegOutcome pipeline: postponed game pushes correctly', function() {
  // Full end-to-end: odds API game → snapshot status → leg outcome
  var oddsApiGame = { completed: false, status: 'postponed', scores: null };
  var snapStatus  = deriveSnapshotStatus(oddsApiGame);
  assertEq(snapStatus, 'canceled', 'snapshot status');
  var leg    = { pick: 'team a', market: 'moneyline' };
  var result = { status: snapStatus, home_team: 'team a', away_team: 'team b' };
  var lo     = deriveLegOutcome(leg, result);
  assertEq(lo.outcome, 'push', 'end-to-end: postponed → canceled snapshot → push leg');
});

// ---------------------------------------------------------------------------
console.log('\nGRD-7 canceled/postponed settlement tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
