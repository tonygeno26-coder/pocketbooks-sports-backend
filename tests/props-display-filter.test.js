'use strict';

// NFL + MLB props display line filter.
// Run: node tests/props-display-filter.test.js

const fs = require('fs');
const path = require('path');
const INDEX_JS = path.join(__dirname, '..', 'index.js');

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

function extractFn(source, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('missing ' + name);
  let brace = source.indexOf('{', m.index);
  let depth = 0;
  for (let j = brace; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) return source.slice(m.index, j + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const src = fs.readFileSync(INDEX_JS, 'utf8');
const start = src.indexOf('const _PROPS_ALLOWED_LINES_BY_CATEGORY');
const end = src.indexOf('function _americanToImpliedPct');
if (start < 0 || end < 0) throw new Error('could not locate props filter consts');
const block = src.slice(start, end);
const code = block + '\n'
  + extractFn(src, '_propLineCategory') + '\n'
  + extractFn(src, '_isHalfPointLine') + '\n'
  + extractFn(src, '_isAllowedPropLine') + '\n'
  + extractFn(src, '_normalizePropsSportParam').replace(
    '_mapToOwlsSport',
    '(function(k){ return ({nfl:"nfl",americanfootball_nfl:"nfl",mlb:"mlb"})[k]||null; })'
  ) + '\n'
  + 'module.exports = { _isAllowedPropLine, _propLineCategory, _normalizePropsSportParam };\n';

const tmp = path.join('/tmp', 'pb-props-display-filter.test.mod.js');
fs.writeFileSync(tmp, code);
const mod = require(tmp);

console.log('\nprops-display-filter');

test('NFL passing yards allowed in range', function() {
  assertEq(mod._isAllowedPropLine('Passing Yards', 225.5), true);
});
test('NFL passing yards out of range rejected', function() {
  assertEq(mod._isAllowedPropLine('Passing Yards', 600.5), false);
});
test('NFL receptions / TDs / sacks / INTs allowed', function() {
  assertEq(mod._isAllowedPropLine('Receptions', 4.5), true);
  assertEq(mod._isAllowedPropLine('Passing TDs', 1.5), true);
  assertEq(mod._isAllowedPropLine('Sacks', 1.5), true);
  assertEq(mod._isAllowedPropLine('Interceptions Thrown', 0.5), true);
  assertEq(mod._isAllowedPropLine('Pass Completions', 22.5), true);
  assertEq(mod._isAllowedPropLine('Pass Attempts', 34.5), true);
});
test('MLB Hits still whitelisted', function() {
  assertEq(mod._isAllowedPropLine('Hits', 0.5), true);
  assertEq(mod._isAllowedPropLine('Hits', 3.5), false);
});
test('unknown categories not wiped', function() {
  assertEq(mod._isAllowedPropLine('Some Future Prop', 12.5), true);
});
test('americanfootball_nfl normalizes to nfl', function() {
  assertEq(mod._normalizePropsSportParam('americanfootball_nfl'), 'nfl');
  assertEq(mod._normalizePropsSportParam('NFL'), 'nfl');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
