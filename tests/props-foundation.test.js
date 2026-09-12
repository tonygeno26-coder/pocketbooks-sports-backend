'use strict';
/**
 * Props data foundation — inventory, alts, unknown fail-closed, capability.
 * Run: node tests/props-foundation.test.js
 */
const pf = require('../lib/props-foundation');

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

function assert(c, m) {
  if (!c) throw new Error(m || 'assert');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'assertEq') + ': got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));
}

console.log('\nprops-foundation');

// ── NFL primary + nested alts ──────────────────────────────────────────────
test('NFL primary + nested single-odds alts preserved (no invented under)', function() {
  var raw = {
    success: true,
    data: [{
      gameId: 'nfl:A@B-20260913',
      homeTeam: 'B',
      awayTeam: 'A',
      commenceTime: '2026-09-13T20:00:00Z',
      books: [{
        key: 'draftkings',
        props: [{
          category: 'passing_yards',
          playerName: 'Jordan Love',
          team: 'Green Bay Packers',
          line: 249.5,
          overPrice: -110,
          underPrice: -110,
          lastUpdate: '2026-09-12T12:00:00Z',
          alternateLines: [
            { line: 224.5, odds: -150 },
            { line: 274.5, odds: 130 },
            { line: 249.5, odds: -105 } // same as primary over — deduped vs primary preference
          ]
        }]
      }]
    }]
  };
  var sels = pf.normalizeOwlsPropsApiResponse(raw, 'nfl');
  var primaryOver = sels.filter(function(s) {
    return s.isPrimary && s.side === 'over' && s.line === 249.5;
  });
  var primaryUnder = sels.filter(function(s) {
    return s.isPrimary && s.side === 'under' && s.line === 249.5;
  });
  var alts = sels.filter(function(s) { return s.isAlternate; });
  assertEq(primaryOver.length, 1);
  assertEq(primaryUnder.length, 1);
  assert(alts.length >= 2, 'expected nested alts');
  assert(alts.every(function(a) { return a.side === 'over'; }), 'single-odds alts must be over-only');
  assert(alts.every(function(a) { return typeof a.odds === 'number'; }), 'alts need authoritative odds');
  assertEq(sels[0].identity.photoPolicy, 'PRESENTATION_ONLY');
  assertEq(sels[0].book, 'draftkings');
  assert(!!sels[0].lastUpdate, 'timestamp preserved');
});

test('NFL alt ladder max sample via inventory tree', function() {
  var alts = [];
  for (var i = 1; i <= 29; i++) alts.push({ line: 100 + i, odds: -100 - i });
  var raw = {
    success: true,
    data: [{
      gameId: 'nfl:g1', homeTeam: 'H', awayTeam: 'A',
      books: [{
        key: 'fanduel',
        props: [{
          category: 'receiving_yards',
          playerName: 'Justin Jefferson',
          team: 'MIN',
          line: 75.5,
          overPrice: -115,
          underPrice: -105,
          alternateLines: alts
        }]
      }]
    }]
  };
  var sels = pf.normalizeOwlsPropsApiResponse(raw, 'nfl');
  var tree = pf.buildPropsInventoryTree(sels);
  assertEq(tree.maxAltSample, 29);
  assert(tree.games.length === 1);
  assertEq(tree.photoPolicy, 'PRESENTATION_ONLY');
  var market = tree.games[0].categories[0].players[0].markets[0];
  assert(market.primary);
  assertEq(market.alternates.length, 29);
});

// ── NCAAF ──────────────────────────────────────────────────────────────────
test('NCAAF receptions normalize as supported', function() {
  var raw = {
    success: true,
    data: [{
      gameId: 'ncaaf:g1', homeTeam: 'H', awayTeam: 'A',
      books: [{
        key: 'betmgm',
        props: [{
          category: 'receptions',
          playerName: 'College WR',
          team: 'Alabama',
          line: 4.5,
          overPrice: -120,
          underPrice: 100
        }]
      }]
    }]
  };
  var sels = pf.normalizeOwlsPropsApiResponse(raw, 'ncaaf');
  assert(sels.length === 2);
  assertEq(sels[0].supportStatus, 'SUPPORTED_NORMALIZED');
  assert(sels[0].bettable === true);
});

