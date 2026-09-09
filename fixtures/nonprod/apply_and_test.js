'use strict';
/**
 * Apply Option A proposed migrations to an ISOLATED local Postgres fixture DB.
 * NEVER targets production padgicwrrzmukahfsyhk.
 *
 * Usage:
 *   NONPROD_DATABASE_URL=postgres://... node fixtures/nonprod/apply_and_test.js
 *   # or defaults to local fixture:
 *   postgres://localhost:5432/pb_settlement_nonprod
 *
 * Exit 0 = migrations + cancel matrix ran on real PG.
 * Exit 2 = no local Postgres — skip (JS sim tests still cover logic).
 */
const fs = require('fs');
const path = require('path');

const PROD_REF = 'padgicwrrzmukahfsyhk';
const DEFAULT_URL = process.env.NONPROD_DATABASE_URL ||
  'postgres://localhost:5432/pb_settlement_nonprod';

function assertNotProd(url) {
  if (!url) throw new Error('missing database url');
  if (String(url).indexOf(PROD_REF) !== -1) {
    throw new Error('REFUSING: URL looks like production ' + PROD_REF);
  }
  if (/db\.padgicwrrzmukahfsyhk\.supabase\.co/i.test(url)) {
    throw new Error('REFUSING: production Supabase host');
  }
}

