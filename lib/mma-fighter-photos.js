/**
 * MMA fighter photo database — Owls matchup names → ESPN IDs → verified headshots.
 *
 * Writes to public.player_photos (sport='mma'). Exact-name matching only (no fuzzy).
 *
 * Search strategy (in order):
 *  1. Task-style: query={name} mma&sport=mma&type=athlete&limit=3 (site.web.api + site.api)
 *  2. query={name}&type=player&limit=5 (site.web.api) — most reliable from edge-blocked hosts
 *  3. query={name} mma|ufc&type=player
 *
 * Only stores verified=true when the ESPN headshot URL returns an image.
 */
'use strict';

const { execFile } = require('child_process');

const SPORT = 'mma';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function normName(n) {
  return String(n || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headshotUrl(espnId) {
  return 'https://a.espncdn.com/i/headshots/mma/players/full/' + espnId + '.png';
}

function httpsJson(url, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(
      'curl',
      [
        '-sS', '-L', '--max-time', String(Math.ceil((timeoutMs || 8000) / 1000)),
        '-A', UA, '-H', 'Accept: application/json', url
      ],
      { timeout: (timeoutMs || 8000) + 1000, maxBuffer: 2 * 1024 * 1024 },
      function (err, stdout) {
        if (err || !stdout) return resolve(null);
        var s = String(stdout);
        if (s.trim().charAt(0) === '<') return resolve(null);
        try { resolve(JSON.parse(s)); }
        catch (_e) { resolve(null); }
      }
    );
  });
}

function verifyImageUrl(url) {
  return new Promise(function (resolve) {
    execFile(
      'curl',
      [
        '-sS', '-o', '/dev/null', '-w', '%{http_code} %{content_type}',
        '-I', '-L', '--max-time', '8', '-A', UA, url
      ],
      { timeout: 10000 },
      function (err, stdout) {
        var parts = String(stdout || '').trim().split(/\s+/);
        var code = parts[0];
        var ct = (parts.slice(1).join(' ') || '').toLowerCase();
        if (code === '200' && (!ct || ct.indexOf('image') >= 0 || ct.indexOf('octet') >= 0)) {
          return resolve(true);
        }
        execFile(
          'curl',
          ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-L', '--max-time', '8', '-A', UA, '-r', '0-64', url],
          { timeout: 10000 },
          function (err2, stdout2) {
            var c = String(stdout2 || '').trim();
            resolve(c === '200' || c === '206');
          }
        );
      }
    );
  });
}

function buildSearchUrls(playerName) {
  var name = String(playerName || '').trim();
  var parts = name.split(/\s+/).filter(Boolean);
  var firstLast = parts.length >= 2 ? parts[0] + ' ' + parts[parts.length - 1] : name;
  var queries = [name, name + ' mma', name + ' ufc', firstLast];
  var seen = {};
  var urls = [];
  queries.forEach(function (q) {
    if (!q || seen[q]) return;
    seen[q] = true;
    var enc = encodeURIComponent(q);
    urls.push('https://site.web.api.espn.com/apis/common/v3/search?query=' + enc + '&sport=mma&type=athlete&limit=3');
    urls.push('https://site.api.espn.com/apis/common/v3/search?query=' + enc + '&sport=mma&type=athlete&limit=3');
    urls.push('https://site.web.api.espn.com/apis/common/v3/search?query=' + enc + '&type=player&limit=5');
  });
  return urls;
}

async function searchEspnMmaFighter(playerName) {
  var want = normName(playerName);
  if (!want) return null;
  var urls = buildSearchUrls(playerName);
  for (var i = 0; i < urls.length; i++) {
    var data = await httpsJson(urls[i], 8000);
    var items = (data && data.items) || [];
    var exact = [];
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      if (!it || !it.id) continue;
      var sp = String(it.sport || '').toLowerCase();
      if (sp && sp !== 'mma') continue;
      var dn = normName(it.displayName || it.name || '');
      if (dn === want) exact.push(it);
    }
    if (exact.length !== 1) continue;
    var chosen = exact[0];
    var espnId = String(chosen.id);
    var hs = chosen.headshot && chosen.headshot.href ? String(chosen.headshot.href) : '';
    var photoUrl = hs || headshotUrl(espnId);
    var verified = await verifyImageUrl(photoUrl);
    if (!verified && hs) {
      photoUrl = headshotUrl(espnId);
      verified = await verifyImageUrl(photoUrl);
    }
    if (!verified) {
      return { espnId: espnId, photoUrl: null, verified: false, displayName: chosen.displayName || playerName };
    }
    return {
      espnId: espnId,
      photoUrl: photoUrl,
      verified: true,
      displayName: chosen.displayName || playerName
    };
  }
  return null;
}

function collectFighterNamesFromGames(games) {
  var names = {};
  (games || []).forEach(function (g) {
    if (!g) return;
    [g.home, g.away, g.home_team, g.away_team].forEach(function (n) {
      var s = String(n || '').trim();
      if (s && s.length >= 2 && !/^[0-9.+-]+$/.test(s) && !/[\/,]/.test(s)) names[s] = true;
    });
  });
  return Object.keys(names).sort();
}

