'use strict';

// Snapshot place-bet contract: frontend builder fields === backend ingest
// fields, then a live single + 3-leg parlay against real Owls markets.
//
// Run: node tests/place-bet-contract.test.js
// Optional: PLACE_BET_BASE=https://... PLACE_BET_SKIP_LIVE=1

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CONTRACT_FIELDS = [
  'pick', 'market', 'odds', 'line', 'canonicalGameKey', 'scheduledStart', 'gameId'
];
const LIVE_BASE = process.env.PLACE_BET_BASE
  || 'https://pocketbooks-sports-backend-production.up.railway.app';
const ACTOR_ID = '2a3e6819-be2f-4df3-8112-54ce19d0929e';
const CLUB_ID  = 'd616dc2a-95a6-473a-97b1-7da330878479';
const FE_PLAYER = path.resolve(__dirname, '../../pocketbooks-sports/player.html');
const INDEX_JS  = path.join(__dirname, '..', 'index.js');

let _pass = 0;
let _fail = 0;
const results = { liveBase: LIVE_BASE, localBase: null, single: null, parlay: null };

function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      throw new Error('async test must be awaited via runAsync, not test(): ' + name);
    }
    console.log('  OK  ' + name);
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
    throw new Error((msg || 'values differ')
      + ' - got ' + JSON.stringify(actual) + ' expected ' + JSON.stringify(expected));
  }
}

const indexSource = fs.readFileSync(INDEX_JS, 'utf8');
const html = fs.existsSync(FE_PLAYER) ? fs.readFileSync(FE_PLAYER, 'utf8') : '';

function extractFn(src, name) {
  const start = src.indexOf('function ' + name);
  assert(start !== -1, 'missing function ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unterminated function ' + name);
}

console.log('\n-- Place-bet snapshot contract --');

test('backend declares the seven contract fields', function() {
  assert(indexSource.includes('PLACE_BET_LEG_CONTRACT_FIELDS'));
  assert(indexSource.includes('function _ingestPlaceBetLeg'));
  assert(indexSource.includes('function _validatePlaceBetLegContract'));
  CONTRACT_FIELDS.forEach(function(f) {
    assert(indexSource.indexOf("'" + f + "'") !== -1, 'backend contract missing ' + f);
  });
  assert(indexSource.includes('_missing_gameId'));
  assert(indexSource.includes('_missing_scheduledStart'));
  assert(indexSource.includes('_missing_canonicalGameKey'));
  assert(!/_missing_homeTeam/.test(indexSource), 'must not require homeTeam');
  assert(!/_missing_awayTeam/.test(indexSource), 'must not require awayTeam');
  assert(!/_missing_sport/.test(indexSource), 'must not require sport');
});

test('frontend builder return matches backend contract fields', function() {
  assert(html, 'frontend player.html not found at ' + FE_PLAYER);
  const builder = extractFn(html, '_buildContractPlaceLeg');
  CONTRACT_FIELDS.forEach(function(f) {
    assert(new RegExp('^\\s*' + f + '\\s*:', 'm').test(builder)
      || builder.indexOf(f + ':') !== -1,
      'frontend builder missing ' + f);
  });
  const ingest = extractFn(indexSource, '_ingestPlaceBetLeg');
  assert(ingest.indexOf('out.gameId') !== -1);
  assert(ingest.indexOf('out.scheduledStart') !== -1);
  assert(ingest.indexOf('out.canonicalGameKey') !== -1);
  assert(html.indexOf('_buildContractPlaceLeg(leg)') !== -1, 'confirmBet must use builder');
  assert(html.indexOf('_buildContractPlaceLeg(b)') !== -1, '_makeSelection must use builder');
  assert(html.indexOf('_buildContractPlaceLeg(Object.assign({}, sel') !== -1,
    'bsToggle must use builder');
  assert(html.indexOf('data-game-id=') !== -1, 'click cells must carry gameId');
});