async function main() {
  assertNotProd(DEFAULT_URL);
  var pg;
  try {
    pg = require('pg');
  } catch (e) {
    console.error('[nonprod] pg module missing');
    process.exit(2);
  }

  var client = new pg.Client({ connectionString: DEFAULT_URL });
  try {
    await client.connect();
  } catch (e) {
    console.warn('[nonprod] local Postgres unavailable:', e.message);
    console.warn('[nonprod] Skipping SQL apply. Run JS sim tests instead.');
    console.warn('[nonprod] To enable: create DB pb_settlement_nonprod and set NONPROD_DATABASE_URL.');
    process.exit(2);
  }

  var root = path.join(__dirname, '..', '..');
  var files = [
    path.join(__dirname, 'schema_minimal.sql'),
    path.join(root, 'migrations', 'PROPOSED_settlement_payments.sql'),
    path.join(root, 'migrations', 'PROPOSED_settlement_opening_balances.sql'),
    path.join(root, 'migrations', 'PROPOSED_settle_payment_option_a_tx.sql'),
    path.join(root, 'migrations', 'PROPOSED_bootstrap_settlement_opening_epoch.sql'),
    path.join(root, 'migrations', 'PROPOSED_cancel_bet_tx_club_isolation.sql')
  ];

  // Supabase GRANT targets — create stub roles so proposed SQL applies on bare Postgres.
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN;
      END IF;
    END $$;
  `);

  console.log('[nonprod] Connected (non-prod). Applying:');
  for (var i = 0; i < files.length; i++) {
    var sql = fs.readFileSync(files[i], 'utf8');
    console.log('  -', path.basename(files[i]));
    await client.query(sql);
  }

  // Seed + cancel matrix against real function
  await client.query('TRUNCATE club_members, tickets, ledger_entries RESTART IDENTITY CASCADE');
  try { await client.query('TRUNCATE settlement_payments'); } catch (_e) {}

  await client.query(`
    INSERT INTO club_members (club_id, player_id, balance_start) VALUES
      ('clubA','p1',1000), ('clubB','p1',500);
    INSERT INTO tickets (id, club_id, player_id, status, risk_amount, potential_profit) VALUES
      ('tA1','clubA','p1','active',100,91),
      ('tB1','clubB','p1','active',50,45),
      ('tA_won','clubA','p1','won',20,18),
      ('tA_lost','clubA','p1','lost',30,0),
      ('tX','clubA','orphan','active',25,20);
  `);

  var results = [];

  async function callCancel(ticketId, clubId, playerId, key) {
    var r = await client.query(
      `SELECT public.cancel_bet_tx($1,$2,$3,$4,$5,$6) AS j`,
      [ticketId, clubId, playerId, key, 'test', playerId]
    );
    return r.rows[0].j;
  }

  results.push(['valid', await callCancel('tA1', 'clubA', 'p1', 'CAN_A1')]);
  results.push(['wrong_club', await callCancel('tB1', 'clubA', 'p1', 'CAN_WC')]);
  // re-seed tB1 still active — wrong club on tA1 already canceled; use tB1 with clubA
  results.push(['wrong_player', await callCancel('tB1', 'clubB', 'p2', 'CAN_WP')]);
  results.push(['missing_member', await callCancel('tX', 'clubA', 'orphan', 'CAN_OR')]);
  results.push(['two_club_B', await callCancel('tB1', 'clubB', 'p1', 'CAN_B1')]);
  results.push(['dup', await callCancel('tA1', 'clubA', 'p1', 'CAN_A1')]);
  results.push(['already_canceled', await callCancel('tA1', 'clubA', 'p1', 'CAN_A1b')]);
  results.push(['already_graded', await callCancel('tA_won', 'clubA', 'p1', 'CAN_WON')]);

  // settlement_payments insert smoke
  await client.query(`
    INSERT INTO settlement_payments (
      payment_id, club_id, player_id, direction, amount, amount_cents,
      status, confirmed_at, balance_before, balance_after
    ) VALUES (
      'SETTLE_DIRECT_clubA_k1','clubA','p1','player_paid_host',200,20000,
      'confirmed', now(), -500, -300
    )
  `);
  var payCount = await client.query(`SELECT count(*)::int AS c FROM settlement_payments WHERE club_id='clubA'`);

  var fail = 0;
  function expect(name, cond, detail) {
    if (cond) console.log('  ✅', name);
    else { console.error('  ❌', name, detail || ''); fail++; }
  }

  var by = {};
  results.forEach(function(pair){ by[pair[0]] = pair[1]; });

  expect('valid cancel ok', by.valid && by.valid.ok === true && Number(by.valid.refund) === 100, JSON.stringify(by.valid));
  expect('wrong club', by.wrong_club && by.wrong_club.error === 'ticket_club_mismatch', JSON.stringify(by.wrong_club));
  expect('wrong player', by.wrong_player && by.wrong_player.error === 'ticket_player_mismatch', JSON.stringify(by.wrong_player));
  expect('phantom1000 blocked', by.missing_member && by.missing_member.error === 'no_club_member_balance_found', JSON.stringify(by.missing_member));
  expect('two club B ok', by.two_club_B && by.two_club_B.ok === true && Number(by.two_club_B.refund) === 50, JSON.stringify(by.two_club_B));
  expect('idempotent dup', by.dup && by.dup.ok === true && by.dup.idempotent === true, JSON.stringify(by.dup));
  expect('already canceled', by.already_canceled && by.already_canceled.error === 'invalid_transition', JSON.stringify(by.already_canceled));
  expect('already graded', by.already_graded && by.already_graded.error === 'invalid_transition', JSON.stringify(by.already_graded));
  expect('settlement_payments row', payCount.rows[0].c === 1);

  // Serialized settle smoke (advisory lock path) — isolated player
  await client.query(`
    INSERT INTO club_members (club_id, player_id, balance_start) VALUES ('clubA','pSettle',1000)
    ON CONFLICT (club_id, player_id) DO UPDATE SET balance_start=1000;
    INSERT INTO tickets (id, club_id, player_id, status, risk_amount, potential_profit, graded_at)
    VALUES ('tSettle','clubA','pSettle','lost',500,0, now())
    ON CONFLICT (id) DO UPDATE SET status='lost', risk_amount=500, player_id='pSettle', graded_at=now()
  `);
  var settleJ = await client.query(
    `SELECT public.settle_payment_option_a_tx('clubA','pSettle',200,'APPLY_SMOKE',NULL,NULL,'test','DIRECT',3000) AS j`
  );
  expect('serialized settle 200 on −500 → −300',
    settleJ.rows[0].j && settleJ.rows[0].j.ok === true && Number(settleJ.rows[0].j.balanceAfter) === -300,
    JSON.stringify(settleJ.rows[0].j));
  expect('serialized flag', settleJ.rows[0].j && settleJ.rows[0].j.serialized === true);

  // Record exact SQL paths used
  var record = {
    appliedAt: new Date().toISOString(),
    database: DEFAULT_URL.replace(/:[^:@/]+@/, ':***@'),
    productionTouched: false,
    files: files.map(function(f){ return path.relative(root, f); }),
    cancelResults: by,
    settlementPaymentsCount: payCount.rows[0].c,
    settleSmoke: settleJ.rows[0].j
  };
  fs.writeFileSync(path.join(__dirname, 'LAST_APPLY.json'), JSON.stringify(record, null, 2));
  console.log('[nonprod] Wrote fixtures/nonprod/LAST_APPLY.json');

  await client.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function(e) {
  console.error('[nonprod] fatal', e);
  process.exit(1);
});
