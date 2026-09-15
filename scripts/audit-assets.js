#!/usr/bin/env node
/**
 * Permanent asset coverage audit against CURRENT Owls sportsbook catalog.
 *
 *   npm run audit:assets
 *   npm run audit:assets -- --skip-http
 *   PBS_BACKEND_URL=https://... npm run audit:assets
 *
 * Reports soccer logo + tennis photo coverage, classifies misses A–I,
 * validates resolved URLs (broken = missing), and updates the unresolved queue.
 * Never fuzzy-assigns images.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const soccer = require('../lib/soccer-team-logos');
const queue = require('../lib/unresolved-assets-queue');

const API = process.env.PBS_BACKEND_URL ||
  process.env.API ||
  'https://pocketbooks-sports-backend-production.up.railway.app';
const SKIP_HTTP = process.argv.indexOf('--skip-http') >= 0;
const OUT = (function () {
  var i = process.argv.indexOf('--out');
  return i >= 0 && process.argv[i + 1]
    ? process.argv[i + 1]
    : path.join(__dirname, '..', 'data', 'asset-audit-latest.json');
})();

function curlJson(url) {
  var out = execFileSync(
    'curl',
    ['-sS', '-L', '--max-time', '90', '-A', 'PocketBooks-AssetAudit/1.0', url],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  return JSON.parse(out);
}

function httpHeadOk(url) {
  return new Promise(function (resolve) {
    try {
      var u = new URL(url);
      var lib = u.protocol === 'http:' ? http : https;
      var req = lib.request({
        method: 'HEAD',
        hostname: u.hostname,
        path: u.pathname + u.search,
        protocol: u.protocol,
        timeout: 10000,
        headers: { 'User-Agent': 'PocketBooks-AssetAudit/1.0' }
      }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpHeadOk(res.headers.location).then(resolve);
          res.resume();
          return;
        }
        var ct = String(res.headers['content-type'] || '').toLowerCase();
        var ok = res.statusCode === 200 &&
          (!ct || ct.indexOf('image') >= 0 || ct.indexOf('octet') >= 0);
        resolve(ok);
        res.resume();
      });
      req.on('error', function () { resolve(false); });
      req.on('timeout', function () { req.destroy(); resolve(false); });
      req.end();
    } catch (_e) {
      resolve(false);
    }
  });
}

async function mapPool(items, worker, concurrency) {
  var idx = 0;
  var out = new Array(items.length);
  async function pump() {
    while (idx < items.length) {
      var i = idx++;
      out[i] = await worker(items[i], i);
    }
  }
  var n = Math.min(concurrency || 8, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, function () { return pump(); }));
  return out;
}

function extractCatalog(markets) {
  var games = (markets && markets.games) || [];
  var soccerTeams = Object.create(null);
  var tennisPlayers = Object.create(null);
  var soccerCtx = Object.create(null);
  var tennisCtx = Object.create(null);
  games.forEach(function (g) {
    if (!g) return;
    var sk = String(g.sport_key || g.sport || '').toLowerCase();
    var home = g.home_team || g.home;
    var away = g.away_team || g.away;
    var league = g.league || g.sport_title || null;
    if (sk.indexOf('soccer') >= 0) {
      [home, away].forEach(function (n) {
        if (!n) return;
        var name = String(n).trim();
        soccerTeams[name] = true;
        soccerCtx[name] = league;
      });
    } else if (sk.indexOf('tennis') >= 0) {
      [home, away].forEach(function (n) {
        if (!n) return;
        var name = String(n).trim();
        // Doubles "A / B" kept as board identity (no auto-split photo assign)
        tennisPlayers[name] = true;
        tennisCtx[name] = league;
      });
    }
  });
  return {
    soccer: Object.keys(soccerTeams).sort(),
    tennis: Object.keys(tennisPlayers).sort(),
    soccerCtx: soccerCtx,
    tennisCtx: tennisCtx
  };
}

function loadRemoteSoccerIndex() {
  var logos = curlJson(API + '/api/team-logos/soccer');
  var rows = (logos.teams || []).map(function (t) {
    return {
      sport: 'soccer',
      provider: 'espn',
      provider_team_id: t.providerTeamId,
      canonical_name: t.canonicalName,
      display_name: t.displayName,
      abbreviation: t.abbreviation,
      logo_url: t.logoUrl,
      aliases: t.aliases || [],
      classification: t.classification,
      active: true
    };
  });
  return soccer.buildResolverIndex(rows);
}

function loadFeVerifiedTennis() {
  var fePath = path.join(__dirname, '..', '..', 'pocketbooks-sports', 'player-photos.js');
  // Prefer sibling FE checkout; fall back to empty
  var candidates = [
    fePath,
    path.join(process.env.PBS_FE_ROOT || '', 'player-photos.js'),
    path.join(__dirname, '..', 'player-photos.js')
  ];
  var src = '';
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (candidates[i] && fs.existsSync(candidates[i])) {
        src = fs.readFileSync(candidates[i], 'utf8');
        break;
      }
    } catch (_e) {}
  }
  var map = Object.create(null);
  if (!src) return map;
  var idx = src.indexOf('\n  tennis: {');
  if (idx < 0) return map;
  var brace = src.indexOf('{', idx);
  var depth = 0;
  var end = brace;
  for (var j = brace; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) { end = j; break; }
    }
  }
  var body = src.slice(brace + 1, end);
  var re = /(?:'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)")\s*:\s*(\d+)/g;
  var m;
  while ((m = re.exec(body))) {
    var name = (m[1] != null ? m[1] : m[2]).replace(/\\'/g, "'");
    map[name] = String(m[3]);
    map[queue.normKey(name)] = String(m[3]);
  }
  return map;
}

/**
 * Optional ESPN source-audit overlay (from Phase-2 full catalog probe).
 * Maps Owls name → { status, espnId?, reason? }.
 */
