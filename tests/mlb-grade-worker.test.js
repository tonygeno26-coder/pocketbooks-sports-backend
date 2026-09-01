'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
    pass++;
  } catch (e) {
    console.error('  FAIL ' + name + '\n     ' + e.message);
    fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'expected true');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'values differ') +
      ' - got ' + JSON.stringify(actual) + ' expected ' + JSON.stringify(expected));
  }
}

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const _CACHE_SPORT_KEY_BY_SHORT = {
  mlb: 'baseball_mlb', nba: 'basketball_nba', nfl: 'americanfootball_nfl'
};

function _oddsApiSportKey(sport) {
  const s = String(sport || 'baseball_mlb').toLowerCase().trim();
  if (!s || s === 'unknown') return 'baseball_mlb';
  if (_CACHE_SPORT_KEY_BY_SHORT[s]) return _CACHE_SPORT_KEY_BY_SHORT[s];
  return s;
}

function _resultSnapshotCanonicalKey(game, sport) {
  const sportKey = _oddsApiSportKey((game && game.sport_key) || sport || 'baseball_mlb');
  const away = (game && game.away_team) || '';
  const home = (game && game.home_team) || '';
  const date = String((game && game.commence_time) || '').slice(0, 10);
  return sportKey + '|' + away + '|' + home + '|' + date;
}

function _expandSportPrefixOnGameKey(cKey) {
  if (!cKey) return cKey;
  const parts = String(cKey).split('|');
  if (!parts[0]) return cKey;
  const raw = parts[0].toLowerCase();
  const expanded = _CACHE_SPORT_KEY_BY_SHORT[raw] || raw;
  if (expanded === parts[0]) return String(cKey);
  parts[0] = expanded;
  return parts.join('|');
}

function _unhyphenateGameKeyTeams(cKey) {
  if (!cKey) return cKey;
  const parts = String(cKey).split('|');
  if (parts.length < 3) return String(cKey);
  function titleCaseWords(s) {
    return String(s || '').replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }
  parts[1] = titleCaseWords(parts[1]);
  parts[2] = titleCaseWords(parts[2]);
  return parts.join('|');
}

function _hyphenateGameKeyTeams(cKey) {
  if (!cKey) return cKey;
  const parts = String(cKey).split('|');
  if (parts.length < 3) return String(cKey);
  function slug(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '-');
  }
  parts[1] = slug(parts[1]);
  parts[2] = slug(parts[2]);
  return parts.join('|');
}

function _sportPrefix(sportKey) {
  const k = (sportKey||'').toLowerCase();
  if (k.startsWith('baseball')) return 'MLB';
  if (k.startsWith('basketball_nba')) return 'NBA';
  if (k.startsWith('americanfootball_nfl')) return 'NFL';
  if (k.startsWith('icehockey')) return 'NHL';
  return k.split('_')[0].toUpperCase();
}

function _collapseSportPrefixOnGameKey(cKey) {
  if (!cKey) return cKey;
  const parts = String(cKey).split('|');
  if (!parts[0]) return cKey;
  const collapsed = _sportPrefix(parts[0]);
  if (!collapsed || collapsed === parts[0]) return String(cKey);
  parts[0] = collapsed;
  return parts.join('|');
}

function _gameKeyLookupCandidates(cKey) {
  const seen = {};
  const out = [];
  function add(k) {
    if (!k || seen[k]) return;
    seen[k] = true;
    out.push(k);
  }
  const prefixes = [cKey, _expandSportPrefixOnGameKey(cKey), _collapseSportPrefixOnGameKey(cKey)];
  prefixes.forEach(function(p) {
    add(p);
    add(_unhyphenateGameKeyTeams(p));
    add(_hyphenateGameKeyTeams(p));
  });
  return out;
}

function _lookupResultByGameKey(resultsByKey, cKey) {
  if (!resultsByKey) return null;
  const cands = _gameKeyLookupCandidates(cKey);
  for (let i = 0; i < cands.length; i++) {
    if (resultsByKey[cands[i]]) return resultsByKey[cands[i]];
  }
  return null;
}

