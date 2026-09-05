#!/usr/bin/env node
/**
 * Sync ESPN college-football (FBS) team logos into public.team_logos.
 *
 * Usage:
 *   node scripts/sync-ncaaf-team-logos.js
 *   node scripts/sync-ncaaf-team-logos.js --fcs
 *
 * Idempotent: re-running upserts by (sport, provider, provider_team_id).
 * Does not delete rows omitted from a sync pass.
 */
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const {
  syncNcaafTeamLogos,
  fetchEspnFbsTeams
} = require('../lib/ncaaf-team-logos');

async function main() {
  var includeFcs = process.argv.indexOf('--fcs') >= 0;
  var dryRun = process.argv.indexOf('--dry-run') >= 0;

  if (dryRun) {
    var fetched = await fetchEspnFbsTeams();
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      season: fetched.season,
      fbs_teams: fetched.teams.length,
      sample: fetched.teams.slice(0, 3).map(function (t) {
        return { id: t.id, displayName: t.displayName, conference: t.conference, logo: t.logo };
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
  var result = await syncNcaafTeamLogos(sb, { includeFcs: includeFcs });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok || result.failed > 0) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
