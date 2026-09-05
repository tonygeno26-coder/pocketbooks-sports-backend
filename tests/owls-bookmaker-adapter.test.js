'use strict';

/**
 * Owls Bookmaker v2 adapter — Golf / Rugby only.
 * Run: node tests/owls-bookmaker-adapter.test.js
 * Pure logic — no network.
 */

const adapter = require('../lib/owls-bookmaker-adapter');

let _pass = 0, _fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅ ' + name); _pass++; }
  catch (e) { console.error('  ❌ ' + name + '\n     ' + e.message); _fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'Expected true'); }
function assertEq(a, b, m) {
  if (a !== b) throw new Error((m || '') + ' — got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));
}

console.log('\n── Bookmaker sport routing ──');
test('golf and rugby are bookmaker v2 sports', function() {
  assert(adapter.isBookmakerV2Sport('golf'));
  assert(adapter.isBookmakerV2Sport('rugby'));
  assert(adapter.isBookmakerV2Sport('GOLF'));
});
test('nfl/mlb are NOT bookmaker v2 sports', function() {
  assert(!adapter.isBookmakerV2Sport('nfl'));
  assert(!adapter.isBookmakerV2Sport('mlb'));
  assert(!adapter.isBookmakerV2Sport('nba'));
  assert(!adapter.isBookmakerV2Sport('soccer'));
});

console.log('\n── Price / line parsing ──');
test('parses American moneylines', function() {
  assertEq(adapter.parseBookmakerAmericanPrice('+111'), 111);
  assertEq(adapter.parseBookmakerAmericanPrice('-148'), -148);
  assertEq(adapter.parseBookmakerAmericanPrice('EVEN'), -110);
  assertEq(adapter.parseBookmakerAmericanPrice('-'), null);
  assertEq(adapter.parseBookmakerAmericanPrice(''), null);
});
test('parses half-fraction lines', function() {
  assertEq(adapter.parseBookmakerLine('+1½'), 1.5);
  assertEq(adapter.parseBookmakerLine('-17½'), -17.5);
  assertEq(adapter.parseBookmakerLine('56½'), 56.5);
  assertEq(adapter.parseBookmakerLine('-'), null);
  assertEq(adapter.parseBookmakerLine('PK'), 0);
});

console.log('\n── Start time parsing ──');
test('parses Bookmaker PT wall times to ISO', function() {
  // Fixed "now" near Sept 2026 so year inference is stable.
  var now = Date.parse('2026-09-05T16:00:00.000Z');
  var iso = adapter.parseBookmakerStartTime('9/06 12:20am PT', now);
  assert(!!iso, 'expected ISO string');
  assert(/^\d{4}-\d{2}-\d{2}T/.test(iso), 'ISO shape');
  // 12:20am PT on Sep 6 ≈ 07:20Z (PDT) or 08:20Z (PST). PDT in September.
  var ms = Date.parse(iso);
  assert(!isNaN(ms), 'parseable');
  var la = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: true
  }).format(new Date(ms));
  assert(/9\/6\/2026/.test(la) || /9\/06\/2026/.test(la), 'LA date ' + la);
});

console.log('\n── League key extraction ──');
test('extracts leagueKey from leagues payload', function() {
  var keys = adapter.extractLeagueKeys({
    leagues: [
      { leagueKey: 'ru-france-top-14', leagueName: 'ru-france-top-14', marketCount: 70 },
      { leagueKey: 'euro-omega-european-masters-matchups', marketCount: 7 }
    ]
  });
  assertEq(keys.length, 2);
  assertEq(keys[0].leagueKey, 'ru-france-top-14');
  assertEq(keys[1].leagueKey, 'euro-omega-european-masters-matchups');
});

console.log('\n── Game market normalization ──');
test('priced rugby game → moneyline markets only (no fabricated spread odds)', function() {
  var g = adapter.normalizeBookmakerMarket('9-05-racing-92-union-bordeaux-begles', {
    kind: 'game',
    section: 'RU - FRANCE TOP 14',
    startTime: '9/05 12:15pm PT',
    visitor: { team: 'Racing 92', spread: '+17½', total: '63½', moneyline: '+520' },
    home: { team: 'Union Bordeaux Begles', spread: '-17½', total: '63½', moneyline: '-1000' },
    draw: null,
    pageLastUpdate: 'Saturday, September 5th 9:00 am PT'
  }, { sportKey: 'rugby', leagueKey: 'ru-france-top-14', nowMs: Date.parse('2026-09-05T16:00:00Z') });

  assert(g, 'game emitted');
  assertEq(g.away_team, 'Racing 92');
  assertEq(g.home_team, 'Union Bordeaux Begles');
  assertEq(g.sport_key, 'rugby');
  assert(g.source === 'bookmaker-v2');
  var mls = g.markets.filter(function(m) { return m.marketType === 'moneyline'; });
  var sps = g.markets.filter(function(m) { return m.marketType === 'spread'; });
  var tots = g.markets.filter(function(m) { return m.marketType === 'total'; });
  assertEq(mls.length, 2);
  assertEq(sps.length, 0, 'no fabricated spread odds');
  assertEq(tots.length, 0, 'no fabricated total odds');
  assert(mls.some(function(m) { return m.teamOrSide === 'Racing 92' && m.odds === 520; }));
  assert(mls.some(function(m) { return m.teamOrSide === 'Union Bordeaux Begles' && m.odds === -1000; }));
});

