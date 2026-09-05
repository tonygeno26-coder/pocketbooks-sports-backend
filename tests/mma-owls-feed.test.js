'use strict';

/**
 * MMA Owls feed plumbing — books merge, sport-key helpers, normalize moneyline.
 * Pure unit tests (no network).
 */

function owlsBooksForSport(sportKey, baseBooks, mmaExtra, sportMap) {
  var owlsSport = (sportMap && sportMap[sportKey]) || String(sportKey || '').toLowerCase();
  var base = String(baseBooks || '').split(',').map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean);
  var extra = [];
  if (owlsSport === 'mma') {
    extra = String(mmaExtra || '').split(',').map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean);
  }
  var seen = {}, out = [];
  base.concat(extra).forEach(function(b) {
    if (!b || seen[b]) return;
    seen[b] = true;
    out.push(b);
  });
  return out.join(',');
}

function isMmaCacheSportKey(gameSportKey) {
  var g = String(gameSportKey || '').toLowerCase();
  if (!g) return false;
  return g === 'mma' || g === 'mma_mixed_martial_arts' || g.indexOf('mma') === 0;
}

function normalizeMmaOwlsSample(owlsData) {
  if (!owlsData || owlsData.success === false || !owlsData.data) return { ok:false, games:[] };
  var allEvents = [];
  var seen = {};
  function add(ev) {
    if (ev && ev.id && !seen[ev.id]) { seen[ev.id] = true; allEvents.push(ev); }
  }
  var raw = owlsData.data;
  if (Array.isArray(raw)) raw.forEach(add);
  else Object.values(raw || {}).forEach(function(v) {
    if (Array.isArray(v)) v.forEach(add);
    else if (v && v.id) add(v);
  });
  var games = allEvents.map(function(ev) {
    var home = ev.home_team || '';
    var away = ev.away_team || '';
    var markets = [];
    (ev.bookmakers || []).forEach(function(bm) {
      (bm.markets || []).forEach(function(mkt) {
        var key = String(mkt.key || '').toLowerCase();
        if (key !== 'h2h' && key !== 'moneyline') return;
        (mkt.outcomes || []).forEach(function(oc) {
          markets.push({
            marketType: 'moneyline',
            teamOrSide: oc.name,
            odds: oc.price,
            sportsbook: bm.key || 'owls'
          });
        });
      });
    });
    return {
      id: ev.id,
      sport_key: ev.sport_key || ev.sport || 'mma',
      home_team: home,
      away_team: away,
      commence_time: ev.commence_time,
      league: ev.league || null,
      markets: markets
    };
  });
  return { ok:true, games: games };
}

describe('MMA Owls feed plumbing', function() {
  test('appends betonline for MMA without changing MLB books', function() {
    var map = { mlb:'mlb', mma:'mma', mma_mixed_martial_arts:'mma' };
    var base = 'pinnacle,fanduel,draftkings';
    var extra = 'betonline,bet365';
    expect(owlsBooksForSport('mlb', base, extra, map)).toBe('pinnacle,fanduel,draftkings');
    expect(owlsBooksForSport('mma', base, extra, map)).toBe('pinnacle,fanduel,draftkings,betonline,bet365');
    expect(owlsBooksForSport('mma_mixed_martial_arts', base, extra, map))
      .toBe('pinnacle,fanduel,draftkings,betonline,bet365');
  });

  test('recognizes MMA cache sport keys', function() {
    expect(isMmaCacheSportKey('mma')).toBe(true);
    expect(isMmaCacheSportKey('mma_mixed_martial_arts')).toBe(true);
    expect(isMmaCacheSportKey('mlb')).toBe(false);
  });

  test('normalizes betonline MMA moneyline card into unified game shape', function() {
    var sample = {
      success: true,
      data: {
        betonline: [{
          id: 'betonline-mma-491101379',
          sport_key: 'mma',
          sport: 'mma',
          commence_time: '2026-09-13T00:00:00.000Z',
          home_team: 'Brandon Moreno',
          away_team: 'Joseph Morales',
          status: 'scheduled',
          league: 'Noche UFC',
          bookmakers: [{
            key: 'betonline',
            markets: [{
              key: 'h2h',
              outcomes: [
                { name: 'Brandon Moreno', price: 115 },
                { name: 'Joseph Morales', price: -135 }
              ]
            }]
          }]
        }]
      }
    };
    var out = normalizeMmaOwlsSample(sample);
    expect(out.ok).toBe(true);
    expect(out.games.length).toBe(1);
    var g = out.games[0];
    expect(g.id).toBe('betonline-mma-491101379');
    expect(g.sport_key).toBe('mma');
    expect(g.home_team).toBe('Brandon Moreno');
    expect(g.away_team).toBe('Joseph Morales');
    expect(g.league).toBe('Noche UFC');
    expect(g.markets.length).toBe(2);
    expect(g.markets[0].marketType).toBe('moneyline');
    expect(g.markets.every(function(m){ return typeof m.odds === 'number'; })).toBe(true);
  });
});
