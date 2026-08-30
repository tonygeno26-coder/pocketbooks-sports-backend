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

test('odds poller uses recursive setTimeout plus 30s watchdog', function() {
  assert(indexSource.includes('function _scheduleOddsPollTick'), 'recursive setTimeout scheduler missing');
  assert(indexSource.includes('function _runOddsPollTick'), 'poll tick runner missing');
  assert(indexSource.includes('const POLL_WATCHDOG_STALE_MS = 30 * 1000'), 'watchdog must restart after 30s');
  assert(indexSource.includes(" _startOddsPoller('watchdog_stale')"), 'watchdog restart reason missing');
  assert(indexSource.includes('_scheduleOddsPollTick(LIVE_CACHE_POLL_INTERVAL_MS)'), 'next tick must be scheduled from finally');
  assert(indexSource.includes('} finally {'), 'tick must schedule next run in finally');
  assert(!/setInterval\(\s*pollLiveOddsLoopWithSnapshots/.test(indexSource),
    'in-process poller must not use setInterval');
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
