'use strict';

/**
 * Confirmation quote — atomic bet finalization commit point.
 * Covers rapid price ticks, policy behavior, expiry, tamper, line identity.
 */

var cq = require('../lib/confirmation-quote');
var policy = require('../lib/odds-change-policy');

var _pass = 0;
var _fail = 0;
var SECRET = 'test-confirmation-quote-secret';

function test(name, fn) {
  try {
    fn();
    _pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    _fail++;
    console.error('  ✗ ' + name + ': ' + (e && e.message));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a));
}

function baseLeg(overrides) {
  return Object.assign({
    pick: 'Lakers',
    market: 'moneyline',
    odds: -110,
    line: null,
    canonicalGameKey: 'basketball_nba|Lakers|Celtics|2026-09-17',
    gameId: 'gid-1',
    scheduledStart: '2026-09-17T23:00:00Z'
  }, overrides || {});
}

function mintFor(legs, opts) {
  opts = opts || {};
  var quoteLegs = (legs || [baseLeg()]).map(function(l, i) {
    return {
      legIndex: i,
      pick: l.pick,
      market: l.market,
      canonicalGameKey: l.canonicalGameKey,
      gameId: l.gameId,
      acceptedOdds: l.odds,
      acceptedPointLine: l.line
    };
  });
  return cq.mintConfirmationQuote({
    secret: SECRET,
    clubId: opts.clubId || 'club-1',
    playerId: opts.playerId || 'player-1',
    stake: opts.stake != null ? opts.stake : 25,
    legs: quoteLegs,
    nowMs: opts.nowMs || 1_700_000_000_000,
    ttlMs: opts.ttlMs
  });
}

cq._resetConsumedForTests();

console.log('\n── mint / verify happy path ──');
test('mint returns token + payload', function() {
  var m = mintFor([baseLeg({ odds: 105 })]);
  assert(m && m.token && m.token.indexOf('.') > 0);
  assertEq(m.payload.legs[0].acceptedOdds, 105);
  assert(m.expiresAt > m.payload.iat);
});

test('verify accepts matching place request', function() {
  var leg = baseLeg({ odds: 105 });
  var m = mintFor([leg]);
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'club-1', playerId: 'player-1', stake: 25,
    legs: [leg], nowMs: m.payload.iat + 1000
  });
  assert(v.ok, v.reason || v.code);
  assert(v.legByIndex[0]);
  assertEq(v.legByIndex[0].acceptedOdds, 105);
});

console.log('\n── reject: expiry / tamper / scope ──');
test('expired quote rejected', function() {
  var leg = baseLeg({ odds: 105 });
  var m = mintFor([leg], { ttlMs: 5000 });
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'club-1', playerId: 'player-1', stake: 25,
    legs: [leg], nowMs: m.payload.exp + 1
  });
  assert(!v.ok);
  assertEq(v.code, 'confirmation_quote_expired');
});

test('tampered signature rejected', function() {
  var leg = baseLeg({ odds: 105 });
  var m = mintFor([leg]);
  var bad = m.token.slice(0, -4) + 'xxxx';
  var v = cq.verifyConfirmationQuote(bad, {
    secret: SECRET, clubId: 'club-1', playerId: 'player-1', stake: 25,
    legs: [leg], nowMs: m.payload.iat + 1000
  });
  assert(!v.ok);
  assertEq(v.code, 'confirmation_quote_invalid');
});

test('club mismatch rejected', function() {
  var leg = baseLeg({ odds: 105 });
  var m = mintFor([leg]);
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'other-club', playerId: 'player-1', stake: 25,
    legs: [leg], nowMs: m.payload.iat + 1000
  });
  assert(!v.ok);
  assertEq(v.reason, 'club_mismatch');
});

