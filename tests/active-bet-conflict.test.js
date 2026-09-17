'use strict';

/**
 * Exact-duplicate active-bet conflict identity tests.
 * Run: node tests/active-bet-conflict.test.js
 */

const assert = require('assert');
const {
  activeBetDuplicateToken,
  isExactActiveBetDuplicate
} = require('../lib/active-bet-conflict');

let _pass = 0, _fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅ ' + name); _pass++; }
  catch (e) { console.error('  ❌ ' + name + '\n     ' + e.message); _fail++; }
}

const GAME = 'baseball_mlb|Kansas City Royals|Houston Astros|2026-09-17';

function ml(pick, side) {
  return {
    canonicalGameKey: GAME,
    market: 'moneyline',
    pick: pick,
    side: side || null,
    canonicalSelectionKey: String(pick).toLowerCase().replace(/\s+/g, '_'),
    line: null
  };
}

function spread(pick, side, line) {
  return {
    canonicalGameKey: GAME,
    market: 'spread',
    pick: pick,
    side: side,
    line: line,
    acceptedPointLine: line,
    canonicalSelectionKey: String(pick).toLowerCase().replace(/\s+/g, '_')
  };
}

function total(pick, side, line) {
  return {
    canonicalGameKey: GAME,
    market: 'total',
    pick: pick,
    side: side,
    line: line,
    accepted_point_line: line,
    canonical_selection_key: side
  };
}

console.log('\n── Exact duplicate tokens ──');

test('exact same Royals ML tokens match', function() {
  var a = ml('Kansas City Royals', 'away');
  var b = {
    canonical_game_key: GAME,
    market: 'Moneyline',
    pick: 'Kansas City Royals',
    side: 'away',
    canonical_selection_key: 'kansas_city_royals',
    line: null
  };
  assert.strictEqual(isExactActiveBetDuplicate(a, b), true);
});

test('Royals ML vs Astros ML do NOT conflict (opposite side)', function() {
  assert.strictEqual(
    isExactActiveBetDuplicate(ml('Kansas City Royals', 'away'), ml('Houston Astros', 'home')),
    false
  );
});

test('Royals ML vs Royals run line do NOT conflict (distinct market)', function() {
  assert.strictEqual(
    isExactActiveBetDuplicate(ml('Kansas City Royals', 'away'), spread('Kansas City Royals +1.5', 'away', 1.5)),
    false
  );
});

test('Royals ML vs game total do NOT conflict', function() {
  assert.strictEqual(
    isExactActiveBetDuplicate(ml('Kansas City Royals', 'away'), total('Over 8.5', 'over', 8.5)),
    false
  );
});

test('same total side+line conflicts; different line does not', function() {
  var over85 = total('Over 8.5', 'over', 8.5);
  var over85b = total('Over 8.5', 'over', 8.5);
  var over9 = total('Over 9', 'over', 9);
  assert.strictEqual(isExactActiveBetDuplicate(over85, over85b), true);
  assert.strictEqual(isExactActiveBetDuplicate(over85, over9), false);
});

test('same spread opposite team different selection does not conflict', function() {
  assert.strictEqual(
    isExactActiveBetDuplicate(
      spread('Kansas City Royals +1.5', 'away', 1.5),
      spread('Houston Astros -1.5', 'home', -1.5)
    ),
    false
  );
});

test('different event does not conflict', function() {
  var other = Object.assign(ml('Kansas City Royals', 'away'), {
    canonicalGameKey: 'baseball_mlb|New York Yankees|Boston Red Sox|2026-09-17'
  });
  assert.strictEqual(isExactActiveBetDuplicate(ml('Kansas City Royals', 'away'), other), false);
});

test('incomplete identity returns null token (no false conflict)', function() {
  assert.strictEqual(activeBetDuplicateToken({ canonicalGameKey: GAME, market: 'moneyline' }), null);
  assert.strictEqual(
    isExactActiveBetDuplicate(ml('Kansas City Royals', 'away'), { canonical_game_key: GAME, market: 'moneyline' }),
    false
  );
});

test('index.js conflict gate uses exact-duplicate helper (source contract)', function() {
  var fs = require('fs');
  var path = require('path');
  var src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert(src.includes("require('./lib/active-bet-conflict')"), 'must require active-bet-conflict');
  assert(src.includes('isExactActiveBetDuplicate'), 'must call isExactActiveBetDuplicate');
  assert(src.includes("userMessage:'You already have this wager active.'"), 'clean userMessage');
  assert(!/conflict_active_bet:'\+legsArr/.test(src), 'must not append raw game fingerprint to error');
});

console.log('\n── Results: ' + _pass + ' passed, ' + _fail + ' failed ──');
process.exit(_fail ? 1 : 0);
