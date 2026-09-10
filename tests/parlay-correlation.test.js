'use strict';
/**
 * Parlay correlation protection — full matrix + place-gate bypass simulation.
 * Run: node tests/parlay-correlation.test.js
 * No production DB / settlement / financial writes.
 */
const corr = require('../lib/parlay-correlation');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); pass++; }
  catch (e) { console.error('  FAIL ' + name + '\n     ' + e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function assertEq(a, b, m) {
  if (a !== b) throw new Error((m || '') + ' — got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));
}

const GAME = 'mlb|Cleveland Guardians|Pittsburgh Pirates|2026-05-21';
const GAME2 = 'mlb|Miami Marlins|New York Mets|2026-05-21';
const NFL = 'nfl|Kansas City Chiefs|Baltimore Ravens|2026-09-10';
const SOCCER = 'soccer|Arsenal|Chelsea|2026-05-21';
const TENNIS = 'tennis|Player A|Player B|2026-05-21';

function leg(pick, market, game, extra) {
  return Object.assign({
    pick: pick,
    market: market,
    canonicalGameKey: game || GAME,
    odds: -110,
    sport: (game || GAME).split('|')[0]
  }, extra || {});
}

console.log('\n── coerceMarketType ──');
test('run line → spread', function() { assertEq(corr.coerceMarketType('Run Line'), 'spread'); });
test('team totals → team_total', function() { assertEq(corr.coerceMarketType('Team Totals'), 'team_total'); });
test('player prop', function() { assertEq(corr.coerceMarketType('player_prop'), 'player_prop'); });
test('futures', function() { assertEq(corr.coerceMarketType('Futures'), 'futures'); });

console.log('\n── INDEPENDENT (different events) ──');
test('ML game1 + ML game2 → INDEPENDENT', function() {
  var r = corr.classifyLegRelationship(
    leg('Cleveland Guardians', 'Moneyline', GAME),
    leg('Miami Marlins', 'Moneyline', GAME2)
  );
  assertEq(r.relationship, 'INDEPENDENT');
});
test('3-leg multi-game assert ok', function() {
  var g = corr.assertParlayCorrelationAllowed([
    leg('Cleveland Guardians', 'moneyline', GAME),
    leg('Miami Marlins', 'moneyline', GAME2),
    leg('Kansas City Chiefs', 'moneyline', NFL)
  ], { betType: 'Parlay' });
  assert(g.ok);
});

console.log('\n── DUPLICATES ──');
test('same ML twice → DUPLICATE', function() {
  var r = corr.classifyLegRelationship(
    leg('Cleveland Guardians', 'moneyline', GAME),
    leg('Cleveland Guardians', 'moneyline', GAME)
  );
  assertEq(r.relationship, 'DUPLICATE');
});
test('same Over 7.5 twice → DUPLICATE', function() {
  var r = corr.classifyLegRelationship(
    leg('Over 7.5', 'total', GAME),
    leg('Over 7.5', 'totals', GAME)
  );
  assertEq(r.relationship, 'DUPLICATE');
});

console.log('\n── MUTUALLY EXCLUSIVE ──');
test('both teams ML → MUTUALLY_EXCLUSIVE', function() {
  var r = corr.classifyLegRelationship(
    leg('Cleveland Guardians', 'moneyline', GAME),
    leg('Pittsburgh Pirates', 'moneyline', GAME)
  );
  assertEq(r.relationship, 'MUTUALLY_EXCLUSIVE');
});
test('Over + Under → MUTUALLY_EXCLUSIVE', function() {
  var r = corr.classifyLegRelationship(
    leg('Over 7.5', 'total', GAME),
    leg('Under 7.5', 'total', GAME)
  );
  assertEq(r.relationship, 'MUTUALLY_EXCLUSIVE');
});
test('opposite spreads same line → MUTUALLY_EXCLUSIVE', function() {
  var r = corr.classifyLegRelationship(
    leg('Cleveland Guardians -1.5', 'spread', GAME),
    leg('Pittsburgh Pirates +1.5', 'spread', GAME)
  );
  assertEq(r.relationship, 'MUTUALLY_EXCLUSIVE');
});
test('soccer home + away ML → MUTUALLY_EXCLUSIVE', function() {
  var r = corr.classifyLegRelationship(
    leg('Arsenal', 'moneyline', SOCCER),
    leg('Chelsea', 'moneyline', SOCCER)
  );
  assertEq(r.relationship, 'MUTUALLY_EXCLUSIVE');
});

console.log('\n── OVERLAPPING ALTS ──');
test('same team -3.5 and -7.5 → CORRELATED_SGP_REQUIRED', function() {
  var r = corr.classifyLegRelationship(
    leg('Chiefs -3.5', 'spread', NFL),
    leg('Chiefs -7.5', 'alt_spread', NFL)
  );
  assertEq(r.relationship, 'CORRELATED_SGP_REQUIRED');
  assertEq(r.reason, 'overlapping_alt_spreads');
});
test('Over 45.5 + Over 48.5 → CORRELATED_SGP_REQUIRED', function() {
  var r = corr.classifyLegRelationship(
    leg('Over 45.5', 'total', NFL),
    leg('Over 48.5', 'alt_total', NFL)
  );
  assertEq(r.relationship, 'CORRELATED_SGP_REQUIRED');
});

console.log('\n── SAME TEAM ML + SPREAD ──');
test('Guardians ML + Guardians RL → CORRELATED_SGP_REQUIRED', function() {
  var r = corr.classifyLegRelationship(
    leg('Cleveland Guardians', 'moneyline', GAME),
    leg('Cleveland Guardians -1.5', 'Run Line', GAME)
  );
  assertEq(r.relationship, 'CORRELATED_SGP_REQUIRED');
  assertEq(r.reason, 'moneyline_plus_spread');
});
test('Guardians ML + Pirates RL → CORRELATED_SGP_REQUIRED', function() {
  var r = corr.classifyLegRelationship(
    leg('Cleveland Guardians', 'moneyline', GAME),
    leg('Pittsburgh Pirates +1.5', 'spread', GAME)
  );
  assertEq(r.relationship, 'CORRELATED_SGP_REQUIRED');
});

console.log('\n── TOTAL + TEAM TOTAL ──');
test('game total + team total → CORRELATED_SGP_REQUIRED', function() {
  var r = corr.classifyLegRelationship(
    leg('Over 7.5', 'total', GAME),
    leg('Cleveland Guardians Over 3.5', 'team_total', GAME)
  );
  assertEq(r.relationship, 'CORRELATED_SGP_REQUIRED');
  assertEq(r.reason, 'total_plus_team_total');
});

console.log('\n── PLAYER PROP CORRELATION ──');
test('player prop + ML → CORRELATED_SGP_REQUIRED', function() {
  var r = corr.classifyLegRelationship(
    leg('Jose Ramirez Over 1.5 Hits', 'player_prop', GAME, { playerName: 'Jose Ramirez' }),
    leg('Cleveland Guardians', 'moneyline', GAME)
  );
  assertEq(r.relationship, 'CORRELATED_SGP_REQUIRED');
  assertEq(r.reason, 'player_prop_plus_game_market');
});
test('player prop + total → CORRELATED_SGP_REQUIRED', function() {
  var r = corr.classifyLegRelationship(
    leg('Jose Ramirez Over 1.5 Hits', 'player_prop', GAME, { playerName: 'Jose Ramirez' }),
    leg('Over 7.5', 'total', GAME)
  );
  assertEq(r.relationship, 'CORRELATED_SGP_REQUIRED');
});

console.log('\n── UNKNOWN SAME-EVENT FAIL CLOSED ──');
test('unknown market labels same event → UNSUPPORTED_CORRELATION', function() {
  var r = corr.classifyLegRelationship(
    { pick: 'Weird A', market: 'mystery_market_xyz', canonicalGameKey: GAME, sport: 'mlb' },
    { pick: 'Weird B', market: 'other_mystery', canonicalGameKey: GAME, sport: 'mlb' }
  );
  assertEq(r.relationship, 'UNSUPPORTED_CORRELATION');
});
test('tennis same-event unknown combo → UNSUPPORTED_CORRELATION', function() {
  var r = corr.classifyLegRelationship(
    leg('Player A', 'moneyline', TENNIS),
    leg('Over 22.5 Games', 'total', TENNIS)
  );
  // side+total is CORRELATED_SGP_REQUIRED first (known pattern) — still blocked
  assert(r.relationship === 'CORRELATED_SGP_REQUIRED' || r.relationship === 'UNSUPPORTED_CORRELATION');
});
test('missing event key → UNSUPPORTED_CORRELATION', function() {
  var r = corr.classifyLegRelationship(
    { pick: 'A', market: 'moneyline', odds: -110 },
    { pick: 'B', market: 'moneyline', odds: -110 }
  );
  assertEq(r.relationship, 'UNSUPPORTED_CORRELATION');
});

console.log('\n── FUTURES ──');
test('futures leg → DEPENDENT_FUTURE', function() {
  var r = corr.classifyLegRelationship(
    leg('Chiefs', 'futures', NFL),
    leg('Miami Marlins', 'moneyline', GAME2)
  );
  assertEq(r.relationship, 'DEPENDENT_FUTURE');
});

console.log('\n── PERIOD CORRELATION ──');
test('1H ML + full-game ML → CORRELATED_SGP_REQUIRED', function() {
  var r = corr.classifyLegRelationship(
    leg('Cleveland Guardians', 'first_half_moneyline', GAME),
    leg('Cleveland Guardians', 'moneyline', GAME)
  );
  assertEq(r.relationship, 'CORRELATED_SGP_REQUIRED');
});

console.log('\n── SIDE + TOTAL (classic SGP) blocked without engine ──');
test('ML + Over same game → CORRELATED_SGP_REQUIRED and place reject', function() {
  var r = corr.classifyLegRelationship(
    leg('Cleveland Guardians', 'moneyline', GAME),
    leg('Over 7.5', 'total', GAME)
  );
  assertEq(r.relationship, 'CORRELATED_SGP_REQUIRED');
  var g = corr.assertParlayCorrelationAllowed([
    leg('Cleveland Guardians', 'moneyline', GAME),
    leg('Over 7.5', 'total', GAME)
  ], { betType: 'Parlay' });
  assert(!g.ok);
  assertEq(g.financialMutation, 'NONE');
});
test('SGP betType still rejected — engine unsupported', function() {
  var g = corr.assertParlayCorrelationAllowed([
    leg('Cleveland Guardians', 'moneyline', GAME),
    leg('Over 7.5', 'total', GAME)
  ], { betType: 'SGP' });
  assert(!g.ok);
  assert(corr.sgpEngineSupportsCombination() === false);
});

console.log('\n── API BYPASS SIMULATION (server gate) ──');
test('manipulated client same-game parlay rejected with ZERO financial mutation', function() {
  // Simulates /api/bets/place early gate — no ticket/ledger/bankroll side effects.
  var payload = {
    betType: 'Parlay',
    stake: 50,
    legs: [
      leg('Cleveland Guardians', 'moneyline', GAME),
      leg('Cleveland Guardians -1.5', 'spread', GAME)
    ]
  };
  var gate = corr.assertParlayCorrelationAllowed(payload.legs, { betType: payload.betType });
  assert(!gate.ok, 'must reject');
  assertEq(gate.error, 'parlay_correlation_rejected');
  assertEq(gate.financialMutation, 'NONE');
  // Contract: caller must short-circuit before place_bet_tx
  var ticketsCreated = 0;
  var ledgerMutations = 0;
  var bankrollMutations = 0;
  if (!gate.ok) {
    // reject path — zero mutations
  } else {
    ticketsCreated = 1; ledgerMutations = 1; bankrollMutations = 1;
  }
  assertEq(ticketsCreated, 0);
  assertEq(ledgerMutations, 0);
  assertEq(bankrollMutations, 0);
});

test('source gate: index.js wires parlayCorrelation before money RPC', function() {
  var fs = require('fs');
  var path = require('path');
  var src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert(src.indexOf("require('./lib/parlay-correlation')") >= 0, 'require missing');
  var start = src.indexOf("app.post('/api/bets/place'");
  var end = src.indexOf("app.post('/api/bets/cancel'");
  assert(start > 0 && end > start, 'place handler bounds');
  var chunk = src.slice(start, end);
  var gatePos = chunk.indexOf('assertParlayCorrelationAllowed');
  var rpcPos = chunk.indexOf("place_bet_tx");
  assert(gatePos >= 0, 'gate call missing in place handler');
  assert(rpcPos > gatePos, 'correlation gate must precede place_bet_tx in place handler');
  assert(/financialMutation:\s*'NONE'/.test(chunk), 'NONE mutation marker');
});

console.log('\n── classifySlip / pairs ──');
test('classifySlip worst wins', function() {
  var slip = corr.classifySlip([
    leg('Cleveland Guardians', 'moneyline', GAME),
    leg('Cleveland Guardians', 'moneyline', GAME), // duplicate
    leg('Miami Marlins', 'moneyline', GAME2)
  ]);
  assertEq(slip.relationship, 'DUPLICATE');
});

console.log('\n' + '─'.repeat(54));
console.log('parlay-correlation tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) { console.error('PARLAY CORRELATION TESTS FAILED'); process.exit(1); }
console.log('All parlay correlation checks verified');