test('backend snapshot lookup reads contract gameId + scheduledStart + line', function() {
  const verify = extractFn(indexSource, '_verifyLegOddsSnapshot');
  assert(verify.indexOf('gameId=') !== -1, 'must log gameId');
  assert(verify.indexOf('scheduledStart=') !== -1, 'must log scheduledStart');
  assert(verify.indexOf('provider_game_id') !== -1, 'must look up by provider_game_id');
  assert(verify.indexOf("odds_changed") !== -1, 'must keep exact-odds matching');
  assert(verify.indexOf('exact_match_required') !== -1, 'must keep exact-odds matching');
});

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = JSON.parse(JSON.stringify(body));
  function walk(o) {
    if (!o || typeof o !== 'object') return;
    Object.keys(o).forEach(function(k) {
      if (/token|jwt|authorization|secret/i.test(k)) o[k] = '[redacted]';
      else walk(o[k]);
    });
  }
  walk(copy);
  return copy;
}

async function httpJson(base, method, urlPath, body, token, extraHeaders) {
  const headers = Object.assign({
    'Content-Type': 'application/json',
    'X-Club-Id': CLUB_ID
  }, extraHeaders || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  if (method === 'POST' && urlPath.indexOf('/api/bets/place') !== -1) {
    headers['Idempotency-Key'] = (body && body.idempotencyKey) || ('IK_' + Date.now());
  }
  const res = await fetch(base + urlPath, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let parsed = null;
  const text = await res.text();
  try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text.slice(0, 500) }; }
  return { status: res.status, body: parsed, safeBody: sanitizeBody(parsed) };
}

function amToDec(o) {
  var n = Number(o);
  if (!n) return 1;
  return n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1;
}

function fillOwlsKey(game) {
  var iso = game.scheduledStart || game.time || '';
  var dateStr = '';
  if (iso) {
    var ms = new Date(iso).getTime();
    if (!isNaN(ms)) dateStr = new Date(ms).toISOString().slice(0, 10);
  }
  var key = String(game.canonicalGameKey || '');
  var parts = key.split('|');
  if (parts.length >= 4 && !/^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 1] || '') && dateStr) {
    parts[parts.length - 1] = dateStr;
    key = parts.join('|');
  }
  if (!key && game.away && game.home && dateStr) {
    key = 'baseball_mlb|' + game.away + '|' + game.home + '|' + dateStr;
  }
  return key;
}

