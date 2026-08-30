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

function _gameKeyLookupCandidates(cKey) {
  const seen = {};
  const out = [];
  function add(k) {
    if (!k || seen[k]) return;
    seen[k] = true;
    out.push(k);
  }
  add(cKey);
  const expanded = _expandSportPrefixOnGameKey(cKey);
  add(expanded);
  add(_unhyphenateGameKeyTeams(cKey));
  add(_unhyphenateGameKeyTeams(expanded));
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

if (fail) {
  console.error('\n' + fail + ' failed, ' + pass + ' passed');
  process.exit(1);
}
console.log('\n' + pass + ' passed');
