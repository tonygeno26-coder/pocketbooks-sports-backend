'use strict';

/**
 * P1 alternate-line identity — LINE is part of wager identity.
 * Simultaneous alternates must never collapse or flex to neighbors.
 * Run: node tests/alternate-line-identity.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
      ' — got ' + JSON.stringify(actual) + ' expected ' + JSON.stringify(expected));
  }
}

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const MARKET_TYPES = Object.freeze({
  MONEYLINE: 'moneyline',
  SPREAD: 'spread',
  TOTAL: 'total',
  PLAYER_PROP: 'player_prop',
  TEAM_TOTAL: 'team_total',
  PERIOD_MONEYLINE: 'period_moneyline',
  PERIOD_SPREAD: 'period_spread',
  PERIOD_TOTAL: 'period_total',
});

function _coerceMarketType(raw) {
  if (!raw) return null;
  const k = String(raw).toLowerCase().trim();
  if (k === 'moneyline' || k === 'h2h' || k === 'to win' || k === 'win') return MARKET_TYPES.MONEYLINE;
  if (k === 'spread' || k === 'spreads' || k === 'run_line' || k === 'runline' || k === 'run line'
   || k === 'puck_line' || k === 'puckline' || k === 'puck line'
   || k === 'alt_spread' || k === 'alternate_spread' || k === 'alternate_spreads') return MARKET_TYPES.SPREAD;
  if (k === 'total' || k === 'totals'
   || k === 'alt_total' || k === 'alternate_total' || k === 'alternate_totals') return MARKET_TYPES.TOTAL;
  if (k === 'player_prop' || k === 'prop') return MARKET_TYPES.PLAYER_PROP;
  if (k === 'team_total' || k === 'team_totals') return MARKET_TYPES.TEAM_TOTAL;
  if (k === 'first_half_moneyline' || k === 'h2h_h1' || k === 'moneyline_h1') return MARKET_TYPES.PERIOD_MONEYLINE;
  if (k === 'first_half_spread' || k === 'spreads_h1' || k === 'spread_h1') return MARKET_TYPES.PERIOD_SPREAD;
  if (k === 'first_half_total' || k === 'totals_h1' || k === 'total_h1') return MARKET_TYPES.PERIOD_TOTAL;
  if (/^(period|quarter|inning|half|h1|h2|q1|q2|q3|q4)_total$/.test(k)) return MARKET_TYPES.PERIOD_TOTAL;
  if (/^(period|quarter|inning|half|h1|h2|q1|q2|q3|q4)_spread$/.test(k)) return MARKET_TYPES.PERIOD_SPREAD;
  if (/^(period|quarter|inning|half|h1|h2|q1|q2|q3|q4)_moneyline$/.test(k)) return MARKET_TYPES.PERIOD_MONEYLINE;
  return null;
}

function _normalizePlayerName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/['’\.]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function _stripToWinSuffix(pick) {
  return String(pick || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+to\s+win\s*$/i, '')
    .replace(/\s+ml\s*$/i, '')
    .trim();
}

// Extract identity helpers from index.js into a sandbox.
const helperNames = [
  '_normalizePointLineValue',
  '_formatPointLineForKey',
  '_pointLinesEqual',
  '_isLineBearingMarketType',
  '_buildLegacySelectionKey',
  '_buildCanonicalSelectionKey',
  '_dedupeSnapshotUpsertRows'
];

const sandbox = {
  MARKET_TYPES: MARKET_TYPES,
  _coerceMarketType: _coerceMarketType,
  _normalizePlayerName: _normalizePlayerName,
  _stripToWinSuffix: _stripToWinSuffix,
  Map: Map,
  Array: Array,
  String: String,
  Number: Number,
  Math: Math,
  parseFloat: parseFloat,
  Object: Object
};
vm.createContext(sandbox);

helperNames.forEach(function(name) {
  const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}');
  const m = indexSource.match(re);
  assert(m, name + ' must exist in index.js');
  vm.runInContext(m[0], sandbox);
});

const {
  _normalizePointLineValue,
  _formatPointLineForKey,
  _pointLinesEqual,
  _isLineBearingMarketType,
  _buildLegacySelectionKey,
  _buildCanonicalSelectionKey,
  _dedupeSnapshotUpsertRows
} = sandbox;

console.log('\n-- Line normalization --');

test('8.5 and 8.50 normalize identically', function() {
  assertEq(_formatPointLineForKey(8.5), '8.5');
  assertEq(_formatPointLineForKey(8.50), '8.5');
  assertEq(_formatPointLineForKey('8.50'), '8.5');
  assert(_pointLinesEqual(8.5, '8.50'));
  assert(!_pointLinesEqual(8.5, 10));
});

test('affected market types are line-bearing', function() {
  ['total', 'spread', 'team_total', 'player_prop', 'period_total', 'period_spread',
   'alt_total', 'alternate_spreads', 'run line', 'first_half_total'].forEach(function(m) {
    assert(_isLineBearingMarketType(m), m + ' must be line-bearing');
  });
  assert(!_isLineBearingMarketType('moneyline'));
  assert(!_isLineBearingMarketType('period_moneyline'));
});

console.log('\n-- Canonical + legacy identity (simultaneous alts) --');

test('TOTAL Over 8.5 / 9 / 9.5 / 10 are distinct canonical + legacy keys', function() {
  const lines = [8.5, 9, 9.5, 10];
  const csks = {};
  const legs = {};
  lines.forEach(function(ln) {
    const csk = _buildCanonicalSelectionKey({ marketType: 'total', side: 'over', line: ln });
    const leg = _buildLegacySelectionKey({ marketType: 'total', overUnder: 'over', line: ln });
    assertEq(csk, 'over:' + _formatPointLineForKey(ln));
    assertEq(leg, 'over:' + _formatPointLineForKey(ln));
    assert(!csks[csk], 'csk collision at ' + csk);
    assert(!legs[leg], 'legacy collision at ' + leg);
    csks[csk] = true;
    legs[leg] = true;
  });
});

test('TOTAL Under alternates stay distinct from Over', function() {
  assertEq(_buildCanonicalSelectionKey({ marketType: 'total', side: 'under', line: 8.5 }), 'under:8.5');
  assert(_buildLegacySelectionKey({ marketType: 'total', overUnder: 'under', line: 8.5 }) !==
    _buildLegacySelectionKey({ marketType: 'total', overUnder: 'over', line: 8.5 }));
});

test('SPREAD A -1.5 / -2.5 and B +1.5 / +2.5 are distinct', function() {
  const keys = [
    _buildCanonicalSelectionKey({ marketType: 'spread', team: 'Guardians', line: -1.5 }),
    _buildCanonicalSelectionKey({ marketType: 'spread', team: 'Guardians', line: -2.5 }),
    _buildCanonicalSelectionKey({ marketType: 'spread', team: 'Athletics', line: 1.5 }),
    _buildCanonicalSelectionKey({ marketType: 'spread', team: 'Athletics', line: 2.5 })
  ];
  assertEq(new Set(keys).size, 4);
  assertEq(keys[0], 'guardians:-1.5');
  const legA = _buildLegacySelectionKey({ marketType: 'spread', teamOrSide: 'guardians', line: -1.5 });
  const legB = _buildLegacySelectionKey({ marketType: 'spread', teamOrSide: 'guardians', line: -2.5 });
  assert(legA !== legB);
});

test('PLAYER PROP Over 5.5 vs 6.5 are separate', function() {
  const a = _buildCanonicalSelectionKey({
    marketType: 'player_prop', player: 'Aaron Judge', side: 'over', line: 5.5
  });
  const b = _buildCanonicalSelectionKey({
    marketType: 'player_prop', player: 'Aaron Judge', side: 'over', line: 6.5
  });
  assertEq(a, 'aaron_judge:over:5.5');
  assertEq(b, 'aaron_judge:over:6.5');
  assert(a !== b);
  const la = _buildLegacySelectionKey({
    marketType: 'player_prop', playerName: 'Aaron Judge', overUnder: 'over', line: 5.5
  });
  const lb = _buildLegacySelectionKey({
    marketType: 'player_prop', playerName: 'Aaron Judge', overUnder: 'over', line: 6.5
  });
  assert(la !== lb);
});

test('TEAM_TOTAL and PERIOD_TOTAL include line', function() {
  assertEq(_buildCanonicalSelectionKey({
    marketType: 'team_total', side: 'over', line: 4.5
  }), 'over:4.5');
  assertEq(_buildCanonicalSelectionKey({
    marketType: 'period_total', side: 'under', line: 3.5
  }), 'under:3.5');
  assertEq(_buildLegacySelectionKey({
    marketType: 'team_total', overUnder: 'over', line: 4.5
  }), 'over:4.5');
});

test('moneyline stays team-only (no invented line)', function() {
  assertEq(_buildCanonicalSelectionKey({
    marketType: 'moneyline', team: 'Guardians'
  }), 'guardians');
  assertEq(_buildLegacySelectionKey({
    marketType: 'moneyline', teamOrSide: 'Guardians'
  }), 'guardians');
});

console.log('\n-- Snapshot upsert coexistence (no last-write-wins across alts) --');

test('simultaneous Over 8.5 and Over 10 both survive dedupe', function() {
  const game = 'baseball_mlb|Athletics|Guardians|2026-09-17';
  const rows = [
    {
      canonical_game_key: game,
      market_key: 'total',
      selection_key: _buildLegacySelectionKey({ marketType: 'total', overUnder: 'over', line: 8.5 }),
      point_line: 8.5,
      odds_american: -108,
      canonical_selection_key: 'over:8.5'
    },
    {
      canonical_game_key: game,
      market_key: 'total',
      selection_key: _buildLegacySelectionKey({ marketType: 'total', overUnder: 'over', line: 10 }),
      point_line: 10,
      odds_american: 167,
      canonical_selection_key: 'over:10'
    },
    {
      canonical_game_key: game,
      market_key: 'total',
      selection_key: _buildLegacySelectionKey({ marketType: 'total', overUnder: 'under', line: 8.5 }),
      point_line: 8.5,
      odds_american: -112,
      canonical_selection_key: 'under:8.5'
    }
  ];
  const out = _dedupeSnapshotUpsertRows(rows);
  assertEq(out.dropped, 0);
  assertEq(out.rows.length, 3);
});

test('same alternate line with updated odds keeps last write only', function() {
  const game = 'baseball_mlb|Athletics|Guardians|2026-09-17';
  const sk = _buildLegacySelectionKey({ marketType: 'total', overUnder: 'over', line: 8.5 });
  const out = _dedupeSnapshotUpsertRows([
    { canonical_game_key: game, market_key: 'total', selection_key: sk, odds_american: -110, point_line: 8.5 },
    { canonical_game_key: game, market_key: 'total', selection_key: sk, odds_american: -108, point_line: 8.5 }
  ]);
  assertEq(out.dropped, 1);
  assertEq(out.rows.length, 1);
  assertEq(out.rows[0].odds_american, -108);
});

test('bare over/under collision (pre-fix shape) would still collapse — regression guard', function() {
  // Documents the historical bug: selection_key without line collapses alts.
  const game = 'baseball_mlb|Athletics|Guardians|2026-09-17';
  const out = _dedupeSnapshotUpsertRows([
    { canonical_game_key: game, market_key: 'total', selection_key: 'over', odds_american: -108, point_line: 8.5 },
    { canonical_game_key: game, market_key: 'total', selection_key: 'over', odds_american: 167, point_line: 10 }
  ]);
  assertEq(out.dropped, 1, 'bare over keys still collide — production must use over:LINE');
  assertEq(out.rows[0].odds_american, 167);
});

console.log('\n-- Source contracts (fail closed / no flex) --');

test('canonical_line_flex is gone; selected_line_unavailable fail-closed present', function() {
  assert(!/matchStrategy\s*=\s*'canonical_line_flex'/.test(indexSource),
    'must not assign canonical_line_flex');
  assert(!/\.like\(\s*'canonical_selection_key'/.test(indexSource),
    'must not LIKE canonical_selection_key');
  assert(/selected_line_unavailable/.test(indexSource),
    'exact miss must return selected_line_unavailable');
  assert(/Selected line is no longer available/.test(indexSource),
    'clean userMessage required');
});

test('Athletics @ Guardians forensics: Over 8.5 must not resolve to Over 10 keys', function() {
  const sel85 = _buildLegacySelectionKey({ marketType: 'total', overUnder: 'over', line: 8.5 });
  const sel10 = _buildLegacySelectionKey({ marketType: 'total', overUnder: 'over', line: 10 });
  assertEq(sel85, 'over:8.5');
  assertEq(sel10, 'over:10');
  assert(sel85 !== sel10);
  const csk85 = _buildCanonicalSelectionKey({ marketType: 'total', side: 'over', line: 8.5 });
  const csk10 = _buildCanonicalSelectionKey({ marketType: 'total', side: 'over', line: 10 });
  assert(csk85 !== csk10);
});

test('active-bet-conflict treats distinct total lines as non-duplicates', function() {
  const {
    isExactActiveBetDuplicate
  } = require('../lib/active-bet-conflict');
  const GAME = 'baseball_mlb|Athletics|Guardians|2026-09-17';
  const a = {
    canonicalGameKey: GAME, market: 'total', pick: 'Over 8.5',
    canonicalSelectionKey: 'over:8.5', line: 8.5, acceptedPointLine: 8.5
  };
  const b = {
    canonicalGameKey: GAME, market: 'total', pick: 'Over 10',
    canonicalSelectionKey: 'over:10', line: 10, acceptedPointLine: 10
  };
  assert(!isExactActiveBetDuplicate(a, b));
  assert(isExactActiveBetDuplicate(a, Object.assign({}, a)));
});

test('8.50 vs 8.5 duplicate tokens match', function() {
  const { activeBetDuplicateToken } = require('../lib/active-bet-conflict');
  const GAME = 'baseball_mlb|Athletics|Guardians|2026-09-17';
  const a = activeBetDuplicateToken({
    canonicalGameKey: GAME, market: 'total', pick: 'Over 8.5',
    canonicalSelectionKey: 'over:8.5', line: 8.5
  });
  const b = activeBetDuplicateToken({
    canonicalGameKey: GAME, market: 'total', pick: 'Over 8.50',
    canonicalSelectionKey: 'over:8.5', line: 8.50
  });
  assertEq(a, b);
});

console.log('\nAlternate line identity: ' + _pass + ' passed, ' + _fail + ' failed');
if (_fail > 0) process.exit(1);
