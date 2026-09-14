'use strict';

const assert = require('assert');
const feedback = require('../lib/feedback');

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('  OK ' + name);
    pass++;
  } catch (e) {
    console.error('  FAIL ' + name + '\n     ' + e.message);
    fail++;
  }
}

function row(id, createdAtMs) {
  return { id: id, created_at: new Date(createdAtMs).toISOString() };
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function storeInWindow(store, playerId, nowMs) {
  const since = nowMs - feedback.RATE_WINDOW_MS;
  return store
    .filter(function (r) {
      return r.player_id === playerId && new Date(r.created_at).getTime() >= since;
    })
    .sort(function (a, b) {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      if (ta !== tb) return ta - tb;
      return String(a.id).localeCompare(String(b.id));
    });
}

/**
 * Production-style path: pre-count → insert → post-count → rollback excess.
 * Shared mutable store + random yields (not serialized helper-only).
 */
async function prodPathRequest(store, playerId, seq) {
  const nowMs = Date.now();
  await sleep(Math.floor(Math.random() * 8));
  const recent = storeInWindow(store, playerId, nowMs);
  const decision = feedback.evaluateActorRateLimit(recent, nowMs);
  if (!decision.allowed) {
    return { status: 429, wrote: false, phase: 'pre' };
  }
  await sleep(Math.floor(Math.random() * 12));
  const id = 'c-' + seq + '-' + Math.random().toString(16).slice(2, 10);
  const created_at = new Date().toISOString();
  store.push({ id: id, player_id: playerId, created_at: created_at });
  await sleep(Math.floor(Math.random() * 12));
  const after = storeInWindow(store, playerId, Date.now());
  if (after.length > feedback.RATE_LIMIT) {
    if (!feedback.acceptInsertedUnderLimit(after, id, feedback.RATE_LIMIT)) {
      const idx = store.findIndex(function (r) { return r.id === id; });
      if (idx >= 0) store.splice(idx, 1);
      return { status: 429, wrote: false, phase: 'post' };
    }
  }
  return { status: 200, wrote: true, phase: 'ok', id: id };
}

/** Naive COUNT→INSERT only — expected to overshoot under burst. */
async function naiveCountThenInsert(store, playerId, seq) {
  const nowMs = Date.now();
  await sleep(Math.floor(Math.random() * 8));
  const recent = storeInWindow(store, playerId, nowMs);
  if (!feedback.evaluateActorRateLimit(recent, nowMs).allowed) {
    return { status: 429, wrote: false };
  }
  await sleep(Math.floor(Math.random() * 12));
  store.push({
    id: 'n-' + seq + '-' + Math.random().toString(16).slice(2, 10),
    player_id: playerId,
    created_at: new Date().toISOString()
  });
  return { status: 200, wrote: true };
}

async function main() {
  console.log('\n-- feedback rate limit (8 / 15m / actor) --');

  await test('constants are 8 / 15 minutes', function () {
    assert.strictEqual(feedback.RATE_LIMIT, 8);
    assert.strictEqual(feedback.RATE_WINDOW_MS, 15 * 60 * 1000);
  });

  await test('rateLimitActorKey is server player id only', function () {
    assert.strictEqual(feedback.rateLimitActorKey('player-a'), 'feedback:actor:player-a');
    assert.ok(!String(feedback.rateLimitActorKey('player-a')).includes('club'));
  });

  await test('requests 1-8 allowed', function () {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0);
    for (let n = 0; n < 8; n++) {
      const rows = [];
      for (let i = 0; i < n; i++) rows.push(row('r' + i, now - (n - i) * 1000));
      const d = feedback.evaluateActorRateLimit(rows, now);
      assert.strictEqual(d.allowed, true, 'n=' + n);
      assert.strictEqual(d.count, n);
      assert.strictEqual(d.remaining, 8 - n);
      assert.strictEqual(d.retryAfterSec, 0);
    }
  });

  await test('9th request denied with Retry-After', function () {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0);
    const oldest = now - 60 * 1000;
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push(row('r' + i, oldest + i * 1000));
    const d = feedback.evaluateActorRateLimit(rows, now);
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.remaining, 0);
    // Oldest ages out in 14 minutes from now (15m window - 1m age).
    assert.ok(d.retryAfterSec >= 14 * 60 - 5 && d.retryAfterSec <= 14 * 60 + 5,
      'retryAfterSec=' + d.retryAfterSec);
  });

  await test('same actor after limit still 429', function () {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0);
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push(row('a' + i, now - 30 * 1000));
    assert.strictEqual(feedback.evaluateActorRateLimit(rows, now).allowed, false);
    assert.strictEqual(feedback.evaluateActorRateLimit(rows, now + 1000).allowed, false);
  });

  await test('different actors independent', function () {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0);
    const actorA = [];
    for (let i = 0; i < 8; i++) actorA.push(row('a' + i, now - 1000));
    const actorB = [row('b0', now - 500)];
    assert.strictEqual(feedback.evaluateActorRateLimit(actorA, now).allowed, false);
    assert.strictEqual(feedback.evaluateActorRateLimit(actorB, now).allowed, true);
    assert.notStrictEqual(
      feedback.rateLimitActorKey('player-a'),
      feedback.rateLimitActorKey('player-b')
    );
  });

  await test('spoofed club/player cannot change bucket key', function () {
    const id = feedback.deriveIdentity(
      { actorId: 'player-real', clubId: 'club-1' },
      { playerId: 'player-spoof', clubId: 'club-1' }
    );
    assert.strictEqual(id.playerId, 'player-real');
    assert.strictEqual(
      feedback.rateLimitActorKey(id.playerId),
      'feedback:actor:player-real'
    );
  });

  await test('window expiration frees a slot', function () {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0);
    const windowMs = feedback.RATE_WINDOW_MS;
    const rows = [];
    // 8 rows; oldest just outside window after +1ms past expiry
    rows.push(row('old', now - windowMs));
    for (let i = 1; i < 8; i++) rows.push(row('r' + i, now - 60 * 1000));
    assert.strictEqual(feedback.evaluateActorRateLimit(rows, now).allowed, false);
    const later = now + 1;
    const d = feedback.evaluateActorRateLimit(rows, later);
    assert.strictEqual(d.allowed, true, 'oldest aged out');
    assert.strictEqual(d.count, 7);
  });

  await test('concurrent burst keeps oldest 8 only', function () {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0);
    const rows = [];
    for (let i = 0; i < 12; i++) {
      rows.push(row('id-' + i, now + i));
    }
    let kept = 0;
    let rejected = 0;
    for (let i = 0; i < 12; i++) {
      if (feedback.acceptInsertedUnderLimit(rows, 'id-' + i, 8)) kept++;
      else rejected++;
    }
    assert.strictEqual(kept, 8);
    assert.strictEqual(rejected, 4);
    assert.ok(feedback.acceptInsertedUnderLimit(rows, 'id-0', 8));
    assert.ok(feedback.acceptInsertedUnderLimit(rows, 'id-7', 8));
    assert.ok(!feedback.acceptInsertedUnderLimit(rows, 'id-8', 8));
    assert.ok(!feedback.acceptInsertedUnderLimit(rows, 'id-11', 8));
  });

  await test('production-path concurrent burst caps accepted at 8', async function () {
    const playerId = 'burst-actor-a';
    let worstAccepted = 0;
    let worstRemaining = 0;
    for (let round = 0; round < 12; round++) {
      const store = [];
      const n = 24;
      const results = await Promise.all(
        Array.from({ length: n }, function (_, i) {
          return prodPathRequest(store, playerId, i);
        })
      );
      const accepted = results.filter(function (r) { return r.status === 200; }).length;
      const remaining = storeInWindow(store, playerId, Date.now()).length;
      if (accepted > worstAccepted) worstAccepted = accepted;
      if (remaining > worstRemaining) worstRemaining = remaining;
      assert.strictEqual(accepted, 8, 'round ' + round + ' accepted=' + accepted);
      assert.strictEqual(remaining, 8, 'round ' + round + ' remaining=' + remaining);
      assert.ok(results.every(function (r) {
        return r.status === 200 || r.status === 429;
      }));
    }
    assert.strictEqual(worstAccepted, 8);
    assert.strictEqual(worstRemaining, 8);
  });

  await test('naive COUNT→INSERT overshoots (control — why post-rollback is required)', async function () {
    const playerId = 'naive-actor';
    let sawOvershoot = false;
    for (let round = 0; round < 20 && !sawOvershoot; round++) {
      const store = [];
      const results = await Promise.all(
        Array.from({ length: 24 }, function (_, i) {
          return naiveCountThenInsert(store, playerId, i);
        })
      );
      const accepted = results.filter(function (r) { return r.status === 200; }).length;
      if (accepted > 8) sawOvershoot = true;
    }
    assert.ok(sawOvershoot, 'control must demonstrate COUNT→INSERT race past 8');
  });

  await test('auth denied before write — unauthenticated', function () {
    const r = feedback.deriveIdentity({ error: 'unauthenticated', status: 401 }, {
      category: 'bug', message: 'x', playerId: 'attacker'
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.http, 401);
  });

  await test('no financial coupling in rate-limit helpers', function () {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib', 'feedback.js'), 'utf8'
    );
    assert.ok(!/place_bet_tx|grade_ticket_tx|cancel_bet_tx|ledger|diamonds|settlement/i.test(src));
  });

  await test('route fail-closes concurrent post-check errors with rollback', function () {
    const route = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'index.js'), 'utf8'
    );
    const start = route.indexOf("app.post('/api/feedback'");
    const end = route.indexOf("app.post('/api/notifications/read'");
    assert.ok(start > 0 && end > start);
    const slice = route.slice(start, end);
    assert.ok(slice.includes('acceptInsertedUnderLimit'), 'post-insert burst guard');
    assert.ok(slice.includes('concurrent rate check failed (rollback)')
      || slice.includes('concurrent rate check exception (rollback)'),
      'fail-closed rollback on post-check failure');
    assert.ok(!slice.includes('concurrent rate check skipped'), 'no fail-open skip');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
  console.log('feedback rate limit: PASS');
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
