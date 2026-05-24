#!/usr/bin/env node
/**
 * cleanup-orphan-tickets.js
 *
 * One-shot diagnostic + cleanup for stale active/open tickets left behind
 * by failed bet-placement attempts during Phase A RPC integration.
 *
 * Usage:
 *   DRY RUN (default — shows what would be deleted, changes nothing):
 *     node scripts/cleanup-orphan-tickets.js
 *
 *   ACTUALLY DELETE (requires explicit flag):
 *     node scripts/cleanup-orphan-tickets.js --confirm
 *
 *   Filter to one player:
 *     node scripts/cleanup-orphan-tickets.js --player=<playerId>
 *
 *   Filter to one club:
 *     node scripts/cleanup-orphan-tickets.js --club=<clubId>
 *
 *   Filter to one game key (the one in conflict_active_bet error):
 *     node scripts/cleanup-orphan-tickets.js --game="basketball_nba|Oklahoma City Thunder|San Antonio Spurs|2026-05-23"
 *
 * Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (same as backend)
 * Run on Railway via: `railway run node scripts/cleanup-orphan-tickets.js`
 * or locally if you have those env vars exported.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
                  || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

// Parse flags
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const playerFilter = (args.find(a => a.startsWith('--player=')) || '').split('=')[1];
const clubFilter   = (args.find(a => a.startsWith('--club=')) || '').split('=')[1];
const gameFilter   = (args.find(a => a.startsWith('--game=')) || '').split('=')[1];

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function main() {
  console.log('═'.repeat(72));
  console.log('cleanup-orphan-tickets — ' + (confirm ? 'LIVE MODE' : 'DRY RUN'));
  console.log('═'.repeat(72));
  if (playerFilter) console.log('Player filter:', playerFilter);
  if (clubFilter)   console.log('Club filter:  ', clubFilter);
  if (gameFilter)   console.log('Game filter:  ', gameFilter);
  console.log('');

  // 1. Find active/open tickets
  let tq = sb.from('tickets')
    .select('id, player_id, club_id, type, status, risk_amount, placed_at')
    .in('status', ['active', 'open'])
    .order('placed_at', { ascending: false });
  if (playerFilter) tq = tq.eq('player_id', playerFilter);
  if (clubFilter)   tq = tq.eq('club_id', clubFilter);
  const { data: tix, error: tErr } = await tq;
  if (tErr) { console.error('tickets query failed:', tErr); process.exit(1); }

  if (!tix || !tix.length) {
    console.log('No active/open tickets match the filters. Nothing to do.');
    return;
  }

  // 2. Pull legs for those tickets so we can game-filter and display context
  const ticketIds = tix.map(t => t.id);
  const { data: legs, error: lErr } = await sb.from('ticket_legs')
    .select('ticket_id, canonical_game_key, market, pick, american_odds')
    .in('ticket_id', ticketIds);
  if (lErr) { console.error('ticket_legs query failed:', lErr); process.exit(1); }
  const legsByTicket = {};
  for (const leg of (legs || [])) {
    (legsByTicket[leg.ticket_id] ||= []).push(leg);
  }

  // 3. Apply game filter post-fetch (it's a leg-level match, easier in JS)
  let targets = tix;
  if (gameFilter) {
    const wantKey = gameFilter.split('|').slice(0, 4).join('|'); // first 4 segments
    targets = tix.filter(t => {
      const tl = legsByTicket[t.id] || [];
      return tl.some(l => (l.canonical_game_key || '').startsWith(wantKey));
    });
  }

  if (!targets.length) {
    console.log('No tickets match game filter. Active tickets in DB:');
    for (const t of tix.slice(0, 10)) {
      const tl = legsByTicket[t.id] || [];
      const keys = [...new Set(tl.map(l => l.canonical_game_key))].join(', ');
      console.log(`  ${t.id}  player=${t.player_id}  risk=${t.risk_amount}  ${t.placed_at}  [${keys || 'no legs'}]`);
    }
    return;
  }

  // 4. Print what we'll touch
  console.log(`Found ${targets.length} ticket(s) to clean up:\n`);
  let totalRisk = 0;
  for (const t of targets) {
    const tl = legsByTicket[t.id] || [];
    totalRisk += parseFloat(t.risk_amount) || 0;
    console.log(`  Ticket ${t.id}`);
    console.log(`    player=${t.player_id}  club=${t.club_id || '-'}  type=${t.type}`);
    console.log(`    status=${t.status}  risk=${t.risk_amount}  placed=${t.placed_at}`);
    for (const leg of tl) {
      console.log(`    leg: ${leg.canonical_game_key}  market=${leg.market}  pick=${leg.pick}  odds=${leg.american_odds}`);
    }
  }
  console.log(`\nTotal risk that will be released: ${totalRisk.toFixed(2)}`);

  if (!confirm) {
    console.log('\nDRY RUN — pass --confirm to actually delete.');
    return;
  }

  // 5. Live delete: ledger_entries -> ticket_legs -> tickets (FK order)
  console.log('\nDeleting...');
  const targetIds = targets.map(t => t.id);

  const { error: delLedger, count: ledgerCount } = await sb
    .from('ledger_entries').delete({ count: 'exact' }).in('ticket_id', targetIds);
  if (delLedger) { console.error('ledger_entries delete failed:', delLedger); process.exit(1); }
  console.log(`  ledger_entries: ${ledgerCount ?? '?'} rows`);

  const { error: delLegs, count: legsCount } = await sb
    .from('ticket_legs').delete({ count: 'exact' }).in('ticket_id', targetIds);
  if (delLegs) { console.error('ticket_legs delete failed:', delLegs); process.exit(1); }
  console.log(`  ticket_legs:    ${legsCount ?? '?'} rows`);

  const { error: delTix, count: tixCount } = await sb
    .from('tickets').delete({ count: 'exact' }).in('id', targetIds);
  if (delTix) { console.error('tickets delete failed:', delTix); process.exit(1); }
  console.log(`  tickets:        ${tixCount ?? '?'} rows`);

  console.log('\n✅ Cleanup complete.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
