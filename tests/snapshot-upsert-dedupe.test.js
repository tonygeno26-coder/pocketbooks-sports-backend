'use strict';

/**
 * Snapshot upsert batch dedupe — conflict-target uniqueness before ON CONFLICT.
 * Run: node tests/snapshot-upsert-dedupe.test.js
 * Pure logic — no network / no DB.
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

const fnMatch = indexSource.match(
  /function _dedupeSnapshotUpsertRows\(rows\) \{[\s\S]*?\n\}/
);
assert(fnMatch, '_dedupeSnapshotUpsertRows must exist in index.js');

const sandbox = { Map: Map, Array: Array, String: String };
vm.createContext(sandbox);
vm.runInContext(fnMatch[0], sandbox);
const _dedupeSnapshotUpsertRows = sandbox._dedupeSnapshotUpsertRows;

function row(overrides) {
  return Object.assign({
    canonical_game_key: 'americanfootball_nfl|Chiefs|Bills|2026-09-20',
    market_key: 'moneyline',
    selection_key: 'chiefs',
    odds_american: -110,
    odds_decimal: 1.9091,
    point_line: null,
    fetched_at: '2026-09-14T00:00:00.000Z'
  }, overrides || {});
}

console.log('\n-- Snapshot upsert dedupe wiring --');

test('index wires dedupe before chunked upsert', function() {
  assert(indexSource.includes('_dedupeSnapshotUpsertRows(rows)'),
    'must call _dedupeSnapshotUpsertRows in _upsertSnapshotRowsChunked');
  assert(indexSource.includes('SNAPSHOT_UPSERT_DEDUPED'),
    'must log SNAPSHOT_UPSERT_DEDUPED when drops occur');
  assert(indexSource.includes("onConflict:'canonical_game_key,market_key,selection_key'"),
    'upsert conflict target must match dedupe key');
});

console.log('\n-- Dedupe correctness --');

test('empty / null / undefined inputs stay empty', function() {
  assertEq(_dedupeSnapshotUpsertRows([]).dropped, 0);
  assertEq(_dedupeSnapshotUpsertRows([]).rows.length, 0);
  assertEq(_dedupeSnapshotUpsertRows(null).rows.length, 0);
  assertEq(_dedupeSnapshotUpsertRows(undefined).rows.length, 0);
});

test('unique conflict keys are all kept', function() {
  const input = [
    row({ selection_key: 'chiefs', odds_american: -120 }),
    row({ selection_key: 'bills', odds_american: 100 }),
    row({ market_key: 'spread', selection_key: 'chiefs', odds_american: -110, point_line: -3.5 })
  ];
  const out = _dedupeSnapshotUpsertRows(input);
  assertEq(out.dropped, 0);
  assertEq(out.rows.length, 3);
});

test('duplicate conflict target keeps last write (updated odds)', function() {
  const input = [
    row({ odds_american: -150, fetched_at: '2026-09-14T00:00:01.000Z' }),
    row({ odds_american: -120, fetched_at: '2026-09-14T00:00:02.000Z' }),
    row({ odds_american: -105, fetched_at: '2026-09-14T00:00:03.000Z' })
  ];
  const out = _dedupeSnapshotUpsertRows(input);
  assertEq(out.dropped, 2);
  assertEq(out.rows.length, 1);
  assertEq(out.rows[0].odds_american, -105);
  assertEq(out.rows[0].fetched_at, '2026-09-14T00:00:03.000Z');
});

test('different markets for same game/selection stay distinct', function() {
  const input = [
    row({ market_key: 'moneyline', odds_american: -110 }),
    row({ market_key: 'spread', odds_american: -115, point_line: -2.5 }),
    row({ market_key: 'total', selection_key: 'over', odds_american: -105, point_line: 47.5 }),
    row({ market_key: 'total', selection_key: 'under', odds_american: -115, point_line: 47.5 })
  ];
  const out = _dedupeSnapshotUpsertRows(input);
  assertEq(out.dropped, 0);
  assertEq(out.rows.length, 4);
});

test('different games with same market/selection stay distinct', function() {
  const input = [
    row({ canonical_game_key: 'mlb|a|b|2026-09-14', odds_american: -110 }),
    row({ canonical_game_key: 'mlb|c|d|2026-09-14', odds_american: -120 })
  ];
  const out = _dedupeSnapshotUpsertRows(input);
  assertEq(out.dropped, 0);
  assertEq(out.rows.length, 2);
});

test('nullish rows skipped without counting as drops', function() {
  const input = [null, row({ odds_american: -110 }), undefined, row({ odds_american: -105 })];
  const out = _dedupeSnapshotUpsertRows(input);
  assertEq(out.dropped, 1);
  assertEq(out.rows.length, 1);
  assertEq(out.rows[0].odds_american, -105);
});

console.log('\n-- Concurrent poll / batch uniqueness --');

test('merged concurrent-poll duplicates collapse to unique conflict keys', function() {
  // Simulate two poll sources concatenated into one upsert batch.
  const pollA = [
    row({ market_key: 'moneyline', selection_key: 'chiefs', odds_american: -130 }),
    row({ market_key: 'moneyline', selection_key: 'bills', odds_american: 110 }),
    row({ market_key: 'spread', selection_key: 'chiefs', odds_american: -110, point_line: -3 })
  ];
  const pollB = [
    row({ market_key: 'moneyline', selection_key: 'chiefs', odds_american: -125 }),
    row({ market_key: 'moneyline', selection_key: 'bills', odds_american: 105 }),
    row({ market_key: 'total', selection_key: 'over', odds_american: -108, point_line: 48 })
  ];
  const out = _dedupeSnapshotUpsertRows(pollA.concat(pollB));
  assertEq(out.dropped, 2);
  assertEq(out.rows.length, 4);

  const keys = {};
  for (let i = 0; i < out.rows.length; i++) {
    const r = out.rows[i];
    const k = r.canonical_game_key + '|' + r.market_key + '|' + r.selection_key;
    assert(!keys[k], 'deduped batch must have unique conflict keys: ' + k);
    keys[k] = true;
  }
  const chiefsMl = out.rows.find(function(r) {
    return r.market_key === 'moneyline' && r.selection_key === 'chiefs';
  });
  assertEq(chiefsMl.odds_american, -125, 'last poll write wins for moneyline chiefs');
});

test('large batch with many dups yields unique conflict set (perf + correctness)', function() {
  const n = 5000;
  const input = [];
  for (let i = 0; i < n; i++) {
    input.push(row({
      canonical_game_key: 'nba|home|away|2026-10-' + String((i % 30) + 1).padStart(2, '0'),
      market_key: (i % 3 === 0) ? 'moneyline' : (i % 3 === 1) ? 'spread' : 'total',
      selection_key: (i % 2 === 0) ? 'home' : 'away',
      odds_american: -100 - (i % 50),
      fetched_at: '2026-09-14T00:00:' + String(i % 60).padStart(2, '0') + '.000Z'
    }));
    // Force intentional duplicates every 7th row against an earlier key.
    if (i > 0 && i % 7 === 0) {
      input.push(row({
        canonical_game_key: input[i - 7].canonical_game_key,
        market_key: input[i - 7].market_key,
        selection_key: input[i - 7].selection_key,
        odds_american: -999,
        fetched_at: '2026-09-14T23:59:59.000Z'
      }));
    }
  }
  const t0 = process.hrtime.bigint();
  const out = _dedupeSnapshotUpsertRows(input);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(out.dropped > 0, 'expected intentional duplicates dropped');
  assert(out.rows.length < input.length, 'kept rows must be fewer than input');
  const seen = new Set();
  for (let i = 0; i < out.rows.length; i++) {
    const r = out.rows[i];
    const k = String(r.canonical_game_key) + '\0' + String(r.market_key) + '\0' + String(r.selection_key);
    assert(!seen.has(k), 'duplicate conflict key survived dedupe');
    seen.add(k);
  }
  assertEq(seen.size, out.rows.length);
  assert(ms < 250, 'dedupe of ~' + input.length + ' rows should be <250ms, took ' + ms.toFixed(1) + 'ms');
  console.log('     perf: input=' + input.length + ' kept=' + out.rows.length +
    ' dropped=' + out.dropped + ' ms=' + ms.toFixed(2));
});

console.log('\n-- Results: ' + _pass + ' passed, ' + _fail + ' failed --\n');
if (_fail) process.exit(1);
