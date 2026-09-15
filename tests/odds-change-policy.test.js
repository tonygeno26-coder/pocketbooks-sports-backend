'use strict';

var policy = require('../lib/odds-change-policy');
var _pass = 0;
var _fail = 0;

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

console.log('\n── normalizeOddsChangePolicy ──');
test('default / empty → ask', function() {
  assertEq(policy.normalizeOddsChangePolicy(null), 'ask');
  assertEq(policy.normalizeOddsChangePolicy(''), 'ask');
  assertEq(policy.normalizeOddsChangePolicy('bogus'), 'ask');
});
test('legacy reject → ask', function() {
  assertEq(policy.normalizeOddsChangePolicy('reject'), 'ask');
});
test('accept_any_with_confirm → accept_all', function() {
  assertEq(policy.normalizeOddsChangePolicy('accept_any_with_confirm'), 'accept_all');
});
test('canonical names preserved', function() {
  assertEq(policy.normalizeOddsChangePolicy('ask'), 'ask');
  assertEq(policy.normalizeOddsChangePolicy('accept_better'), 'accept_better');
  assertEq(policy.normalizeOddsChangePolicy('accept_all'), 'accept_all');
});

console.log('\n── compareAmericanOddsForBettor ──');
test('+120 → +130 = better', function() {
  assertEq(policy.compareAmericanOddsForBettor(120, 130), 'better');
});
test('+120 → +110 = worse', function() {
  assertEq(policy.compareAmericanOddsForBettor(120, 110), 'worse');
});
test('-120 → -110 = better', function() {
  assertEq(policy.compareAmericanOddsForBettor(-120, -110), 'better');
});
test('-120 → -130 = worse', function() {
  assertEq(policy.compareAmericanOddsForBettor(-120, -130), 'worse');
});
test('+105 → -105 = worse', function() {
  assertEq(policy.compareAmericanOddsForBettor(105, -105), 'worse');
});
test('-105 → +105 = better', function() {
  assertEq(policy.compareAmericanOddsForBettor(-105, 105), 'better');
});
test('same odds', function() {
  assertEq(policy.compareAmericanOddsForBettor(-110, -110), 'same');
  assertEq(policy.compareAmericanOddsForBettor(150, 150), 'same');
});
test('invalid zero / NaN', function() {
  assertEq(policy.compareAmericanOddsForBettor(0, -110), 'invalid');
  assertEq(policy.compareAmericanOddsForBettor(-110, 0), 'invalid');
  assertEq(policy.compareAmericanOddsForBettor(null, -110), 'invalid');
});

console.log('\n── resolveOddsChangeAction ──');
test('ask: any move → confirm', function() {
  assertEq(policy.resolveOddsChangeAction('ask', 120, 115).action, 'confirm');
  assertEq(policy.resolveOddsChangeAction('ask', 120, 130).action, 'confirm');
  assertEq(policy.resolveOddsChangeAction('reject', 120, 130).action, 'confirm');
});
test('ask: same → continue', function() {
  assertEq(policy.resolveOddsChangeAction('ask', -110, -110).action, 'continue');
});
test('accept_better: better → continue', function() {
  var r = policy.resolveOddsChangeAction('accept_better', 120, 130);
  assertEq(r.action, 'continue');
  assertEq(r.comparison, 'better');
});
test('accept_better: worse → confirm', function() {
  var r = policy.resolveOddsChangeAction('accept_better', 120, 110);
  assertEq(r.action, 'confirm');
  assertEq(r.comparison, 'worse');
});
test('accept_better: negative better/worse', function() {
  assertEq(policy.resolveOddsChangeAction('accept_better', -120, -110).action, 'continue');
  assertEq(policy.resolveOddsChangeAction('accept_better', -120, -130).action, 'confirm');
});
test('accept_all: worse → continue', function() {
  assertEq(policy.resolveOddsChangeAction('accept_all', 120, 110).action, 'continue');
});
test('accept_all: better → continue', function() {
  assertEq(policy.resolveOddsChangeAction('accept_any_with_confirm', 120, 130).action, 'continue');
});
test('sign crossing under accept_better', function() {
  assertEq(policy.resolveOddsChangeAction('accept_better', 105, -105).action, 'confirm');
  assertEq(policy.resolveOddsChangeAction('accept_better', -105, 105).action, 'continue');
});

console.log('\n── payload builders ──');
test('odds_changed payload requires confirmation', function() {
  var p = policy.buildOddsChangedPayload({
    leg: 'Lakers', submittedOdds: 120, serverOdds: 115, comparison: 'worse', policy: 'ask'
  });
  assertEq(p.code, 'odds_changed');
  assert(p.requiresConfirmation);
  assertEq(p.submittedOdds, 120);
  assertEq(p.serverOdds, 115);
});
test('line_changed payload always confirms', function() {
  var p = policy.buildLineChangedPayload({
    leg: 'Over 13.5', submittedPointLine: 13.5, serverPointLine: 14.5,
    submittedOdds: -110, serverOdds: -110
  });
  assertEq(p.code, 'line_changed');
  assert(p.requiresConfirmation);
  assertEq(p.submittedPointLine, 13.5);
  assertEq(p.serverPointLine, 14.5);
});

console.log('\n' + '─'.repeat(54));
console.log('odds-change-policy tests: ' + _pass + ' passed, ' + _fail + ' failed');
if (_fail) process.exit(1);
