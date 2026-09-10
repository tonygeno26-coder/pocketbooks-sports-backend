'use strict';

/**
 * Non-prod idempotency remediation matrix (T1, T2/fingerprint, T7 cross-scope,
 * T8 expired+ledger, fail-closed, concurrent reserve, retention helper).
 *
 * FE sticky timeout notes documented in assertions comments (T3).
 */

const assert = require('assert');
const engine = require('../lib/idempotency-engine');

let pass = 0;
let fail = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () {
      console.log('  OK ' + name);
      pass++;
    })
    .catch(function (e) {
      console.error('  FAIL ' + name + '\n     ' + (e && e.stack || e));
      fail++;
    });
}

function assertEq(a, b, msg) {
  assert.strictEqual(a, b, msg || (String(a) + ' !== ' + String(b)));
}

async function run() {
  console.log('\n== idempotency remediation matrix ==\n');

  await test('fingerprint: same body → same hash; different stake → different hash', function () {
    const a = engine.hashRequest('/api/bets/place', 'P1', 'C1', { stake: 10, legs: [{ x: 1 }] });
    const b = engine.hashRequest('/api/bets/place', 'P1', 'C1', { legs: [{ x: 1 }], stake: 10 });
    const c = engine.hashRequest('/api/bets/place', 'P1', 'C1', { stake: 20, legs: [{ x: 1 }] });
    assertEq(a, b);
    assert(a !== c);
  });

  await test('deterministic ticket_id stable across calls', function () {
    const t1 = engine.deterministicTicketId('clubA', 'player1', 'BET_abc');
    const t2 = engine.deterministicTicketId('clubA', 'player1', 'BET_abc');
    const t3 = engine.deterministicTicketId('clubB', 'player1', 'BET_abc');
    assertEq(t1, t2);
    assert(t1 !== t3);
    assert(t1.indexOf('T_') === 0);
  });

  await test('scoped ledger id decision scoped_hash_v1', function () {
    assertEq(engine.LEDGER_ID_SCOPING, 'scoped_hash_v1');
    const id = engine.scopedLedgerId('C1', 'P1', 'BET_1');
    assert(id.indexOf('IK_') === 0);
    assertEq(id.length, 3 + 40);
    assert(id !== engine.scopedLedgerId('C2', 'P1', 'BET_1'));
  });

  await test('T1 concurrent duplicate reserve — one winner', async function () {
    const store = engine.createMemStore();
    const scope = { clientKey: 'K1', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const body = { stake: 5, idempotencyKey: 'K1' };
    const results = await Promise.all([
      engine.idemCheck(store, scope, '/api/bets/place', body, { money: true }),
      engine.idemCheck(store, scope, '/api/bets/place', body, { money: true }),
      engine.idemCheck(store, scope, '/api/bets/place', body, { money: true })
    ]);
    const executes = results.filter(function (r) { return r.action === 'execute'; });
    const blocked = results.filter(function (r) {
      return r.action === 'in_progress' || r.action === 'replay';
    });
    assertEq(executes.length, 1, 'exactly one executor');
    assertEq(blocked.length, 2, 'others blocked');
  });

  await test('T2 fingerprint conflict body_mismatch → 409', async function () {
    const store = engine.createMemStore();
    const scope = { clientKey: 'K2', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const r1 = await engine.idemCheck(store, scope, '/api/bets/place', { stake: 10 }, { money: true });
    assertEq(r1.action, 'execute');
    await engine.idemComplete(store, scope, 200, { ok: true, ticketId: 'T_x' });
    const r2 = await engine.idemCheck(store, scope, '/api/bets/place', { stake: 99 }, { money: true });
    assertEq(r2.action, 'conflict');
    assertEq(r2.reason, 'body_mismatch');
  });

  await test('T7 cross-player same bare key — isolated scopes', async function () {
    const store = engine.createMemStore();
    const body = { stake: 10 };
    const a = await engine.idemCheck(store, {
      clientKey: 'SAME', clubId: 'C1', playerId: 'P1', actorId: 'P1'
    }, '/api/bets/place', body, { money: true });
    const b = await engine.idemCheck(store, {
      clientKey: 'SAME', clubId: 'C1', playerId: 'P2', actorId: 'P2'
    }, '/api/bets/place', body, { money: true });
    assertEq(a.action, 'execute');
    assertEq(b.action, 'execute');
    assert(engine.scopedLedgerId('C1', 'P1', 'SAME') !==
      engine.scopedLedgerId('C1', 'P2', 'SAME'));
  });

  await test('T7 cross-club same bare key — isolated scopes', async function () {
    const store = engine.createMemStore();
    const body = { stake: 10 };
    const a = await engine.idemCheck(store, {
      clientKey: 'SAME', clubId: 'C1', playerId: 'P1', actorId: 'P1'
    }, '/api/bets/place', body, { money: true });
    const b = await engine.idemCheck(store, {
      clientKey: 'SAME', clubId: 'C2', playerId: 'P1', actorId: 'P1'
    }, '/api/bets/place', body, { money: true });
    assertEq(a.action, 'execute');
    assertEq(b.action, 'execute');
  });

  await test('T8 expired + no ledger → idempotency_key_expired', async function () {
    const store = engine.createMemStore();
    const scope = { clientKey: 'Kexp', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const past = Date.now() - 1000;
    const row = engine.buildPendingRow(scope, '/api/bets/place', 'hash', past - engine.KEY_TTL_MS);
    row.status = 'completed';
    row.response_status = 200;
    row.response_body = { ok: true };
    row.expires_at = new Date(past).toISOString();
    await store.save(scope, row);
    const r = await engine.idemCheck(store, scope, '/api/bets/place', { stake: 1 }, {
      money: true,
      nowMs: Date.now(),
      lookupLedger: async function () { return null; }
    });
    assertEq(r.action, 'expired');
    assertEq(r.error, 'idempotency_key_expired');
  });

  await test('T8 expired + ledger exists → replay', async function () {
    const store = engine.createMemStore();
    const scope = { clientKey: 'Kexp2', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const past = Date.now() - 1000;
    const row = engine.buildPendingRow(scope, '/api/bets/place', 'hash', past - engine.KEY_TTL_MS);
    row.status = 'completed';
    row.expires_at = new Date(past).toISOString();
    await store.save(scope, row);
    const r = await engine.idemCheck(store, scope, '/api/bets/place', { stake: 1 }, {
      money: true,
      nowMs: Date.now(),
      lookupLedger: async function () {
        return { id: 'IK_x', ticket_id: 'T_old', balance_after: 100, club_id: 'C1', player_id: 'P1' };
      }
    });
    assertEq(r.action, 'replay');
    assert(r.fromLedger);
    assertEq(r.existingRow.response_body.ticketId, 'T_old');
  });

  await test('fail-closed missing club on money place', async function () {
    const store = engine.createMemStore();
    const r = await engine.idemCheck(store, {
      clientKey: 'K3', clubId: '', playerId: 'P1', actorId: 'P1'
    }, '/api/bets/place', { stake: 1 }, { money: true });
    assertEq(r.action, 'reject');
    assertEq(r.error, 'missing_club_or_player_for_idempotency');
  });

  await test('fail-closed missing player on money place', async function () {
    const store = engine.createMemStore();
    const r = await engine.idemCheck(store, {
      clientKey: 'K4', clubId: 'C1', playerId: '', actorId: 'anon'
    }, '/api/bets/place', { stake: 1 }, { money: true });
    assertEq(r.action, 'reject');
  });

  await test('money path store missing → 503 no mem-primary', async function () {
    const store = {
      ensureSchema: async function () { return 'missing'; },
      load: async function () { return null; },
      insertIfAbsent: async function () { return { won: false, storeMissing: true }; },
      save: async function () {}
    };
    const r = await engine.idemCheck(store, {
      clientKey: 'K5', clubId: 'C1', playerId: 'P1', actorId: 'P1'
    }, '/api/bets/place', { stake: 1 }, { money: true });
    assertEq(r.action, 'reject');
    assertEq(r.status, 503);
    assertEq(r.error, 'idempotency_store_unavailable');
  });

  await test('completed replay same fingerprint', async function () {
    const store = engine.createMemStore();
    const scope = { clientKey: 'K6', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const body = { stake: 7 };
    const r1 = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(r1.action, 'execute');
    await engine.idemComplete(store, scope, 200, { ok: true, ticketId: 'T_det' });
    const r2 = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(r2.action, 'replay');
    assertEq(r2.existingRow.response_body.ticketId, 'T_det');
  });

  await test('retention purge deletes only expired+grace', async function () {
    const store = engine.createMemStore();
    const now = Date.now();
    const oldScope = { clientKey: 'old', clubId: 'C1', playerId: 'P1' };
    const newScope = { clientKey: 'new', clubId: 'C1', playerId: 'P1' };
    const oldRow = engine.buildPendingRow(oldScope, '/x', 'h', now);
    oldRow.expires_at = new Date(now - engine.RETENTION_GRACE_MS - 1000).toISOString();
    const newRow = engine.buildPendingRow(newScope, '/x', 'h', now);
    newRow.expires_at = new Date(now + engine.KEY_TTL_MS).toISOString();
    await store.save(oldScope, oldRow);
    await store.save(newScope, newRow);
    const n = await engine.purgeExpiredKeys(store, now);
    assert(n >= 1);
    assertEq(await store.load(oldScope), null);
    assert(await store.load(newScope));
  });

  await test('evaluateExisting: club_mismatch', function () {
    const r = engine.evaluateExisting({
      club_id: 'C1', player_id: 'P1', actor_id: 'P1',
      request_hash: 'abc', status: 'completed',
      expires_at: new Date(Date.now() + 99999).toISOString()
    }, { actorId: 'P1', clubId: 'C2', playerId: 'P1', reqHash: 'abc', nowMs: Date.now() });
    assertEq(r.action, 'conflict');
    assertEq(r.reason, 'club_mismatch');
  });

  // T3 FE sticky note (documented expectation — BE-side):
  // FE 0e1d678 lineage keeps _pendingPlaceIdemKey on uncertain timeout and
  // reuses path-matched Idempotency-Key. BE then hits replay/ledger path.
  await test('T3 timeout sticky FE note: same key yields deterministic ticket', function () {
    const a = engine.deterministicTicketId('C', 'P', 'sticky-key');
    const b = engine.deterministicTicketId('C', 'P', 'sticky-key');
    assertEq(a, b);
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

run();
