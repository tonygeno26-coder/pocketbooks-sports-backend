#!/usr/bin/env node
/**
 * Audit distinct NCAAF odds-provider team names against team_logos mappings.
 *
 * Sources (first available):
 *  1. LIVE args: --names "Alabama","Ole Miss"
 *  2. stdin JSON array of strings
 *  3. Optional Owls/live cache scrape if backend helpers are loadable
 *  4. Distinct home/away from ticket_legs where sport ~ ncaaf
 *
 * Prints unmatched and ambiguous names exactly.
 */
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const {
  loadTeamLogoRows,
  buildResolverIndex,
  auditProviderNames,
  resolveTeamLogo
} = require('../lib/ncaaf-team-logos');

function parseNamesArg(argv) {
  var i = argv.indexOf('--names');
  if (i < 0 || !argv[i + 1]) return null;
  return argv[i + 1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

async function collectFromDb(sb) {
  var names = {};
  // ticket_legs
  try {
    var { data } = await sb.from('ticket_legs')
      .select('home_team,away_team,sport')
      .or('sport.ilike.%ncaaf%,sport.ilike.%americanfootball_ncaaf%')
      .limit(5000);
    (data || []).forEach(function (r) {
      if (r.home_team) names[String(r.home_team).trim()] = true;
      if (r.away_team) names[String(r.away_team).trim()] = true;
    });
  } catch (_e) {}
  // odds_snapshots may store game payloads — best-effort
  try {
    var { data: snaps } = await sb.from('odds_snapshots')
      .select('home_team,away_team,sport')
      .or('sport.ilike.%ncaaf%,sport.ilike.%americanfootball_ncaaf%')
      .limit(5000);
    (snaps || []).forEach(function (r) {
      if (r.home_team) names[String(r.home_team).trim()] = true;
      if (r.away_team) names[String(r.away_team).trim()] = true;
    });
  } catch (_e2) {}
  return Object.keys(names).filter(Boolean).sort();
}

async function main() {
  var url = process.env.SUPABASE_URL;
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  var sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  var rows = await loadTeamLogoRows(sb, 'ncaaf');
  var index = buildResolverIndex(rows);

  var names = parseNamesArg(process.argv);
  if (!names && !process.stdin.isTTY) {
    var chunks = '';
    for await (var chunk of process.stdin) chunks += chunk;
    chunks = chunks.trim();
    if (chunks) {
      try {
        var parsed = JSON.parse(chunks);
        if (Array.isArray(parsed)) names = parsed.map(String);
      } catch (_e) {
        names = chunks.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
      }
    }
  }
  if (!names) names = await collectFromDb(sb);

  // Spot-check list always included when auditing
  var spot = [
    'Alabama', 'Georgia', 'Ohio State', 'Michigan', 'Texas', 'Oklahoma', 'Oregon',
    'USC', 'Notre Dame', 'Miami', 'Miami (FL)', 'Miami (OH)', 'LSU', 'Penn State',
    'Clemson', 'Florida State', 'Boise State', 'UNLV', 'UTEP', 'BYU', 'UCF', 'Ole Miss',
    'Washington', 'Washington State', 'Houston', 'Georgia State', 'Michigan State',
    'Oklahoma State', 'South Carolina', 'Louisiana', 'UL Monroe', 'Appalachian State',
    'NC State', 'UTSA', 'SMU', 'TCU', 'FIU', 'FAU'
  ];
  var set = {};
  names.concat(spot).forEach(function (n) { if (n) set[n] = true; });
  names = Object.keys(set).sort();

  var report = auditProviderNames(names, index);
  console.log(JSON.stringify({
    team_logos_rows: rows.length,
    total_distinct_names: report.total,
    matched: report.matched,
    exact: report.exact,
    alias: report.alias,
    normalized: report.normalized,
    unresolved_count: report.unresolved.length,
    ambiguous_count: report.ambiguous.length,
    unresolved: report.unresolved.map(function (x) { return x.name; }),
    ambiguous: report.ambiguous.map(function (x) { return x.name; })
  }, null, 2));

  // Ambiguity safety checks
  var safety = [
    ['Miami', 'Miami Hurricanes'],
    ['Miami (OH)', 'Miami (OH) RedHawks'],
    ['USC', 'USC Trojans'],
    ['Washington', 'Washington Huskies'],
    ['Washington State', 'Washington State Cougars'],
    ['Georgia', 'Georgia Bulldogs'],
    ['Georgia State', 'Georgia State Panthers'],
    ['Michigan', 'Michigan Wolverines'],
    ['Michigan State', 'Michigan State Spartans'],
    ['Oklahoma', 'Oklahoma Sooners'],
    ['Oklahoma State', 'Oklahoma State Cowboys']
  ];
  var safetyFails = [];
  safety.forEach(function (pair) {
    var r = resolveTeamLogo(pair[0], index);
    var got = r.row && r.row.canonical_name;
    if (got !== pair[1]) safetyFails.push({ input: pair[0], expected: pair[1], got: got || r.status });
  });
  if (safetyFails.length) {
    console.error('SAFETY_FAIL', JSON.stringify(safetyFails, null, 2));
    process.exitCode = 2;
  }
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
