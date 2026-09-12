'use strict';

// NFL + MLB props display line filter (via props-foundation).
// Run: node tests/props-display-filter.test.js

const path = require('path');
const pf = require(path.join(__dirname, '..', 'lib', 'props-foundation'));

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  OK  ' + name);
    pass++;
  } catch (e) {
    console.error('  FAIL ' + name + '\n     ' + e.message);
    fail++;
  }
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'assertEq') + ': got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));
}

function _normalizePropsSportParam(sport) {
  var s = String(sport || '').toLowerCase();
  var map = { nfl: 'nfl', americanfootball_nfl: 'nfl', mlb: 'mlb', nba: 'nba' };
  return map[s] || s;
}

console.log('\nprops-display-filter');

test('NFL passing yards allowed in range', function() {
  assertEq(pf.isAllowedPropLine('Passing Yards', 225.5), true);
});
test('NFL passing yards out of range rejected', function() {
  assertEq(pf.isAllowedPropLine('Passing Yards', 600.5), false);
});
test('NFL receptions / TDs / sacks / INTs allowed', function() {
  assertEq(pf.isAllowedPropLine('Receptions', 4.5), true);
  assertEq(pf.isAllowedPropLine('Passing TDs', 1.5), true);
  assertEq(pf.isAllowedPropLine('Sacks', 1.5), true);
  assertEq(pf.isAllowedPropLine('Interceptions Thrown', 0.5), true);
  assertEq(pf.isAllowedPropLine('Pass Completions', 22.5), true);
  assertEq(pf.isAllowedPropLine('Pass Attempts', 34.5), true);
});
test('MLB Hits still whitelisted', function() {
  assertEq(pf.isAllowedPropLine('Hits', 0.5), true);
  assertEq(pf.isAllowedPropLine('Hits', 3.5), true);
});
test('MLB Home Runs expanded safely', function() {
  assertEq(pf.isAllowedPropLine('Home Runs', 0.5), true);
  assertEq(pf.isAllowedPropLine('Home Runs', 1.5), true);
});
test('unknown categories not wiped', function() {
  assertEq(pf.isAllowedPropLine('Some Future Prop', 12.5), true);
});
test('americanfootball_nfl normalizes to nfl', function() {
  assertEq(_normalizePropsSportParam('americanfootball_nfl'), 'nfl');
  assertEq(_normalizePropsSportParam('NFL'), 'nfl');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