test('player mismatch rejected', function() {
  var leg = baseLeg({ odds: 105 });
  var m = mintFor([leg]);
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'club-1', playerId: 'other', stake: 25,
    legs: [leg], nowMs: m.payload.iat + 1000
  });
  assert(!v.ok);
  assertEq(v.reason, 'player_mismatch');
});

test('stake mismatch rejected', function() {
  var leg = baseLeg({ odds: 105 });
  var m = mintFor([leg]);
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'club-1', playerId: 'player-1', stake: 50,
    legs: [leg], nowMs: m.payload.iat + 1000
  });
  assert(!v.ok);
  assertEq(v.reason, 'stake_mismatch');
});

test('submitted odds ≠ quoted odds rejected (arbitrary client odds)', function() {
  var quoted = baseLeg({ odds: 105 });
  var m = mintFor([quoted]);
  var tampered = baseLeg({ odds: 150 }); // client tries better price
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'club-1', playerId: 'player-1', stake: 25,
    legs: [tampered], nowMs: m.payload.iat + 1000
  });
  assert(!v.ok);
  assertEq(v.reason, 'odds_mismatch');
});

test('line mismatch on quoted point market rejected', function() {
  var quoted = baseLeg({
    pick: 'Over 225.5', market: 'total', odds: -110, line: 225.5
  });
  var m = mintFor([quoted]);
  // Keep pick text; only line field drifts (tamper / stale slip)
  var moved = baseLeg({
    pick: 'Over 225.5', market: 'total', odds: -110, line: 226.5
  });
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'club-1', playerId: 'player-1', stake: 25,
    legs: [moved], nowMs: m.payload.iat + 1000
  });
  assert(!v.ok);
  assertEq(v.reason, 'line_mismatch');
});

console.log('\n── single-consumption ──');
test('consumed jti rejected on reuse', function() {
  cq._resetConsumedForTests();
  var leg = baseLeg({ odds: 105 });
  var m = mintFor([leg]);
  cq.consumeConfirmationQuote(m.payload);
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'club-1', playerId: 'player-1', stake: 25,
    legs: [leg], nowMs: m.payload.iat + 1000
  });
  assert(!v.ok);
  assertEq(v.code, 'confirmation_quote_consumed');
  cq._resetConsumedForTests();
});

console.log('\n── resolveQuotedPriceAction / rapid ticks ──');
test('Ask Me: commit quote when provider ticked again (+110→+105→+115)', function() {
  var quoteLeg = { acceptedOdds: 105 };
  // Player accepted +105; provider now +115 (worse than quote from bettor view? +115 better)
  // submitted = quoted 105, server now 100 (worse) → Ask Me would confirm again without quote
  var r = cq.resolveQuotedPriceAction(quoteLeg, 105, 100, 'ask');
  assertEq(r.action, 'commit_quote');
  assertEq(r.acceptedOdds, 105);
});

test('Ask Me rapid sequence commits accepted tick', function() {
  // Simulate: displayed +110, server +105 (confirm), accept 105, server moves to +100
  var ticks = [110, 105, 115, 100, 120];
  var accepted = 105;
  var quoteLeg = { acceptedOdds: accepted };
  for (var i = 2; i < ticks.length; i++) {
    var r = cq.resolveQuotedPriceAction(quoteLeg, accepted, ticks[i], 'ask');
    assertEq(r.action, 'commit_quote', 'tick ' + ticks[i]);
    assertEq(r.acceptedOdds, accepted);
  }
});

test('Accept Better: worse after quote still commits quote', function() {
  var r = cq.resolveQuotedPriceAction({ acceptedOdds: 105 }, 105, 100, 'accept_better');
  assertEq(r.action, 'commit_quote');
  assertEq(r.acceptedOdds, 105);
});

test('Accept Better: better after quote continues at server price', function() {
  var r = cq.resolveQuotedPriceAction({ acceptedOdds: 105 }, 105, 120, 'accept_better');
  assertEq(r.action, 'continue_server');
  assertEq(r.acceptedOdds, 120);
});