function loadTennisSourceOverlay() {
  var i = process.argv.indexOf('--tennis-source');
  var candidates = [];
  if (i >= 0 && process.argv[i + 1]) candidates.push(process.argv[i + 1]);
  if (process.env.PBS_TENNIS_SOURCE_AUDIT) candidates.push(process.env.PBS_TENNIS_SOURCE_AUDIT);
  candidates.push(
    path.join(__dirname, '..', '..', 'pocketbooks-sports', '.tmp-asset-audit', 'tennis_source_audit_full.json'),
    path.join(process.env.PBS_FE_ROOT || '', '.tmp-asset-audit', 'tennis_source_audit_full.json')
  );
  for (var c = 0; c < candidates.length; c++) {
    try {
      if (!candidates[c] || !fs.existsSync(candidates[c])) continue;
      var raw = JSON.parse(fs.readFileSync(candidates[c], 'utf8'));
      var by = Object.create(null);
      (raw.results || []).forEach(function (r) {
        if (!r || !r.name) return;
        by[r.name] = r;
        by[queue.normKey(r.name)] = r;
      });
      return { path: candidates[c], by: by, byStatus: raw.byStatus || null };
    } catch (_e) {}
  }
  return { path: null, by: Object.create(null), byStatus: null };
}

function tennisHeadshotUrl(id) {
  return 'https://a.espncdn.com/i/headshots/tennis/players/full/' + id + '.png';
}