// ── MLB primary + newly preserved ─────────────────────────────────────────
test('MLB Hits 3.5 now preserved/allowed; Combos unsupported', function() {
  assertEq(pf.isAllowedPropLine('Hits', 3.5), true);
  assertEq(pf.isAllowedPropLine('Home Runs', 1.5), true);
  assertEq(pf.isAllowedPropLine('Total Bases', 3.5), true);
  var raw = {
    success: true,
    data: [{
      gameId: 'mlb:g1', homeTeam: 'NYY', awayTeam: 'BOS',
      books: [{
        key: 'draftkings',
        props: [
          {
            category: 'hits', playerName: 'Aaron Judge', team: 'NYY',
            line: 1.5, overPrice: -140, underPrice: 110,
            alternateLines: [{ line: 2.5, odds: 180 }, { line: 3.5, odds: 450 }]
          },
          {
            category: 'combos', playerName: 'A & B', team: 'NYY',
            line: 2, overPrice: -110
          },
          {
            category: 'unknown', playerName: 'Mystery', rawMarketName: 'No Hitter Special',
            line: 0.5, overPrice: 2000
          }
        ]
      }]
    }]
  };
  var sels = pf.normalizeOwlsPropsApiResponse(raw, 'mlb');
  var hits = sels.filter(function(s) { return s.propType === 'Hits'; });
  assert(hits.length >= 3, 'hits primary+alts');
  var combos = sels.filter(function(s) { return s.propType === 'Combos' || s.category === 'combos'; });
  assert(combos.every(function(c) { return c.supportStatus === 'UNSUPPORTED' && c.bettable === false; }));
  var unknown = sels.filter(function(s) { return s.supportStatus === 'UNKNOWN_RAW'; });
  assert(unknown.length >= 1, 'unknown retained');
  assert(unknown.every(function(u) { return u.bettable === false; }));
});

test('MLB inventory retain includes unknown; display filter drops unknown', function() {
  var sels = [
    { playerName: 'X', propType: 'Hits', line: 0.5, side: 'over', odds: -110,
      sport: 'MLB', supportStatus: 'SUPPORTED_NORMALIZED', gameId: 'g' },
    { playerName: 'Y', propType: 'No Hitter Special', line: 0.5, side: 'over', odds: 500,
      sport: 'MLB', supportStatus: 'UNKNOWN_RAW', category: 'unknown', gameId: 'g' }
  ];
  var inv = pf.filterPropsForDisplay(sels, { retainUnknown: true, bettableOnly: false });
  var flat = pf.filterPropsForDisplay(sels, { bettableOnly: true });
  assert(inv.some(function(s) { return s.supportStatus === 'UNKNOWN_RAW'; }));
  assert(!flat.some(function(s) { return s.supportStatus === 'UNKNOWN_RAW'; }));
});

// ── WNBA ───────────────────────────────────────────────────────────────────
test('WNBA points/rebounds supported', function() {
  var raw = {
    success: true,
    data: [{
      gameId: 'wnba:g1', homeTeam: 'SEA', awayTeam: 'LV',
      books: [{
        key: 'caesars',
        props: [{
          category: 'points', playerName: "A'ja Wilson",
          line: 22.5, overPrice: -115, underPrice: -105
        }]
      }]
    }]
  };
  var sels = pf.normalizeOwlsPropsApiResponse(raw, 'wnba');
  assertEq(sels.length, 2);
  assertEq(sels[0].supportStatus, 'SUPPORTED_NORMALIZED');
  assertEq(sels[0].identity.team, null);
  assertEq(sels[0].identity.photoPolicy, 'PRESENTATION_ONLY');
});

// ── Dup alts ───────────────────────────────────────────────────────────────
test('duplicate alts dedupe keep better odds; primary preferred', function() {
  var raw = {
    success: true,
    data: [{
      gameId: 'nfl:g1', homeTeam: 'H', awayTeam: 'A',
      books: [
        {
          key: 'draftkings',
          props: [{
            category: 'rushing_yards', playerName: 'CMC', team: 'SF',
            line: 75.5, overPrice: -110, underPrice: -110,
            alternateLines: [{ line: 60.5, odds: -200 }]
          }]
        },
        {
          key: 'fanduel',
          props: [{
            category: 'rushing_yards', playerName: 'CMC', team: 'SF',
            line: 75.5, overPrice: -105, underPrice: -115,
            alternateLines: [{ line: 60.5, odds: -180 }]
          }]
        }
      ]
    }]
  };
  var sels = pf.normalizeOwlsPropsApiResponse(raw, 'nfl');
  var overPrimary = sels.filter(function(s) {
    return s.line === 75.5 && s.side === 'over' && s.isPrimary;
  });
  assertEq(overPrimary.length, 1);
  assertEq(overPrimary[0].odds, -105);
  var alt = sels.filter(function(s) { return s.line === 60.5 && s.isAlternate; });
  assertEq(alt.length, 1);
  assertEq(alt[0].odds, -180);
});

