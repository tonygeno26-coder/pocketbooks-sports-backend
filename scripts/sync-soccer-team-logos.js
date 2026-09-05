#!/usr/bin/env node
/**
 * Sync ESPN soccer team crests into public.team_logos (sport=soccer).
 *
 * Usage:
 *   node scripts/sync-soccer-team-logos.js
 *   node scripts/sync-soccer-team-logos.js --dry-run
 *   node scripts/sync-soccer-team-logos.js --board   # also strict-search current Owls board gaps
 *
 * Idempotent: upserts by (sport, provider, provider_team_id). Never deletes.
 */
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { execFileSync } = require('child_process');
const {
  syncSoccerTeamLogos,
  fetchEspnSoccerTeams
} = require('../lib/soccer-team-logos');

function fetchLiveBoardNames() {
  var base = process.env.PBS_BACKEND_URL ||
    'https://pocketbooks-sports-backend-production.up.railway.app';
  try {
    var out = execFileSync(
      'curl',
      ['-sS', '-L', '--max-time', '25', base + '/api/odds/soccer'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    );
    var games = JSON.parse(out);
    if (!Array.isArray(games)) return [];
    var names = {};
    games.forEach(function (g) {
      if (g && g.home) names[String(g.home).trim()] = true;
      if (g && g.away) names[String(g.away).trim()] = true;
    });
    return Object.keys(names).filter(Boolean).sort();
  } catch (_e) {
    return [];
  }
}

async function main() {
  var dryRun = process.argv.indexOf('--dry-run') >= 0;
  var useBoard = process.argv.indexOf('--board') >= 0;

  if (dryRun) {
    var fetched = await fetchEspnSoccerTeams();
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      teams: fetched.teams.length,
      leagues_ok: fetched.leagues_ok,
      leagues_fail: fetched.leagues_fail,
      sample: fetched.teams.slice(0, 5).map(function (t) {
        return {
          id: t.id,
          displayName: t.displayName,
          league: t.league,
          classification: t.classification,
          logo: t.logo
        };
      })
    }, null, 2));
    return;
  }

  var url = process.env.SUPABASE_URL;
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  var sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  var extra = useBoard ? fetchLiveBoardNames() : [];
  var result = await syncSoccerTeamLogos(sb, { extraProviderNames: extra });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok || result.failed > 0) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
