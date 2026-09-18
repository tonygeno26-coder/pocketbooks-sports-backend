'use strict';

/**
 * P1 CURRENT SNAPSHOT RESOLUTION GATE
 *
 * Ordering rule for provider_game_id multi-row collisions
 * (_pickProviderGameIdSnapshotRow):
 *   1) preferred event date (leg scheduledStart / key date, UTC YYYY-MM-DD)
 *   2) else today (UTC from toISOString)
 *   3) else freshest non-live / latest-dated upcoming over ancient live
 *   4) within pool: fetched_at DESC (NOT created_at)
 *
 * Never depend on whichever historical row returns first from .limit(1).
 */

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
const LIVE_SNAPSHOT_TTL_MS = 10 * 1000;

function _stripAccentsForKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ø/g, 'o').replace(/Ø/g, 'O')
    .replace(/æ/g, 'ae').replace(/Æ/g, 'AE')
    .replace(/å/g, 'a').replace(/Å/g, 'A')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/ł/g, 'l').replace(/Ł/g, 'L');
}

function _normalizeMatchupNameToken(s) {
  return _stripAccentsForKey(s)
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _gameKeyMatchupNorm(cKey) {
  const parts = String(cKey || '').split('|');
  return _normalizeMatchupNameToken(parts[0] || '') + '|'
    + _normalizeMatchupNameToken(parts[1] || '') + '|'
    + _normalizeMatchupNameToken(parts[2] || '');
}

function _spaceHyphenNameVariants(name) {
  const raw = _stripAccentsForKey(String(name || '').trim());
  if (!raw) return [];
  const words = raw.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ')
    .filter(Boolean);
  if (!words.length) return [raw];
  if (words.length === 1) return [words[0], raw].filter(Boolean);
  const joints = Math.min(words.length - 1, 4);
  const max = 1 << joints;
  const out = [];
  const seen = {};
  function add(v) {
    if (!v || seen[v]) return;
    seen[v] = true;
    out.push(v);
  }
  add(raw);
  for (let mask = 0; mask < max; mask++) {
    let s = words[0];
    for (let i = 0; i < joints; i++) {
      s += ((mask >> i) & 1) ? '-' : ' ';
      s += words[i + 1];
    }
    for (let j = joints + 1; j < words.length; j++) s += ' ' + words[j];
    add(s);
  }
  return out;
}

function _compoundHyphenGameKeyVariants(cKey) {
  if (!cKey) return [];
  const parts = String(cKey).split('|');
  if (parts.length < 3) return [String(cKey)];
  const awayVars = _spaceHyphenNameVariants(parts[1]);
  const homeVars = _spaceHyphenNameVariants(parts[2]);
  const out = [];
  const seen = {};
  function add(k) {
    if (!k || seen[k]) return;
    seen[k] = true;
    out.push(k);
  }
  add(String(cKey));
  for (let a = 0; a < awayVars.length; a++) {
    for (let h = 0; h < homeVars.length; h++) {
      const next = parts.slice();
      next[1] = awayVars[a];
      next[2] = homeVars[h];
      add(next.join('|'));
    }
  }
  return out;
}

function _splitSelectionKeyLine(sel) {
  const raw = String(sel || '');
  const idx = raw.lastIndexOf(':');
  if (idx < 0) return { name: raw, lineSuffix: '' };
  const maybeLine = raw.slice(idx + 1);
  if (/^[+-]?\d+(\.\d+)?$/.test(maybeLine)) {
    return { name: raw.slice(0, idx), lineSuffix: ':' + maybeLine };
  }
  return { name: raw, lineSuffix: '' };
}

function _selectionKeysEquivalent(a, b) {
  const aa = _splitSelectionKeyLine(a);
  const bb = _splitSelectionKeyLine(b);
  if (aa.lineSuffix !== bb.lineSuffix) return false;
  return _normalizeMatchupNameToken(aa.name) === _normalizeMatchupNameToken(bb.name);
}

function _pickProviderGameIdSnapshotRow(rows, opts) {
  opts = opts || {};
  if (!rows || !rows.length) return null;
  const preferredDate = String(opts.preferredDate || '').slice(0, 10);
  const today = String(opts.today || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  function dateOf(r) {
    const parts = String((r && r.canonical_game_key) || '').split('|');
    const d = parts[parts.length - 1] || '';
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
    const ct = r && (r.commence_time || r.commenceTime);
    if (ct) {
      const ms = new Date(ct).getTime();
      if (!isNaN(ms)) return new Date(ms).toISOString().slice(0, 10);
    }
    return '';
  }
  function isLiveRow(r) {
    if (!r) return false;
    if (r.event_live === true || r.eventLive === true) return true;
    const ev = String(r.event_status || r.eventStatus || r.gameStatus || '').toLowerCase();
    return ev === 'live' || ev === 'in_play' || ev === 'in_progress';
  }
  function fetchedMs(r) {
    const ms = new Date((r && (r.fetched_at || r.fetchedAt)) || 0).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  function matchesDate(r, want) {
    if (!want) return false;
    const d = dateOf(r);
    return d === want || (want && String(d).indexOf(want) === 0);
  }
  function sortFreshest(a, b) {
    return fetchedMs(b) - fetchedMs(a);
  }

  if (preferredDate) {
    const pref = rows.filter(function(r) { return matchesDate(r, preferredDate); });
    if (pref.length) {
      pref.sort(sortFreshest);
      return pref[0];
    }
  }
  if (today) {
    const todays = rows.filter(function(r) { return matchesDate(r, today); });
    if (todays.length) {
      todays.sort(sortFreshest);
      return todays[0];
    }
  }
  const nonLive = rows.filter(function(r) { return !isLiveRow(r); });
  if (nonLive.length) {
    nonLive.sort(sortFreshest);
    const bestNonLive = nonLive[0];
    const bestAny = rows.slice().sort(sortFreshest)[0];
    if (bestAny && isLiveRow(bestAny) && fetchedMs(bestAny) < fetchedMs(bestNonLive)) {
      return bestNonLive;
    }
    if (bestAny && isLiveRow(bestAny)) {
      const liveAge = nowMs - fetchedMs(bestAny);
      if (liveAge > LIVE_SNAPSHOT_TTL_MS && fetchedMs(bestNonLive) >= fetchedMs(bestAny)) {
        return bestNonLive;
      }
    }
    let latest = '';
    nonLive.forEach(function(r) {
      const d = dateOf(r);
      if (d > latest) latest = d;
    });
    if (latest) {
      const latestRows = nonLive.filter(function(r) { return dateOf(r) === latest; });
      latestRows.sort(sortFreshest);
      if (latestRows[0]) return latestRows[0];
    }
    return bestNonLive;
  }
  let latestLiveDate = '';
  rows.forEach(function(r) {
    const d = dateOf(r);
    if (d > latestLiveDate) latestLiveDate = d;
  });
  const pool = latestLiveDate
    ? rows.filter(function(r) { return dateOf(r) === latestLiveDate; })
    : rows.slice();
  pool.sort(sortFreshest);
  return pool[0] || null;
}

function _classifyMarket(snap, nowMs) {
  nowMs = nowMs || Date.now();
  if (!snap) return 'suspended';
  const fetchedMs = new Date(snap.fetched_at || snap.fetchedAt).getTime();
  const ageMs = nowMs - fetchedMs;
  const evStatus = String(snap.event_status || snap.eventStatus || snap.gameStatus || '').toLowerCase();
  const mkStatus = String(snap.market_status || snap.marketStatus || '').toLowerCase();
  if (snap.eventCompleted === true || evStatus === 'final' || evStatus === 'completed' ||
      mkStatus === 'final' || mkStatus === 'closed' || mkStatus === 'settled')
    return 'final';
  if (snap.eventCanceled === true || evStatus === 'canceled' || evStatus === 'cancelled' ||
      evStatus === 'postponed' || evStatus === 'abandoned')
    return 'canceled';
  if (snap.suspended === true || mkStatus === 'suspended' || mkStatus === 'paused')
    return 'suspended';
  let isLiveSnapshot = snap.eventLive === true || snap.event_live === true ||
    evStatus === 'live' || evStatus === 'in_play' || evStatus === 'in_progress';
  const ct = snap.commence_time || snap.commenceTime;
  if (!isLiveSnapshot && ct) {
    const ms = new Date(ct).getTime();
    if (!isNaN(ms) && nowMs >= ms) isLiveSnapshot = true;
  }
  const ttlMs = isLiveSnapshot ? LIVE_SNAPSHOT_TTL_MS : (5 * 60 * 1000);
  if (!Number.isFinite(fetchedMs) || ageMs > ttlMs) return 'stale';
  if (isLiveSnapshot) return 'live';
  return 'active';
}

// Minimal selected-leg resolve for parlay independence fixtures
function resolveSelectedLegs(legs, snapsByLeg, nowMs) {
  const confirmLegs = [];
  let hardFail = null;
  const accepted = [];
  for (let i = 0; i < legs.length; i++) {
    const snap = snapsByLeg[i];
    if (!snap) {
      hardFail = { code: 'odds_service_unavailable', legIndex: i };
      break;
    }
    const state = _classifyMarket(snap, nowMs);
    if (state === 'stale') {
      hardFail = { code: 'odds_stale', legIndex: i };
      break;
    }
    if (state === 'suspended') {
      hardFail = { code: 'market_suspended', legIndex: i, leg: legs[i].pick };
      break;
    }
    const serverOdds = Number(snap.odds_american);
    const submitted = Number(legs[i].odds);
    if (serverOdds !== submitted) {
      confirmLegs.push({ code: 'odds_changed', legIndex: i, serverOdds: serverOdds });
      continue;
    }
    accepted.push({ legIndex: i, odds: serverOdds });
  }
  return { hardFail: hardFail, confirmLegs: confirmLegs, accepted: accepted };
}

console.log('\n-- P1 Current Snapshot Resolution Gate --');

test('index wires provider_game_id CURRENT picker (not naked .limit(1))', function() {
  assert(indexSource.includes('function _pickProviderGameIdSnapshotRow'),
    'must define CURRENT-row picker');
  assert(indexSource.includes("matchStrategy = 'provider_game_id'"),
    'must retain provider_game_id tier');
  assert(indexSource.includes('_pickProviderGameIdSnapshotRow(matched'),
    'Tier 2c must call CURRENT picker');
  assert(!/eq\('provider_game_id'[\s\S]{0,220}\.eq\('selection_key'[\s\S]{0,120}\.limit\(1\)/.test(indexSource),
    'must not take first provider_game_id+selection row via naked limit(1)');
  assert(indexSource.includes('order(\'fetched_at\', { ascending: false })'),
    'must order by fetched_at desc');
  assert(indexSource.includes('ORDERING RULE'),
    'must document ordering rule in-source');
});

test('compound hyphen/space candidates hit golf Neergaard-Petersen', function() {
  const spaceKey = 'golf|Rasmus Neergaard Petersen|Brooks Koepka|2026-09-18';
  const hyphenKey = 'golf|Rasmus Neergaard-Petersen|Brooks Koepka|2026-09-18';
  const vars = _compoundHyphenGameKeyVariants(spaceKey);
  assert(vars.indexOf(hyphenKey) >= 0,
    'space form must candidate hyphen form, got ' + JSON.stringify(vars));
  assertEq(_gameKeyMatchupNorm(spaceKey), _gameKeyMatchupNorm(hyphenKey));
});

test('accent strip does not invent aggressive fuzzy collisions', function() {
  assertEq(_normalizeMatchupNameToken('Højgaard'), _normalizeMatchupNameToken('Hojgaard'));
  assert(_normalizeMatchupNameToken('Casey Jarvis') !== _normalizeMatchupNameToken('Brooks Koepka'));
});

test('production fixture: prefer 09-18 -136 over prior-day live -124', function() {
  const nowMs = Date.parse('2026-09-18T04:21:47.000Z');
  const staleLive = {
    canonical_game_key: 'golf|Rasmus Neergaard-Petersen|Brooks Koepka|2026-09-17',
    odds_american: -124,
    event_live: true,
    fetched_at: '2026-09-17T17:30:00.000Z',
    selection_key: 'rasmus neergaard-petersen',
    provider_game_id: 'bm:golf:euro-bmw-pga-championship-round-matchups:9-17-rasmus-neergaard-petersen-brooks-koepka'
  };
  const freshUpcoming = {
    canonical_game_key: 'golf|Rasmus Neergaard-Petersen|Brooks Koepka|2026-09-18',
    odds_american: -136,
    event_live: false,
    fetched_at: '2026-09-18T04:20:00.000Z',
    selection_key: 'rasmus neergaard-petersen',
    provider_game_id: staleLive.provider_game_id
  };
  // Wrong-first order (as .limit(1) without order might return)
  const rows = [staleLive, freshUpcoming];
  const picked = _pickProviderGameIdSnapshotRow(rows, {
    preferredDate: '2026-09-18',
    today: '2026-09-18',
    nowMs: nowMs
  });
  assert(picked, 'must pick a row');
  assertEq(picked.odds_american, -136);
  assertEq(picked.canonical_game_key, freshUpcoming.canonical_game_key);
  assertEq(_classifyMarket(picked, nowMs), 'active', 'fresh upcoming must not be stale');
  assertEq(_classifyMarket(staleLive, nowMs), 'stale', 'prior-day live must classify stale');
});

test('UTC date boundary: preferredDate 09-18 wins even if server local differs', function() {
  const rows = [
    {
      canonical_game_key: 'golf|A|B|2026-09-17',
      odds_american: -124,
      event_live: true,
      fetched_at: '2026-09-17T23:59:00.000Z'
    },
    {
      canonical_game_key: 'golf|A|B|2026-09-18',
      odds_american: -136,
      event_live: false,
      fetched_at: '2026-09-18T00:05:00.000Z'
    }
  ];
  const picked = _pickProviderGameIdSnapshotRow(rows, {
    preferredDate: '2026-09-18',
    today: '2026-09-17', // pathological "local today" — preferred still wins
    nowMs: Date.parse('2026-09-18T00:10:00.000Z')
  });
  assertEq(picked.odds_american, -136);
});

test('selection key equivalence preserves Over 8.5 vs Over 10', function() {
  assert(_selectionKeysEquivalent('over:8.5', 'Over:8.5'));
  assert(!_selectionKeysEquivalent('over:8.5', 'over:9'));
  assert(!_selectionKeysEquivalent('over:8.5', 'over:9.5'));
  assert(!_selectionKeysEquivalent('over:8.5', 'over:10'));
  assert(_selectionKeysEquivalent('rasmus neergaard petersen', 'rasmus neergaard-petersen'));
  assert(_selectionKeysEquivalent('toronto blue jays:-1.5', 'Toronto Blue Jays:-1.5'));
  assert(!_selectionKeysEquivalent('toronto blue jays:-1.5', 'toronto blue jays:-2.5'),
    'signed spread lines must stay distinct');
});

test('alt-line flex remains removed (no neighbor resolve)', function() {
  assert(!indexSource.includes("matchStrategy = 'canonical_line_flex'"));
  assert(!/\.like\('canonical_selection_key'/.test(indexSource));
});

test('selected-leg-only: unrelated C does not enter verify loop', function() {
  assert(indexSource.includes('async function _recalcPayoutFromSnapshots'),
    'parlay resolve must use per-leg snapshot verify');
  assert(indexSource.includes('await _verifyLegOddsSnapshot(sb, legs[i]'),
    'only submitted legs are verified');
  const nowMs = Date.parse('2026-09-18T04:21:47.000Z');
  const legs = [
    { pick: 'Rasmus Neergaard-Petersen', odds: -136 },
    { pick: 'Casey Jarvis', odds: -109 }
  ];
  const snaps = [
    {
      odds_american: -136,
      event_live: false,
      fetched_at: '2026-09-18T04:20:00.000Z',
      canonical_game_key: 'golf|Rasmus Neergaard-Petersen|Brooks Koepka|2026-09-18'
    },
    {
      odds_american: -109,
      event_live: false,
      fetched_at: '2026-09-18T04:20:00.000Z',
      canonical_game_key: 'golf|Casey Jarvis|Andy Sullivan|2026-09-18'
    }
  ];
  // Unrelated C market update is simply absent from snapsByLeg — no effect
  const r = resolveSelectedLegs(legs, snaps, nowMs);
  assert(!r.hardFail, 'A+B current must place path');
  assertEq(r.confirmLegs.length, 0);
  assertEq(r.accepted.length, 2);
});

test('A price change → odds_changed; Leg2 still evaluated', function() {
  const nowMs = Date.parse('2026-09-18T04:21:47.000Z');
  const r = resolveSelectedLegs(
    [{ pick: 'A', odds: -136 }, { pick: 'B', odds: -109 }],
    [
      { odds_american: -140, event_live: false, fetched_at: '2026-09-18T04:20:00.000Z' },
      { odds_american: -109, event_live: false, fetched_at: '2026-09-18T04:20:00.000Z' }
    ],
    nowMs
  );
  assert(!r.hardFail);
  assertEq(r.confirmLegs.length, 1);
  assertEq(r.confirmLegs[0].legIndex, 0);
  assertEq(r.confirmLegs[0].code, 'odds_changed');
  assertEq(r.accepted.length, 1);
  assertEq(r.accepted[0].legIndex, 1);
  assert(indexSource.includes("code === 'odds_changed' || code === 'line_changed'"),
    'parlay must continue collecting confirm legs');
});

test('A suspended → exact Leg1 block; hard-fail', function() {
  const nowMs = Date.parse('2026-09-18T04:21:47.000Z');
  const r = resolveSelectedLegs(
    [{ pick: 'A', odds: -136 }, { pick: 'B', odds: -109 }],
    [
      { odds_american: -136, suspended: true, fetched_at: '2026-09-18T04:20:00.000Z' },
      { odds_american: -109, event_live: false, fetched_at: '2026-09-18T04:20:00.000Z' }
    ],
    nowMs
  );
  assert(r.hardFail);
  assertEq(r.hardFail.code, 'market_suspended');
  assertEq(r.hardFail.legIndex, 0);
});

test('single bet same stale/current fixture prefers current', function() {
  const nowMs = Date.parse('2026-09-18T04:21:47.000Z');
  const picked = _pickProviderGameIdSnapshotRow([
    {
      canonical_game_key: 'golf|Rasmus Neergaard-Petersen|Brooks Koepka|2026-09-17',
      odds_american: -124, event_live: true, fetched_at: '2026-09-17T17:30:00.000Z'
    },
    {
      canonical_game_key: 'golf|Rasmus Neergaard-Petersen|Brooks Koepka|2026-09-18',
      odds_american: -136, event_live: false, fetched_at: '2026-09-18T04:20:00.000Z'
    }
  ], { preferredDate: '2026-09-18', today: '2026-09-18', nowMs: nowMs });
  assertEq(picked.odds_american, -136);
  assertEq(_classifyMarket(picked, nowMs), 'active');
});

test('sport coverage fixtures: ML/total/spread/prop identity tokens stay distinct', function() {
  const fixtures = [
    { sport: 'golf', key: 'golf|Rasmus Neergaard-Petersen|Brooks Koepka|2026-09-18', sel: 'rasmus neergaard-petersen', mkt: 'moneyline' },
    { sport: 'mlb', key: 'baseball_mlb|Boston Red Sox|New York Yankees|2026-09-18', sel: 'boston red sox', mkt: 'moneyline' },
    { sport: 'nfl', key: 'americanfootball_nfl|Kansas City Chiefs|Buffalo Bills|2026-09-18', sel: 'over:47.5', mkt: 'total' },
    { sport: 'nba', key: 'basketball_nba|Los Angeles Lakers|Boston Celtics|2026-09-18', sel: 'los angeles lakers:-3.5', mkt: 'spread' },
    { sport: 'nhl', key: 'icehockey_nhl|Toronto Maple Leafs|Montreal Canadiens|2026-09-18', sel: 'toronto maple leafs', mkt: 'moneyline' },
    { sport: 'soccer', key: 'soccer_epl|Arsenal|Chelsea|2026-09-18', sel: 'arsenal', mkt: 'moneyline' },
    { sport: 'tennis', key: 'tennis|Carlos Alcaraz|Jannik Sinner|2026-09-18', sel: 'carlos alcaraz', mkt: 'moneyline' },
    { sport: 'nba_prop', key: 'basketball_nba|Lakers|Celtics|2026-09-18', sel: 'lebron_james:points:over:25.5', mkt: 'player_prop' }
  ];
  fixtures.forEach(function(f) {
    assert(!!f.key && !!f.sel, f.sport + ' fixture present');
    if (f.mkt === 'total' || f.mkt === 'spread') {
      const split = _splitSelectionKeyLine(f.sel);
      assert(!!split.lineSuffix, f.sport + ' must keep line suffix');
    }
  });
  // Neighbor totals remain distinct under selection equivalence
  ['8.5', '9', '9.5', '10'].forEach(function(a, i, arr) {
    arr.forEach(function(b) {
      if (a === b) {
        assert(_selectionKeysEquivalent('over:' + a, 'over:' + b));
      } else {
        assert(!_selectionKeysEquivalent('over:' + a, 'over:' + b),
          'Over ' + a + ' must not equal Over ' + b);
      }
    });
  });
});

test('odds_stale copy is not "Odds refreshing"', function() {
  assert(!indexSource.includes('Odds refreshing — please try again.'),
    'misleading refreshing copy must be removed');
  assert(indexSource.includes('Current odds unavailable for this selection — please try again.'),
    'accurate odds_stale copy required');
});

test('confirmationQuote still minted only from verify reject path (not stale first-row)', function() {
  assert(indexSource.includes('mintConfirmationQuote'), 'quote mint retained');
  assert(indexSource.includes('verifyConfirmationQuote'), 'quote verify retained');
  assert(indexSource.includes('_pickProviderGameIdSnapshotRow'),
    'quote path inherits CURRENT snapshot selection via shared verify');
});

test('live-cache matchup norm covers hyphen gap', function() {
  assert(indexSource.includes('_gameKeyMatchupNorm(cKey)'),
    'live-cache prefix fallback must use matchup norm');
  assert(indexSource.includes('function _gameKeyMatchupNorm'),
    'matchup norm helper must exist');
});

test('canonical + legacy lookups order by fetched_at desc', function() {
  assert(/canonical_market_key[\s\S]{0,200}order\('fetched_at'/.test(indexSource),
    'canonical tier must order fetched_at');
  assert(/canonical_game_key[\s\S]{0,280}order\('fetched_at'/.test(indexSource),
    'legacy tier must order fetched_at');
});

console.log('\n' + _pass + ' passed, ' + _fail + ' failed');
if (_fail) process.exit(1);
