#!/usr/bin/env node
/**
 * cleanup-orphan-tickets.js
 *
 * Identify and VOID stale active/open smoke/QA tickets via cancel_bet_tx.
 * Never deletes tickets, legs, or ledger rows.
 *
 * Usage:
 *   DRY RUN (default — lists matches, changes nothing):
 *     node scripts/cleanup-orphan-tickets.js
 *
 *   VOID via cancel_bet_tx (requires explicit flag):
 *     node scripts/cleanup-orphan-tickets.js --confirm
 *
 *   Filter to one player / club / game key:
 *     --player=<playerId>
 *     --club=<clubId>
 *     --game="basketball_nba|Oklahoma City Thunder|San Antonio Spurs|2026-05-23"
 *
 *   Restrict to tickets placed before a date (default 2026-06-01):
 *     --before=2026-06-01
 *
 * Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (same as backend)
 */
'use strict';
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
                  || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const playerFilter = (args.find(a => a.startsWith('--player=')) || '').split('=').slice(1).join('=');
const clubFilter   = (args.find(a => a.startsWith('--club=')) || '').split('=').slice(1).join('=');
const gameFilter   = (args.find(a => a.startsWith('--game=')) || '').split('=').slice(1).join('=');
const beforeArg    = (args.find(a => a.startsWith('--before=')) || '').split('=').slice(1).join('=');
const beforeDate   = beforeArg || '2026-06-01';

const DEMO_PLAYER_IDS = new Set(['P1001', '1']);
const QA_TEST_PLAYER  = '0a1885b8-0fe3-4e75-aeda-f89662c87d49';

function isSmokeTestTicketId(id) {
  return /^(SMOKE_|GRD\d+_)/i.test(String(id || ''));
}

function isProvenSmokeTicket(t) {
  if (!t) return false;
  if (isSmokeTestTicketId(t.id)) return true;
  if (t.club_id === 'demo-club') return true;
  if (DEMO_PLAYER_IDS.has(String(t.player_id))) return true;
  if (String(t.player_id) === QA_TEST_PLAYER && t.placed_at && String(t.placed_at) < beforeDate) return true;
  return false;
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function main() {
  console.log('═'.repeat(72));
  console.log('cleanup-orphan-tickets — ' + (confirm ? 'LIVE VOID (cancel_bet_tx)' : 'DRY RUN'));
  console.log('═'.repeat(72));
  if (playerFilter) console.log('Player filter:', playerFilter);
  if (clubFilter)   console.log('Club filter:  ', clubFilter);
  if (gameFilter)   console.log('Game filter:  ', gameFilter);
  console.log('Before:       ', beforeDate);
  console.log('');

  let tq = sb.from('tickets')
    .select('id, player_id, club_id, type, status, risk_amount, placed_at')
    .in('status', ['active', 'open'])
    .lt('placed_at', beforeDate)
    .order('placed_at', { ascending: true });
  if (playerFilter) tq = tq.eq('player_id', playerFilter);
  if (clubFilter)   tq = tq.eq('club_id', clubFilter);
  const { data: tix, error: tErr } = await tq;
  if (tErr) { console.error('tickets query failed:', tErr); process.exit(1); }

  if (!tix || !tix.length) {
    console.log('No active/open tickets before '+beforeDate+' match the filters.');
    return;
  }

  const ticketIds = tix.map(t => t.id);
  const { data: legs, error: lErr } = await sb.from('ticket_legs')
    .select('ticket_id, canonical_game_key, market, pick, american_odds, scheduled_start')
    .in('ticket_id', ticketIds);
  if (lErr) { console.error('ticket_legs query failed:', lErr); process.exit(1); }
  const legsByTicket = {};
  for (const leg of (legs || [])) {
    (legsByTicket[leg.ticket_id] ||= []).push(leg);
  }

  let targets = tix.filter(isProvenSmokeTicket);
  if (gameFilter) {
    const wantKey = gameFilter.split('|').slice(0, 4).join('|');
    targets = targets.filter(t => {
      const tl = legsByTicket[t.id] || [];
      return tl.some(l => (l.canonical_game_key || '').startsWith(wantKey));
    });
  }

  const skipped = tix.filter(t => !targets.some(x => x.id === t.id));
  if (skipped.length) {
    console.log('Skipped '+skipped.length+' active ticket(s) that are not proven smoke/QA:');
    for (const t of skipped) {
      console.log(`  ${t.id}  player=${t.player_id}  club=${t.club_id || '-'}  ${t.placed_at}`);
    }
    console.log('');
  }

  if (!targets.length) {
    console.log('No proven smoke/QA tickets to void.');
    return;
  }

  console.log(`Found ${targets.length} proven smoke/QA ticket(s) to VOID (not delete):\n`);
  let totalRisk = 0;
  for (const t of targets) {
    const tl = legsByTicket[t.id] || [];
    totalRisk += parseFloat(t.risk_amount) || 0;
    console.log(`  Ticket ${t.id}`);
    console.log(`    player=${t.player_id}  club=${t.club_id || '-'}  type=${t.type}`);
    console.log(`    status=${t.status}  risk=${t.risk_amount}  placed=${t.placed_at}`);
    if (!tl.length) console.log('    legs: (none)');
    for (const leg of tl) {
      console.log(`    leg: ${leg.canonical_game_key}  market=${leg.market}  pick=${leg.pick}`);
    }
  }
  console.log(`\nTotal risk that will be refunded via cancel_bet_tx: ${totalRisk.toFixed(2)}`);

  if (!confirm) {
    console.log('\nDRY RUN — pass --confirm to void via cancel_bet_tx. Tickets are never deleted.');
    return;
  }

  console.log('\nVoiding via cancel_bet_tx...');
  let okCount = 0;
  let failCount = 0;
  for (const t of targets) {
    const idempotencyKey = 'VOID_SMOKE_' + t.id;
    const { data, error } = await sb.rpc('cancel_bet_tx', {
      p_ticket_id: t.id,
      p_club_id: t.club_id || '',
      p_player_id: t.player_id,
      p_idempotency_key: idempotencyKey,
      p_reason: 'stale_smoke_void',
      p_created_by: 'cleanup-orphan-tickets'
    });
    const result = data || {};
    if (error || (result.ok === false && !result.idempotent)) {
      failCount++;
      console.error(`  FAIL ${t.id}:`, error && error.message || result.error || 'cancel_failed');
      continue;
    }
    okCount++;
    console.log(`  ${result.idempotent ? 'IDEM' : 'VOID'} ${t.id}  status=${result.status || 'canceled'}  refund=${result.refund}`);
  }
  console.log(`\nDone. voided=${okCount} failed=${failCount}. Rows were not deleted.`);
  if (failCount) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