async function main() {
  console.log('Asset audit against', API);
  var markets = curlJson(API + '/api/markets/live');
  var catalog = extractCatalog(markets);
  var index = loadRemoteSoccerIndex();
  var tennisVerified = loadFeVerifiedTennis();
  var tennisSource = loadTennisSourceOverlay();
  if (tennisSource.path) console.log('Tennis source overlay:', tennisSource.path);

  // Soccer resolve
  var soccerResolved = [];
  var soccerMissing = [];
  var soccerBroken = [];
  var soccerAmbiguous = [];
  for (var si = 0; si < catalog.soccer.length; si++) {
    var sName = catalog.soccer[si];
    var r = soccer.resolveTeamLogo(sName, index);
    if (r.status === 'ambiguous') {
      soccerAmbiguous.push(sName);
      soccerMissing.push({ name: sName, reason: 'F', status: 'ambiguous' });
      continue;
    }
    if (!r.logoUrl) {
      soccerMissing.push({ name: sName, reason: queue.classifySoccerMiss(sName, { inDb: false }), status: r.status });
      continue;
    }
    soccerResolved.push({ name: sName, url: r.logoUrl, status: r.status, id: r.row && r.row.provider_team_id });
  }

  if (!SKIP_HTTP) {
    var checked = await mapPool(soccerResolved, async function (item) {
      var ok = await httpHeadOk(item.url);
      return Object.assign({}, item, { ok: ok });
    }, 8);
    soccerResolved = [];
    checked.forEach(function (item) {
      if (item.ok) soccerResolved.push(item);
      else {
        soccerBroken.push(item.name);
        soccerMissing.push({ name: item.name, reason: 'E', status: 'broken', url: item.url });
      }
    });
  }

  // Tennis resolve via FE verified map + optional ESPN source overlay for miss taxonomy
  var tennisResolved = [];
  var tennisMissing = [];
  var tennisBroken = [];
  var tennisQuality = {
    verifiedPhoto: 0,
    doublesPair: 0,
    espnIdNoHeadshot: 0,
    notInEspn: 0,
    noExactMatch: 0,
    ambiguous: 0,
    unmappedNoOverlay: 0
  };
  for (var ti = 0; ti < catalog.tennis.length; ti++) {
    var tName = catalog.tennis[ti];
    if (tName.indexOf(' / ') >= 0) {
      tennisMissing.push({ name: tName, reason: 'D', status: 'doubles_pair' });
      tennisQuality.doublesPair++;
      continue;
    }
    var id = tennisVerified[tName] || tennisVerified[queue.normKey(tName)];
    if (id) {
      var url = tennisHeadshotUrl(id);
      tennisResolved.push({ name: tName, url: url, espnId: id });
      continue;
    }
    var srcHit = tennisSource.by[tName] || tennisSource.by[queue.normKey(tName)];
    if (srcHit && srcHit.status === 'verified' && srcHit.espnId && srcHit.photoUrl) {
      // Source-proven photo not yet in FE map — still count as resolvable once filled;
      // until then treat as Class C (mapping missing), not Class D.
      tennisMissing.push({
        name: tName,
        reason: 'C',
        status: 'source_verified_unmapped',
        espnId: srcHit.espnId,
        url: srcHit.photoUrl
      });
      tennisQuality.verifiedPhoto++;
      continue;
    }
    if (srcHit && srcHit.status === 'no_headshot') {
      tennisMissing.push({
        name: tName,
        reason: queue.classifyTennisMiss(tName, { espnId: srcHit.espnId, headshot404: true }),
        status: 'espn_id_no_headshot',
        espnId: srcHit.espnId || null
      });
      tennisQuality.espnIdNoHeadshot++;
      continue;
    }
    if (srcHit && srcHit.status === 'not_in_espn') {
      tennisMissing.push({ name: tName, reason: 'D', status: 'not_in_espn' });
      tennisQuality.notInEspn++;
      continue;
    }
    if (srcHit && srcHit.status === 'no_exact') {
      tennisMissing.push({ name: tName, reason: 'C', status: 'no_exact' });
      tennisQuality.noExactMatch++;
      continue;
    }
    if (srcHit && srcHit.status === 'ambiguous') {
      tennisMissing.push({ name: tName, reason: 'F', status: 'ambiguous', espnIds: srcHit.espnIds });
      tennisQuality.ambiguous++;
      continue;
    }
    tennisMissing.push({ name: tName, reason: 'C', status: 'unmapped' });
    tennisQuality.unmappedNoOverlay++;
  }

  if (!SKIP_HTTP) {
    var tChecked = await mapPool(tennisResolved, async function (item) {
      var ok = await httpHeadOk(item.url);
      return Object.assign({}, item, { ok: ok });
    }, 8);
    tennisResolved = [];
    tChecked.forEach(function (item) {
      if (item.ok) tennisResolved.push(item);
      else {
        tennisBroken.push(item.name);
        tennisMissing.push({ name: item.name, reason: 'E', status: 'broken', url: item.url, espnId: item.espnId });
      }
    });
  }

  var soccerTotal = catalog.soccer.length;
  var tennisTotal = catalog.tennis.length;
  var soccerOk = soccerResolved.length;
  var tennisOk = tennisResolved.length;

  var report = {
    ok: true,
    auditedAt: new Date().toISOString(),
    api: API,
    soccer: {
      total: soccerTotal,
      resolved: soccerOk,
      missing: soccerTotal - soccerOk,
      broken: soccerBroken.length,
      ambiguous: soccerAmbiguous.length,
      coveragePct: soccerTotal ? Math.round((1000 * soccerOk) / soccerTotal) / 10 : 0,
      missingNames: soccerMissing.map(function (x) { return x.name; }),
      missingClassified: soccerMissing,
      brokenNames: soccerBroken,
      ambiguousNames: soccerAmbiguous
    },
    tennis: {
      total: tennisTotal,
      resolved: tennisOk,
      missing: tennisTotal - tennisOk,
      broken: tennisBroken.length,
      coveragePct: tennisTotal ? Math.round((1000 * tennisOk) / tennisTotal) / 10 : 0,
      missingNames: tennisMissing.map(function (x) { return x.name; }),
      missingClassified: tennisMissing,
      brokenNames: tennisBroken,
      quality: tennisQuality,
      sourceOverlay: tennisSource.path || null,
      sourceByStatus: tennisSource.byStatus || null,
      verifiedMapSize: Object.keys(tennisVerified).filter(function (k) { return !/^[a-z0-9 ]+$/.test(k) || tennisVerified[k] !== tennisVerified[queue.normKey(k)]; }).length
    }
  };

  // Unresolved queue (durable)
  var queueEntries = [];
  soccerMissing.forEach(function (m) {
    queueEntries.push({
      sport: 'soccer',
      entityName: m.name,
      reason: m.reason,
      provider: 'owls',
      competition: catalog.soccerCtx[m.name] || null,
      notes: m.status
    });
  });
  tennisMissing.forEach(function (m) {
    queueEntries.push({
      sport: 'tennis',
      entityName: m.name,
      reason: m.reason,
      provider: 'owls',
      competition: catalog.tennisCtx[m.name] || null,
      providerId: m.espnId || null,
      notes: m.status
    });
  });
  var q = queue.recordUnresolved(queueEntries);
  report.unresolvedQueue = { path: queue.DEFAULT_PATH, count: q.items.length };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');

  console.log('\n========== ASSET COVERAGE AUDIT ==========');
  console.log('SOCCER: ' + soccerOk + ' / ' + soccerTotal + ' resolved (' + report.soccer.coveragePct + '%)');
  console.log('  missing: ' + report.soccer.missing + '  broken: ' + report.soccer.broken + '  ambiguous: ' + report.soccer.ambiguous);
  console.log('TENNIS: ' + tennisOk + ' / ' + tennisTotal + ' resolved (' + report.tennis.coveragePct + '%)');
  console.log('  missing: ' + report.tennis.missing + '  broken: ' + report.tennis.broken);
  if (report.tennis.quality) {
    console.log('  quality:', JSON.stringify(report.tennis.quality));
  }
  console.log('Unresolved queue items:', q.items.length);
  console.log('Wrote', OUT);
  console.log('==========================================\n');

  if (report.soccer.missingNames.length) {
    console.log('MISSING SOCCER (' + report.soccer.missingNames.length + '):');
    report.soccer.missingNames.slice(0, 80).forEach(function (n) { console.log('  - ' + n); });
    if (report.soccer.missingNames.length > 80) console.log('  ... +' + (report.soccer.missingNames.length - 80) + ' more');
  }
  if (report.tennis.missingNames.length) {
    console.log('\nMISSING TENNIS (' + report.tennis.missingNames.length + '):');
    report.tennis.missingNames.slice(0, 80).forEach(function (n) { console.log('  - ' + n); });
    if (report.tennis.missingNames.length > 80) console.log('  ... +' + (report.tennis.missingNames.length - 80) + ' more');
  }
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
