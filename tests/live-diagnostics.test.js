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

const CODES = new Set([
  'live_betting_disabled',
  'odds_changed',
  'line_changed',
  'odds_stale',
  'market_unavailable',
  'live_stake_above_max',
  'live_payout_above_max',
  'live_sport_disabled',
  'live_parlays_disabled',
  'snapshot_missing',
  'provider_unhealthy',
  'final_recheck_failed'
]);

function makeDiagnostics() {
  return { counters:Object.create(null), recent:[] };
}

function normalize(code, reason) {
  if (code === 'odds_service_unavailable' && reason === 'snapshot_missing') return 'snapshot_missing';
  return code || 'unknown';
}

function record(diag, code, ctx) {
  ctx = ctx || {};
  const normalized = normalize(code, ctx.reason);
  if (!CODES.has(normalized)) return;
  const prev = diag.counters[normalized] || { count:0 };
  const entry = {
    code:normalized,
    at:new Date().toISOString(),
    phase:ctx.phase || null,
    reason:ctx.reason || null,
    sport:ctx.sport || null,
    clubId:ctx.clubId || null,
    canonicalGameKey:ctx.canonicalGameKey || null
  };
  diag.counters[normalized] = {
    count:prev.count + 1,
    lastAt:entry.at,
    sport:entry.sport,
    clubId:entry.clubId,
    canonicalGameKey:entry.canonicalGameKey
  };
  diag.recent.push(entry);
  if (diag.recent.length > 50) diag.recent.splice(0, diag.recent.length - 50);
  if (ctx.phase === 'final_snapshot') record(diag, 'final_recheck_failed', Object.assign({}, ctx, { phase:'final_snapshot_marker' }));
}

function providerHealth(cache, nowMs, liveTtlMs, pollMs) {
  const updatedAt = cache.updatedAt ? new Date(cache.updatedAt).getTime() : NaN;
  const lastSuccessAt = cache.lastSuccessAt ? new Date(cache.lastSuccessAt).getTime() : NaN;
  const cacheAgeMs = !isNaN(updatedAt) ? nowMs - updatedAt : null;
  const lastSuccessAgeMs = !isNaN(lastSuccessAt) ? nowMs - lastSuccessAt : null;
  const staleForLive = cacheAgeMs == null || cacheAgeMs > liveTtlMs;
  const noRecentSuccess = lastSuccessAgeMs == null || lastSuccessAgeMs > Math.max(liveTtlMs, pollMs * 3);
  return {
    healthy:cache.sourceStatus === 'healthy' && cache.gameCount > 0 && !staleForLive && !noRecentSuccess,
    staleForLive,
    noRecentSuccess
  };
}

console.log('\n-- Live diagnostics --');

test('counters increment and retain last occurrence dimensions', function() {
  const d = makeDiagnostics();
  record(d, 'odds_changed', { sport:'nba', clubId:'club-1', canonicalGameKey:'g1' });
  record(d, 'odds_changed', { sport:'nba', clubId:'club-2', canonicalGameKey:'g2' });
  assertEq(d.counters.odds_changed.count, 2);
  assertEq(d.counters.odds_changed.clubId, 'club-2');
  assertEq(d.counters.odds_changed.canonicalGameKey, 'g2');
});

test('recent-event buffer rolls at 50 events', function() {
  const d = makeDiagnostics();
  for (let i = 0; i < 55; i++) {
    record(d, 'line_changed', { canonicalGameKey:'g'+i });
  }
  assertEq(d.recent.length, 50);
  assertEq(d.recent[0].canonicalGameKey, 'g5');
  assertEq(d.recent[49].canonicalGameKey, 'g54');
});

test('snapshot_missing normalization is counted', function() {
  const d = makeDiagnostics();
  record(d, 'odds_service_unavailable', { reason:'snapshot_missing', sport:'mlb' });
  assertEq(d.counters.snapshot_missing.count, 1);
  assertEq(d.recent[0].code, 'snapshot_missing');
});

test('provider unhealthy state appears for stale live cache', function() {
  const r = providerHealth({
    sourceStatus:'healthy',
    gameCount:10,
    updatedAt:new Date(1000).toISOString(),
    lastSuccessAt:new Date(1000).toISOString()
  }, 20000, 10000, 5000);
  assertEq(r.healthy, false);
  assertEq(r.staleForLive, true);
});

test('final_recheck_failed is recorded alongside original rejection', function() {
  const d = makeDiagnostics();
  record(d, 'odds_changed', { phase:'final_snapshot', sport:'nba' });
  assertEq(d.counters.odds_changed.count, 1);
  assertEq(d.counters.final_recheck_failed.count, 1);
});

test('diagnostics endpoint shape is stable in source', function() {
  [
    "app.get('/api/live/diagnostics'",
    'liveBettingEnabled:LIVE_BETTING_ENABLED',
    'providerHealth',
    'cacheAgeMs:providerHealth.cacheAgeMs',
    'pollIntervalMs:LIVE_CACHE_POLL_INTERVAL_MS',
    'rejectionCounters:_liveDiagnostics.counters',
    'recentRejections:_liveDiagnostics.recent.slice(-50).reverse()',
    'liveExposureSummary',
    'currentLiveEnabledClubs'
  ].forEach(function(marker) {
    assert(indexSource.includes(marker), 'missing endpoint marker: ' + marker);
  });
});

console.log('\nLive diagnostics tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
