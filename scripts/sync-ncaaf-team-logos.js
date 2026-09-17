#!/usr/bin/env node
/**
 * Sync ESPN college-football (FBS + optional FCS) team logos into public.team_logos.
 *
 * Usage:
 *   node scripts/sync-ncaaf-team-logos.js
 *   node scripts/sync-ncaaf-team-logos.js --fcs
 *   node scripts/sync-ncaaf-team-logos.js --fcs --dry-run
 *   node scripts/sync-ncaaf-team-logos.js --fcs --export /tmp/ncaaf_rows.json
 *
 * Idempotent: re-running upserts by (sport, provider, provider_team_id).
 * Does not delete rows omitted from a sync pass.
 * Image validation required unless --skip-image-validation.
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const {
  syncNcaafTeamLogos,
  fetchEspnFbsTeams,
  fetchEspnFcsTeams,
  dedupeTeamsById,
  rebuildAliases,
  rowFromEspnTeam,
  validateLogoUrl
} = require('../lib/ncaaf-team-logos');

function argValue(flag) {
  var i = process.argv.indexOf(flag);
  if (i < 0 || !process.argv[i + 1]) return null;
  return process.argv[i + 1];
}

async function collectTeams(includeFcs) {
  var fetched = await fetchEspnFbsTeams();
  var teams = fetched.teams.slice();
  if (fetched.fcsLeaks && fetched.fcsLeaks.length) teams = teams.concat(fetched.fcsLeaks);
  if (includeFcs) {
    var fcs = await fetchEspnFcsTeams(fetched.season);
    teams = teams.concat(fcs || []);
  }
  teams = dedupeTeamsById(teams);
  rebuildAliases(teams);
  return { season: fetched.season, teams: teams };
}

async function main() {
  var includeFcs = process.argv.indexOf('--fcs') >= 0;
  var dryRun = process.argv.indexOf('--dry-run') >= 0;
  var skipImageValidation = process.argv.indexOf('--skip-image-validation') >= 0;
  var exportPath = argValue('--export');

  if (dryRun || exportPath) {
    var collected = await collectTeams(includeFcs);
    var rows = [];
    var invalid = [];
    for (var i = 0; i < collected.teams.length; i++) {
      var row = rowFromEspnTeam(collected.teams[i]);
      if (!skipImageValidation) {
        var v = await validateLogoUrl(row.logo_url, 8000);
        if (!v.ok) {
          invalid.push({ id: row.provider_team_id, name: row.display_name, reason: v.reason });
          continue;
        }
      }
      rows.push(row);
      if ((i + 1) % 25 === 0) process.stderr.write('validated ' + (i + 1) + '/' + collected.teams.length + '\n');
    }
    var payload = {
      ok: true,
      dry_run: !!dryRun,
      season: collected.season,
      include_fcs: includeFcs,
      espn_teams: collected.teams.length,
      valid_rows: rows.length,
      invalid_logo: invalid.length,
      fbs: rows.filter(function (r) { return r.classification !== 'fcs'; }).length,
      fcs: rows.filter(function (r) { return r.classification === 'fcs'; }).length,
      sample: rows.slice(0, 3).map(function (r) {
        return { id: r.provider_team_id, display: r.display_name, class: r.classification, logo: r.logo_url };
      }),
      invalid_sample: invalid.slice(0, 10),
      rows: exportPath ? rows : undefined
    };
    if (exportPath) {
      fs.writeFileSync(exportPath, JSON.stringify({ season: collected.season, rows: rows, invalid: invalid }, null, 2));
      payload.export = exportPath;
      delete payload.rows;
    }
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  var url = process.env.SUPABASE_URL;
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  var sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  var result = await syncNcaafTeamLogos(sb, {
    includeFcs: includeFcs,
    skipImageValidation: skipImageValidation
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok || result.failed > 0) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