console.log('\n-- MLB grading worker keys + wiring --');

test('Odds API sport key maps MLB → baseball_mlb', function() {
  assertEq(_oddsApiSportKey('MLB'), 'baseball_mlb');
  assertEq(_oddsApiSportKey('mlb'), 'baseball_mlb');
  assertEq(_oddsApiSportKey('baseball_mlb'), 'baseball_mlb');
});

test('result snapshot key matches ticket Owls key', function() {
  const game = {
    sport_key: 'baseball_mlb',
    away_team: 'Boston Red Sox',
    home_team: 'New York Yankees',
    commence_time: '2026-08-30T17:35:00Z'
  };
  assertEq(
    _resultSnapshotCanonicalKey(game, 'baseball_mlb'),
    'baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30'
  );
});

test('slug MLB result key still finds title-case ticket key', function() {
  const ticketKey = 'baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30';
  const stored = {
    canonical_game_key: 'MLB|boston-red-sox|new-york-yankees|2026-08-30',
    status: 'final', home_score: 5, away_score: 3
  };
  const map = {};
  _gameKeyLookupCandidates(stored.canonical_game_key).forEach(function(k) { map[k] = stored; });
  const hit = _lookupResultByGameKey(map, ticketKey);
  assert(hit, 'expected candidate lookup to find snapshot');
  assertEq(hit.status, 'final');
});

test('index.js starts in-process MLB grade poller', function() {
  assert(indexSource.includes('function _startMlbGradePoller'), 'missing _startMlbGradePoller');
  assert(indexSource.includes('_startMlbGradePoller()'), 'poller never started');
  assert(indexSource.includes("enqueueJob('grade_run'"), 'grade_run never enqueued');
  assert(indexSource.includes("idempotencyKey:'BOOT_grade_run'"), 'BOOT_grade_run missing');
  assert(indexSource.includes('_resultSnapshotCanonicalKey'), 'key helper missing');
  assert(indexSource.includes('_lookupResultByGameKey'), 'lookup helper missing');
  assert(indexSource.includes('_oddsApiSportKey'), 'sport mapper missing');
});

test('index.js uses ticket-matching result keys not slug MLB keys', function() {
  assert(!/const cKey = sp\+'\|'\+away\+'\|'\+home\+'\|'\+date/.test(indexSource),
    'legacy slug result key still in upsert');
  assert(indexSource.includes('_resultSnapshotCanonicalKey(game, sport)'),
    'upsert should call _resultSnapshotCanonicalKey');
});

test('in-process poller grades without ODDS_KEY / host auth', function() {
  assert(indexSource.includes("GRADE_POLL_SKIP reason=supabase_not_configured"),
    'poller should skip only when supabase is missing');
  assert(!indexSource.includes("skip sb='+!!sb+' oddsKey="),
    'poller must not require ODDS_KEY');
  assert(indexSource.includes("await _runGradeCore({ body:{ daysBack:3 } }, sb)"),
    'poller must call _runGradeCore');
  assert(indexSource.includes('auth=none clubs=ALL'),
    'poller must advertise unauthenticated all-club grading');
});

test('ESPN scoreboard is the scores fallback when Odds API is empty', function() {
  assert(indexSource.includes('function _fetchEspnSportScores'), 'missing ESPN fetch');
  assert(indexSource.includes('function _fetchScoresForSport'), 'missing scores aggregator');
  assert(indexSource.includes("converted.length ? 'espn' : 'odds-api'"), 'espn source not returned');
  assert(indexSource.includes('baseball/mlb'), 'MLB ESPN path missing');
  assert(indexSource.includes('RESULT_ESPN_PARSE_EMPTY'), 'must log root keys when ESPN parse is empty');
  assert(indexSource.includes("User-Agent': 'curl/8.7.1'"), 'ESPN fetch must use curl UA (custom UAs are 403)');
  assert(indexSource.includes('_lookupResultForLeg'), 'grade core must match tickets by team name');
  assert(indexSource.includes('espnScoreboard.toPublicScore'), 'scores API must use ESPN public mapper');
});

