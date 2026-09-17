#!/usr/bin/env node
/**
 * Apply durable asset-recovery seed into Supabase (player_photos + soccer team_logos).
 *
 *   node scripts/apply-asset-recovery-seed.js --dry-run
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/apply-asset-recovery-seed.js
 *
 * Idempotent upserts only. Never deletes. No TSDB. No NCAAF team logo polish.
 *
 * Existing verified/working assets win:
 *   - skip player update when verified + working photo already present (unless identical)
 *   - skip soccer logo_url overwrite when existing active logo already present (aliases still merge)
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SEED = path.join(__dirname, '..', 'data', 'asset-recovery-seed.json');
const APPROVED = path.join(__dirname, '..', '..', 'pocketbooks-sports', '.tmp-asset-census', 'phase2-safe-fixes.json');
const MANIFEST_DIR = path.join(__dirname, '..', '.tmp-asset-recovery');
const MANIFEST = path.join(MANIFEST_DIR, 'dry-run-manifest.json');
const DRY = process.argv.indexOf('--dry-run') >= 0;
const FORCE_OVERWRITE = process.argv.indexOf('--force-overwrite') >= 0;

function isEspnAssetUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^https:\/\/a\.espncdn\.com\//i.test(url) && !/\/default[_-]?/i.test(url);
}

function workingPhoto(url) {
  return isEspnAssetUrl(url);
}

function loadApprovedIndex() {
  if (!fs.existsSync(APPROVED)) return null;
  const raw = JSON.parse(fs.readFileSync(APPROVED, 'utf8'));
  const fixes = raw.fixes || [];
  const byKey = new Map();
  fixes.forEach(function (f) {
    const sport = String(f.sport || '').toLowerCase();
    const name = String(f.providerName || '');
    const espnId = String(f.espnId || '');
    byKey.set(sport + '|' + name.toLowerCase() + '|' + espnId, f);
  });
  return { count: fixes.length, byKey: byKey, classes: fixes.reduce(function (acc, f) {
    acc[f.recoveryClass] = (acc[f.recoveryClass] || 0) + 1;
    return acc;
  }, {}) };
}

function approvedHit(index, sport, name, espnId) {
  if (!index) return null;
  return index.byKey.get(String(sport).toLowerCase() + '|' + String(name).toLowerCase() + '|' + String(espnId)) || null;
}

function ensureClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function planPlayerMutation(sb, row, approved) {
  const fix = approvedHit(approved, row.sport, row.player_name, row.espn_id);
  const base = {
    entity: row.player_name,
    sport: row.sport,
    entityType: 'athlete',
    canonicalIdentity: { espn_id: String(row.espn_id), player_name: row.player_name },
    currentAsset: null,
    proposedAsset: row.photo_url,
    source: 'espn',
    reason: fix ? (fix.recoveryClass + ': ' + ((fix.notes && fix.notes[0]) || fix.reasonCode || 'approved')) : 'SEED_NOT_IN_APPROVED',
    recoveryClass: fix ? fix.recoveryClass : 'UNAPPROVED',
    targetTable: 'player_photos',
    columns: ['player_name', 'sport', 'espn_id', 'photo_url', 'verified', 'created_at', 'updated_at'],
    operation: 'UNKNOWN',
    skipReason: null
  };

  if (!sb) {
    base.operation = 'PLANNED_UPSERT';
    base.note = 'No SUPABASE_* creds — classified as upsert without live DB probe';
    return base;
  }

  const { data: existing, error } = await sb.from('player_photos')
    .select('player_name,sport,espn_id,photo_url,verified')
    .eq('sport', row.sport)
    .ilike('player_name', row.player_name)
    .limit(1);
  if (error) throw error;

  if (!existing || !existing[0]) {
    base.operation = 'INSERT';
    return base;
  }

  const cur = existing[0];
  base.currentAsset = cur.photo_url || null;
  base.currentEspnId = cur.espn_id != null ? String(cur.espn_id) : null;
  base.currentVerified = !!cur.verified;

  const samePhoto = String(cur.photo_url || '') === String(row.photo_url || '');
  const sameId = String(cur.espn_id || '') === String(row.espn_id || '');
  const hasWorking = workingPhoto(cur.photo_url);

  if (samePhoto && sameId && cur.verified) {
    base.operation = 'NOOP';
    base.skipReason = 'identical_verified_row';
    return base;
  }

  // Existing correct assets must win — fill gaps only unless --force-overwrite
  if (!FORCE_OVERWRITE && cur.verified && hasWorking && !samePhoto) {
    base.operation = 'SKIP';
    base.skipReason = 'existing_verified_working_asset_wins';
    return base;
  }
  if (!FORCE_OVERWRITE && cur.verified && hasWorking && !sameId) {
    base.operation = 'SKIP';
    base.skipReason = 'existing_verified_identity_wins';
    return base;
  }

  base.operation = 'UPDATE';
  base.columns = ['espn_id', 'photo_url', 'verified', 'updated_at'];
  return base;
}

async function planSoccerTeamMutation(sb, row, approved) {
  const fix = approvedHit(approved, 'soccer', row.canonical_name, row.provider_team_id);
  const base = {
    entity: row.canonical_name,
    sport: 'soccer',
    entityType: 'team',
    canonicalIdentity: { provider: 'espn', provider_team_id: String(row.provider_team_id) },
    currentAsset: null,
    proposedAsset: row.logo_url,
    source: 'espn',
    reason: fix ? (fix.recoveryClass + ': ' + ((fix.notes && fix.notes[0]) || fix.reasonCode || 'approved')) : 'SEED_NOT_IN_APPROVED',
    recoveryClass: fix ? fix.recoveryClass : 'UNAPPROVED',
    targetTable: 'team_logos',
    columns: ['sport', 'provider', 'provider_team_id', 'canonical_name', 'display_name', 'logo_url', 'aliases', 'classification', 'active', 'created_at', 'updated_at', 'last_synced_at'],
    operation: 'UNKNOWN',
    skipReason: null
  };

  if (!sb) {
    base.operation = 'PLANNED_UPSERT';
    base.note = 'No SUPABASE_* creds — classified as upsert without live DB probe';
    return base;
  }

  const { data: existing, error } = await sb.from('team_logos')
    .select('id, aliases, logo_url, canonical_name, display_name, active, provider_team_id')
    .eq('sport', 'soccer')
    .eq('provider', 'espn')
    .eq('provider_team_id', row.provider_team_id)
    .maybeSingle();
  if (error) throw error;

  if (!existing || !existing.id) {
    base.operation = 'INSERT';
    return base;
  }

  base.currentAsset = existing.logo_url || null;
  base.currentCanonical = existing.canonical_name || null;
  const sameLogo = String(existing.logo_url || '') === String(row.logo_url || '');
  const hasWorking = workingPhoto(existing.logo_url);

  if (sameLogo && existing.active) {
    // Still may merge aliases
    base.operation = 'UPDATE_ALIASES_ONLY';
    base.columns = ['aliases', 'updated_at', 'last_synced_at'];
    base.skipReason = 'existing_logo_kept_merge_aliases';
    return base;
  }

  if (!FORCE_OVERWRITE && hasWorking && existing.active && !sameLogo) {
    base.operation = 'UPDATE_ALIASES_ONLY';
    base.columns = ['aliases', 'updated_at', 'last_synced_at'];
    base.skipReason = 'existing_working_logo_wins';
    return base;
  }

  base.operation = 'UPDATE';
  base.columns = ['canonical_name', 'display_name', 'logo_url', 'aliases', 'active', 'updated_at', 'last_synced_at'];
  return base;
}

async function planAliasMutation(sb, row, approved) {
  const fix = approvedHit(approved, 'soccer', row.alias, row.provider_team_id);
  const base = {
    entity: row.alias,
    sport: 'soccer',
    entityType: 'team_alias',
    canonicalIdentity: { provider: 'espn', provider_team_id: String(row.provider_team_id) },
    currentAsset: null,
    proposedAsset: row.logo_url || null,
    source: 'espn',
    reason: fix ? (fix.recoveryClass + ': board alias attach') : 'SEED_NOT_IN_APPROVED',
    recoveryClass: fix ? fix.recoveryClass : 'UNAPPROVED',
    targetTable: 'team_logos',
    columns: ['aliases', 'updated_at'],
    operation: 'UNKNOWN',
    skipReason: null
  };

  if (!sb) {
    base.operation = 'PLANNED_UPDATE_ALIASES';
    base.note = 'No SUPABASE_* creds — alias merge planned if provider_team_id row exists';
    return base;
  }

  const { data: existing, error } = await sb.from('team_logos')
    .select('id, aliases, logo_url')
    .eq('sport', 'soccer')
    .eq('provider', 'espn')
    .eq('provider_team_id', row.provider_team_id)
    .maybeSingle();
  if (error) throw error;

  if (!existing || !existing.id) {
    base.operation = 'SKIP';
    base.skipReason = 'canonical_row_missing_for_alias';
    return base;
  }

  base.currentAsset = existing.logo_url || null;
  const aliases = existing.aliases || [];
  if (aliases.indexOf(row.alias) >= 0) {
    base.operation = 'NOOP';
    base.skipReason = 'alias_already_present';
    return base;
  }
  base.operation = 'UPDATE';
  return base;
}

async function buildManifest(seed, sb) {
  const approved = loadApprovedIndex();
  const mutations = [];

  for (let i = 0; i < seed.playerPhotos.length; i++) {
    mutations.push(await planPlayerMutation(sb, seed.playerPhotos[i], approved));
  }
  for (let i = 0; i < seed.soccerTeams.length; i++) {
    mutations.push(await planSoccerTeamMutation(sb, seed.soccerTeams[i], approved));
  }
  for (let i = 0; i < seed.soccerAliases.length; i++) {
    mutations.push(await planAliasMutation(sb, seed.soccerAliases[i], approved));
  }

  const counts = {
    INSERT: 0,
    UPDATE: 0,
    UPDATE_ALIASES_ONLY: 0,
    PLANNED_UPSERT: 0,
    PLANNED_UPDATE_ALIASES: 0,
    NOOP: 0,
    SKIP: 0,
    UNKNOWN: 0
  };
  let unapproved = 0;
  let ambiguousWrites = 0;
  let tsdbWrites = 0;
  let ncaafTeamWrites = 0;
  let ncaafAthleteWrites = 0;
  let overwriteRisk = 0;

  mutations.forEach(function (m) {
    counts[m.operation] = (counts[m.operation] || 0) + 1;
    if (m.recoveryClass === 'UNAPPROVED') unapproved++;
    if (m.recoveryClass === 'AMBIGUOUS') ambiguousWrites++;
    if (m.source === 'tsdb' || /tsdb|thesportsdb/i.test(String(m.proposedAsset || ''))) tsdbWrites++;
    if (m.sport === 'ncaaf' && m.entityType === 'team') ncaafTeamWrites++;
    if (m.sport === 'ncaaf' && m.entityType === 'athlete' && m.operation !== 'NOOP' && m.operation !== 'SKIP') {
      ncaafAthleteWrites++;
    }
    if (m.skipReason === 'existing_verified_working_asset_wins' || m.operation === 'UPDATE' && m.currentAsset && workingPhoto(m.currentAsset) && m.currentAsset !== m.proposedAsset) {
      if (m.operation === 'UPDATE' && m.currentAsset && workingPhoto(m.currentAsset) && String(m.currentAsset) !== String(m.proposedAsset)) {
        overwriteRisk++;
      }
    }
  });

  const plannedMutating = mutations.filter(function (m) {
    return ['INSERT', 'UPDATE', 'UPDATE_ALIASES_ONLY', 'PLANNED_UPSERT', 'PLANNED_UPDATE_ALIASES'].indexOf(m.operation) >= 0;
  });

  return {
    generatedAt: new Date().toISOString(),
    dryRun: true,
    dbProbed: !!sb,
    forceOverwrite: FORCE_OVERWRITE,
    seed: {
      players: seed.playerPhotos.length,
      soccerTeams: seed.soccerTeams.length,
      soccerAliases: seed.soccerAliases.length,
      total: seed.playerPhotos.length + seed.soccerTeams.length + seed.soccerAliases.length
    },
    approved: approved ? { count: approved.count, classes: approved.classes } : null,
    matchApproved604: approved ? (seed.playerPhotos.length + seed.soccerTeams.length + seed.soccerAliases.length === 604 && approved.count === 604 && unapproved === 0) : false,
    unapprovedInSeed: unapproved,
    tablesTouched: ['player_photos', 'team_logos'],
    columnsTouched: {
      player_photos: ['player_name', 'sport', 'espn_id', 'photo_url', 'verified', 'created_at', 'updated_at'],
      team_logos: ['sport', 'provider', 'provider_team_id', 'canonical_name', 'display_name', 'logo_url', 'aliases', 'classification', 'active', 'created_at', 'updated_at', 'last_synced_at']
    },
    operationCounts: counts,
    plannedInserts: counts.INSERT,
    plannedUpdates: counts.UPDATE + counts.UPDATE_ALIASES_ONLY + counts.PLANNED_UPDATE_ALIASES,
    plannedUpserts: counts.PLANNED_UPSERT,
    plannedDeletes: 0,
    totalPlannedMutations: plannedMutating.length,
    espnRecoveries: seed.playerPhotos.length + seed.soccerTeams.length,
    aliases: seed.soccerAliases.length,
    ambiguousWrites: ambiguousWrites,
    tsdbWrites: tsdbWrites,
    ncaafTeamWrites: ncaafTeamWrites,
    ncaafAthleteWrites: ncaafAthleteWrites,
    existingVerifiedOverwriteRisk: overwriteRisk,
    financialTables: [],
    bettingTables: [],
    authTables: [],
    settlementTables: [],
    deletes: 0,
    policy: {
      neverDelete: true,
      noTsdb: true,
      noFuzzy: true,
      noAmbiguous: true,
      existingVerifiedWins: !FORCE_OVERWRITE
    },
    mutations: mutations
  };
}

async function applyFromSeed(seed, sb) {
  let playersUpserted = 0;
  let playersSkipped = 0;
  let playersFailed = 0;
  for (let i = 0; i < seed.playerPhotos.length; i++) {
    const row = seed.playerPhotos[i];
    const now = new Date().toISOString();
    try {
      const plan = await planPlayerMutation(sb, row, loadApprovedIndex());
      if (plan.operation === 'SKIP' || plan.operation === 'NOOP') {
        playersSkipped++;
        continue;
      }
      if (plan.operation === 'UPDATE') {
        const { data: existing } = await sb.from('player_photos')
          .select('player_name,sport')
          .eq('sport', row.sport)
          .ilike('player_name', row.player_name)
          .limit(1);
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
  let soccerSkipped = 0;
  let soccerFailed = 0;
  for (let i = 0; i < seed.soccerTeams.length; i++) {
    const row = seed.soccerTeams[i];
    const now = new Date().toISOString();
    try {
      const plan = await planSoccerTeamMutation(sb, row, loadApprovedIndex());
      if (plan.operation === 'NOOP') {
        soccerSkipped++;
        continue;
      }
      const { data: existing } = await sb.from('team_logos')
        .select('id, aliases, logo_url')
        .eq('sport', 'soccer')
        .eq('provider', 'espn')
        .eq('provider_team_id', row.provider_team_id)
        .maybeSingle();

      if (existing && existing.id) {
        const merged = Array.from(new Set([].concat(existing.aliases || [], row.aliases || [])));
        if (plan.operation === 'UPDATE_ALIASES_ONLY') {
          const { error } = await sb.from('team_logos').update({
            aliases: merged,
            updated_at: now,
            last_synced_at: now
          }).eq('id', existing.id);
          if (error) throw error;
        } else {
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
        }
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

  let aliasAttached = 0;
  let aliasSkipped = 0;
  for (let i = 0; i < seed.soccerAliases.length; i++) {
    const a = seed.soccerAliases[i];
    try {
      const plan = await planAliasMutation(sb, a, loadApprovedIndex());
      if (plan.operation === 'SKIP' || plan.operation === 'NOOP') {
        aliasSkipped++;
        continue;
      }
      const { data: existing } = await sb.from('team_logos')
        .select('id, aliases')
        .eq('sport', 'soccer')
        .eq('provider', 'espn')
        .eq('provider_team_id', a.provider_team_id)
        .maybeSingle();
      if (!existing || !existing.id) {
        aliasSkipped++;
        continue;
      }
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

  return {
    ok: playersFailed === 0 && soccerFailed === 0,
    playersUpserted,
    playersSkipped,
    playersFailed,
    soccerUpserted,
    soccerSkipped,
    soccerFailed,
    aliasAttached,
    aliasSkipped
  };
}

async function main() {
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  console.log('Seed loaded', {
    players: seed.playerPhotos.length,
    soccerTeams: seed.soccerTeams.length,
    soccerAliases: seed.soccerAliases.length,
    dryRun: DRY,
    forceOverwrite: FORCE_OVERWRITE
  });

  const sb = ensureClient();

  if (DRY) {
    const manifest = await buildManifest(seed, sb);
    fs.mkdirSync(MANIFEST_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    const summary = {
      ok: true,
      dry_run: true,
      dbProbed: manifest.dbProbed,
      matchApproved604: manifest.matchApproved604,
      seedTotal: manifest.seed.total,
      approvedCount: manifest.approved && manifest.approved.count,
      plannedInserts: manifest.plannedInserts,
      plannedUpdates: manifest.plannedUpdates,
      plannedUpserts: manifest.plannedUpserts,
      plannedDeletes: manifest.plannedDeletes,
      totalPlannedMutations: manifest.totalPlannedMutations,
      espnRecoveries: manifest.espnRecoveries,
      aliases: manifest.aliases,
      ambiguousWrites: manifest.ambiguousWrites,
      tsdbWrites: manifest.tsdbWrites,
      ncaafTeamWrites: manifest.ncaafTeamWrites,
      ncaafAthleteWrites: manifest.ncaafAthleteWrites,
      existingVerifiedOverwriteRisk: manifest.existingVerifiedOverwriteRisk,
      operationCounts: manifest.operationCounts,
      tablesTouched: manifest.tablesTouched,
      manifestPath: MANIFEST
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (!sb) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  // Always emit a pre-apply manifest for audit trail (local only)
  const pre = await buildManifest(seed, sb);
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(MANIFEST_DIR, 'pre-apply-manifest.json'), JSON.stringify(pre, null, 2));

  const result = await applyFromSeed(seed, sb);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