function toIso(v) {
  if (!v) return null;
  var ms = new Date(v).getTime();
  if (isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function isUpcoming(game, nowMs) {
  var status = String(game.status || '').toLowerCase();
  if (status === 'live' || status === 'final' || status === 'canceled' || status === 'cancelled') return false;
  var iso = toIso(game.scheduledStart || game.time);
  if (!iso) return false;
  return new Date(iso).getTime() > nowMs + 60 * 1000;
}

function contractLegFromGame(game, kind) {
  var iso = toIso(game.scheduledStart || game.time);
  var key = fillOwlsKey(game);
  var gameId = String(game.id || game.providerGameId || '');
  if (kind === 'moneyline') {
    var ml = (game.moneyline || []).find(function(m) { return m && m.odds; });
    if (!ml) return null;
    var pick = String(ml.team || ml.name || '').replace(/\s+to\s+win\s*$/i, '').trim();
    if (!pick) return null;
    return {
      pick: pick,
      market: 'moneyline',
      odds: Number(ml.odds),
      line: null,
      canonicalGameKey: key,
      scheduledStart: iso,
      gameId: gameId
    };
  }
  if (kind === 'total') {
    var ov = (game.totals || []).find(function(t) { return t && /over/i.test(t.name || ''); })
      || (game.totals || []).find(function(t) { return t && t.odds; });
    if (!ov || ov.line == null || !ov.odds) return null;
    return {
      pick: 'Over ' + ov.line,
      market: 'total',
      odds: Number(ov.odds),
      line: Number(ov.line),
      canonicalGameKey: key,
      scheduledStart: iso,
      gameId: gameId
    };
  }
  if (kind === 'spread') {
    var sp = (game.spreads || []).find(function(s) { return s && s.odds && s.line != null; });
    if (!sp) return null;
    var team = sp.team || sp.name;
    var line = Number(sp.line);
    var pick = team + ' ' + (line > 0 ? '+' : '') + line;
    return {
      pick: pick,
      market: 'spread',
      odds: Number(sp.odds),
      line: line,
      canonicalGameKey: key,
      scheduledStart: iso,
      gameId: gameId
    };
  }
  return null;
}

function assertContractLeg(leg, label) {
  CONTRACT_FIELDS.forEach(function(f) {
    assert(Object.prototype.hasOwnProperty.call(leg, f), label + ' missing ' + f);
  });
  assert(typeof leg.pick === 'string' && leg.pick.length > 0, label + ' pick');
  assert(/to win/i.test(leg.pick) === false, label + ' pick must not include To Win');
  assert(['moneyline','total','spread'].indexOf(leg.market) !== -1, label + ' market=' + leg.market);
  assert(typeof leg.odds === 'number' && Number.isFinite(leg.odds), label + ' odds');
  assert(leg.line === null || Number.isFinite(Number(leg.line)), label + ' line');
  if (leg.market === 'moneyline') assertEq(leg.line, null, label + ' moneyline line');
  if (leg.market === 'total' || leg.market === 'spread') {
    assert(Number.isFinite(Number(leg.line)), label + ' needs numeric line');
  }
  assert(/\|/.test(leg.canonicalGameKey) && /\d{4}-\d{2}-\d{2}$/.test(leg.canonicalGameKey),
    label + ' canonicalGameKey Owls date form: ' + leg.canonicalGameKey);
  assert(/^\d{4}-\d{2}-\d{2}T/.test(leg.scheduledStart) && /Z$/.test(leg.scheduledStart),
    label + ' scheduledStart ISO UTC: ' + leg.scheduledStart);
  assert(typeof leg.gameId === 'string' && leg.gameId.length > 0, label + ' gameId');
}

function uniqueCandidates(games, nowMs) {
  const upcoming = (games || []).filter(function(g) { return isUpcoming(g, nowMs); });
  const seen = {};
  const packed = [];
  upcoming.forEach(function(g) {
    var key = fillOwlsKey(g) || String(g.id || g.providerGameId || '');
    if (!key || seen[key]) return;
    var row = {
      key: key,
      moneyline: contractLegFromGame(g, 'moneyline'),
      total: contractLegFromGame(g, 'total'),
      spread: contractLegFromGame(g, 'spread')
    };
    if (!row.moneyline) return;
    try { assertContractLeg(row.moneyline, 'ml'); } catch (e) { return; }
    if (row.total) { try { assertContractLeg(row.total, 'tot'); } catch (e) { row.total = null; } }
    if (row.spread) { try { assertContractLeg(row.spread, 'sp'); } catch (e) { row.spread = null; } }
    seen[key] = true;
    packed.push(row);
  });
  return packed;
}

function conflictToken(leg) {
  return String(leg.canonicalGameKey) + '|' + String(leg.market || '').toLowerCase();
}

function buildParlay(candidates, blocked) {
  const parlay = [];
  const used = Object.assign({}, blocked || {});
  function tryAdd(leg) {
    if (!leg || parlay.length >= 3) return;
    var tok = conflictToken(leg);
    if (used[tok]) return;
    parlay.push(leg);
    used[tok] = true;
  }
  candidates.forEach(function(p) { tryAdd(p.moneyline); });
  candidates.forEach(function(p) { tryAdd(p.total); });
  candidates.forEach(function(p) { tryAdd(p.spread); });
  return parlay.length >= 3 ? parlay.slice(0, 3) : null;
}

function ticketPayout(stake, legs) {
  var product = legs.reduce(function(p, l) { return p * amToDec(l.odds); }, 1);
  return Math.round(stake * product * 100) / 100;
}

async function mintSession(base) {
  const r = await httpJson(base, 'POST', '/api/auth/token', {
    actorId: ACTOR_ID,
    clubId: CLUB_ID
  });
  if (r.status !== 200 || !r.body || !r.body.token) {
    throw new Error('token mint failed status=' + r.status + ' body=' + JSON.stringify(r.body));
  }
  const clubId = r.body.clubId || r.body.club_id || CLUB_ID;
  const actorId = r.body.actorId || r.body.actor_id || ACTOR_ID;
  return { token: r.body.token, clubId: clubId, actorId: actorId };
}

async function placeBet(base, session, betType, legs, stake) {
  const payload = {
    clubId: session.clubId,
    playerId: session.actorId,
    betType: betType,
    stake: stake,
    payout: ticketPayout(stake, legs),
    potentialProfit: Math.round((ticketPayout(stake, legs) - stake) * 100) / 100,
    idempotencyKey: 'CONTRACT_' + betType + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    legs: legs
  };
  let r = await httpJson(base, 'POST', '/api/bets/place', payload, session.token, {
    'X-Club-Id': session.clubId
  });
  if (r.status === 409 && r.body && r.body.code === 'odds_changed' && Number.isFinite(Number(r.body.serverOdds))) {
    const changed = String(r.body.leg || '');
    payload.legs = payload.legs.map(function(leg) {
      if (leg.pick === changed || changed.indexOf(leg.pick) !== -1) {
        return Object.assign({}, leg, { odds: Number(r.body.serverOdds) });
      }
      return leg;
    });
    payload.idempotencyKey = payload.idempotencyKey + '_oa';
    payload.payout = ticketPayout(stake, payload.legs);
    r = await httpJson(base, 'POST', '/api/bets/place', payload, session.token, {
      'X-Club-Id': session.clubId
    });
  }
  return r;
}

async function fetchUpcomingGames(base, token) {
  const sports = ['mlb', 'nba', 'nhl', 'nfl'];
  let all = [];
  for (var i = 0; i < sports.length; i++) {
    const r = await httpJson(base, 'GET', '/api/odds/' + sports[i], null, token);
    if (r.status === 200 && Array.isArray(r.body)) all = all.concat(r.body);
    else if (r.body && Array.isArray(r.body.games)) all = all.concat(r.body.games);
  }
  return all;
}

function summarizeFail(r) {
  return 'status=' + r.status + ' body=' + JSON.stringify(r.safeBody || sanitizeBody(r.body));
}

async function runAgainst(base, label) {
  const health = await httpJson(base, 'GET', '/api/health', null, null);
  console.log('  health[' + label + '] commit=' + ((health.body && (health.body.commit || health.body.bakedSHA)) || '?')
    + ' oddsStatus=' + ((health.body && health.body.oddsStatus) || '?')
    + ' ok=' + ((health.body && health.body.ok) || false));
  const session = await mintSession(base);
  const games = await fetchUpcomingGames(base, session.token);
  const nowMs = Date.now();
  const candidates = uniqueCandidates(games, nowMs);
  if (!candidates.length) {
    throw new Error('[' + label + '] no placeable upcoming markets from /api/odds (games=' + games.length + ')');
  }

  const blocked = {};
  let singleLeg = null;
  let single = null;
  for (var si = 0; si < candidates.length; si++) {
    const cand = candidates[si].moneyline;
    assertContractLeg(cand, label + ' single-try');
    single = await placeBet(base, session, 'Single', [cand], 1);
    if (single.status === 200 && single.body && single.body.ok === true) {
      singleLeg = cand;
      blocked[conflictToken(cand)] = true;
      break;
    }
    if (single.status === 409 && /conflict_active_bet/.test(String(single.body && single.body.error || ''))) {
      blocked[conflictToken(cand)] = true;
      continue;
    }
    throw new Error('[' + label + '] single place failed ' + summarizeFail(single));
  }
  results[label === 'live' ? 'single' : 'localSingle'] = {
    ok: !!singleLeg, status: single && single.status, body: single && single.body
  };
  if (!singleLeg) {
    throw new Error('[' + label + '] single place failed after retries ' + summarizeFail(single || { status: 0, body: {} }));
  }
  console.log('  OK  ' + label + ' single placed');

  let parlayLegs = buildParlay(candidates, blocked);
  if (!parlayLegs) {
    throw new Error('[' + label + '] need 3 parlay legs from distinct upcoming games (usableGames=' + candidates.length + ')');
  }
  parlayLegs.forEach(function(leg, i) { assertContractLeg(leg, label + ' parlay' + i); });
  let parlay = await placeBet(base, session, 'Parlay', parlayLegs, 1);
  for (var pr = 0; pr < 6 && parlay.status === 409 && /conflict_active_bet/.test(String(parlay.body && parlay.body.error || '')); pr++) {
    const hit = String(parlay.body.error || '').replace(/^conflict_active_bet:/, '');
    if (hit) {
      blocked[hit + '|moneyline'] = true;
      blocked[hit + '|total'] = true;
      blocked[hit + '|spread'] = true;
    }
    parlayLegs = buildParlay(candidates, blocked);
    if (!parlayLegs) break;
    parlay = await placeBet(base, session, 'Parlay', parlayLegs, 1);
  }
  const parlayOk = parlay.status === 200 && parlay.body && parlay.body.ok === true;
  results[label === 'live' ? 'parlay' : 'localParlay'] = {
    ok: parlayOk, status: parlay.status, body: parlay.body
  };
  if (!parlayOk) {
    throw new Error('[' + label + '] parlay place failed ' + summarizeFail(parlay));
  }
  console.log('  OK  ' + label + ' 3-leg parlay placed');
  return true;
}

function waitHealth(base, ms) {
  const deadline = Date.now() + ms;
  return (async function poll() {
    while (Date.now() < deadline) {
      try {
        const r = await httpJson(base, 'GET', '/api/health', null, null);
        if (r.status === 200) return r;
      } catch (_) {}
      await new Promise(function(res) { setTimeout(res, 1000); });
    }
    throw new Error('local backend did not become healthy at ' + base);
  })();
}

async function maybeStartLocal() {
  const local = process.env.PLACE_BET_LOCAL_BASE || 'http://127.0.0.1:3000';
  try {
    const r = await httpJson(local, 'GET', '/api/health', null, null);
    if (r.status === 200) {
      results.localBase = local;
      return { base: local, started: false };
    }
  } catch (_) {}
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    return { base: null, started: false, reason: 'no_local_env' };
  }
  console.log('  starting local backend on :3000');
  const child = spawn('node', ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', function() {});
  child.stderr.on('data', function() {});
  try {
    await waitHealth(local, 25000);
    results.localBase = local;
    return { base: local, started: true, child: child };
  } catch (e) {
    try { child.kill(); } catch (_) {}
    return { base: null, started: false, reason: String(e.message || e) };
  }
}

async function runLive() {
  if (process.env.PLACE_BET_SKIP_LIVE === '1' || process.env.JEST_WORKER_ID) {
    console.log('  skip live (PLACE_BET_SKIP_LIVE or jest)');
    return;
  }
  let liveErr = null;
  try {
    await runAgainst(LIVE_BASE, 'live');
    results.live = 'passed';
    return;
  } catch (e) {
    liveErr = e;
    results.live = 'failed';
    results.liveError = e.message;
    console.error('  FAIL live: ' + e.message);
  }

  const local = await maybeStartLocal();
  if (!local.base) {
    throw new Error('live failed and local unavailable (' + (local.reason || 'unknown')
      + '): ' + (liveErr && liveErr.message));
  }
  try {
    await runAgainst(local.base, 'local');
    results.local = 'passed';
    if (liveErr) {
      throw new Error('live failed because Railway is likely on an old SHA; local passed. live error: '
        + liveErr.message);
    }
  } finally {
    if (local.child) {
      try { local.child.kill(); } catch (_) {}
    }
  }
}

(async function main() {
  try {
    await runLive();
    console.log('  OK  live single + 3-leg parlay');
    _pass++;
  } catch (e) {
    console.error('  FAIL live single + 3-leg parlay\n     ' + e.message);
    _fail++;
  }
  console.log('\nPlace-bet contract tests: ' + _pass + ' passed, ' + _fail + ' failed');
  if (_fail > 0) process.exit(1);
})();
