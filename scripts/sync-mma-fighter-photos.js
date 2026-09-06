#!/usr/bin/env node
/**
 * Sync ESPN MMA fighter headshots into public.player_photos (sport=mma).
 *
 * Usage:
 *   node scripts/sync-mma-fighter-photos.js
 *   node scripts/sync-mma-fighter-photos.js --dry-run
 *   node scripts/sync-mma-fighter-photos.js --extra "Jon Jones,Conor McGregor"
 *
 * Sources fighter names from Owls (OWLS_INSIGHT_API_KEY) with production
 * /api/odds/mma fallback. Idempotent upserts; never deletes.
 */
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const {
  syncMmaFighterPhotos,
  fetchOwlsMmaGames,
  collectFighterNamesFromGames,
  searchEspnMmaFighter
} = require('../lib/mma-fighter-photos');

const TOP_UFC = [
  'Jon Jones', 'Islam Makhachev', 'Alex Pereira', 'Leon Edwards', 'Dricus Du Plessis',
  "Sean O'Malley", 'Ilia Topuria', 'Tom Aspinall', 'Arman Tsarukyan', 'Charles Oliveira',
  'Dustin Poirier', 'Justin Gaethje', 'Conor McGregor', 'Khamzat Chimaev', 'Robert Whittaker',
  'Kamaru Usman', 'Israel Adesanya', 'Max Holloway', 'Alexander Volkanovski', 'Paddy Pimblett',
  'Sean Strickland', 'Jiri Prochazka', 'Jan Blachowicz', 'Magomed Ankalaev', 'Jamahal Hill',
  'Sergei Pavlovich', 'Ciryl Gane', 'Stipe Miocic', 'Francis Ngannou', 'Curtis Blaydes',
  'Belal Muhammad', 'Colby Covington', 'Jorge Masvidal', 'Nate Diaz', 'Amanda Nunes',
  'Valentina Shevchenko', 'Zhang Weili', 'Rose Namajunas', 'Julianna Pena'
];

function parseExtra() {
  var idx = process.argv.indexOf('--extra');
  if (idx < 0 || !process.argv[idx + 1]) return [];
  return String(process.argv[idx + 1]).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

async function main() {
  var dryRun = process.argv.indexOf('--dry-run') >= 0;
  var extra = TOP_UFC.concat(parseExtra());

  if (dryRun) {
    var games = await fetchOwlsMmaGames({});
    var names = collectFighterNamesFromGames(games);
    var sample = names.slice(0, 5);
    var probes = [];
    for (var i = 0; i < Math.min(3, sample.length); i++) {
      probes.push({ name: sample[i], hit: await searchEspnMmaFighter(sample[i]) });
    }
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      games: games.length,
      fighters: names.length,
      sample: sample,
      probes: probes
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
  var result = await syncMmaFighterPhotos(sb, { extraNames: extra });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok || result.failed > result.resolved) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
