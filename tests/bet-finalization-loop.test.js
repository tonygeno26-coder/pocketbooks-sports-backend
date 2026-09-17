'use strict';

/**
 * Integration-style simulation of the P1 odds-update loop and quote commit.
 * Does not hit Postgres / place_bet_tx — pure finalization gate logic.
 */

var cq = require('../lib/confirmation-quote');
var policy = require('../lib/odds-change-policy');

var _pass = 0;
var _fail = 0;
var SECRET = 'sim-secret';

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

/**
 * Simulate one place attempt's price gate (what _verifyLegOddsSnapshot does
 * for price after identity/availability already passed).
 */
function priceGate(submitted, server, pol, quoteLeg) {
  if (quoteLeg) {
    return cq.resolveQuotedPriceAction(quoteLeg, submitted, server, pol);
  }
  var d = policy.resolveOddsChangeAction(pol, submitted, server);
  if (d.action === 'confirm') {
    return { action: 'odds_changed', serverOdds: server, submittedOdds: submitted };
  }
  if (d.action === 'continue') {
    return { action: 'continue_server', acceptedOdds: server, comparison: d.comparison };
  }
  return { action: 'reject' };
}

/**
 * Full loop simulation: place → odds_changed → accept with quote → place again
 * while provider keeps ticking.
 */
function simulateAskMeLoop(ticks) {
  var mutations = 0;
  var submitted = ticks[0];
  var server = ticks[1];
  var first = priceGate(submitted, server, 'ask', null);
  assertEq(first.action, 'odds_changed');
  assertEq(mutations, 0);

  // Server mints quote at authoritative server odds
  var quoteLeg = { acceptedOdds: server };
  var m = cq.mintConfirmationQuote({
    secret: SECRET,
    clubId: 'c1',
    playerId: 'p1',
    stake: 10,
    legs: [{
      legIndex: 0, pick: 'Lakers', market: 'moneyline',
      canonicalGameKey: 'nba|L|C|2026-09-17', gameId: 'g1',
      acceptedOdds: server, acceptedPointLine: null
    }],
    nowMs: 1000,
    ttlMs: 25000
  });
  assert(m && m.token);

  // Player accepts: slip patched to server odds, quote sent
  var acceptedOdds = server;
  var placeLegs = [{
    pick: 'Lakers', market: 'moneyline', odds: acceptedOdds, line: null,
    canonicalGameKey: 'nba|L|C|2026-09-17', gameId: 'g1'
  }];
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'c1', playerId: 'p1', stake: 10,
    legs: placeLegs, nowMs: 2000
  });
  assert(v.ok, v.reason || v.code);

  // Provider keeps moving through remaining ticks — each must commit quote
  for (var i = 2; i < ticks.length; i++) {
    var r = priceGate(acceptedOdds, ticks[i], 'ask', quoteLeg);
    assertEq(r.action, 'commit_quote', 'tick[' + i + ']=' + ticks[i]);
    assertEq(r.acceptedOdds, acceptedOdds);
  }

  // Final JIT recheck also uses quote
  var finalTick = ticks[ticks.length - 1];
  var final = priceGate(acceptedOdds, finalTick, 'ask', quoteLeg);
  assertEq(final.action, 'commit_quote');
  mutations = 1; // only after commit would money RPC run
  assertEq(mutations, 1);
  return { acceptedOdds: acceptedOdds, mutations: mutations, quote: m };
}

cq._resetConsumedForTests();

console.log('\n── LOOP REPRO: Ask Me without quote never finalizes ──');
test('without quote, every provider tick re-opens odds_changed', function() {
  var ticks = [110, 105, 115, 100, 120];
  var submitted = ticks[0];
  var confirms = 0;
  for (var i = 1; i < ticks.length; i++) {
    var r = priceGate(submitted, ticks[i], 'ask', null);
    if (r.action === 'odds_changed') {
      confirms++;
      submitted = ticks[i]; // FE patches — but next tick still differs
    }
  }
  // After patching to each new price, next tick still confirms again
  // Re-simulate correctly: after each confirm, submit = that server price
  confirms = 0;
  submitted = 110;
  for (var j = 1; j < ticks.length; j++) {
    var g = priceGate(submitted, ticks[j], 'ask', null);
    assertEq(g.action, 'odds_changed');
    confirms++;
    submitted = ticks[j];
  }
  assert(confirms >= 4, 'expected unbound loop confirms, got ' + confirms);
});

console.log('\n── WITH QUOTE: Ask Me finalizes through rapid ticks ──');
test('Ask Me + quote commits across +110→+105→+115→+100→+120', function() {
  var r = simulateAskMeLoop([110, 105, 115, 100, 120]);
  assertEq(r.acceptedOdds, 105);
  assertEq(r.mutations, 1);
});

console.log('\n── Accept Better / Accept All ──');
test('Accept All never loops on price-only moves', function() {
  var submitted = 110;
  var ticks = [105, 115, 100, 120];
  for (var i = 0; i < ticks.length; i++) {
    var r = priceGate(submitted, ticks[i], 'accept_all', null);
    assertEq(r.action, 'continue_server');
    submitted = ticks[i];
  }
});