test('unpriced game → null (empty, not fake odds)', function() {
  var g = adapter.normalizeBookmakerMarket('10-03-future-unpriced', {
    kind: 'game',
    startTime: '10/03 7:35am PT',
    visitor: { team: 'ASM Clermont Auvergne', spread: '-', total: '-', moneyline: '-' },
    home: { team: 'Stade Rochelais', spread: '-', total: '-', moneyline: '-' }
  }, { sportKey: 'rugby', leagueKey: 'ru-france-top-14', nowMs: Date.parse('2026-09-05T16:00:00Z') });
  assertEq(g, null);
});

test('golf matchup → moneyline event', function() {
  var g = adapter.normalizeBookmakerMarket('9-06-adrian-meronk-davis-bryant', {
    kind: 'game',
    section: 'Euro - Omega European Masters Matchups',
    startTime: '9/06 12:20am PT',
    visitor: { team: 'Adrian Meronk', spread: '-', total: '-', moneyline: '-105' },
    home: { team: 'Davis Bryant', spread: '-', total: '-', moneyline: '-125' }
  }, { sportKey: 'golf', leagueKey: 'euro-omega-european-masters-matchups', nowMs: Date.parse('2026-09-05T16:00:00Z') });
  assert(g);
  assertEq(g.sport_key, 'golf');
  assertEq(g.markets.length, 2);
  assert(g.markets.every(function(m) { return m.sportsbook === 'bookmaker'; }));
});

test('futures board → outright moneyline list', function() {
  var g = adapter.normalizeBookmakerMarket('european-masters-2026-winner', {
    kind: 'futures',
    title: 'European Masters 2026 - Winner',
    options: [
      { text: 'Ryan Gerard +1016', name: 'Ryan Gerard', price: '+1016' },
      { text: 'Matt Wallace +1352', name: 'Matt Wallace', price: '+1352' },
      { text: 'Unpriced Player', name: 'Unpriced Player' }
    ]
  }, { sportKey: 'golf', leagueKey: 'euro-omega-european-masters-winner', nowMs: Date.parse('2026-09-05T16:00:00Z') });
  assert(g);
  assertEq(g.home_team, 'Outright');
  assertEq(g.away_team, 'European Masters 2026 - Winner');
  assertEq(g.markets.length, 2, 'skip unpriced options');
  assert(g.markets.some(function(m) { return m.teamOrSide === 'Ryan Gerard' && m.odds === 1016; }));
});

console.log('\n── League payload + fetch result ──');
test('league payload skips unpriced, keeps priced', function() {
  var r = adapter.normalizeBookmakerLeaguePayload({
    sport: 'rugby',
    league: 'ru-france-top-14',
    data: {
      priced: {
        kind: 'game',
        startTime: '9/05 10:05am PT',
        visitor: { team: 'A', moneyline: '+111', spread: '-', total: '-' },
        home: { team: 'B', moneyline: '-148', spread: '-', total: '-' }
      },
      unpriced: {
        kind: 'game',
        startTime: '10/03 7:35am PT',
        visitor: { team: 'C', moneyline: '-', spread: '-', total: '-' },
        home: { team: 'D', moneyline: '-', spread: '-', total: '-' }
      }
    }
  }, { sportKey: 'rugby', leagueKey: 'ru-france-top-14', nowMs: Date.parse('2026-09-05T16:00:00Z') });
  assertEq(r.games.length, 1);
  assertEq(r.skippedUnpriced, 1);
});

test('empty leagues → empty ok result (not error)', function() {
  var r = adapter.buildBookmakerFetchResult([], { warnings: ['no_leagues'], meta: { sport: 'golf' } });
  assert(r.ok);
  assertEq(r.sourceStatus, 'empty');
  assertEq(r.games.length, 0);
});

test('stampMarket hook invoked', function() {
  var stamped = 0;
  var game = adapter.normalizeBookmakerMarket('x', {
    kind: 'game',
    startTime: '9/05 10:05am PT',
    visitor: { team: 'A', moneyline: '+100' },
    home: { team: 'B', moneyline: '-120' }
  }, { sportKey: 'golf', leagueKey: 'l1', nowMs: Date.parse('2026-09-05T16:00:00Z') });
  var r = adapter.buildBookmakerFetchResult([game], {
    stampMarket: function(entry) { stamped++; entry.canonicalMarketKey = 'stamped'; }
  });
  assert(stamped >= 2);
  assert(r.games[0].markets.every(function(m) { return m.canonicalMarketKey === 'stamped'; }));
});

console.log('\n── Results: ' + _pass + ' passed, ' + _fail + ' failed ──');
process.exit(_fail ? 1 : 0);
