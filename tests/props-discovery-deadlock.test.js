/**
 * Props discovery deadlock — backend /api/sports cold-cache contract (source + unit).
 * Run: node tests/props-discovery-deadlock.test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var pf = require('../lib/props-foundation');

var pass = 0;
var fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  OK  ' + name);
    pass++;
  } catch (e) {
    console.log('  FAIL  ' + name + ' — ' + (e && e.message));
    fail++;
  }
}

var indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

console.log('\n-- props discovery deadlock (backend) --\n');

test('/api/sports passes cacheKnown from _PROPS_RESPONSE_CACHE', function() {
  assert(indexSrc.indexOf('cacheKnown: cacheKnown') >= 0 || indexSrc.indexOf('cacheKnown: !!propsCache') >= 0 || indexSrc.indexOf('cacheKnown: cacheKnown') >= 0);
  assert(indexSrc.indexOf('const cacheKnown = !!propsCache') >= 0);
  // Must not coerce hasProps with !! which turns null → false
  assert(indexSrc.indexOf('hasProps:          !!propsCap.hasProps') < 0);
  assert(indexSrc.indexOf('hasProps:          propsCap.hasProps') >= 0);
});

test('scoped props uses resolvePropsForGameScope / unique home-away', function() {
  assert(indexSrc.indexOf('_resolveScopedProps') >= 0);
  assert(indexSrc.indexOf('_lookupPropsGameHintsFromOddsCache') >= 0);
  assert(indexSrc.indexOf('resolvePropsForGameScope') >= 0);
  assert(indexSrc.indexOf('ambiguous_denied') >= 0 || indexSrc.indexOf('filterPropsByTeamsUnique') >= 0);
});

test('cold restart contract via foundation', function() {
  // Empty in-memory cache after process restart
  var cold = pf.sportPropsCapability('nfl', 0, { cacheKnown: false });
  assert.strictEqual(cold.propsStatus, 'unknown');
  assert.strictEqual(cold.hasProps, null);

  // On-demand fetch warms cache
  var warm = pf.sportPropsCapability('nfl', 297, { cacheKnown: true });
  assert.strictEqual(warm.propsStatus, 'available');
  assert.strictEqual(warm.hasProps, true);
});

test('numeric gameId alone fails closed without hints; eventId resolves', function() {
  var props = [{
    gameId: 'nfl:Detroit Lions@Buffalo Bills-20260918',
    home: 'Buffalo Bills', away: 'Detroit Lions',
    playerName: 'Jared Goff', propType: 'Passing Yards', line: 249.5, side: 'over', odds: -110
  }];
  assert.strictEqual(pf.resolvePropsForGameScope(props, { gameId: '1636268302' }).props.length, 0);
  assert.strictEqual(pf.resolvePropsForGameScope(props, {
    gameId: '1636268302',
    hints: { eventId: 'nfl:Detroit Lions@Buffalo Bills-20260918' }
  }).props.length, 1);
  assert.strictEqual(pf.resolvePropsForGameScope(props, {
    gameId: '1636268302',
    home: 'Buffalo Bills',
    away: 'Detroit Lions'
  }).filterMode, 'teams');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