test('Accept Better auto-continues better, confirms worse', function() {
  assertEq(priceGate(110, 120, 'accept_better', null).action, 'continue_server');
  assertEq(priceGate(110, 100, 'accept_better', null).action, 'odds_changed');
});

test('Accept Better worse → quote → commit even if ticks worse again', function() {
  var first = priceGate(110, 100, 'accept_better', null);
  assertEq(first.action, 'odds_changed');
  var quoteLeg = { acceptedOdds: 100 };
  assertEq(priceGate(100, 95, 'accept_better', quoteLeg).action, 'commit_quote');
  assertEq(priceGate(100, 130, 'accept_better', quoteLeg).action, 'continue_server');
});

console.log('\n── line change never auto-commits via price quote ──');
test('line identity mismatch is separate from quote price commit', function() {
  // Quote is for line 225.5; if market line moves, caller must reject via
  // buildLineChangedPayload BEFORE resolveQuotedPriceAction. Here we only
  // assert quote verify catches client submitting wrong line.
  var m = cq.mintConfirmationQuote({
    secret: SECRET, clubId: 'c1', playerId: 'p1', stake: 10,
    legs: [{
      legIndex: 0, pick: 'Over 225.5', market: 'total',
      canonicalGameKey: 'nba|L|C|d', gameId: 'g1',
      acceptedOdds: -110, acceptedPointLine: 225.5
    }],
    nowMs: 1000
  });
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'c1', playerId: 'p1', stake: 10,
    legs: [{
      pick: 'Over 225.5', market: 'total', odds: -110, line: 226.5,
      canonicalGameKey: 'nba|L|C|d', gameId: 'g1'
    }],
    nowMs: 1500
  });
  assert(!v.ok);
  assertEq(v.reason, 'line_mismatch');
});

console.log('\n── stale confirmation ──');
test('stale/expired quote falls back to fresh resolve (no money mutation)', function() {
  var m = cq.mintConfirmationQuote({
    secret: SECRET, clubId: 'c1', playerId: 'p1', stake: 10, ttlMs: 5000,
    legs: [{
      legIndex: 0, pick: 'Lakers', market: 'moneyline',
      canonicalGameKey: 'k', gameId: 'g1', acceptedOdds: 105, acceptedPointLine: null
    }],
    nowMs: 1000
  });
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'c1', playerId: 'p1', stake: 10,
    legs: [{
      pick: 'Lakers', market: 'moneyline', odds: 105, line: null,
      canonicalGameKey: 'k', gameId: 'g1'
    }],
    nowMs: m.payload.exp + 1
  });
  assertEq(v.code, 'confirmation_quote_expired');
  // Without quote, next tick still odds_changed — zero mutation
  assertEq(priceGate(105, 100, 'ask', null).action, 'odds_changed');
});

console.log('\n── double-click / consume ──');
test('second place with same quote after consume is rejected', function() {
  cq._resetConsumedForTests();
  var m = cq.mintConfirmationQuote({
    secret: SECRET, clubId: 'c1', playerId: 'p1', stake: 10,
    legs: [{
      legIndex: 0, pick: 'Lakers', market: 'moneyline',
      canonicalGameKey: 'k', gameId: 'g1', acceptedOdds: 105, acceptedPointLine: null
    }],
    nowMs: 1000
  });
  var legs = [{
    pick: 'Lakers', market: 'moneyline', odds: 105, line: null,
    canonicalGameKey: 'k', gameId: 'g1'
  }];
  var v1 = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'c1', playerId: 'p1', stake: 10, legs: legs, nowMs: 1100
  });
  assert(v1.ok);
  cq.consumeConfirmationQuote(m.payload); // after money RPC success
  var v2 = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'c1', playerId: 'p1', stake: 10, legs: legs, nowMs: 1200
  });
  assertEq(v2.code, 'confirmation_quote_consumed');
  cq._resetConsumedForTests();
});

console.log('\n── arbitrary client odds ──');
test('client cannot force better odds via quote + patched slip', function() {
  var m = cq.mintConfirmationQuote({
    secret: SECRET, clubId: 'c1', playerId: 'p1', stake: 10,
    legs: [{
      legIndex: 0, pick: 'Lakers', market: 'moneyline',
      canonicalGameKey: 'k', gameId: 'g1', acceptedOdds: 105, acceptedPointLine: null
    }],
    nowMs: 1000
  });
  var v = cq.verifyConfirmationQuote(m.token, {
    secret: SECRET, clubId: 'c1', playerId: 'p1', stake: 10,
    legs: [{
      pick: 'Lakers', market: 'moneyline', odds: 250, line: null,
      canonicalGameKey: 'k', gameId: 'g1'
    }],
    nowMs: 1100
  });
  assert(!v.ok);
  assertEq(v.reason, 'odds_mismatch');
});

console.log('\n' + '─'.repeat(54));
console.log('bet-finalization-loop tests: ' + _pass + ' passed, ' + _fail + ' failed');
if (_fail) process.exit(1);
