'use strict';

/**
 * Non-prod idempotency remediation FINAL matrix.
 *
 * Covers: fingerprint, concurrent 2x/10x (ticket delta=1), conflict,
 * cross-player/club, expired+ledger, response-loss, restart, multi-instance,
 * stale processing reclaim, TX rollback, fail-closed store, retention.
 *
 * No production SQL / financial side effects.
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

/** Simulated money place: ledger UNIQUE + deterministic ticket. */
function createPlaceSimulator(ledgerMap) {
  ledgerMap = ledgerMap || new Map();
  const tickets = [];
  return {
    tickets: tickets,
    ledger: ledgerMap,
    async place(clubId, playerId, clientKey) {
      const tid = engine.deterministicTicketId(clubId, playerId, clientKey);
      const lid = engine.scopedLedgerId(clubId, playerId, clientKey);
      if (ledgerMap.has(lid)) {
        return {
          ok: true,
          idempotent: true,
          ticketId: ledgerMap.get(lid).ticket_id,
          ledgerEntryId: lid
        };
      }
      // Simulate TX: insert ledger + ticket atomically or neither
      const entry = {
        id: lid,
        ticket_id: tid,
        club_id: clubId,
        player_id: playerId,
        balance_after: 100
      };
      ledgerMap.set(lid, entry);
      tickets.push(tid);
      return { ok: true, idempotent: false, ticketId: tid, ledgerEntryId: lid };
    },
    async placeAbortBeforeCommit(clubId, playerId, clientKey) {
      // TX rollback: nothing written
      void clubId; void playerId; void clientKey;
      return { ok: false, error: 'tx_rolled_back', rolledBack: true };
    }
  };
}

