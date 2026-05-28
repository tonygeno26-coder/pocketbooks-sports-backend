'use strict';

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

function toAmericanOdds(price) {
  if (typeof price !== 'number') return price;
  if (Math.abs(price) <= 30 && price > 0) {
    if (price >= 2) return Math.round((price - 1) * 100);
    return Math.round(-100 / (price - 1));
  }
  return price;
}

function americanToDecimalOdds(americanOdds) {
  const n = Number(americanOdds);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0
    ? Math.round((n / 100 + 1) * 10000) / 10000
    : Math.round((100 / Math.abs(n) + 1) * 10000) / 10000;
}

function buildSnapshotRow(entry, outcome) {
  const isOwlsShape = !outcome;
  const rawOdds = isOwlsShape ? entry.odds : outcome.price;
  const rawOddsNum = Number(rawOdds);

  if (!Number.isFinite(rawOddsNum)) return null;

  const oddsAmerican = Math.round(toAmericanOdds(rawOddsNum));
  if (!Number.isFinite(oddsAmerican) || oddsAmerican === 0) return null;

  const oddsDecimal = americanToDecimalOdds(oddsAmerican);
  if (!Number.isFinite(oddsDecimal) || oddsDecimal <= 1) return null;

  return {
    odds_american: oddsAmerican,
    odds_decimal: oddsDecimal,
    point_line: isOwlsShape ? (entry.line != null ? entry.line : null)
                            : (outcome.point != null ? outcome.point : null)
  };
}

function entry(overrides) {
  return Object.assign({
    cKey:'MLB|reds|guardians|2026-05-27',
    market:'moneyline',
    gameId:'G1',
    bookmaker:'testbook'
  }, overrides || {});
}

function outcome(price) {
  return { name:'Guardians', price:price };
}

console.log('\n-- Snapshot row odds validation --');

test('null American odds skipped', function() {
  assertEq(buildSnapshotRow(entry(), outcome(null)), null);
});

test('zero American odds skipped', function() {
  assertEq(buildSnapshotRow(entry(), outcome(0)), null);
});

test('NaN odds skipped', function() {
  assertEq(buildSnapshotRow(entry(), outcome(NaN)), null);
});

test('non-finite odds skipped', function() {
  assertEq(buildSnapshotRow(entry(), outcome(Infinity)), null);
});

test('valid positive American odds written', function() {
  const row = buildSnapshotRow(entry(), outcome(150));
  assert(row, 'row expected');
  assertEq(row.odds_american, 150);
  assertEq(row.odds_decimal, 2.5);
});

test('valid negative American odds written', function() {
  const row = buildSnapshotRow(entry(), outcome(-110));
  assert(row, 'row expected');
  assertEq(row.odds_american, -110);
  assertEq(row.odds_decimal, 1.9091);
});

test('decimal odds converted to American and decimal recomputed', function() {
  const row = buildSnapshotRow(entry(), outcome(1.9091));
  assert(row, 'row expected');
  assertEq(row.odds_american, -110);
  assertEq(row.odds_decimal, 1.9091);
});

test('Owls flat entry validates odds and preserves point line', function() {
  const row = buildSnapshotRow(entry({ odds:2.3, line:7.5 }), null);
  assert(row, 'row expected');
  assertEq(row.odds_american, 130);
  assertEq(row.odds_decimal, 2.3);
  assertEq(row.point_line, 7.5);
});

console.log('\nSnapshot row odds validation tests: ' + _pass + ' passed, ' + _fail + ' failed');
if (_fail > 0) process.exit(1);