test('GRD-7b: ESPN still merges when Odds API already has other finals', function() {
  assert(indexSource.includes('function _mergeOddsAndEspnScores'), 'missing merge helper');
  assert(indexSource.includes('_mergeOddsAndEspnScores(odds || [], converted)'),
    'fetchScoresForSport must merge Odds + ESPN');
  assert(!/if \(oddsFinals\.length\) \{\s*console\.log\('RESULT_SCORES source=odds-api/.test(indexSource),
    'must not skip ESPN just because other Odds games are final');
  assert(indexSource.includes('_pastScoreboardYmdsFromLegs(allLegs, 14)'),
    'grade core must request ESPN dates for still-active past legs');
});

test('poller stamps lastGradeRunAt even when nothing grades', function() {
  assert(indexSource.includes('let _lastGradeRunAt = null'), 'missing lastGradeRunAt');
  assert(indexSource.includes('_lastGradeRunAt = new Date().toISOString()'),
    'poller never stamps lastGradeRunAt');
  assert(indexSource.includes('let _lastGradedAt = null'), 'missing lastGradedAt');
  assert(indexSource.includes('_lastGradedAt = new Date().toISOString()'),
    'must stamp lastGradedAt when a ticket grades');
  assert(indexSource.includes('GRADE_POLL_START'), 'missing GRADE_POLL_START log');
  assert(indexSource.includes('GRADE_CORE_SNAPSHOTS'), 'missing snapshot log');
  assert(indexSource.includes('GRADE_CORE_DONE'), 'missing GRADE_CORE_DONE log');
  assert(indexSource.includes('GRADE_KEY_COMPARE'), 'must log ticket vs ESPN keys');
  assert(indexSource.includes('GRADE_TICKET_SKIP'), 'must log skip reason with match/miss');
});

test('grade core reads ticket_legs.canonical_game_key not tickets', function() {
  const coreStart = indexSource.indexOf('async function _runGradeCore');
  const coreEnd = indexSource.indexOf('// ── WORKER LOOP');
  const core = indexSource.slice(coreStart, coreEnd > coreStart ? coreEnd : coreStart + 8000);
  assert(core.includes("from('ticket_legs')"), '_runGradeCore must load ticket_legs');
  assert(core.includes('l.canonical_game_key'), '_runGradeCore must use ticket_legs.canonical_game_key');
  assert(!/from\('tickets'\)\.select\([^)]*canonical_game_key/.test(core),
    'tickets table should not be the canonical_game_key source');
  assert(indexSource.includes('_lookupResultForLeg(resultsByKey, leg)'),
    'derive outcome must look up via ticket_legs fields');
  assert(indexSource.includes('leg.home_team || leg.homeTeam'),
    '_lookupResultForLeg must use ticket_legs home_team');
  assert(indexSource.includes('leg.away_team || leg.awayTeam'),
    '_lookupResultForLeg must use ticket_legs away_team');
  assert(indexSource.includes("const pick     = (leg.pick||'').toLowerCase()"),
    'grade pick from ticket_legs.pick');
  assert(indexSource.includes("const market   = (leg.market||'moneyline')"),
    'grade market from ticket_legs.market');
});

test('ESPN games convert to ticket-matching Odds-shaped keys', function() {
  const espnGame = {
    id: '401234',
    home: 'New York Yankees',
    away: 'Boston Red Sox',
    home_score: 16,
    away_score: 1,
    completed: true,
    canceled: false,
    commence_time: '2026-08-30T17:35:00Z'
  };
  const converted = {
    id: String(espnGame.id),
    sport_key: 'baseball_mlb',
    home_team: espnGame.home,
    away_team: espnGame.away,
    commence_time: espnGame.commence_time,
    completed: true,
    scores: [
      { name: espnGame.home, score: String(espnGame.home_score) },
      { name: espnGame.away, score: String(espnGame.away_score) }
    ]
  };
  assertEq(
    _resultSnapshotCanonicalKey(converted, 'baseball_mlb'),
    'baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30'
  );
  const map = {};
  const stored = {
    canonical_game_key: _resultSnapshotCanonicalKey(converted, 'baseball_mlb'),
    status: 'final', home_score: 16, away_score: 1, home_team: 'New York Yankees',
    away_team: 'Boston Red Sox'
  };
  _gameKeyLookupCandidates(stored.canonical_game_key).forEach(function(k) { map[k] = stored; });
  const hit = _lookupResultByGameKey(map, 'baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30');
  assert(hit, 'ESPN-derived snapshot should match ticket key');
});

test('ticket pick Boston Red Sox matches ESPN Yankees/Red Sox result', function() {
  const espn = require('../lib/espn-scoreboard');
  const fixture = {
    events: [{
      id: '401816732',
      date: '2026-08-30T17:35Z',
      competitions: [{
        date: '2026-08-30T17:35Z',
        competitors: [
          { homeAway: 'home', score: '16', team: { displayName: 'New York Yankees' } },
          { homeAway: 'away', score: '1', team: { displayName: 'Boston Red Sox' } }
        ],
        status: { type: { name: 'STATUS_FINAL', state: 'post', completed: true } }
      }]
    }]
  };
  const converted = espn.espnGamesToOddsScores(espn.espnScoreboardToGames(fixture), 'baseball_mlb')[0];
  const key = _resultSnapshotCanonicalKey(converted, 'baseball_mlb');
  assertEq(key, 'baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30');
  const stored = {
    canonical_game_key: key, status: 'final',
    home_team: converted.home_team, away_team: converted.away_team,
    home_score: 16, away_score: 1, commence_time: converted.commence_time
  };
  const map = {};
  _gameKeyLookupCandidates(key).forEach(function(k) { map[k] = stored; });
  assert(_lookupResultByGameKey(map, key), 'canonical key should hit');
  assertEq(stored.away_team, 'Boston Red Sox');
});

test('Owls title-case ticket key candidates include hyphenated MLB slug', function() {
  const ticketKey = 'baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30';
  const espnKey = 'baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30';
  const legacySlug = 'MLB|boston-red-sox|new-york-yankees|2026-08-30';
  const cands = _gameKeyLookupCandidates(ticketKey);
  assert(cands.indexOf(espnKey) >= 0, 'must include ESPN away|home|UTC-date key');
  assert(cands.indexOf(legacySlug) >= 0, 'must include hyphenated MLB slug, got ' + JSON.stringify(cands));
});

test('ESPN Yankees/Sox snapshot matches ticket_legs via _lookupResultForLeg', function() {
  function _isoDateFromValue(v) {
    if (v == null || v === '') return '';
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return '';
  }
  function _normTeamToken(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function _teamNamesLooselyEqual(a, b) {
    const na = _normTeamToken(a), nb = _normTeamToken(b);
    if (!na || !nb) return false;
    return na === nb || na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0;
  }
  function _uniqueResultRows(resultsByKey) {
    const out = [], seen = [];
    Object.keys(resultsByKey || {}).forEach(function(k) {
      const row = resultsByKey[k];
      if (!row || seen.indexOf(row) >= 0) return;
      seen.push(row); out.push(row);
    });
    return out;
  }
  function _lookupResultByTeams(resultsByKey, home, away, dateStr) {
    const rows = _uniqueResultRows(resultsByKey);
    const date = String(dateStr || '').slice(0, 10);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const homeOk = !home || _teamNamesLooselyEqual(row.home_team, home);
      const awayOk = !away || _teamNamesLooselyEqual(row.away_team, away);
      if (!homeOk || !awayOk) continue;
      if (date) {
        const rowDate = _isoDateFromValue(row.commence_time || '');
        const keyDate = String(row.canonical_game_key || '').split('|').pop();
        if (rowDate && rowDate !== date && keyDate !== date) continue;
      }
      return row;
    }
    return null;
  }
  function lookupForLeg(resultsByKey, leg) {
    const cKey = (leg && (leg.canonical_game_key || leg.canonicalGameKey)) || '';
    const cands = _gameKeyLookupCandidates(cKey);
    for (let i = 0; i < cands.length; i++) {
      if (resultsByKey[cands[i]]) return resultsByKey[cands[i]];
    }
    const parts = String(cKey).split('|');
    const date = _isoDateFromValue(leg.scheduled_start || '') || (parts[3] || '');
    const home = leg.home_team || parts[2] || '';
    const away = leg.away_team || parts[1] || '';
    return _lookupResultByTeams(resultsByKey, home, away, date);
  }
  function deriveLeg(leg, result) {
    if (!result) return { outcome:'error', reason:'result_missing' };
    if (result.status !== 'final') return { outcome:'pending', reason:'result_not_final', status:result.status };
    const market = (leg.market||'moneyline').toLowerCase();
    const pick = (leg.pick||'').toLowerCase();
    const homeTeam = (result.home_team||'').toLowerCase();
    const awayTeam = (result.away_team||'').toLowerCase();
    const homeScore = parseInt(result.home_score,10)||0;
    const awayScore = parseInt(result.away_score,10)||0;
    if (market==='moneyline'||market==='h2h') {
      const pickedHome = pick.includes(homeTeam);
      const pickedAway = pick.includes(awayTeam);
      if (result.winner==='home'&&pickedHome) return { outcome:'won' };
      if (result.winner==='away'&&pickedAway) return { outcome:'won' };
      return { outcome:'lost' };
    }
    if (market==='total'||market==='totals') {
      const total = homeScore+awayScore;
      const line = parseFloat(leg.line||0);
      const pickOver = pick.includes('over');
      return (pickOver?total>line:total<line) ? { outcome:'won' } : { outcome:'lost' };
    }
    return { outcome:'error', reason:'unsupported_market:'+market };
  }

  const espnKey = _resultSnapshotCanonicalKey({
    sport_key: 'baseball_mlb',
    away_team: 'Boston Red Sox',
    home_team: 'New York Yankees',
    commence_time: '2026-08-30T17:35Z'
  }, 'baseball_mlb');
  assertEq(espnKey, 'baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30');

  const stored = {
    canonical_game_key: espnKey, status: 'final',
    home_team: 'New York Yankees', away_team: 'Boston Red Sox',
    home_score: 16, away_score: 1, winner: 'home',
    commence_time: '2026-08-30T17:35Z'
  };
  const map = {};
  _gameKeyLookupCandidates(stored.canonical_game_key).forEach(function(k) { map[k] = stored; });

  const leg = {
    canonical_game_key: 'baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30',
    home_team: 'New York Yankees', away_team: 'Boston Red Sox',
    pick: 'Boston Red Sox', market: 'moneyline'
  };
  const hit = lookupForLeg(map, leg);
  assert(hit, 'ticket_legs Sox/Yankees key must match ESPN snapshot');
  assertEq(hit.status, 'final');
  assertEq(deriveLeg(leg, hit).outcome, 'lost');

  const slugLeg = {
    canonical_game_key: 'MLB|boston-red-sox|new-york-yankees|2026-08-30',
    home_team: 'New York Yankees', away_team: 'Boston Red Sox',
    pick: 'New York Yankees', market: 'moneyline'
  };
  const slugHit = lookupForLeg(map, slugLeg);
  assert(slugHit, 'hyphen slug ticket_legs key must still hit ESPN snapshot');
  assertEq(deriveLeg(slugLeg, slugHit).outcome, 'won');

  const totalsLeg = {
    canonical_game_key: 'baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30',
    home_team: 'New York Yankees', away_team: 'Boston Red Sox',
    pick: 'Over 8.5', market: 'total', line: 8.5
  };
  assertEq(deriveLeg(totalsLeg, lookupForLeg(map, totalsLeg)).outcome, 'won');
});

function _normTeamToken(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function _scoreIdentityKey(g) {
  const date = String((g && g.commence_time) || '').slice(0, 10);
  const a = _normTeamToken(g && (g.home_team || g.home));
  const b = _normTeamToken(g && (g.away_team || g.away));
  if (!a || !b) return '';
  return [a, b].sort().join('|') + '|' + date;
}
function _gameIsFinalScore(g) {
  if (!g || g.canceled) return false;
  const scores = g.scores;
  const hasScores = Array.isArray(scores) && scores.length >= 2 &&
    scores.every(function(s) { return s && s.score != null && s.score !== ''; });
  return !!(g.completed && hasScores);
}
function _mergeOddsAndEspnScores(odds, espn) {
  const byKey = {};
  function consider(g) {
    if (!g) return;
    const key = _scoreIdentityKey(g);
    if (!key) return;
    const existing = byKey[key];
    if (!existing) { byKey[key] = g; return; }
    if (_gameIsFinalScore(g) && !_gameIsFinalScore(existing)) byKey[key] = g;
  }
  (odds || []).forEach(consider);
  (espn || []).forEach(consider);
  return Object.keys(byKey).map(function(k) { return byKey[k]; });
}

test('GRD-7b merge keeps Odds finals and fills a dropped Owls game from ESPN', function() {
  const oddsYankees = {
    home_team: 'New York Yankees', away_team: 'Boston Red Sox',
    commence_time: '2026-08-30T17:35:00Z', completed: true,
    scores: [{ name: 'New York Yankees', score: '16' }, { name: 'Boston Red Sox', score: '1' }]
  };
  const oddsDroppedLive = {
    home_team: 'Los Angeles Dodgers', away_team: 'San Francisco Giants',
    commence_time: '2026-08-30T20:10:00Z', completed: false,
    scores: []
  };
  const espnDroppedFinal = {
    home_team: 'Los Angeles Dodgers', away_team: 'San Francisco Giants',
    commence_time: '2026-08-30T20:10:00Z', completed: true,
    scores: [{ name: 'Los Angeles Dodgers', score: '4' }, { name: 'San Francisco Giants', score: '2' }]
  };
  const merged = _mergeOddsAndEspnScores([oddsYankees, oddsDroppedLive], [espnDroppedFinal]);
  assertEq(merged.length, 2, 'two distinct games');
  const dodgers = merged.find(function(g) { return g.home_team === 'Los Angeles Dodgers'; });
  assert(dodgers && dodgers.completed, 'ESPN final must replace Odds non-final for dropped game');
  assertEq(dodgers.scores[0].score, '4');
  const yankees = merged.find(function(g) { return g.home_team === 'New York Yankees'; });
  assert(yankees && yankees.completed, 'unrelated Odds final must be kept');
});

test('GRD-7b merge does not invent a result when ESPN has no final either', function() {
  const oddsLive = {
    home_team: 'Chicago Cubs', away_team: 'St. Louis Cardinals',
    commence_time: '2026-08-30T18:00:00Z', completed: false, scores: []
  };
  const espnUpcoming = {
    home_team: 'Chicago Cubs', away_team: 'St. Louis Cardinals',
    commence_time: '2026-08-30T18:00:00Z', completed: false, scores: []
  };
  const merged = _mergeOddsAndEspnScores([oddsLive], [espnUpcoming]);
  assertEq(merged.length, 1);
  assert(!_gameIsFinalScore(merged[0]), 'must stay unresolved without a final');
});

if (fail) {
  console.error('\n' + fail + ' failed, ' + pass + ' passed');
  process.exit(1);
}
console.log('\n' + pass + ' passed');