async function run() {
  console.log('\n== idempotency remediation FINAL matrix ==\n');

  await test('fingerprint: canonical same body → same hash; different stake → different', function () {
    const a = engine.hashRequest('/api/bets/place', 'P1', 'C1', { stake: 10, legs: [{ x: 1 }] });
    const b = engine.hashRequest('/api/bets/place', 'P1', 'C1', { legs: [{ x: 1 }], stake: 10 });
    const c = engine.hashRequest('/api/bets/place', 'P1', 'C1', { stake: 20, legs: [{ x: 1 }] });
    assertEq(a, b);
    assert(a !== c);
  });

  await test('deterministic ticket_id / RR group / scoped ledger stable', function () {
    const t1 = engine.deterministicTicketId('clubA', 'player1', 'BET_abc');
    const t2 = engine.deterministicTicketId('clubA', 'player1', 'BET_abc');
    const t3 = engine.deterministicTicketId('clubB', 'player1', 'BET_abc');
    assertEq(t1, t2);
    assert(t1 !== t3);
    assert(t1.indexOf('T_') === 0);
    assertEq(engine.LEDGER_ID_SCOPING, 'scoped_hash_v1');
    const id = engine.scopedLedgerId('C1', 'P1', 'BET_1');
    assert(id.indexOf('IK_') === 0);
    assertEq(id.length, 3 + 40);
    assert(engine.deterministicRrGroupId('C1', 'P1', 'K').indexOf('RRG_') === 0);
  });

  await test('reserve writes status=processing (not bare pending-only)', async function () {
    const store = engine.createMemStore();
    const scope = { clientKey: 'Kproc', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const r = await engine.idemCheck(store, scope, '/api/bets/place', { stake: 1 }, { money: true });
    assertEq(r.action, 'execute');
    const row = await store.load(scope);
    assertEq(row.status, 'processing');
  });

  await test('CONCURRENT 2X — ticket delta=1, same ticket', async function () {
    const shared = new Map();
    const store = engine.createUniqueDbSimStore({ sharedMap: shared, latencyMs: 5 });
    const sim = createPlaceSimulator();
    const scope = { clientKey: 'K2x', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const body = { stake: 5 };

    const results = await Promise.all([0, 1].map(async function () {
      const r = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
      if (r.action !== 'execute') return r;
      const placed = await sim.place(scope.clubId, scope.playerId, scope.clientKey);
      await engine.idemComplete(store, scope, 200, { ok: true, ticketId: placed.ticketId }, placed.ticketId);
      return { action: 'execute', ticketId: placed.ticketId, placed: placed };
    }));

    const executes = results.filter(function (r) { return r.action === 'execute'; });
    const blocked = results.filter(function (r) {
      return r.action === 'in_progress' || r.action === 'replay';
    });
    assertEq(executes.length, 1, 'exactly one executor');
    assertEq(blocked.length, 1, 'one blocked');
    assertEq(sim.tickets.length, 1, 'ticket delta=1');
    const tid = engine.deterministicTicketId('C1', 'P1', 'K2x');
    assertEq(sim.tickets[0], tid);

    // Loser retry after complete → same ticket replay
    const again = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(again.action, 'replay');
    assertEq(again.existingRow.ticket_id || again.existingRow.response_body.ticketId, tid);
  });

  await test('CONCURRENT 10X — ticket delta=1, same ticket', async function () {
    const shared = new Map();
    const store = engine.createUniqueDbSimStore({
      sharedMap: shared,
      latencyMs: function () { return 1 + Math.floor(Math.random() * 8); }
    });
    const sim = createPlaceSimulator();
    const scope = { clientKey: 'K10x', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const body = { stake: 11 };
    const expectedTid = engine.deterministicTicketId('C1', 'P1', 'K10x');

    const results = await Promise.all(Array.from({ length: 10 }, async function () {
      const r = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
      if (r.action !== 'execute') return r;
      const placed = await sim.place(scope.clubId, scope.playerId, scope.clientKey);
      await engine.idemComplete(store, scope, 200, {
        ok: true, ticketId: placed.ticketId
      }, placed.ticketId);
      return { action: 'execute', ticketId: placed.ticketId };
    }));

    const executes = results.filter(function (r) { return r.action === 'execute'; });
    assertEq(executes.length, 1, 'exactly one of 10 executes');
    assertEq(sim.tickets.length, 1, 'ticket delta=1 under 10x');
    assertEq(sim.tickets[0], expectedTid);
    assert(executes[0].ticketId === expectedTid);
  });

  await test('CHANGED REQUEST CONFLICT body_mismatch → 409, no second ticket', async function () {
    const store = engine.createMemStore();
    const sim = createPlaceSimulator();
    const scope = { clientKey: 'K2', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const r1 = await engine.idemCheck(store, scope, '/api/bets/place', { stake: 10 }, { money: true });
    assertEq(r1.action, 'execute');
    const placed = await sim.place('C1', 'P1', 'K2');
    await engine.idemComplete(store, scope, 200, { ok: true, ticketId: placed.ticketId }, placed.ticketId);
    const r2 = await engine.idemCheck(store, scope, '/api/bets/place', { stake: 99 }, { money: true });
    assertEq(r2.action, 'conflict');
    assertEq(r2.reason, 'body_mismatch');
    assertEq(sim.tickets.length, 1);
  });

  await test('SAME REQUEST REPLAY → same ticket', async function () {
    const store = engine.createMemStore();
    const scope = { clientKey: 'K6', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const body = { stake: 7 };
    const r1 = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(r1.action, 'execute');
    const tid = engine.deterministicTicketId('C1', 'P1', 'K6');
    await engine.idemComplete(store, scope, 200, { ok: true, ticketId: tid }, tid);
    const r2 = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(r2.action, 'replay');
    assertEq(r2.existingRow.response_body.ticketId, tid);
  });

  await test('CROSS-PLAYER same bare key — isolated scopes + distinct ledger ids', async function () {
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
    assert(engine.deterministicTicketId('C1', 'P1', 'SAME') !==
      engine.deterministicTicketId('C1', 'P2', 'SAME'));
  });

  await test('CROSS-CLUB same bare key — isolated scopes', async function () {
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

  await test('expired + no ledger → idempotency_key_expired', async function () {
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

  await test('expired + ledger exists → replay (no second wager)', async function () {
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

  await test('RESPONSE LOSS — money posted, complete never ran → ledger_only_replay', async function () {
    const store = engine.createMemStore();
    const sim = createPlaceSimulator();
    const scope = { clientKey: 'Kloss', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const body = { stake: 3 };
    // No idempotency row; money already posted (response lost / crash after RPC)
    const placed = await sim.place('C1', 'P1', 'Kloss');
    const r = await engine.idemCheck(store, scope, '/api/bets/place', body, {
      money: true,
      lookupLedger: async function () {
        return sim.ledger.get(engine.scopedLedgerId('C1', 'P1', 'Kloss'));
      }
    });
    assertEq(r.action, 'replay');
    assertEq(r.reason, 'ledger_only_replay');
    assertEq(r.existingRow.response_body.ticketId, placed.ticketId);
    assertEq(sim.tickets.length, 1);
  });

  await test('RESTART — processing row + ledger → stale ledger replay, no second ticket', async function () {
    const store = engine.createMemStore();
    const sim = createPlaceSimulator();
    const scope = { clientKey: 'Krest', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const body = { stake: 4 };
    const r1 = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(r1.action, 'execute');
    const placed = await sim.place('C1', 'P1', 'Krest');
    // Crash: never idemComplete; row still processing; age it past stale window
    const row = await store.load(scope);
    row.created_at = new Date(Date.now() - engine.STALE_PROCESSING_MS - 1000).toISOString();
    await store.save(scope, row);

    const r2 = await engine.idemCheck(store, scope, '/api/bets/place', body, {
      money: true,
      nowMs: Date.now(),
      lookupLedger: async function () {
        return sim.ledger.get(engine.scopedLedgerId('C1', 'P1', 'Krest'));
      }
    });
    assertEq(r2.action, 'replay');
    assertEq(r2.reason, 'stale_processing_ledger_replay');
    assertEq(sim.tickets.length, 1);
    assertEq(r2.existingRow.response_body.ticketId, placed.ticketId);
  });

  await test('MULTI-INSTANCE — two stores, shared UNIQUE map → one winner', async function () {
    const shared = new Map();
    const a = engine.createUniqueDbSimStore({ sharedMap: shared, instanceId: 'A', latencyMs: 3 });
    const b = engine.createUniqueDbSimStore({ sharedMap: shared, instanceId: 'B', latencyMs: 3 });
    const sim = createPlaceSimulator();
    const scope = { clientKey: 'Kmi', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const body = { stake: 8 };

    const results = await Promise.all([
      engine.idemCheck(a, scope, '/api/bets/place', body, { money: true }),
      engine.idemCheck(b, scope, '/api/bets/place', body, { money: true })
    ]);
    const executes = results.filter(function (r) { return r.action === 'execute'; });
    assertEq(executes.length, 1);
    const winnerStore = results[0].action === 'execute' ? a : b;
    const placed = await sim.place('C1', 'P1', 'Kmi');
    await engine.idemComplete(winnerStore, scope, 200, { ok: true, ticketId: placed.ticketId }, placed.ticketId);

    // Other instance loads completed via shared map
    const other = winnerStore === a ? b : a;
    const replay = await engine.idemCheck(other, scope, '/api/bets/place', body, { money: true });
    assertEq(replay.action, 'replay');
    assertEq(sim.tickets.length, 1);
  });

  await test('STALE PROCESSING no ledger → reclaim execute, still one ticket', async function () {
    const store = engine.createMemStore();
    const sim = createPlaceSimulator();
    const scope = { clientKey: 'Kstale', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const body = { stake: 6 };
    const r1 = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(r1.action, 'execute');
    // Crash before money — leave stale processing
    const row = await store.load(scope);
    row.created_at = new Date(Date.now() - engine.STALE_PROCESSING_MS - 5000).toISOString();
    await store.save(scope, row);

    const r2 = await engine.idemCheck(store, scope, '/api/bets/place', body, {
      money: true,
      nowMs: Date.now(),
      lookupLedger: async function () { return null; }
    });
    assertEq(r2.action, 'execute');
    assert(r2.reclaimed);
    const placed = await sim.place('C1', 'P1', 'Kstale');
    await engine.idemComplete(store, scope, 200, { ok: true, ticketId: placed.ticketId }, placed.ticketId);
    assertEq(sim.tickets.length, 1);

    const r3 = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(r3.action, 'replay');
  });

  await test('fresh processing (not stale) → in_progress 409', async function () {
    const store = engine.createMemStore();
    const scope = { clientKey: 'Kfresh', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const body = { stake: 1 };
    const r1 = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(r1.action, 'execute');
    const r2 = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(r2.action, 'in_progress');
  });

  await test('TX ROLLBACK — abort before commit; reclaim; one ticket after success', async function () {
    const store = engine.createMemStore();
    const sim = createPlaceSimulator();
    const scope = { clientKey: 'Ktx', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    const body = { stake: 9 };
    const r1 = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(r1.action, 'execute');
    const aborted = await sim.placeAbortBeforeCommit('C1', 'P1', 'Ktx');
    assert(aborted.rolledBack);
    // Mark failed (client got error) OR leave processing — test failed path
    await engine.idemComplete(store, scope, 500, { ok: false, error: 'tx_rolled_back' }, null);
    // Failed replay (safe — no second ticket). Client mints new key for retry in product;
    // here we assert failed status replays without placing.
    const r2 = await engine.idemCheck(store, scope, '/api/bets/place', body, { money: true });
    assertEq(r2.action, 'replay');
    assertEq(r2.existingRow.status, 'failed');
    assertEq(sim.tickets.length, 0);

    // Alternate path: stale processing after abort without complete → reclaim places once
    const store2 = engine.createMemStore();
    const sim2 = createPlaceSimulator();
    const scope2 = { clientKey: 'Ktx2', clubId: 'C1', playerId: 'P1', actorId: 'P1' };
    await engine.idemCheck(store2, scope2, '/api/bets/place', body, { money: true });
    await sim2.placeAbortBeforeCommit('C1', 'P1', 'Ktx2');
    const row = await store2.load(scope2);
    row.created_at = new Date(Date.now() - engine.STALE_PROCESSING_MS - 1).toISOString();
    await store2.save(scope2, row);
    const reclaim = await engine.idemCheck(store2, scope2, '/api/bets/place', body, {
      money: true,
      nowMs: Date.now(),
      lookupLedger: async function () { return null; }
    });
    assertEq(reclaim.action, 'execute');
    assert(reclaim.reclaimed);
    const placed = await sim2.place('C1', 'P1', 'Ktx2');
    await engine.idemComplete(store2, scope2, 200, { ok: true, ticketId: placed.ticketId }, placed.ticketId);
    assertEq(sim2.tickets.length, 1);
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

  await test('money path store missing → 503 fail-closed (no mem-primary)', async function () {
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

  await test('evaluateExisting: club_mismatch', function () {
    const r = engine.evaluateExisting({
      club_id: 'C1', player_id: 'P1', actor_id: 'P1',
      request_hash: 'abc', status: 'completed',
      expires_at: new Date(Date.now() + 99999).toISOString()
    }, { actorId: 'P1', clubId: 'C2', playerId: 'P1', reqHash: 'abc', nowMs: Date.now() });
    assertEq(r.action, 'conflict');
    assertEq(r.reason, 'club_mismatch');
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

  // T3 FE sticky note: FE 0e1d678 lineage keeps sticky key on uncertain timeout.
  await test('T3 timeout sticky: same key → deterministic same ticket', function () {
    const a = engine.deterministicTicketId('C', 'P', 'sticky-key');
    const b = engine.deterministicTicketId('C', 'P', 'sticky-key');
    assertEq(a, b);
  });

  await test('legacy pending status treated as in-progress', function () {
    const r = engine.evaluateExisting({
      club_id: 'C1', player_id: 'P1', actor_id: 'P1',
      request_hash: 'h', status: 'pending',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 99999).toISOString()
    }, { actorId: 'P1', clubId: 'C1', playerId: 'P1', reqHash: 'h', nowMs: Date.now() });
    assertEq(r.action, 'in_progress');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

run();
