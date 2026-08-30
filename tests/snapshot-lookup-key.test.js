'use strict';

const fs = require('fs');
const path = require('path');

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
      ' - got ' + JSON.stringify(actual) + ' expected ' + JSON.stringify(expected));
  }
}

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const _CACHE_SPORT_KEY_BY_SHORT = {
  mlb: 'baseball_mlb', nba: 'basketball_nba', wnba: 'basketball_wnba',
  nfl: 'americanfootball_nfl', nhl: 'icehockey_nhl'
};

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

function _stripToWinSuffix(pick) {
  return String(pick || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+to\s+win\s*$/i, '')
    .replace(/\s+ml\s*$/i, '')
    .trim();
}

function _normalizePickForSnapshotLookup(pick) {
  return _stripToWinSuffix(pick)
    .toLowerCase()
    .replace(/\s[+-]?\d+\.?\d*$/, '')
    .trim();
}

console.log('\n-- Snapshot lookup key mismatch --');

test('index.js logs searched key, market, selection, and found/miss', function() {
  assert(indexSource.includes('SNAPSHOT_LOOKUP_BEGIN'), 'BEGIN log missing');
  assert(indexSource.includes('SNAPSHOT_LOOKUP_HIT'), 'HIT log missing');
  assert(indexSource.includes('SNAPSHOT_LOOKUP_MISS'), 'MISS log missing');
  assert(indexSource.includes('cKey='), 'must log canonicalGameKey');
  assert(indexSource.includes('marketForLookup='), 'must log market');
  assert(indexSource.includes('pickClean='), 'must log pickClean alongside raw pick');
  assert(indexSource.includes('selection='), 'must log selection');
  assert(indexSource.includes('found=true') || indexSource.includes("found=true"), 'must log found=true');
  assert(indexSource.includes('closestHint='), 'miss path must log closest keys, not dump table');
});

test('verify path uses pickClean for identity and selection_key query', function() {
  assert(indexSource.includes('const pickClean = _stripToWinSuffix(pick)'),
    'must compute pickClean from raw pick before lookup');
  assert(indexSource.includes('pick: pickClean'),
    'must pass pickClean into _normalizeLegIdentity so canonical key is not miami_marlins_to_win');
  assert(indexSource.includes(".eq('selection_key', pickForLookup)"),
    'legacy query must use pickForLookup (cleaned), not raw pick');
  assert(indexSource.includes('_lookupSnapshotFromLiveCache(keyCandidates[ki], marketForLookup, pickForLookup)'),
    'live-cache lookup must use cleaned pickForLookup');
});

test('mlb short prefix expands to baseball_mlb Owls key', function() {
  const lobby = 'mlb|Miami Marlins|Washington Nationals|2026-08-30';
  const db = 'baseball_mlb|Miami Marlins|Washington Nationals|2026-08-30';
  const cands = _gameKeyLookupCandidates(lobby);
  assert(cands.indexOf(db) >= 0, 'candidates must include Owls key, got ' + JSON.stringify(cands));
});

test('hyphenated MLB legacy key maps to Owls display names', function() {
  const lobby = 'MLB|colorado-rockies|atlanta-braves|2026-08-30';
  const db = 'baseball_mlb|Colorado Rockies|Atlanta Braves|2026-08-30';
  const cands = _gameKeyLookupCandidates(lobby);
  assert(cands.indexOf(db) >= 0, 'candidates must include ' + db + ', got ' + JSON.stringify(cands));
});

test('already-correct Owls key is preserved', function() {
  const db = 'baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30';
  const cands = _gameKeyLookupCandidates(db);
  assert(cands.indexOf(db) >= 0, 'Owls key must remain a candidate');
  assertEq(cands[0], db, 'original key stays first');
});

test('moneyline To Win suffix is stripped for selection_key', function() {
  assertEq(_normalizePickForSnapshotLookup('Colorado Rockies To Win'), 'colorado rockies');
  assertEq(_normalizePickForSnapshotLookup('Boston Red Sox to win'), 'boston red sox');
  assertEq(_normalizePickForSnapshotLookup('Miami Marlins To Win'), 'miami marlins');
  assertEq(_normalizePickForSnapshotLookup('Miami  Marlins   To  Win'), 'miami marlins');
  assertEq(_normalizePickForSnapshotLookup('Miami Marlins ML'), 'miami marlins');
  assertEq(_stripToWinSuffix('Miami Marlins To Win'), 'Miami Marlins');
  assertEq(_stripToWinSuffix('Miami Marlins to win'), 'Miami Marlins');
});

test('totals pick strips the numeric line for selection_key over/under', function() {
  assertEq(_normalizePickForSnapshotLookup('Over 9'), 'over');
  assertEq(_normalizePickForSnapshotLookup('Under 8.5'), 'under');
  assertEq(_normalizePickForSnapshotLookup('Over 8'), 'over');
});

test('spread pick strips the point line', function() {
  assertEq(_normalizePickForSnapshotLookup('Toronto Blue Jays +1.5'), 'toronto blue jays');
});

function _isoDateFromValue(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const ms = new Date(s).getTime();
  if (!isNaN(ms)) return new Date(ms).toISOString().slice(0, 10);
  return '';
}

