'use strict';

/**
 * Host Beta Ops — feedback inbox security contracts.
 * Source-slicing + pure helper tests. No live DB / financial RPCs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const feedback = require('../lib/feedback');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

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

function sliceRoute(marker) {
  const start = source.indexOf(marker);
  assert.ok(start > 0, 'route missing: ' + marker);
  const end = source.indexOf('\napp.', start + 10);
  return source.slice(start, end > start ? end : start + 6000);
}

console.log('\n-- host feedback ops security --');

test('GET /api/host/feedback is host-scoped (not public /api/feedback listing)', function () {
  assert.ok(source.includes("app.get('/api/host/feedback'"), 'host GET missing');
  assert.ok(!source.includes("app.get('/api/feedback'"), 'public GET /api/feedback must stay absent');
  assert.ok(!source.includes("app.get('/api/feedback/"), 'public feedback enumeration absent');
  const route = sliceRoute("app.get('/api/host/feedback'");
  assert.ok(route.includes("requirePermissionScoped('view_host_dashboard')"), 'host permission');
  assert.ok(route.includes('requireCanonicalClubId'), 'canonical club');
  assert.ok(route.includes(".eq('club_id', clubId)"), 'hard club pin');
  assert.ok(route.includes("from('feedback_reports')"), 'reads feedback_reports');
  assert.ok(!/place_bet_tx|grade_ticket_tx|cancel_bet_tx|settle_player|ledger_entries\.insert/i.test(route));
});

test('PATCH /api/host/feedback/:id status-only, club-pinned', function () {
  assert.ok(source.includes("app.patch('/api/host/feedback/:id'"), 'host PATCH missing');
  const route = sliceRoute("app.patch('/api/host/feedback/:id'");
  assert.ok(route.includes("requirePermissionScoped('view_host_dashboard')"), 'host permission');
  assert.ok(route.includes('requireCanonicalClubId'), 'canonical club');
  assert.ok(route.includes('validateStatusPatch'), 'status-only validator');
  assert.ok(route.includes(".eq('id', reportId)"), 'id pin');
  assert.ok(route.includes(".eq('club_id', clubId)"), 'club pin');
  assert.ok(route.includes("update({ status: validated.status })")
    || route.includes("update({ status:"), 'status update only');
  assert.ok(!route.includes('.delete('), 'no delete');
  assert.ok(!/message\s*:/.test(route.replace(/console\.log[\s\S]*?\);/g, '')), 'no message rewrite');
  assert.ok(!/place_bet_tx|grade_ticket_tx|cancel_bet_tx|settle/i.test(route));
});

test('player cannot use view_host_dashboard (ACTION_MIN_RANK)', function () {
  const start = source.indexOf('const ACTION_MIN_RANK');
  const end = source.indexOf('};', start);
  const block = source.slice(start, end + 2);
  assert.ok(/view_host_dashboard:\s*2/.test(block), 'view_host_dashboard requires rank >= 2');
  // Players map to view_only / player — rank below 2 → DENY
  assert.ok(source.includes("player: 'player'") || source.includes('role !== \'player\'')
    || /ROLE_RANK/.test(source));
});

test('validateStatusPatch allows triage statuses only', function () {
  assert.strictEqual(feedback.validateStatusPatch({ status: 'new' }).ok, true);
  assert.strictEqual(feedback.validateStatusPatch({ status: 'reviewed' }).ok, true);
  assert.strictEqual(feedback.validateStatusPatch({ status: 'resolved' }).ok, true);
  assert.strictEqual(feedback.validateStatusPatch({ status: 'deleted' }).ok, false);
  assert.strictEqual(feedback.validateStatusPatch({ status: 'reviewed', message: 'x' }).error, 'status_only');
  assert.strictEqual(feedback.validateStatusPatch({}).error, 'invalid_status');
});

test('parseHostFeedbackQuery filters are closed-set', function () {
  const ok = feedback.parseHostFeedbackQuery({ status: 'new', category: 'ticket', betIssues: '1', q: 'T_abc' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.status, 'new');
  assert.strictEqual(ok.category, 'ticket');
  assert.strictEqual(ok.betIssuesOnly, true);
  assert.strictEqual(ok.search, 'T_abc');
  assert.strictEqual(feedback.parseHostFeedbackQuery({ status: 'hack' }).ok, false);
  assert.strictEqual(feedback.parseHostFeedbackQuery({ category: 'hack' }).ok, false);
});

test('toHostFeedbackItem marks bet issues and omits secrets', function () {
  const item = feedback.toHostFeedbackItem({
    id: 'f1',
    player_id: 'p1',
    category: 'ticket',
    message: 'wrong grade',
    ticket_id: 'T_19f2f6374133ae740004f306',
    page: 'player.html',
    status: 'new',
    created_at: '2026-09-14T00:00:00Z',
    token: 'SECRET'
  });
  assert.strictEqual(item.isBetIssue, true);
  assert.strictEqual(item.ticketId, 'T_19f2f6374133ae740004f306');
  assert.strictEqual(item.token, undefined);
  assert.ok(!('club_id' in item) || item.club_id == null);
});

test('toHostTicketContext is read-only shape (no mutation hooks)', function () {
  const ctx = feedback.toHostTicketContext({
    id: 'T1',
    status: 'open',
    type: 'straight',
    odds: -110,
    risk_amount: 0.5,
    potential_profit: 0.45,
    player_id: 'p1',
    player_username: 'tester',
    placed_at: '2026-09-14T00:00:00Z'
  });
  assert.strictEqual(ctx.id, 'T1');
  assert.strictEqual(ctx.riskAmount, 0.5);
  assert.strictEqual(ctx.status, 'open');
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'feedback.js'), 'utf8');
  assert.ok(!/place_bet_tx|grade_ticket_tx|cancel_bet_tx|settlement|diamonds/i.test(libSrc));
});

test('search matches player / ticket / message', function () {
  const item = feedback.toHostFeedbackItem({
    id: 'f1', player_id: 'actor-99', category: 'bug', message: 'slip stuck',
    ticket_id: 'T_abc', status: 'new', created_at: null
  }, { playerLabel: 'Alex' });
  assert.strictEqual(feedback.matchesHostFeedbackSearch(item, 'Alex'), true);
  assert.strictEqual(feedback.matchesHostFeedbackSearch(item, 'T_abc'), true);
  assert.strictEqual(feedback.matchesHostFeedbackSearch(item, 'stuck'), true);
  assert.strictEqual(feedback.matchesHostFeedbackSearch(item, 'zzz'), false);
});

test('cross-club update requires both id and club_id pins in PATCH route', function () {
  const route = sliceRoute("app.patch('/api/host/feedback/:id'");
  const eqClub = route.indexOf(".eq('club_id', clubId)");
  const eqId = route.indexOf(".eq('id', reportId)");
  assert.ok(eqClub > 0 && eqId > 0, 'both pins present');
  assert.ok(route.includes("status(404)") || route.includes("not_found"), 'cross-club → not_found');
});

test('no delete route for feedback', function () {
  assert.ok(!source.includes("app.delete('/api/host/feedback"), 'no host delete');
  assert.ok(!source.includes("app.delete('/api/feedback"), 'no public delete');
});

test('no schema migration required for status updates', function () {
  assert.ok(feedback.STATUSES.indexOf('reviewed') !== -1);
  assert.ok(feedback.STATUSES.indexOf('resolved') !== -1);
  const mig = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '2026-09-14_feedback_reports.sql'),
    'utf8'
  );
  assert.ok(mig.includes("CHECK (status IN ('new', 'reviewed', 'resolved'))"));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
console.log('host feedback ops security: PASS');
