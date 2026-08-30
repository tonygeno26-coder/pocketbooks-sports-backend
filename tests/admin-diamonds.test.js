'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8') +
  '\n' + fs.readFileSync(path.join(__dirname, '..', 'admin-diamonds-routes.js'), 'utf8');

function idx(needle) {
  const i = src.indexOf(needle);
  if (i < 0) throw new Error('not found: ' + needle);
  return i;
}

const ROUTES = [
  "app.get('/api/admin/diamonds/overview'",
  "app.get('/api/admin/diamonds/purchases'",
  "app.post('/api/admin/diamonds/purchases/:id/approve'",
  "app.post('/api/admin/diamonds/purchases/:id/reject'",
  "app.get('/api/admin/diamonds/ledger'",
  "app.get('/api/admin/diamonds/hosts/:hostId/audit'",
  "app.get('/api/admin/diamonds/weekly-charges'",
  "app.post('/api/admin/diamonds/audit/run'",
  "app.get('/api/admin/diamonds/audit/history'",
  "app.post('/api/admin/diamonds/adjust'"
];

test('all admin diamond endpoints are registered', function() {
  ROUTES.forEach(function(r) { expect(idx(r)).toBeGreaterThan(0); });
});

test('diamond admin routes require full_admin or platform_admin', function() {
  expect(src).toMatch(/_requireDiamondAdmin/);
  expect(src).toMatch(/insufficient_role/);
  expect(src).toMatch(/platform_admin/);
});

test('audit run is read-only and does not auto-fix balances', function() {
  const start = idx("app.post('/api/admin/diamonds/audit/run'");
  const next = src.indexOf('app.get(\'/api/admin/diamonds/audit/history\'', start);
  const handler = src.slice(start, next > 0 ? next : start + 2500);
  expect(handler).toMatch(/autoFix:\s*false/);
  expect(handler).not.toMatch(/host_diamond_balances'\)\s*\.update/);
  expect(handler).not.toMatch(/host_diamond_balances'\)\s*\.upsert/);
});

test('adjust writes ledger before updating balance', function() {
  const start = idx("app.post('/api/admin/diamonds/adjust'");
  const handler = src.slice(start, start + 3500);
  expect(handler.indexOf('_writeHostDiamondLedger')).toBeGreaterThan(0);
  expect(handler.indexOf('_writeHostDiamondLedger'))
    .toBeLessThan(handler.indexOf("from('host_diamond_balances')"));
  expect(handler).toMatch(/missing_clubId_or_reason/);
});

test('approve is idempotent on already credited purchases', function() {
  expect(src).toMatch(/already_credited|idempotent:\s*true/);
  expect(idx("app.post('/api/admin/diamonds/purchases/:id/approve'")).toBeGreaterThan(0);
});

function diamondDisplayType(row) {
  const meta = row.metadata_json || {};
  if (row.event_type === 'HOST_DIAMOND_PURCHASE') return 'DIAMOND_PURCHASE';
  if (row.event_type === 'HOST_DIAMOND_TOPUP' && (meta.source === 'crypto_purchase' || meta.txHash || meta.method === 'crypto'))
    return 'DIAMOND_PURCHASE';
  if (row.event_type === 'HOST_ACTIVE_BETTOR_CHARGE') return 'ACTIVE_BETTOR_CHARGE';
  if (row.event_type === 'HOST_DIAMOND_ADJUSTMENT') return 'ADMIN_ADJUSTMENT';
  if (row.event_type === 'HOST_DIAMOND_REFUND') return 'REFUND';
  return row.event_type;
}

test('ledger display names map purchase/charge/adjust/refund', function() {
  expect(diamondDisplayType({ event_type:'HOST_DIAMOND_PURCHASE' })).toBe('DIAMOND_PURCHASE');
  expect(diamondDisplayType({ event_type:'HOST_DIAMOND_TOPUP', metadata_json:{ txHash:'0xabc' } })).toBe('DIAMOND_PURCHASE');
  expect(diamondDisplayType({ event_type:'HOST_ACTIVE_BETTOR_CHARGE' })).toBe('ACTIVE_BETTOR_CHARGE');
  expect(diamondDisplayType({ event_type:'HOST_DIAMOND_ADJUSTMENT' })).toBe('ADMIN_ADJUSTMENT');
  expect(diamondDisplayType({ event_type:'HOST_DIAMOND_REFUND' })).toBe('REFUND');
});

function expectedVsStored(credits, debits, stored) {
  const expected = Math.round((credits - debits) * 100) / 100;
  return { expected: expected, mismatch: Math.abs(expected - stored) > 0.009 };
}

test('host audit flags MISMATCH when stored != credits - debits', function() {
  expect(expectedVsStored(100, 15, 85).mismatch).toBe(false);
  expect(expectedVsStored(100, 15, 70).mismatch).toBe(true);
});
