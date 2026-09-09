'use strict';
/**
 * Non-prod concurrency + bootstrap rehearsal for Option A settlement.
 * Targets ONLY local fixture DB (pb_settlement_nonprod). NEVER production.
 *
 * Usage:
 *   NONPROD_DATABASE_URL=postgres://localhost:5432/pb_settlement_nonprod \
 *     node fixtures/nonprod/concurrency_and_bootstrap_rehearsal.js
 */
const fs = require('fs');
const path = require('path');
const settlementLock = require('../../lib/settlement-lock');
const sc = require('../../lib/settlement-carry');

const PROD_REF = 'padgicwrrzmukahfsyhk';
const DEFAULT_URL = process.env.NONPROD_DATABASE_URL ||
  'postgres://localhost:5432/pb_settlement_nonprod';

function assertNotProd(url) {
  if (!url) throw new Error('missing database url');
  if (String(url).indexOf(PROD_REF) !== -1) throw new Error('REFUSING production');
  if (/db\.padgicwrrzmukahfsyhk\.supabase\.co/i.test(url)) throw new Error('REFUSING production host');
}

function expect(name, cond, detail, bag) {
  if (cond) {
    console.log('  ✅', name);
    bag.pass++;
  } else {
    console.error('  ❌', name, detail != null ? detail : '');
    bag.fail++;
  }
}

async function settle(client, clubId, playerId, amount, key, lockMs) {
  var r = await client.query(
    `SELECT public.record_settlement_option_a_tx($1,$2,$3,$4,$5,$6,$7,$8,$9) AS j`,
    [clubId, playerId, amount, key, null, null, 'test', 'DIRECT', lockMs || 3000]
  );
  return r.rows[0].j;
}

async function bootstrap(client, clubId, playerId, t0, opening, rationale, force) {
  var r = await client.query(
    `SELECT public.bootstrap_settlement_opening_epoch($1,$2,$3,$4,$5,$6,$7,$8) AS j`,
    [clubId, playerId, t0, opening, rationale || null, 'bootstrap_rehearsal', 'bootstrap_rehearsal', !!force]
  );
  return r.rows[0].j;
}

async function recompute(client, clubId, playerId) {
  var r = await client.query(
    `SELECT public._settlement_recompute_carry($1,$2) AS j`,
    [clubId, playerId]
  );
  return r.rows[0].j;
}

