'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const feedback = require('../lib/feedback');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '2026-09-14_feedback_reports.sql'),
  'utf8'
);

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

console.log('\n-- feedback persistence security --');

test('migration is additive feedback_reports only', function () {
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS public.feedback_reports'));
  assert.ok(migration.includes("CHECK (category IN ('bug', 'ux', 'odds', 'ticket', 'other'))"));
  assert.ok(migration.includes("CHECK (status IN ('new', 'reviewed', 'resolved'))"));
  assert.ok(migration.includes('ENABLE ROW LEVEL SECURITY'));
  assert.ok(migration.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON public.feedback_reports TO service_role'));
  assert.ok(!/ALTER TABLE public\.(tickets|ledger|ledger_entries|club_memberships|users)/i.test(migration));
  assert.ok(!/place_bet_tx|grade_ticket_tx|cancel_bet_tx|settlement/i.test(migration));
  assert.ok(!/REFERENCES\s+public\.tickets/i.test(migration), 'no financial FK to tickets');
});

test('route exists and is POST-only create', function () {
  assert.ok(source.includes("app.post('/api/feedback'"), 'POST /api/feedback missing');
  assert.ok(!source.includes("app.get('/api/feedback'"), 'no public listing');
  assert.ok(!source.includes("app.get('/api/feedback/"), 'no enumeration routes');
  const start = source.indexOf("app.post('/api/feedback'");
  const end = source.indexOf('\napp.', start + 10);
  const route = source.slice(start, end > start ? end : start + 2500);
  assert.ok(route.includes('requireActor'), 'auth via requireActor');
  assert.ok(route.includes('feedback.deriveIdentity') || route.includes('deriveIdentity'), 'server-derived identity');
  assert.ok(route.includes('ticket_not_allowed') || route.includes('ticketReferenceAllowed'), 'ticket gate');
  assert.ok(route.includes("from('feedback_reports')"), 'writes feedback_reports');
  assert.ok(!route.includes('place_bet_tx') && !route.includes('grade_ticket_tx') && !route.includes('cancel_bet_tx'));
});

test('feedback rate limit is persistent actor quota (not process Map)', function () {
  const cfgStart = source.indexOf('const RATE_LIMIT_CONFIG');
  const cfgEnd = source.indexOf('};', cfgStart);
  const cfg = source.slice(cfgStart, cfgEnd + 2);
  assert.ok(!cfg.includes("'/api/feedback'"), 'must not use process-local RATE_LIMIT_CONFIG for feedback');
  const start = source.indexOf("app.post('/api/feedback'");
  const end = source.indexOf('\napp.', start + 10);
  const route = source.slice(start, end > start ? end : start + 4500);
  assert.ok(route.includes('evaluateActorRateLimit') || route.includes('rateLimitWindowStartIso'), 'DB-backed check');
  assert.ok(route.includes("eq('player_id', identity.playerId)"), 'keyed by server player_id');
  assert.ok(route.includes("status(429)") || route.includes('rate_limited'), 'returns 429');
  assert.ok(route.includes('Retry-After'), 'Retry-After header');
  assert.ok(route.includes('fail-open') || route.includes('failOpen'), 'fail-open on limiter errors');
  assert.ok(route.includes('acceptInsertedUnderLimit') || route.includes('concurrent'), 'concurrent burst guard');
  assert.ok(feedback.RATE_LIMIT === 8 && feedback.RATE_WINDOW_MS === 900000, '8 / 15m');
});

test('unauthenticated identity denied', function () {
  const r = feedback.deriveIdentity({ error: 'unauthenticated', status: 401 }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.http, 401);
});

test('invalid token-shaped actor denied', function () {
  const r = feedback.deriveIdentity({ error: 'invalid_token', status: 401 }, { category: 'bug' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.http, 401);
});

test('valid actor allowed; spoofed player ignored', function () {
  const r = feedback.deriveIdentity(
    { actorId: 'player-a', clubId: 'club-1' },
    { playerId: 'player-b', clubId: 'club-1', category: 'bug', message: 'hi' }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.playerId, 'player-a');
  assert.strictEqual(r.clubId, 'club-1');
  assert.strictEqual(r.ignoredClientPlayerId, 'player-b');
});

test('cross-club spoof denied', function () {
  const r = feedback.deriveIdentity(
    { actorId: 'player-a', clubId: 'club-1' },
    { clubId: 'club-other', message: 'x', category: 'bug' }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'club_scope_mismatch');
});

test('cross-player ticket denied', function () {
  const gate = feedback.ticketReferenceAllowed(
    { id: 'T1', player_id: 'other', club_id: 'club-1' },
    'player-a',
    'club-1'
  );
  assert.strictEqual(gate.ok, false);
  assert.strictEqual(gate.error, 'ticket_not_allowed');
});

test('cross-club ticket denied', function () {
  const gate = feedback.ticketReferenceAllowed(
    { id: 'T1', player_id: 'player-a', club_id: 'club-other' },
    'player-a',
    'club-1'
  );
  assert.strictEqual(gate.ok, false);
});

test('own ticket allowed', function () {
  const gate = feedback.ticketReferenceAllowed(
    { id: 'T1', player_id: 'player-a', club_id: 'club-1' },
    'player-a',
    'club-1'
  );
  assert.strictEqual(gate.ok, true);
});

test('missing ticket denied (no enumeration)', function () {
  const gate = feedback.ticketReferenceAllowed(null, 'player-a', 'club-1');
  assert.strictEqual(gate.ok, false);
  assert.strictEqual(gate.error, 'ticket_not_allowed');
});

test('oversized message denied', function () {
  const r = feedback.validateCreatePayload({
    category: 'bug',
    message: 'x'.repeat(feedback.MAX_MESSAGE + 1)
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'message_too_long');
});

test('invalid category denied', function () {
  const r = feedback.validateCreatePayload({ category: 'hack', message: 'hello' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'invalid_category');
});

test('valid payload allowed; SQL-looking text stored as text', function () {
  const msg = "'; DROP TABLE tickets; -- <script>alert(1)</script>";
  const r = feedback.validateCreatePayload({
    category: 'bug',
    message: msg,
    context: { path: 'player.html', viewport: '390x844', appVersion: 'beta-ux-1' }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.message, msg);
  assert.strictEqual(r.page, 'player.html');
  const row = feedback.buildInsertRow(
    { playerId: 'p1', clubId: 'c1' },
    r,
    '11111111-1111-1111-1111-111111111111'
  );
  assert.strictEqual(row.message, msg);
  assert.strictEqual(row.player_id, 'p1');
  assert.strictEqual(row.club_id, 'c1');
  assert.strictEqual(row.status, 'new');
});

test('sensitive fields in body rejected', function () {
  const r = feedback.validateCreatePayload({
    category: 'bug',
    message: 'hello',
    token: 'SECRET'
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'sensitive_field_rejected');
});

test('no financial RPC coupling in feedback lib', function () {
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'feedback.js'), 'utf8');
  assert.ok(!/place_bet_tx|grade_ticket_tx|cancel_bet_tx|ledger|diamonds|settlement/i.test(libSrc));
});

test('initDB does not auto-apply feedback_reports (prod gate)', function () {
  const initStart = source.indexOf('async function initDB');
  assert.ok(initStart > 0);
  const initSlice = source.slice(initStart, initStart + 8000);
  assert.ok(!initSlice.includes('feedback_reports'), 'must not boot-migrate feedback_reports');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
console.log('feedback persistence security: PASS');
