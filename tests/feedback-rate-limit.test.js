'use strict';

const assert = require('assert');
const feedback = require('../lib/feedback');

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

function row(id, createdAtMs) {
  return { id: id, created_at: new Date(createdAtMs).toISOString() };
}

console.log('\n-- feedback rate limit (8 / 15m / actor) --');

test('constants are 8 / 15 minutes', function () {
  assert.strictEqual(feedback.RATE_LIMIT, 8);
  assert.strictEqual(feedback.RATE_WINDOW_MS, 15 * 60 * 1000);
});

test('rateLimitActorKey is server player id only', function () {
  assert.strictEqual(feedback.rateLimitActorKey('player-a'), 'feedback:actor:player-a');
  assert.ok(!String(feedback.rateLimitActorKey('player-a')).includes('club'));
});

test('requests 1-8 allowed', function () {
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

test('9th request denied with Retry-After', function () {
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

test('same actor after limit still 429', function () {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(row('a' + i, now - 30 * 1000));
  assert.strictEqual(feedback.evaluateActorRateLimit(rows, now).allowed, false);
  assert.strictEqual(feedback.evaluateActorRateLimit(rows, now + 1000).allowed, false);
});

test('different actors independent', function () {
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

test('spoofed club/player cannot change bucket key', function () {
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

test('window expiration frees a slot', function () {
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

test('concurrent burst keeps oldest 8 only', function () {
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

test('auth denied before write — unauthenticated', function () {
  const r = feedback.deriveIdentity({ error: 'unauthenticated', status: 401 }, {
    category: 'bug', message: 'x', playerId: 'attacker'
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.http, 401);
});

test('no financial coupling in rate-limit helpers', function () {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'feedback.js'), 'utf8'
  );
  assert.ok(!/place_bet_tx|grade_ticket_tx|cancel_bet_tx|ledger|diamonds|settlement/i.test(src));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
console.log('feedback rate limit: PASS');