test('Accept All: any move continues at server price', function() {
  var worse = cq.resolveQuotedPriceAction({ acceptedOdds: 105 }, 105, 100, 'accept_all');
  assertEq(worse.action, 'continue_server');
  assertEq(worse.acceptedOdds, 100);
  var better = cq.resolveQuotedPriceAction({ acceptedOdds: 105 }, 105, 130, 'accept_all');
  assertEq(better.action, 'continue_server');
  assertEq(better.acceptedOdds, 130);
});

test('no quote → no_quote action', function() {
  assertEq(cq.resolveQuotedPriceAction(null, 105, 100, 'ask').action, 'no_quote');
});

console.log('\n── policy without quote still confirms Ask Me ──');
test('Ask Me without quote still requires confirm on move', function() {
  assertEq(policy.resolveOddsChangeAction('ask', 110, 105).action, 'confirm');
});
test('Accept All without quote continues', function() {
  assertEq(policy.resolveOddsChangeAction('accept_all', 110, 100).action, 'continue');
});
test('Accept Better without quote confirms on worse', function() {
  assertEq(policy.resolveOddsChangeAction('accept_better', 110, 100).action, 'confirm');
});

console.log('\n── parlay multi-leg quote ──');
test('2-leg parlay quote verifies both legs', function() {
  var legs = [
    baseLeg({ pick: 'Lakers', odds: -110, gameId: 'g1' }),
    baseLeg({
      pick: 'Yankees', odds: 120, gameId: 'g2',
      canonicalGameKey: 'baseball_mlb|Yankees|Red Sox|2026-09-17'
    })
  ];
  var m = mintFor(legs);
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'club-1', playerId: 'player-1', stake: 25,
    legs: legs, nowMs: m.payload.iat + 500
  });
  assert(v.ok, v.reason || v.code);
  assert(v.legByIndex[0] && v.legByIndex[1]);
});

test('parlay: one leg odds tamper fails whole quote', function() {
  var legs = [
    baseLeg({ pick: 'Lakers', odds: -110, gameId: 'g1' }),
    baseLeg({
      pick: 'Yankees', odds: 120, gameId: 'g2',
      canonicalGameKey: 'baseball_mlb|Yankees|Red Sox|2026-09-17'
    })
  ];
  var m = mintFor(legs);
  var bad = [legs[0], Object.assign({}, legs[1], { odds: 200 })];
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'club-1', playerId: 'player-1', stake: 25,
    legs: bad, nowMs: m.payload.iat + 500
  });
  assert(!v.ok);
  assertEq(v.reason, 'odds_mismatch');
});

console.log('\n── legsFromConfirmReject / enrich ──');
test('legsFromConfirmReject builds from odds_changed payload', function() {
  var legs = cq.legsFromConfirmReject({
    code: 'odds_changed',
    leg: 'Lakers',
    legIndex: 0,
    serverOdds: 105,
    submittedOdds: 110
  });
  assertEq(legs.length, 1);
  assertEq(legs[0].acceptedOdds, 105);
});

test('enrichLegsFromRequest fills market identity', function() {
  var enriched = cq.enrichLegsFromRequest(
    [{ legIndex: 0, acceptedOdds: 105, pick: 'Lakers' }],
    [baseLeg({ odds: -110 })]
  );
  assertEq(enriched[0].market, 'moneyline');
  assert(enriched[0].canonicalGameKey);
  assertEq(enriched[0].acceptedOdds, 105);
});

console.log('\n── zero mutation contract (pure helpers) ──');
test('helpers never mutate input legs', function() {
  var leg = baseLeg({ odds: 105 });
  var copy = JSON.stringify(leg);
  mintFor([leg]);
  assertEq(JSON.stringify(leg), copy);
});

console.log('\n' + '─'.repeat(54));
console.log('confirmation-quote tests: ' + _pass + ' passed, ' + _fail + ' failed');
if (_fail) process.exit(1);