async function fetchOwlsMmaGames(opts) {
  opts = opts || {};
  var key = opts.owlsKey || process.env.OWLS_INSIGHT_API_KEY || '';
  var base = (opts.owlsBase || process.env.OWLS_INSIGHT_BASE_URL || 'https://api.owlsinsight.com').replace(/\/$/, '');
  var books = opts.books || process.env.OWLS_INSIGHT_BOOKS || 'pinnacle,fanduel,draftkings';
  if (key) {
    var url = base + '/api/v1/mma/odds?books=' + encodeURIComponent(books) + '&alternates=false';
    var data = await new Promise(function (resolve) {
      execFile(
        'curl',
        [
          '-sS', '-L', '--max-time', '30', '-A', UA,
          '-H', 'Accept: application/json',
          '-H', 'Authorization: Bearer ' + key,
          '-H', 'x-api-key: ' + key,
          url
        ],
        { timeout: 35000, maxBuffer: 8 * 1024 * 1024 },
        function (err, stdout) {
          if (err || !stdout) return resolve(null);
          try { resolve(JSON.parse(String(stdout))); }
          catch (_e) { resolve(null); }
        }
      );
    });
    if (data) {
      var games = Array.isArray(data) ? data : (data.games || data.data || []);
      if (games.length) return games;
    }
  }
  var boardUrl = opts.boardUrl ||
    process.env.PBS_BACKEND_URL ||
    'https://pocketbooks-sports-backend-production.up.railway.app';
  boardUrl = String(boardUrl).replace(/\/$/, '') + '/api/odds/mma';
  var board = await httpsJson(boardUrl, 25000);
  if (Array.isArray(board)) return board;
  if (board && Array.isArray(board.games)) return board.games;
  return [];
}

async function lookupPlayerPhotoRow(sb, name) {
  var { data, error } = await sb.from('player_photos')
    .select('id,player_name,sport,espn_id,photo_url,verified')
    .eq('sport', SPORT)
    .ilike('player_name', String(name).trim())
    .limit(1);
  if (error) throw error;
  if (data && data[0]) return data[0];
  var want = normName(name);
  if (!want) return null;
  var { data: rows } = await sb.from('player_photos')
    .select('id,player_name,sport,espn_id,photo_url,verified')
    .eq('sport', SPORT)
    .limit(4000);
  return (rows || []).find(function (r) { return normName(r.player_name) === want; }) || null;
}

async function upsertPlayerPhoto(sb, row) {
  var existing = await lookupPlayerPhotoRow(sb, row.player_name);
  var now = new Date().toISOString();
  if (existing) {
    var { error } = await sb.from('player_photos').update({
      espn_id: row.espn_id != null ? row.espn_id : existing.espn_id,
      photo_url: row.photo_url != null ? row.photo_url : existing.photo_url,
      verified: row.verified ? true : !!existing.verified,
      updated_at: now
    }).eq('id', existing.id);
    if (error) throw error;
    return { ok: true, updated: true };
  }
  var { error: iErr } = await sb.from('player_photos').insert({
    player_name: row.player_name,
    sport: SPORT,
    espn_id: row.espn_id || null,
    photo_url: row.photo_url || null,
    verified: !!row.verified,
    created_at: now,
    updated_at: now
  });
  if (iErr) throw iErr;
  return { ok: true, inserted: true };
}

async function syncMmaFighterPhotos(sb, options) {
  options = options || {};
  var extra = Array.isArray(options.extraNames) ? options.extraNames : [];
  var games = options.games || await fetchOwlsMmaGames(options);
  var names = collectFighterNamesFromGames(games);
  var seen = {};
  names.forEach(function (n) { seen[normName(n)] = n; });
  extra.forEach(function (n) {
    var k = normName(n);
    if (k && !seen[k]) { seen[k] = String(n).trim(); names.push(String(n).trim()); }
  });

  var inserted = 0, updated = 0, skipped = 0, failed = 0, resolved = 0;
  var failures = [];

  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    try {
      var existing = await lookupPlayerPhotoRow(sb, name);
      if (existing && existing.verified && existing.photo_url) {
        skipped++;
        continue;
      }
      var hit = await searchEspnMmaFighter(name);
      if (!hit) {
        failed++;
        failures.push({ name: name, reason: 'not_found' });
        if (!existing) {
          try {
            await upsertPlayerPhoto(sb, { player_name: name, sport: SPORT, verified: false });
          } catch (_e) {}
        }
        continue;
      }
      if (!hit.verified) {
        failed++;
        failures.push({ name: name, reason: 'headshot_missing', espnId: hit.espnId });
        await upsertPlayerPhoto(sb, {
          player_name: hit.displayName || name,
          sport: SPORT,
          espn_id: hit.espnId,
          photo_url: null,
          verified: false
        });
        continue;
      }
      var r = await upsertPlayerPhoto(sb, {
        player_name: name,
        sport: SPORT,
        espn_id: hit.espnId,
        photo_url: hit.photoUrl,
        verified: true
      });
      if (hit.displayName && normName(hit.displayName) !== normName(name)) {
        await upsertPlayerPhoto(sb, {
          player_name: hit.displayName,
          sport: SPORT,
          espn_id: hit.espnId,
          photo_url: hit.photoUrl,
          verified: true
        });
      }
      resolved++;
      if (r.inserted) inserted++;
      else updated++;
    } catch (e) {
      failed++;
      failures.push({ name: name, reason: (e && e.message) || 'error' });
    }
    await new Promise(function (res) { setTimeout(res, 120); });
  }

  return {
    ok: true,
    sport: SPORT,
    scanned: names.length,
    games: games.length,
    resolved: resolved,
    inserted: inserted,
    updated: updated,
    skipped: skipped,
    failed: failed,
    failures: failures.slice(0, 50)
  };
}

module.exports = {
  SPORT,
  normName,
  headshotUrl,
  buildSearchUrls,
  searchEspnMmaFighter,
  collectFighterNamesFromGames,
  fetchOwlsMmaGames,
  syncMmaFighterPhotos,
  verifyImageUrl
};
