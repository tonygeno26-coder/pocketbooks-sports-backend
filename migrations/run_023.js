#!/usr/bin/env node
// One-shot: apply migration 023 (grade_ticket_tx push-reduced support)
'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl:{ rejectUnauthorized:false } });

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '023_grade_ticket_tx_push_reduced.sql'), 'utf8');
  console.log('[run_023] Applying migration 023 ...');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(sql);
    await c.query('COMMIT');
    console.log('[run_023] committed.');
    // Verify
    const v = await c.query(`SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE proname='grade_ticket_tx' LIMIT 1`);
    const def = v.rows[0] ? v.rows[0].def : '';
    console.log('p_override_profit param:', def.includes('p_override_profit') ? 'FOUND ✅' : 'MISSING ❌');
    console.log('override IS NOT NULL logic:', def.includes('p_override_profit IS NOT NULL') ? 'FOUND ✅' : 'MISSING ❌');
    if (!def.includes('p_override_profit')) { console.error('FAILED'); process.exit(1); }
    console.log('[run_023] ✅ Done');
  } catch(e) { await c.query('ROLLBACK'); console.error('FAILED:', e.message); process.exit(1); }
  finally { c.release(); await pool.end(); }
}
run();
