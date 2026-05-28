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

function normalizeMarketType(key) {
  const k = String(key || '').toLowerCase();
  if (k === 'h2h' || k === 'moneyline') return 'moneyline';
  if (k === 'spreads' || k === 'spread') return 'spread';
  if (k === 'totals' || k === 'total') return 'total';
  return null;
}

function normalizeOwlsMarkets(event, logFn) {
  const sport = event.sport_key || event.sport || 'nba';
  const home = event.home_team || event.home || '';
  const away = event.away_team || event.away || '';
  const ct = event.commence_time || '';
  const ck = sport + '|' + away + '|' + home + '|' + ct.slice(0, 10);
  const evId = event.id || event.event_id || event.game_id;
  const markets = [];
  const warnings = [];

  (event.bookmakers || []).forEach(function(book) {
    (book.markets || []).forEach(function(mkt) {
      const mktKey = mkt.key || mkt.type || mkt.market_key || mkt.name || '';
      const mt = normalizeMarketType(mktKey);
      if (!mt) return;

      const rawMktStatus = String(mkt.status || mkt.state || '').toLowerCase();
      const mktSuspended = mkt.suspended === true || mkt.is_suspended === true ||
        /^(suspended|paused|inactive|removed|halted)$/.test(rawMktStatus);
      const mktClosed = mkt.closed === true || mkt.is_closed === true ||
        /^(closed|settled|final)$/.test(rawMktStatus);

      if (mktSuspended || mktClosed) {
        warnings.push((mktClosed ? 'closed:' : 'suspended:') + evId + ':' + mktKey);
        logFn({
          provider: 'owls',
          reason: 'market_unavailable_skipped',
          unavailableType: mktClosed ? 'closed' : 'suspended',
          rawStatus: rawMktStatus || null,
          status: mkt.status || null,
          state: mkt.state || null,
          suspended: mkt.suspended === true || mkt.is_suspended === true,
          closed: mkt.closed === true || mkt.is_closed === true,
          providerGameId: evId || null,
          canonicalGameKey: ck || null,
          sport: sport || null,
          marketKey: mktKey || null,
          marketName: mkt.name || mkt.label || null,
          homeTeam: home || null,
          awayTeam: away || null
        });
        return;
      }

      (mkt.outcomes || []).forEach(function(outcome) {
        markets.push({ marketType:mt, teamOrSide:outcome.name, odds:outcome.price });
      });
    });
  });

  return { markets, warnings };
}

function makeEvent(marketOverrides) {
  return {
    id: 'G_OWLS_1',
    sport_key: 'nba',
    home_team: 'Lakers',
    away_team: 'Suns',
    commence_time: '2026-05-27T22:00:00Z',
    bookmakers: [{
      key: 'pinnacle',
      markets: [Object.assign({
        key: 'h2h',
        outcomes: [{ name:'Lakers', price:-110 }, { name:'Suns', price:+100 }]
      }, marketOverrides || {})]
    }]
  };
}

console.log('\n-- Owls unavailable market visibility --');

test('suspended market emits structured warning and is skipped', function() {
  const logs = [];
  const result = normalizeOwlsMarkets(makeEvent({ suspended:true, status:'suspended' }), logs.push.bind(logs));
  assertEq(result.markets.length, 0, 'markets skipped');
  assertEq(logs.length, 1, 'one structured log');
  assertEq(logs[0].provider, 'owls');
  assertEq(logs[0].reason, 'market_unavailable_skipped');
  assertEq(logs[0].unavailableType, 'suspended');
  assertEq(logs[0].providerGameId, 'G_OWLS_1');
  assertEq(logs[0].canonicalGameKey, 'nba|Suns|Lakers|2026-05-27');
});

test('closed market emits structured warning and is skipped', function() {
  const logs = [];
  const result = normalizeOwlsMarkets(makeEvent({ closed:true, status:'closed' }), logs.push.bind(logs));
  assertEq(result.markets.length, 0, 'markets skipped');
  assertEq(logs.length, 1, 'one structured log');
  assertEq(logs[0].unavailableType, 'closed');
  assertEq(logs[0].rawStatus, 'closed');
});

test('removed market emits structured warning and is skipped', function() {
  const logs = [];
  const result = normalizeOwlsMarkets(makeEvent({ state:'removed' }), logs.push.bind(logs));
  assertEq(result.markets.length, 0, 'markets skipped');
  assertEq(logs.length, 1, 'one structured log');
  assertEq(logs[0].unavailableType, 'suspended');
  assertEq(logs[0].rawStatus, 'removed');
});

test('halted market emits structured warning and is skipped', function() {
  const logs = [];
  const result = normalizeOwlsMarkets(makeEvent({ status:'halted' }), logs.push.bind(logs));
  assertEq(result.markets.length, 0, 'markets skipped');
  assertEq(logs.length, 1, 'one structured log');
  assertEq(logs[0].rawStatus, 'halted');
});

test('normal market still persists as before', function() {
  const logs = [];
  const result = normalizeOwlsMarkets(makeEvent({ status:'active' }), logs.push.bind(logs));
  assertEq(result.markets.length, 2, 'outcomes preserved');
  assertEq(logs.length, 0, 'no unavailable log');
  assert(result.warnings.length === 0, 'no warnings');
});

console.log('\nOwls unavailable market visibility tests: ' + _pass + ' passed, ' + _fail + ' failed');
if (_fail > 0) process.exit(1);