// ── Unknown fail-closed betting ────────────────────────────────────────────
test('unknown / longest-pass inventory known but not bettable; combos blocked', function() {
  assertEq(pf.isBettablePropType('Longest Reception'), false);
  assertEq(pf.isBettablePropType('Passing Yards'), true);
  assertEq(pf.classifySupportStatus({ propType: 'Longest Reception' }), 'SUPPORTED_NORMALIZED');
  assertEq(pf.classifySupportStatus({
    propType: 'Combos', rawCategory: 'combos', playerName: 'A & B'
  }), 'UNSUPPORTED');
  assertEq(pf.isBettablePropSelection({
    propType: 'Unknown', playerName: 'Z', line: 0.5, odds: 200,
    supportStatus: 'UNKNOWN_RAW'
  }), false);
});

// ── Empty sport capability ─────────────────────────────────────────────────
test('empty sport capability truth — no fake props', function() {
  assertEq(pf.sportPropsCapability('nhl', 0).hasProps, false);
  assertEq(pf.sportPropsCapability('nhl', 0).propsStatus, 'empty');
  assertEq(pf.sportPropsCapability('nhl', 0).propsCapable, true);
  assertEq(pf.sportPropsCapability('soccer', 0).propsStatus, 'unsupported');
  assertEq(pf.sportPropsCapability('mma', 0).hasProps, false);
  assertEq(pf.sportPropsCapability('boxing', 0).propsStatus, 'unsupported');
  assertEq(pf.sportPropsCapability('ncaab', 0).propsStatus, 'empty');
  assertEq(pf.sportPropsCapability('nfl', 100).hasProps, true);
  assertEq(pf.sportPropsCapability('nfl', 100).propsStatus, 'live');
});

// ── Player identity ────────────────────────────────────────────────────────
test('player identity is name+team; no playerId required', function() {
  var expanded = pf.expandPropAlternateLines({ line: 10.5 }, [
    { line: 12.5, odds: 150 }
  ], { book: 'draftkings' });
  assertEq(expanded.length, 1);
  assertEq(expanded[0].side, 'over');
  assert(!('playerId' in expanded[0]));
});

// ── Payload size / pagination ──────────────────────────────────────────────
test('pagination + payload measurement', function() {
  var list = [];
  for (var i = 0; i < 120; i++) {
    list.push({
      gameId: 'g1', playerName: 'P' + i, propType: 'Points', line: 20.5,
      side: 'over', odds: -110, isPrimary: true, sport: 'NBA'
    });
  }
  var page = pf.paginateProps(list, { offset: 0, limit: 50 });
  assertEq(page.items.length, 50);
  assertEq(page.hasMore, true);
  var tree = pf.buildPropsInventoryTree(page.items);
  var bytes = pf.measurePayloadBytes(tree);
  assert(bytes > 0 && bytes < 5 * 1024 * 1024, 'payload under 5MB for sample page');
});

// ── Odds-path expand includes player_prop ──────────────────────────────────
test('odds-path expandOwlsOutcomeAlternates handles player_prop', function() {
  var base = {
    marketType: 'player_prop', propType: 'Receiving Yards',
    playerName: 'WR1', overUnder: 'over', odds: -110, line: 50.5
  };
  var out = pf.expandOwlsOutcomeAlternates({
    alternateLines: [{ line: 40.5, odds: -200 }, { line: 60.5, odds: 150 }]
  }, 'player_prop', base, null);
  assertEq(out.length, 2);
  assert(out.every(function(e) { return e.isAlternate === true; }));
  assert(out.every(function(e) { return e.overUnder === 'over'; }));
});

test('odds-path still expands spread/total alts', function() {
  var base = { marketType: 'total', odds: -110, line: 45.5 };
  var out = pf.expandOwlsOutcomeAlternates({
    alternateLines: [{ point: 48.5, overPrice: -105, underPrice: -115 }]
  }, 'total', base, null);
  assertEq(out.length, 2);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