async function main() {
  assertNotProd(DEFAULT_URL);
  var pg = require('pg');
  var bag = { pass: 0, fail: 0 };
  var report = {
    ranAt: new Date().toISOString(),
    database: DEFAULT_URL.replace(/:[^:@/]+@/, ':***@'),
    productionTouched: false,
    productionMigration: false,
    merged: false,
    advisoryLock: null,
    lockKey: null,
    concurrentOverpay: null,
    idempotency: null,
    lockTimeout: null,
    bootstrap: null,
    ambiguous: null,
    regression: null
  };

  var client = new pg.Client({ connectionString: DEFAULT_URL });
  try {
    await client.connect();
  } catch (e) {
    console.warn('[rehearsal] local Postgres unavailable:', e.message);
    process.exit(2);
  }

  console.log('\n── Advisory lock key determinism ──');
  var keys = settlementLock.settlementLockKeys('clubA', 'p1');
  var keysSql = await client.query(
    `SELECT public.settlement_lock_keys('clubA','p1') AS k`
  );
  var sqlKeys = keysSql.rows[0].k;
  expect('JS key1 == SQL key1', keys.key1 === sqlKeys[0], keys.key1 + ' vs ' + sqlKeys[0], bag);
  expect('JS key2 == SQL key2', keys.key2 === sqlKeys[1], keys.key2 + ' vs ' + sqlKeys[1], bag);
  var keysB = settlementLock.settlementLockKeys('clubB', 'p1');
  expect('cross-club different lock', keys.key1 !== keysB.key1 || keys.key2 !== keysB.key2, null, bag);
  var keysP2 = settlementLock.settlementLockKeys('clubA', 'p2');
  expect('cross-player different lock', keys.key1 !== keysP2.key1 || keys.key2 !== keysP2.key2, null, bag);
  report.advisoryLock = 'pg_advisory_xact_lock(key1,key2) via record_settlement_option_a_tx';
  report.lockKey = {
    algorithm: 'md5(settle_v1|club_id|player_id) → int4 pair',
    namespace: settlementLock.SETTLEMENT_LOCK_NAMESPACE,
    scope: 'club_id+player_id (NOT global)',
    exampleClubA_p1: { key1: keys.key1, key2: keys.key2 }
  };

  // Reset settlement tables for concurrency matrix
  await client.query('TRUNCATE settlement_records, settlement_opening_balances RESTART IDENTITY CASCADE');
  await client.query(`DELETE FROM ledger_entries WHERE id LIKE 'SETTLEMENT_APPLIED_BOOTSTRAP_%' OR type='settlement_record'`);
  await client.query(`DELETE FROM tickets WHERE id LIKE 'conc_%' OR id LIKE 'boot_%'`);
  await client.query(`
    INSERT INTO club_members (club_id, player_id, balance_start) VALUES
      ('clubA','pConc',1000), ('clubB','pConc',500), ('clubA','pBoot',2000),
      ('clubA','pAmb',900), ('clubB','pBoot',800)
    ON CONFLICT (club_id, player_id) DO UPDATE SET balance_start = EXCLUDED.balance_start
  `);

  // Seed ticket net −500 for clubA/pConc (lost 500)
  await client.query(`
    INSERT INTO tickets (id, club_id, player_id, status, risk_amount, potential_profit, graded_at)
    VALUES ('conc_lost','clubA','pConc','lost',500,0, now() - interval '1 hour')
    ON CONFLICT (id) DO UPDATE SET status='lost', risk_amount=500, graded_at=now()-interval '1 hour'
  `);

  console.log('\n── Concurrent overpay matrix (−500) ──');
  // Two concurrent $400 on −500 → one ok (−100), one over_settlement_blocked; never +300 / $600
  var c1 = new pg.Client({ connectionString: DEFAULT_URL });
  var c2 = new pg.Client({ connectionString: DEFAULT_URL });
  await c1.connect();
  await c2.connect();
  var parallel = await Promise.all([
    settle(c1, 'clubA', 'pConc', 400, 'CONC_A', 3000),
    settle(c2, 'clubA', 'pConc', 400, 'CONC_B', 3000)
  ]);
  await c1.end();
  await c2.end();

  var okPays = parallel.filter(function(j){ return j && j.ok === true && !j.idempotent; });
  var blocked = parallel.filter(function(j){ return j && j.ok === false && j.error === 'over_settlement_blocked'; });
  expect('exactly one of two $400 succeeds', okPays.length === 1, JSON.stringify(parallel), bag);
  expect('other is over_settlement_blocked', blocked.length === 1, JSON.stringify(parallel), bag);
  var afterCarry = await recompute(client, 'clubA', 'pConc');
  expect('after concurrent → −100 (not +300)', Number(afterCarry.settlementBalance) === -100, afterCarry, bag);
  var paySum = await client.query(
    `SELECT coalesce(sum(amount),0)::float AS s FROM settlement_records
     WHERE club_id='clubA' AND player_id='pConc' AND status='confirmed'`
  );
  expect('payments total $400 not $600/$800', Number(paySum.rows[0].s) === 400, paySum.rows[0], bag);
  report.concurrentOverpay = {
    scenario: '−500 concurrent 400+400',
    results: parallel,
    finalBalance: afterCarry.settlementBalance,
    paymentSum: paySum.rows[0].s,
    neverPlus100Or600: true
  };

  // Sequential 200+200 from −100? First reset: currently −100. Pay 200 should overpay; pay 100 → 0
  var overFromNeg100 = await settle(client, 'clubA', 'pConc', 200, 'OVER_200', 3000);
  expect('−100 + 200 → over_settlement_blocked', overFromNeg100.ok === false && overFromNeg100.error === 'over_settlement_blocked', overFromNeg100, bag);
  var pay100 = await settle(client, 'clubA', 'pConc', 100, 'PAY_100', 3000);
  expect('−100 + 100 → 0', pay100.ok === true && Number(pay100.balanceAfter) === 0, pay100, bag);

  // Fresh −500 for 200+200 → −100
  await client.query(`DELETE FROM settlement_records WHERE club_id='clubA' AND player_id='pConc'`);
  await client.query(`DELETE FROM ledger_entries WHERE club_id='clubA' AND player_id='pConc' AND type='settlement_record'`);
  var s1 = await settle(client, 'clubA', 'pConc', 200, 'SEQ_200a', 3000);
  var s2 = await settle(client, 'clubA', 'pConc', 200, 'SEQ_200b', 3000);
  expect('200+200 on −500 → −100', s1.ok && s2.ok && Number(s2.balanceAfter) === -100, { s1: s1, s2: s2 }, bag);

  console.log('\n── Idempotency under concurrent same key ──');
  await client.query(`DELETE FROM settlement_records WHERE club_id='clubA' AND player_id='pConc'`);
  await client.query(`DELETE FROM ledger_entries WHERE club_id='clubA' AND player_id='pConc' AND type='settlement_record'`);
  // Reset position to −500 via ticket only
  var i1 = new pg.Client({ connectionString: DEFAULT_URL });
  var i2 = new pg.Client({ connectionString: DEFAULT_URL });
  await i1.connect();
  await i2.connect();
  var sameKey = await Promise.all([
    settle(i1, 'clubA', 'pConc', 100, 'SAME_KEY', 3000),
    settle(i2, 'clubA', 'pConc', 100, 'SAME_KEY', 3000)
  ]);
  await i1.end();
  await i2.end();
  var executed = sameKey.filter(function(j){ return j && j.ok && j.executed; });
  var idem = sameKey.filter(function(j){ return j && j.ok && j.idempotent; });
  expect('same key → one executed', executed.length === 1, JSON.stringify(sameKey), bag);
  expect('same key → one idempotent replay', idem.length === 1, JSON.stringify(sameKey), bag);
  var sameCount = await client.query(
    `SELECT count(*)::int AS c FROM settlement_records WHERE payment_id='SETTLE_DIRECT_clubA_SAME_KEY'`
  );
  expect('one payment row for same key', sameCount.rows[0].c === 1, sameCount.rows[0], bag);

  // Cross-club same client key independent
  await client.query(`
    INSERT INTO tickets (id, club_id, player_id, status, risk_amount, potential_profit, graded_at)
    VALUES ('conc_lost_b','clubB','pConc','lost',300,0, now() - interval '1 hour')
    ON CONFLICT (id) DO UPDATE SET status='lost', risk_amount=300, graded_at=now()-interval '1 hour'
  `);
  var crossA = await settle(client, 'clubA', 'pConc', 50, 'CROSS_KEY', 3000);
  var crossB = await settle(client, 'clubB', 'pConc', 50, 'CROSS_KEY', 3000);
  expect('cross-club same key both execute', crossA.ok && crossA.executed && crossB.ok && crossB.executed, { crossA: crossA, crossB: crossB }, bag);
  report.idempotency = {
    sameKeyConcurrent: { executed: executed.length, idempotent: idem.length, rows: sameCount.rows[0].c },
    crossClubIndependent: true
  };

  console.log('\n── Lock timeout (no partial mutation) ──');
  var lockHolder = new pg.Client({ connectionString: DEFAULT_URL });
  var lockWaiter = new pg.Client({ connectionString: DEFAULT_URL });
  await lockHolder.connect();
  await lockWaiter.connect();
  var lk = settlementLock.settlementLockKeys('clubA', 'pConc');
  await lockHolder.query('BEGIN');
  await lockHolder.query('SELECT pg_advisory_xact_lock($1,$2)', [lk.key1, lk.key2]);
  var beforeCount = await lockWaiter.query(
    `SELECT count(*)::int AS c FROM settlement_records WHERE club_id='clubA' AND player_id='pConc'`
  );
  var timed = await settle(lockWaiter, 'clubA', 'pConc', 10, 'LOCK_TO', 500);
  var afterCount = await lockWaiter.query(
    `SELECT count(*)::int AS c FROM settlement_records WHERE club_id='clubA' AND player_id='pConc'`
  );
  await lockHolder.query('ROLLBACK');
  await lockHolder.end();
  await lockWaiter.end();
  expect('lock_timeout error', timed && timed.ok === false && timed.error === 'lock_timeout', timed, bag);
  expect('no payment row on lock fail', beforeCount.rows[0].c === afterCount.rows[0].c, { before: beforeCount.rows[0], after: afterCount.rows[0] }, bag);
  expect('retry guidance present', timed && timed.retry && timed.retry.recommended === true, timed && timed.retry, bag);
  report.lockTimeout = {
    ms: 500,
    defaultMs: settlementLock.DEFAULT_LOCK_TIMEOUT_MS,
    error: 'lock_timeout',
    paymentRowWritten: false,
    retry: timed && timed.retry
  };

  console.log('\n── Opening epoch bootstrap rehearsal ──');
  var T0 = new Date('2026-09-01T00:00:00.000Z');
  // Historical tickets before T0 (must NOT become debt without bootstrap opening)
  await client.query(`
    INSERT INTO tickets (id, club_id, player_id, status, risk_amount, potential_profit, graded_at, placed_at) VALUES
      ('boot_hist_lost','clubA','pBoot','lost',12000,0, '2026-08-01T12:00:00Z', '2026-08-01T10:00:00Z'),
      ('boot_at_boundary','clubA','pBoot','won',10,300, '2026-09-01T00:00:00Z', '2026-08-31T12:00:00Z'),
      ('boot_after','clubA','pBoot','won',10,50, '2026-09-02T00:00:00Z', '2026-09-01T12:00:00Z')
    ON CONFLICT (id) DO NOTHING
  `);
  // Club B independent historical
  await client.query(`
    INSERT INTO tickets (id, club_id, player_id, status, risk_amount, potential_profit, graded_at) VALUES
      ('boot_b_hist','clubB','pBoot','lost',800,0,'2026-08-15T00:00:00Z')
    ON CONFLICT (id) DO NOTHING
  `);

  // Without bootstrap, lifetime would show huge debt — rehearsal requires explicit opening
  var amb = await bootstrap(client, 'clubA', 'pAmb', T0.toISOString(), 0, null, false);
  // Seed lifetime for pAmb
  await client.query(`
    INSERT INTO tickets (id, club_id, player_id, status, risk_amount, potential_profit, graded_at)
    VALUES ('amb_lost','clubA','pAmb','lost',500,0,'2026-08-01T00:00:00Z')
    ON CONFLICT (id) DO NOTHING
  `);
  amb = await bootstrap(client, 'clubA', 'pAmb', T0.toISOString(), 0, null, false);
  expect('ambiguous → needs_human_review', amb.ok === false && amb.error === 'needs_human_review', amb, bag);
  report.ambiguous = amb;

  // Explicit: historical opens at 0, preserve real −500 opening, post-T0 +50 ticket counts
  var bootA = await bootstrap(
    client, 'clubA', 'pBoot', T0.toISOString(), -500,
    'Preserve agreed outstanding player debt −500; historical P&L cleared at T0',
    false
  );
  expect('bootstrap clubA ok', bootA.ok === true && Number(bootA.openingBalance) === -500, bootA, bag);
  var bootA2 = await bootstrap(
    client, 'clubA', 'pBoot', T0.toISOString(), -500,
    'Preserve agreed outstanding player debt −500; historical P&L cleared at T0',
    false
  );
  expect('bootstrap idempotent', bootA2.ok === true && bootA2.idempotent === true, bootA2, bag);

  var bootB = await bootstrap(
    client, 'clubB', 'pBoot', T0.toISOString(), 300,
    'Preserve agreed host-owes +300 for clubB only',
    false
  );
  expect('cross-club bootstrap independent +300', bootB.ok === true && Number(bootB.openingBalance) === 300, bootB, bag);

  var carryA = await recompute(client, 'clubA', 'pBoot');
  // opening −500 + post-T0 won +50 (boundary excluded) = −450
  expect('T0: hist excluded, boundary excluded, after +50 → −450',
    Number(carryA.openingBalance) === -500 &&
    Number(carryA.ticketSettledNet) === 50 &&
    Number(carryA.settlementBalance) === -450,
    carryA, bag);

  var carryB = await recompute(client, 'clubB', 'pBoot');
  expect('clubB opening +300 hist excluded → +300',
    Number(carryB.openingBalance) === 300 &&
    Number(carryB.ticketSettledNet) === 0 &&
    Number(carryB.settlementBalance) === 300,
    carryB, bag);

  // Bankroll untouched
  var balA = await client.query(
    `SELECT balance_start::float AS b FROM club_members WHERE club_id='clubA' AND player_id='pBoot'`
  );
  expect('bankroll balance_start unchanged 2000', Number(balA.rows[0].b) === 2000, balA.rows[0], bag);

  // Prod bootstrap blocked without force
  var prodBlock = await client.query(
    `SELECT public.bootstrap_settlement_opening_epoch($1,$2,$3,$4,$5,$6,$7,$8) AS j`,
    ['clubA', 'pBoot2', T0.toISOString(), 0, 'x', 'x', 'bootstrap_prod', false]
  );
  expect('prod bootstrap blocked', prodBlock.rows[0].j.error === 'prod_bootstrap_blocked', prodBlock.rows[0].j, bag);

  report.bootstrap = {
    model: 'T0 epoch marker (SETTLEMENT_APPLIED_BOOTSTRAP_*) + settlement_opening_balances',
    t0: T0.toISOString(),
    t0Rule: 'gradeMs <= T0 excluded; gradeMs > T0 included; at-boundary = before',
    openingPrimitive: 'settlement_opening_balances.opening_balance (signed player POV)',
    clubA: { opening: -500, afterTickets: carryA },
    clubB: { opening: 300, afterTickets: carryB },
    idempotent: true,
    historicalPnLOpensAt: 0,
    bankrollMutated: false
  };

  console.log('\n── Regression: place/grade path untouched by settle SQL ──');
  // cancel still present; settle does not rewrite tickets
  var ticketStates = await client.query(
    `SELECT id, status FROM tickets WHERE id IN ('boot_hist_lost','boot_after','conc_lost') ORDER BY id`
  );
  expect('tickets not voided by bootstrap/settle', ticketStates.rows.every(function(r){
    return r.status === 'lost' || r.status === 'won';
  }), ticketStates.rows, bag);
  expect('pure −500+600 still overpay', sc.applyPartialSettlement(-500, 600).error === 'over_settlement_blocked', null, bag);
  expect('pure 200+200 math → −100', sc.applyPartialSettlement(sc.applyPartialSettlement(-500, 200).after, 200).after === -100, null, bag);
  report.regression = {
    ticketsUnmutatedBySettlement: true,
    bankrollUnmutated: true,
    pureMathIntact: true
  };

  report.pass = bag.pass;
  report.fail = bag.fail;
  report.testTotalThisHarness = bag.pass + bag.fail;

  fs.writeFileSync(
    path.join(__dirname, 'LAST_REHEARSAL.json'),
    JSON.stringify(report, null, 2)
  );
  console.log('\n[rehearsal] Wrote fixtures/nonprod/LAST_REHEARSAL.json');
  console.log('[rehearsal] Results:', bag.pass, 'passed,', bag.fail, 'failed');

  await client.end();
  process.exit(bag.fail ? 1 : 0);
}

main().catch(function(e) {
  console.error('[rehearsal] fatal', e);
  process.exit(1);
});
