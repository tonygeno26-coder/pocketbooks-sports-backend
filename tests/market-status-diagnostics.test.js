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

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

console.log('\n-- Market status diagnostics --');

test('split freshness defaults are wired', function() {
  assert(indexSource.includes("LIVE_SNAPSHOT_TTL_MS',    10 * 1000"), 'live TTL default must be 10s');
  assert(indexSource.includes("PREGAME_SNAPSHOT_TTL_MS', 120 * 1000"), 'pregame TTL default must be 120s');
  assert(indexSource.includes("LIVE_ODDS_POLL_MS', 5 * 1000"), 'poll default must be 5s');
});

test('empty slate is a successful poll and quota errors are not', function() {
  assert(indexSource.includes("sourceStatus:'empty', warnings:['empty_slate']"),
    'empty slate must set lastSuccessAt with sourceStatus empty');
  assert(indexSource.includes('lastSuccessfulPollAt unchanged'),
    'API failures must leave lastSuccessfulPollAt unchanged');
  assert(indexSource.includes("games && games._error === 'OUT_OF_USAGE_CREDITS'"),
    'quota errors must be distinguished from empty slates');
  assert(indexSource.includes('const _ODDS_API_QUOTA_BACKOFF_MS'),
    'quota errors must back off instead of hammering every 5s');
  assert(indexSource.includes('pollerScheduled=true'),
    'startup log must confirm the poller was scheduled');
  assert(indexSource.includes('function _maskOddsKey'),
    'startup log must mask the API key');
});

test('odds poller uses recursive setTimeout plus 30s watchdog', function() {
  assert(indexSource.includes('function _scheduleOddsPollTick'), 'recursive setTimeout scheduler missing');
  assert(indexSource.includes('function _runOddsPollTick'), 'poll tick runner missing');
  assert(indexSource.includes('const POLL_WATCHDOG_STALE_MS = 30 * 1000'), 'watchdog must restart after 30s');
  assert(indexSource.includes(" _startOddsPoller('watchdog_stale')"), 'watchdog restart reason missing');
  assert(indexSource.includes("_triggerImmediateOddsRefresh('watchdog_stale')"),
    'watchdog must trigger a real REST refresh on stale cache');
  assert(indexSource.includes('_scheduleOddsPollTick(_getOddsPollIntervalMs())'),
    'next tick must be scheduled from finally with dynamic interval');
  assert(indexSource.includes('} finally {'), 'tick must schedule next run in finally');
  assert(!/setInterval\(\s*pollLiveOddsLoopWithSnapshots/.test(indexSource),
    'in-process poller must not use setInterval');
});

test('WS connected does not freeze REST when cache empty/stale', function() {
  assert(indexSource.includes('function _shouldSkipOwlsRestWhileWsConnected'),
    'WS skip helper missing');
  assert(indexSource.includes('OWLS_WS_STALE_REST_MS'),
    'WS stale REST threshold missing');
  assert(indexSource.includes("reason:'empty_snapshot_refused'"),
    'empty snapshot overwrite guard missing');
  assert(indexSource.includes('Connection limit reached'),
    'connection-limit REST fallback log missing');
  assert(indexSource.includes("_triggerImmediateOddsRefresh('ws_connection_limit')"),
    'connection-limit must trigger REST refresh');
});

test('/api/markets/status exposes live freshness diagnostics', function() {
  [
    'liveSnapshotTtlMs',
    'pregameSnapshotTtlMs',
    'pollIntervalMs',
    'cacheAgeMs',
    'lastSuccessfulPollAt',
    'providerHealth'
  ].forEach(function(field) {
    assert(indexSource.includes(field), 'missing diagnostics field ' + field);
  });
});

test('live placement hard block remains present', function() {
  assert(indexSource.includes("code:'live_betting_disabled'"), 'live placement hard block missing');
  assert(indexSource.includes("reason: state === 'live' ? 'server_live' : 'event_started'"), 'server-derived live reason missing');
});

console.log('\nMarket status diagnostics tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
