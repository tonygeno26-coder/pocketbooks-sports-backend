#!/usr/bin/env node
/**
 * Apply durable asset-recovery seed into Supabase (player_photos + soccer team_logos).
 *
 *   node scripts/apply-asset-recovery-seed.js --dry-run
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/apply-asset-recovery-seed.js
 *
 * Idempotent upserts only. Never deletes. No TSDB. No NCAAF team polish.
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SEED = path.join(__dirname, '..', 'data', 'asset-recovery-seed.json');
const DRY = process.argv.indexOf('--dry-run') >= 0;

async function main() {
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  console.log('Seed loaded', {
    players: seed.playerPhotos.length,
    soccerTeams: seed.soccerTeams.length,
    soccerAliases: seed.soccerAliases.length,
    dryRun: DRY
  });

  if (DRY) {
    console.log(JSON.stringify({ ok: true, dry_run: true, samplePlayers: seed.playerPhotos.slice(0, 3), sampleSoccer: seed.soccerTeams.slice(0, 3) }, null, 2));
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let playersUpserted = 0;
  let playersFailed = 0;
  for (let i = 0; i < seed.playerPhotos.length; i++) {
    const row = seed.playerPhotos[i];
    const now = new Date().toISOString();
    try {
      const { data: existing } = await sb.from('player_photos')
        .select('player_name,sport')
        .eq('sport', row.sport)
        .ilike('player_name', row.player_name)
        .limit(1);
      if (existing && existing[0]) {
        const { error } = await sb.from('player_photos').update({
          espn_id: row.espn_id,
          photo_url: row.photo_url,
          verified: true,
          updated_at: now
        }).eq('sport', row.sport).ilike('player_name', existing[0].player_name);
        if (error) throw error;
      } else {
        const { error } = await sb.from('player_photos').insert({
          player_name: row.player_name,
          sport: row.sport,
          espn_id: row.espn_id,
          photo_url: row.photo_url,
          verified: true,
          created_at: now,
          updated_at: now
        });
        if (error) throw error;
      }
      playersUpserted++;
    } catch (e) {
      playersFailed++;
      if (playersFailed <= 5) console.warn('player fail', row.player_name, e.message);
    }
  }

  let soccerUpserted = 0;
  let soccerFailed = 0;
  for (let i = 0; i < seed.soccerTeams.length; i++) {
    const row = seed.soccerTeams[i];
    const now = new Date().toISOString();
    try {
      const { data: existing } = await sb.from('team_logos')
        .select('id, aliases')
        .eq('sport', 'soccer')
        .eq('provider', 'espn')
        .eq('provider_team_id', row.provider_team_id)
        .maybeSingle();
      if (existing && existing.id) {
        const merged = Array.from(new Set([].concat(existing.aliases || [], row.aliases || [])));
        const { error } = await sb.from('team_logos').update({
          canonical_name: row.canonical_name,
          display_name: row.display_name,
          logo_url: row.logo_url,
          aliases: merged,
          active: true,
          updated_at: now,
          last_synced_at: now
        }).eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await sb.from('team_logos').insert({
          sport: 'soccer',
          provider: 'espn',
          provider_team_id: row.provider_team_id,
          canonical_name: row.canonical_name,
          display_name: row.display_name,
          logo_url: row.logo_url,
          aliases: row.aliases || [],
          classification: 'club',
          active: true,
          created_at: now,
          updated_at: now,
          last_synced_at: now
        });
        if (error) throw error;
      }
      soccerUpserted++;
    } catch (e) {
      soccerFailed++;
      if (soccerFailed <= 5) console.warn('soccer fail', row.canonical_name, e.message);
    }
  }

  // Attach board aliases onto existing rows by provider_team_id
  let aliasAttached = 0;
  for (let i = 0; i < seed.soccerAliases.length; i++) {
    const a = seed.soccerAliases[i];
    try {
      const { data: existing } = await sb.from('team_logos')
        .select('id, aliases')
        .eq('sport', 'soccer')
        .eq('provider', 'espn')
        .eq('provider_team_id', a.provider_team_id)
        .maybeSingle();
      if (!existing || !existing.id) continue;
      const merged = Array.from(new Set([].concat(existing.aliases || [], [a.alias])));
      const { error } = await sb.from('team_logos').update({
        aliases: merged,
        updated_at: new Date().toISOString()
      }).eq('id', existing.id);
      if (error) throw error;
      aliasAttached++;
    } catch (e) {
      console.warn('alias fail', a.alias, e.message);
    }
  }

  console.log(JSON.stringify({
    ok: playersFailed === 0 && soccerFailed === 0,
    playersUpserted,
    playersFailed,
    soccerUpserted,
    soccerFailed,
    aliasAttached
  }, null, 2));
  if (playersFailed || soccerFailed) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