function _fillEmptyGameKeyDate(cKey, dateStr) {
  if (!cKey || !dateStr) return cKey;
  const parts = String(cKey).split('|');
  if (parts.length < 4) return String(cKey);
  if (/^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 1] || '')) return String(cKey);
  parts[parts.length - 1] = dateStr;
  return parts.join('|');
}

function _gameKeyNeedsDateFlex(cKey) {
  const parts = String(cKey || '').split('|');
  if (parts.length < 4) return true;
  return !/^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 1] || '');
}

function _pickDateFlexSnapshotRow(rows, today) {
  if (!rows || !rows.length) return null;
  function dateOf(r) {
    const parts = String((r && r.canonical_game_key) || '').split('|');
    return parts[parts.length - 1] || '';
  }
  function isTodayDate(d) {
    return d === today || (today && String(d).indexOf(today) === 0);
  }
  const todayRows = rows.filter(function(r) { return isTodayDate(dateOf(r)); });
  const pool = todayRows.length ? todayRows : rows;
  const keys = [];
  const seen = {};
  pool.forEach(function(r) {
    const k = (r && r.canonical_game_key) || '';
    if (k && !seen[k]) { seen[k] = true; keys.push(k); }
  });
  if (keys.length > 1) {
    if (todayRows.length > 0) return null;
    let latest = '';
    keys.forEach(function(k) {
      const d = String(k).split('|').pop() || '';
      if (d > latest) latest = d;
    });
    const latestKeys = keys.filter(function(k) { return String(k).split('|').pop() === latest; });
    if (latestKeys.length !== 1) return null;
    const latestRows = pool.filter(function(r) { return r.canonical_game_key === latestKeys[0]; });
    latestRows.sort(function(a, b) {
      return new Date(b.fetched_at || 0) - new Date(a.fetched_at || 0);
    });
    return latestRows[0] || null;
  }
  pool.sort(function(a, b) {
    return new Date(b.fetched_at || 0) - new Date(a.fetched_at || 0);
  });
  return pool[0] || null;
}

test('empty game-key date fills from ISO scheduledStart', function() {
  const empty = 'baseball_mlb|Miami Marlins|Washington Nationals|';
  const filled = _fillEmptyGameKeyDate(empty, _isoDateFromValue('2026-08-30T23:10:00Z'));
  assertEq(filled, 'baseball_mlb|Miami Marlins|Washington Nationals|2026-08-30');
  assertEq(_isoDateFromValue('Sun 7:10 PM'), '', 'display time must not invent a date');
});

test('empty date key is a date-flex candidate; dated key is not', function() {
  assert(_gameKeyNeedsDateFlex('baseball_mlb|Miami Marlins|Washington Nationals|'));
  assert(!_gameKeyNeedsDateFlex('baseball_mlb|Miami Marlins|Washington Nationals|2026-08-30'));
});

test('date-flex prefers today over an older same-matchup snapshot', function() {
  const rows = [
    { canonical_game_key: 'baseball_mlb|Miami Marlins|Washington Nationals|2026-06-01', fetched_at: '2026-06-01T00:00:00Z' },
    { canonical_game_key: 'baseball_mlb|Miami Marlins|Washington Nationals|2026-08-30', fetched_at: '2026-08-30T11:20:00Z' }
  ];
  const picked = _pickDateFlexSnapshotRow(rows, '2026-08-30');
  assert(picked, 'must pick a row');
  assertEq(picked.canonical_game_key, 'baseball_mlb|Miami Marlins|Washington Nationals|2026-08-30');
});

test('date-flex refuses a today doubleheader', function() {
  const rows = [
    { canonical_game_key: 'baseball_mlb|Miami Marlins|Washington Nationals|2026-08-30', fetched_at: '2026-08-30T11:00:00Z' },
    { canonical_game_key: 'baseball_mlb|Miami Marlins|Washington Nationals|2026-08-30-game2', fetched_at: '2026-08-30T11:20:00Z' }
  ];
  assertEq(_pickDateFlexSnapshotRow(rows, '2026-08-30'), null);
});

test('verify path fills empty date and date-flexes prefix lookup', function() {
  assert(indexSource.includes('const dateFromLeg = _isoDateFromValue'),
    'must derive date from scheduledStart');
  assert(indexSource.includes('const rawKey = _fillEmptyGameKeyDate(rawKeyIn, dateFromLeg)'),
    'must stamp empty game-key date before lookup');
  assert(indexSource.includes("matchStrategy = 'date_flex'"),
    'must have date_flex matcher tier');
  assert(indexSource.includes('.like(\'canonical_game_key\', prefix + \'%\')'),
    'date-flex must prefix-match canonical_game_key');
});

test('moneyline vs total cannot share a line-flex prefix', function() {
  assert(indexSource.includes("ident.marketType === MARKET_TYPES.TOTAL"),
    'line-flex must be gated on total/spread market types');
  assert(indexSource.includes('canonical_line_flex'), 'line-flex strategy name missing');
  assert(!/like\('canonical_selection_key', '%/.test(indexSource),
    'must not wildcard the whole selection key (would mix moneyline with totals)');
});

console.log('\nSnapshot lookup key tests: ' + _pass + ' passed, ' + _fail + ' failed');
if (_fail > 0) process.exit(1);
