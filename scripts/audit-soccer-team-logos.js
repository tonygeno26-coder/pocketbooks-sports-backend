#!/usr/bin/env node
/**
 * Audit distinct soccer odds-provider team names against team_logos (sport=soccer).
 *
 * Sources:
 *  1. --names "Inter Milan","Man City"
 *  2. stdin JSON array / newline list
 *  3. Live Owls board via /api/odds/soccer (default when no names)
 *  4. ticket_legs / odds_snapshots fallback
 *
 * Prints every unresolved and ambiguous name.
 */
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { execFileSync } = require('child_process');
const {
  loadTeamLogoRows,
  buildResolverIndex,
  auditProviderNames
} = require('../lib/soccer-team-logos');

function parseNamesArg(argv) {
  var i = argv.indexOf('--names');
  if (i < 0 || !argv[i + 1]) return null;
  return argv[i + 1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

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

async function collectFromDb(sb) {
  var names = {};
  try {
    var { data } = await sb.from('ticket_legs')
      .select('home_team,away_team,sport')
      .ilike('sport', '%soccer%')
      .limit(5000);
    (data || []).forEach(function (r) {
      if (r.home_team) names[String(r.home_team).trim()] = true;
      if (r.away_team) names[String(r.away_team).trim()] = true;
    });
  } catch (_e) {}
  try {
    var { data: snaps } = await sb.from('odds_snapshots')
      .select('home_team,away_team,sport')
      .ilike('sport', '%soccer%')
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

  var rows = await loadTeamLogoRows(sb, 'soccer');
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
  if (!names || !names.length) {
    names = fetchLiveBoardNames();
  }
  if (!names.length) {
    names = await collectFromDb(sb);
  }

  var report = auditProviderNames(names, index);
  var coverage = report.total
    ? Math.round((1000 * report.matched) / report.total) / 10
    : 0;

  console.log(JSON.stringify({
    ok: true,
    sport: 'soccer',
    team_logos_rows: rows.length,
    total: report.total,
    matched: report.matched,
    exact: report.exact,
    alias: report.alias,
    normalized: report.normalized,
    provider_id: report.provider_id,
    coverage_pct: coverage,
    unresolved: report.unresolved.map(function (x) { return x.name; }),
    ambiguous: report.ambiguous.map(function (x) { return x.name; })
  }, null, 2));

  if (report.unresolved.length || report.ambiguous.length) {
    console.error('\nUNRESOLVED (' + report.unresolved.length + '):');
    report.unresolved.forEach(function (x) { console.error('  - ' + x.name); });
    console.error('\nAMBIGUOUS (' + report.ambiguous.length + '):');
    report.ambiguous.forEach(function (x) { console.error('  - ' + x.name); });
  }
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
