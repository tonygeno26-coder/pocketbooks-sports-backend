/**
 * Task 18/19 — Backend authz + survivor host boundary (source gates)
 * Run: node tests/authz-idor.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let _pass = 0, _fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅ ' + name); _pass++; }
  catch (e) { console.error('  ❌ ' + name + '\n     ' + e.message); _fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'Expected true'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

console.log('\n── Mirror IDOR gates ──');
test('mirror/tickets requires actor', function () {
  const block = src.slice(src.indexOf("app.get('/api/mirror/tickets'"));
  assert(block.indexOf('requireActor') < 800, 'requireActor near route start');
  assert(/if\s*\(!privileged\)\s*playerId\s*=\s*String\(actor\.actorId\)/.test(block.slice(0, 1200))
    || /if\s*\(!privileged\)\s*\{\s*[\s\S]*playerId\s*=\s*String\(actor\.actorId\)/.test(block.slice(0, 1500)),
    'non-privileged pinned to self');
});
test('mirror/tickets-with-legs requires actor', function () {
  const idx = src.indexOf("app.get('/api/mirror/tickets-with-legs'");
  assert(idx > 0);
  const block = src.slice(idx, idx + 1500);
  assert(block.includes('requireActor'));
  assert(block.includes('IDOR') || block.includes('actor.actorId'));
});

console.log('\n── Notification IDOR gates ──');
test('GET /api/notifications pins to actor', function () {
  const idx = src.indexOf("app.get('/api/notifications'");
  const block = src.slice(idx, idx + 900);
  assert(block.includes('Always pin to authenticated actor') || /playerId = String\(actor\.actorId/.test(block));
  assert(!/actor\.role !== 'host'/.test(block), 'old host bypass removed');
});
test('POST /api/notifications/read pins to actor', function () {
  const idx = src.indexOf("app.post('/api/notifications/read'");
  const block = src.slice(idx, idx + 700);
  assert(/playerId = String\(actor\.actorId/.test(block));
});

console.log('\n── Player dashboard self-check ──');
test('view_player_dashboard is self-scoped (-1)', function () {
  assert(/view_player_dashboard:\s*-1/.test(src));
});
test('player/dashboard uses requirePermissionScoped', function () {
  assert(src.includes("requirePermissionScoped('view_player_dashboard')"));
});

console.log('\n── Survivor host boundary ──');
test('_survivorIsHost creator-only', function () {
  const m = src.match(/function _survivorIsHost\([\s\S]*?\n\}/);
  assert(m);
  assert(m[0].includes('created_by'));
  assert(m[0].includes('platform_admin'));
  assert(!/full_admin/.test(m[0]), 'full_admin must not bypass pool runner');
});
test('approve/deny/grade require host_or_admin_only via _survivorIsHost', function () {
  assert(src.includes("error:'host_or_admin_only'") || src.includes("error: 'host_or_admin_only'"));
});

console.log('\n── Cash-out notification wording ──');
test('cashout title avoids payment-processor language', function () {
  assert(src.includes("title: 'Cash-out offer'") || src.includes('Cash-out offer'));
  assert(!/payment processed|stripe payout/i.test(src.slice(src.indexOf('offer-cashout'), src.indexOf('offer-cashout') + 2500)));
});

console.log('\n── Summary: ' + _pass + ' passed, ' + _fail + ' failed ──');
process.exit(_fail ? 1 : 0);
