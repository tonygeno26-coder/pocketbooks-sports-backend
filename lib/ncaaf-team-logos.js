/**
 * NCAAF team logo database — ESPN sync + strict alias resolution.
 *
 * Resolution order (no loose fuzzy matching):
 *  1. exact canonical / display name
 *  2. exact known alias
 *  3. normalized exact match
 *  4. verified provider ID (when caller supplies one)
 *  5. unresolved / ambiguous
 *
 * Ambiguous bare names must stay unresolved rather than pick the wrong school.
 */
'use strict';

const { execFile } = require('child_process');

const SPORT = 'ncaaf';
const PROVIDER = 'espn';
const ESPN_NCAA_LOGO = function (id) {
  return 'https://a.espncdn.com/i/teamlogos/ncaa/500/' + id + '.png';
};

/** Exhibition / all-star entries that appear in ESPN FBS group 80 but are not schools. */
const NON_SCHOOL_ID_RE = /^(3144|3145|3146|3147|3193|3194|3197|3198|125290|125291)$/;
const NON_SCHOOL_NAME_RE = /\b(all[- ]?stars?|team gaither|team robinson)\b/i;
/** Known FCS programs that sometimes appear in ESPN FBS group listings. */
const KNOWN_FCS_IDS = {
  '16': true,   // Sacramento State
  '2449': true  // North Dakota State
};

/**
 * Verified odds-provider aliases only. Keys are exact provider strings (and a
 * few common normalizations). Values are ESPN displayName / canonical_name.
 * Do NOT add bare mascot nicknames (Tigers, Bulldogs, …).
 */
const VERIFIED_ALIASES = {
  // Miami — bare "Miami" means Miami (FL) Hurricanes in NCAAF odds feeds.
  'Miami': 'Miami Hurricanes',
  'Miami FL': 'Miami Hurricanes',
  'Miami (FL)': 'Miami Hurricanes',
  'Miami Florida': 'Miami Hurricanes',
  'Miami Hurricanes': 'Miami Hurricanes',
  'MIA': 'Miami Hurricanes',
  'Miami OH': 'Miami (OH) RedHawks',
  'Miami (OH)': 'Miami (OH) RedHawks',
  'Miami Ohio': 'Miami (OH) RedHawks',
  'Miami (Ohio)': 'Miami (OH) RedHawks',
  'M-OH': 'Miami (OH) RedHawks',
  'MUOH': 'Miami (OH) RedHawks',

  // USC / Southern Cal vs South Carolina
  'USC': 'USC Trojans',
  'Southern California': 'USC Trojans',
  'Southern Cal': 'USC Trojans',
  'SC': 'South Carolina Gamecocks', // rare; prefer explicit South Carolina
  'South Carolina': 'South Carolina Gamecocks',
  'S Carolina': 'South Carolina Gamecocks',

  // Washington
  'Washington': 'Washington Huskies',
  'Washington State': 'Washington State Cougars',
  'Washington St': 'Washington State Cougars',
  'Wazzu': 'Washington State Cougars',
  'WSU': 'Washington State Cougars',

  // Houston / Georgia / Michigan / Oklahoma pairs
  'Houston': 'Houston Cougars',
  'Texas': 'Texas Longhorns',
  'TEX': 'Texas Longhorns',
  'Georgia': 'Georgia Bulldogs',
  'Georgia State': 'Georgia State Panthers',
  'Georgia St': 'Georgia State Panthers',
  'Georgia Southern': 'Georgia Southern Eagles',
  'Georgia Tech': 'Georgia Tech Yellow Jackets',
  'Michigan': 'Michigan Wolverines',
  'Michigan State': 'Michigan State Spartans',
  'Michigan St': 'Michigan State Spartans',
  'Oklahoma': 'Oklahoma Sooners',
  'Oklahoma State': 'Oklahoma State Cowboys',
  'Oklahoma St': 'Oklahoma State Cowboys',

  // Mississippi
  'Ole Miss': 'Ole Miss Rebels',
  'Mississippi': 'Ole Miss Rebels',
  'Mississippi State': 'Mississippi State Bulldogs',
  'Miss State': 'Mississippi State Bulldogs',
  'Miss St': 'Mississippi State Bulldogs',

  // Louisiana family
  'Louisiana': 'Louisiana Ragin\' Cajuns',
  'Louisiana Lafayette': 'Louisiana Ragin\' Cajuns',
  'Louisiana-Lafayette': 'Louisiana Ragin\' Cajuns',
  'UL Lafayette': 'Louisiana Ragin\' Cajuns',
  'ULL': 'Louisiana Ragin\' Cajuns',
  'Ragin Cajuns': 'Louisiana Ragin\' Cajuns',
  'UL Monroe': 'UL Monroe Warhawks',
  'ULM': 'UL Monroe Warhawks',
  'Louisiana Monroe': 'UL Monroe Warhawks',
  'Louisiana-Monroe': 'UL Monroe Warhawks',

  // Common abbrev schools
  'UCF': 'UCF Knights',
  'Central Florida': 'UCF Knights',
  'UTSA': 'UTSA Roadrunners',
  'Texas San Antonio': 'UTSA Roadrunners',
  'UTEP': 'UTEP Miners',
  'Texas El Paso': 'UTEP Miners',
  'UNLV': 'UNLV Rebels',
  'BYU': 'BYU Cougars',
  'Brigham Young': 'BYU Cougars',
  'SMU': 'SMU Mustangs',
  'TCU': 'TCU Horned Frogs',
  'LSU': 'LSU Tigers',
  'FIU': 'Florida International Panthers',
  'Florida International': 'Florida International Panthers',
  'FAU': 'Florida Atlantic Owls',
  'Florida Atlantic': 'Florida Atlantic Owls',
  'App State': 'App State Mountaineers',
  'Appalachian State': 'App State Mountaineers',
  'Appalachian St': 'App State Mountaineers',
  'NC State': 'NC State Wolfpack',
  'N.C. State': 'NC State Wolfpack',
  'North Carolina State': 'NC State Wolfpack',
  'NCSU': 'NC State Wolfpack',
  'San Jose State': 'San José State Spartans',
  'San José State': 'San José State Spartans',
  'San Jose St': 'San José State Spartans',
  'Hawaii': 'Hawai\'i Rainbow Warriors',
  'Hawai\'i': 'Hawai\'i Rainbow Warriors',
  'Hawai`i': 'Hawai\'i Rainbow Warriors',
  'UConn': 'UConn Huskies',
  'Connecticut': 'UConn Huskies',
  'UMass': 'Massachusetts Minutemen',
  'Massachusetts': 'Massachusetts Minutemen',
  'Pitt': 'Pittsburgh Panthers',
  'Pittsburgh': 'Pittsburgh Panthers',
  'Southern Miss': 'Southern Miss Golden Eagles',
  'USF': 'South Florida Bulls',
  'South Florida': 'South Florida Bulls',
  'Middle Tennessee': 'Middle Tennessee Blue Raiders',
  'MTSU': 'Middle Tennessee Blue Raiders',
  'Northern Illinois': 'Northern Illinois Huskies',
  'NIU': 'Northern Illinois Huskies',
  'Western Kentucky': 'Western Kentucky Hilltoppers',
  'WKU': 'Western Kentucky Hilltoppers',
  'Bowling Green': 'Bowling Green Falcons',
  'BGSU': 'Bowling Green Falcons',
  'Central Michigan': 'Central Michigan Chippewas',
  'Eastern Michigan': 'Eastern Michigan Eagles',
  'Western Michigan': 'Western Michigan Broncos',
  'New Mexico State': 'New Mexico State Aggies',
  'NMSU': 'New Mexico State Aggies',
  'Jacksonville State': 'Jacksonville State Gamecocks',
  'Jax State': 'Jacksonville State Gamecocks',
  'Sam Houston': 'Sam Houston Bearkats',
  'Sam Houston State': 'Sam Houston Bearkats',
  'Kennesaw State': 'Kennesaw State Owls',
  'Kennesaw St': 'Kennesaw State Owls',
  'James Madison': 'James Madison Dukes',
  'JMU': 'James Madison Dukes',
  'Coastal Carolina': 'Coastal Carolina Chanticleers',
  'Old Dominion': 'Old Dominion Monarchs',
  'ODU': 'Old Dominion Monarchs',
  'Texas State': 'Texas State Bobcats',
  'Texas St': 'Texas State Bobcats',
  'North Texas': 'North Texas Mean Green',
  'UNT': 'North Texas Mean Green',
  'Louisiana Tech': 'Louisiana Tech Bulldogs',
  'LA Tech': 'Louisiana Tech Bulldogs',
  'Air Force': 'Air Force Falcons',
  'Army': 'Army Black Knights',
  'Navy': 'Navy Midshipmen',
  'Notre Dame': 'Notre Dame Fighting Irish',
  'Boise State': 'Boise State Broncos',
  'Boise St': 'Boise State Broncos',
  'Fresno State': 'Fresno State Bulldogs',
  'Fresno St': 'Fresno State Bulldogs',
  'San Diego State': 'San Diego State Aztecs',
  'San Diego St': 'San Diego State Aztecs',
  'Colorado State': 'Colorado State Rams',
  'Colorado St': 'Colorado State Rams',
  'Utah State': 'Utah State Aggies',
  'Utah St': 'Utah State Aggies',
  'Texas A&M': 'Texas A&M Aggies',
  'Texas AM': 'Texas A&M Aggies',
  'Penn State': 'Penn State Nittany Lions',
  'Penn St': 'Penn State Nittany Lions',
  'Ohio State': 'Ohio State Buckeyes',
  'Ohio St': 'Ohio State Buckeyes',
  'Florida State': 'Florida State Seminoles',
  'Florida St': 'Florida State Seminoles',
  'Oregon State': 'Oregon State Beavers',
  'Oregon St': 'Oregon State Beavers',
  'Arizona State': 'Arizona State Sun Devils',
  'Arizona St': 'Arizona State Sun Devils',
  'Kansas State': 'Kansas State Wildcats',
  'Kansas St': 'Kansas State Wildcats',
  'Iowa State': 'Iowa State Cyclones',
  'Iowa St': 'Iowa State Cyclones',
  'Oklahoma St.': 'Oklahoma State Cowboys',
  'Mich. State': 'Michigan State Spartans',
  'Mich State': 'Michigan State Spartans'
};

/** Bare names that map to multiple FBS schools — never auto-resolve without qualifier. */
const AMBIGUOUS_BARE = {
  miami: ['Miami Hurricanes', 'Miami (OH) RedHawks'],
  // "USC" is NOT ambiguous in NCAAF odds (always Trojans); South Carolina is "South Carolina"/"SCAR".
  washington: ['Washington Huskies', 'Washington State Cougars'],
  // Houston is unique among FBS locations; keep list empty intentionally.
  georgia: ['Georgia Bulldogs', 'Georgia State Panthers', 'Georgia Southern Eagles', 'Georgia Tech Yellow Jackets'],
  michigan: ['Michigan Wolverines', 'Michigan State Spartans'],
  oklahoma: ['Oklahoma Sooners', 'Oklahoma State Cowboys'],
  mississippi: ['Ole Miss Rebels', 'Mississippi State Bulldogs'],
  louisiana: ['Louisiana Ragin\' Cajuns', 'Louisiana Tech Bulldogs', 'UL Monroe Warhawks'],
  texas: ['Texas Longhorns', 'Texas A&M Aggies', 'Texas Tech Red Raiders', 'Texas State Bobcats'],
  florida: ['Florida Gators', 'Florida State Seminoles', 'Florida Atlantic Owls', 'Florida International Panthers'],
  ohio: ['Ohio Bobcats', 'Ohio State Buckeyes'],
  california: ['California Golden Bears'],
  northcarolina: ['North Carolina Tar Heels', 'NC State Wolfpack']
};

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[''`]/g, '')
    .replace(/\s*&\s*/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function httpsJson(url, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(
      'curl',
      [
        '-sS', '-L', '--max-time', String(Math.ceil((timeoutMs || 12000) / 1000)),
        '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        '-H', 'Accept: application/json',
        url
      ],
      { timeout: (timeoutMs || 12000) + 2000, maxBuffer: 4 * 1024 * 1024 },
      function (err, stdout) {
        if (err || !stdout) return resolve(null);
        var text = String(stdout).trim();
        if (!text || text.charAt(0) === '<') return resolve(null);
        try { resolve(JSON.parse(text)); }
        catch (_e) { resolve(null); }
      }
    );
  });
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function isSchoolTeam(team) {
  if (!team) return false;
  var id = String(team.id || team.provider_team_id || '');
  if (NON_SCHOOL_ID_RE.test(id)) return false;
  var label = [team.displayName, team.display_name, team.name, team.canonical_name].filter(Boolean).join(' ');
  if (NON_SCHOOL_NAME_RE.test(label)) return false;
  return true;
}

function pickLogoUrl(team) {
  var logos = (team && team.logos) || [];
  for (var i = 0; i < logos.length; i++) {
    var href = logos[i] && logos[i].href;
    if (!href) continue;
    if (href.indexOf('/ncaa/500/') >= 0 && href.indexOf('dark') < 0) return href;
  }
  if (logos[0] && logos[0].href) return logos[0].href;
  var id = team && (team.id || team.provider_team_id);
  return id ? ESPN_NCAA_LOGO(id) : '';
}

function buildAliasesForTeam(team, allTeams) {
  var aliases = {};
  function add(a) {
    var s = String(a || '').trim();
    if (!s) return;
    // Never register bare ambiguous tokens as auto-aliases.
    var nk = normKey(s);
    if (AMBIGUOUS_BARE[nk] && AMBIGUOUS_BARE[nk].length > 1 && nk === normKey(team.location)) {
      // location alone is ambiguous across schools — skip auto
      return;
    }
    aliases[s] = true;
  }

  add(team.displayName);
  add(team.shortDisplayName);
  add(team.abbreviation);
  add(team.location);
  add(team.nickname);
  if (team.location && team.name) add(team.location + ' ' + team.name);

  // Only add location when unique among school teams.
  var locKey = normKey(team.location);
  if (locKey) {
    var locHits = allTeams.filter(function (t) { return normKey(t.location) === locKey; });
    if (locHits.length === 1) add(team.location);
  }

  // Abbreviation uniqueness
  var abKey = normKey(team.abbreviation);
  if (abKey) {
    var abHits = allTeams.filter(function (t) { return normKey(t.abbreviation) === abKey; });
    if (abHits.length === 1) add(team.abbreviation);
  }

  // Verified aliases targeting this display name
  Object.keys(VERIFIED_ALIASES).forEach(function (k) {
    if (VERIFIED_ALIASES[k] === team.displayName) add(k);
  });

  return Object.keys(aliases).filter(function (a) {
    return normKey(a) !== normKey(team.displayName);
  });
}

async function fetchEspnFbsTeams() {
  var season = new Date().getUTCFullYear();
  // Fall sports: season year is the fall year; if early calendar year, still try current then prior.
  var seasons = [season, season - 1];
  var refs = [];
  var usedSeason = season;
  for (var si = 0; si < seasons.length; si++) {
    var url = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/' +
      seasons[si] + '/types/2/groups/80/teams?limit=200';
    var core = await httpsJson(url, 15000);
    if (core && Array.isArray(core.items) && core.items.length) {
      refs = core.items;
      usedSeason = seasons[si];
      break;
    }
  }
  if (!refs.length) throw new Error('espn_fbs_team_list_empty');

  var confByTeam = {};
  var kids = await httpsJson(
    'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/' +
      usedSeason + '/types/2/groups/80/children?limit=50',
    15000
  );
  for (var i = 0; i < ((kids && kids.items) || []).length; i++) {
    var cref = String(kids.items[i].$ref || '').replace('http://', 'https://');
    var conf = await httpsJson(cref, 12000);
    if (!conf) continue;
    var confName = conf.name || conf.shortName || '';
    var confId = conf.id;
    var td = await httpsJson(
      'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/' +
        usedSeason + '/types/2/groups/' + confId + '/teams?limit=100',
      12000
    );
    ((td && td.items) || []).forEach(function (it) {
      var tid = String(it.$ref || '').replace(/\?.*$/, '').split('/').pop();
      confByTeam[tid] = confName;
    });
    await sleep(50);
  }

  var teams = [];
  for (var j = 0; j < refs.length; j++) {
    var tid = String(refs[j].$ref || '').replace(/\?.*$/, '').split('/').pop();
    var t = null;
    for (var attempt = 0; attempt < 4 && !t; attempt++) {
      if (attempt) await sleep(350 * attempt);
      t = await httpsJson(
        'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/' +
          usedSeason + '/teams/' + tid,
        12000
      );
    }
    if (!t || !t.id) continue;
    var row = {
      id: String(t.id),
      abbreviation: t.abbreviation || '',
      displayName: t.displayName || '',
      name: t.name || '',
      shortDisplayName: t.shortDisplayName || '',
      nickname: t.nickname || '',
      location: t.location || '',
      logo: pickLogoUrl(t),
      isActive: t.isActive !== false,
      conference: confByTeam[String(t.id)] || null,
      classification: KNOWN_FCS_IDS[String(t.id)] ? 'fcs' : 'fbs',
      logos: t.logos || []
    };
    if (!isSchoolTeam(row)) continue;
    teams.push(row);
    if ((j + 1) % 25 === 0) await sleep(40);
  }

  // Attach aliases using uniqueness across the school set
  teams.forEach(function (team) {
    team.aliases = buildAliasesForTeam(team, teams);
  });

  var fbsTeams = teams.filter(function (t) { return t.classification !== 'fcs'; });
  var fcsFromGroup = teams.filter(function (t) { return t.classification === 'fcs'; });

  return { season: usedSeason, teams: fbsTeams, fcsLeaks: fcsFromGroup };
}

/**
 * Optional FCS support: pull ESPN FCS group (81) school teams.
 * Kept separate so a missing FCS opponent never breaks FBS cards.
 */
async function fetchEspnFcsTeams(season) {
  var url = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/' +
    season + '/types/2/groups/81/teams?limit=400';
  var core = await httpsJson(url, 15000);
  var refs = (core && core.items) || [];
  var teams = [];
  for (var j = 0; j < refs.length; j++) {
    var tid = String(refs[j].$ref || '').replace(/\?.*$/, '').split('/').pop();
    var t = await httpsJson(
      'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/' +
        season + '/teams/' + tid,
      12000
    );
    if (!t || !t.id) continue;
    var row = {
      id: String(t.id),
      abbreviation: t.abbreviation || '',
      displayName: t.displayName || '',
      name: t.name || '',
      shortDisplayName: t.shortDisplayName || '',
      nickname: t.nickname || '',
      location: t.location || '',
      logo: pickLogoUrl(t),
      isActive: t.isActive !== false,
      conference: null,
      classification: 'fcs',
      logos: t.logos || []
    };
    if (!isSchoolTeam(row)) continue;
    teams.push(row);
    if ((j + 1) % 20 === 0) await sleep(60);
  }
  teams.forEach(function (team) {
    team.aliases = buildAliasesForTeam(team, teams);
  });
  return teams;
}

function rowFromEspnTeam(team) {
  var now = new Date().toISOString();
  return {
    sport: SPORT,
    provider: PROVIDER,
    provider_team_id: String(team.id),
    canonical_name: team.displayName,
    display_name: team.displayName,
    abbreviation: team.abbreviation || null,
    mascot: team.name || null,
    location: team.location || null,
    conference: team.conference || null,
    classification: team.classification || 'fbs',
    logo_url: team.logo || ESPN_NCAA_LOGO(team.id),
    aliases: Array.isArray(team.aliases) ? team.aliases : [],
    active: team.isActive !== false,
    last_synced_at: now,
    updated_at: now
  };
}

async function upsertTeamLogo(sb, row) {
  if (!sb) return { ok: false, error: 'supabase_not_configured' };
  var { data: existing, error: findErr } = await sb
    .from('team_logos')
    .select('id, aliases, logo_url, canonical_name, active')
    .eq('sport', row.sport)
    .eq('provider', row.provider)
    .eq('provider_team_id', row.provider_team_id)
    .maybeSingle();
  if (findErr) throw findErr;

  if (existing) {
    // Preserve extra aliases previously added for odds coverage.
    var mergedAliases = Array.from(new Set([].concat(existing.aliases || [], row.aliases || [])));
    var { error } = await sb.from('team_logos').update({
      canonical_name: row.canonical_name,
      display_name: row.display_name,
      abbreviation: row.abbreviation,
      mascot: row.mascot,
      location: row.location,
      conference: row.conference,
      classification: row.classification,
      logo_url: row.logo_url || existing.logo_url,
      aliases: mergedAliases,
      active: row.active !== false,
      last_synced_at: row.last_synced_at,
      updated_at: row.updated_at
    }).eq('id', existing.id);
    if (error) throw error;
    return { ok: true, updated: true };
  }

  var insertRow = Object.assign({}, row, { created_at: row.updated_at });
  var { error: iErr } = await sb.from('team_logos').insert(insertRow);
  if (iErr) throw iErr;
  return { ok: true, inserted: true };
}

async function syncNcaafTeamLogos(sb, opts) {
  opts = opts || {};
  var includeFcs = !!opts.includeFcs;
  var fetched = await fetchEspnFbsTeams();
  var teams = fetched.teams.slice();
  var fcsCount = 0;
  // Persist FCS schools that leaked into the FBS group (logos still useful).
  if (fetched.fcsLeaks && fetched.fcsLeaks.length) {
    teams = teams.concat(fetched.fcsLeaks);
    fcsCount += fetched.fcsLeaks.length;
  }
  if (includeFcs) {
    try {
      var fcs = await fetchEspnFcsTeams(fetched.season);
      fcsCount = fcs.length;
      teams = teams.concat(fcs);
    } catch (_e) {
      // FCS is optional — never fail the FBS sync.
    }
  }

  var inserted = 0, updated = 0, failed = 0, skipped = 0;
  for (var i = 0; i < teams.length; i++) {
    try {
      var r = await upsertTeamLogo(sb, rowFromEspnTeam(teams[i]));
      if (r.inserted) inserted++;
      else if (r.updated) updated++;
      else skipped++;
    } catch (_e) {
      failed++;
    }
  }

  return {
    ok: true,
    sport: SPORT,
    provider: PROVIDER,
    season: fetched.season,
    espn_retrieved: fetched.teams.length + fcsCount,
    fbs_stored: fetched.teams.length,
    fcs_stored: fcsCount,
    inserted: inserted,
    updated: updated,
    failed: failed,
    skipped: skipped
  };
}

function buildResolverIndex(rows) {
  var byExact = Object.create(null);
  var byNorm = Object.create(null);
  var byId = Object.create(null);
  var ambiguousNorm = Object.create(null);

  function register(key, row, bag) {
    if (!key || !row) return;
    var existing = bag[key];
    if (!existing) {
      bag[key] = row;
      return;
    }
    if (existing.provider_team_id === row.provider_team_id) return;
    // Collision → mark ambiguous
    ambiguousNorm[key] = true;
    delete bag[key];
  }

  (rows || []).forEach(function (row) {
    if (!row || row.active === false) return;
    byId[String(row.provider_team_id)] = row;
    register(String(row.canonical_name || '').trim(), row, byExact);
    register(String(row.display_name || '').trim(), row, byExact);
    register(normKey(row.canonical_name), row, byNorm);
    register(normKey(row.display_name), row, byNorm);
    register(normKey(row.abbreviation), row, byNorm);
    (row.aliases || []).forEach(function (a) {
      register(String(a).trim(), row, byExact);
      register(normKey(a), row, byNorm);
    });
  });

  // Seed verified aliases → canonical when present in index
  Object.keys(VERIFIED_ALIASES).forEach(function (alias) {
    var target = VERIFIED_ALIASES[alias];
    var row = byExact[target] || byNorm[normKey(target)];
    if (!row) return;
    register(alias, row, byExact);
    register(normKey(alias), row, byNorm);
  });

  return { byExact: byExact, byNorm: byNorm, byId: byId, ambiguousNorm: ambiguousNorm };
}

/**
 * Strict resolve. Returns:
 *  { status: 'exact'|'alias'|'normalized'|'provider_id'|'ambiguous'|'unresolved', row?, logoUrl? }
 */
function resolveTeamLogo(name, index, providerTeamId) {
  if (providerTeamId && index && index.byId[String(providerTeamId)]) {
    var byId = index.byId[String(providerTeamId)];
    return { status: 'provider_id', row: byId, logoUrl: byId.logo_url };
  }
  var raw = String(name || '').trim();
  if (!raw || !index) return { status: 'unresolved' };

  if (index.byExact[raw]) {
    return { status: 'exact', row: index.byExact[raw], logoUrl: index.byExact[raw].logo_url };
  }
  // Case-insensitive exact on alias/canonical keys
  var ci = Object.keys(index.byExact).find(function (k) {
    return k.toLowerCase() === raw.toLowerCase();
  });
  if (ci) {
    return { status: 'alias', row: index.byExact[ci], logoUrl: index.byExact[ci].logo_url };
  }

  // Verified alias table (even before DB rows loaded)
  if (VERIFIED_ALIASES[raw] || VERIFIED_ALIASES[raw.toUpperCase()]) {
    var target = VERIFIED_ALIASES[raw] || VERIFIED_ALIASES[raw.toUpperCase()];
    var via = index.byExact[target] || index.byNorm[normKey(target)];
    if (via) return { status: 'alias', row: via, logoUrl: via.logo_url };
  }

  var nk = normKey(raw);
  if (!nk) return { status: 'unresolved' };

  // Ambiguous bare names without verified alias → ambiguous
  if (AMBIGUOUS_BARE[nk] && AMBIGUOUS_BARE[nk].length > 1 && !VERIFIED_ALIASES[raw] && !index.byExact[raw]) {
    // If verified alias already registered into byNorm for this key, allow it.
    if (!index.byNorm[nk]) {
      return { status: 'ambiguous', candidates: AMBIGUOUS_BARE[nk] };
    }
  }

  if (index.ambiguousNorm[nk]) {
    return { status: 'ambiguous' };
  }
  if (index.byNorm[nk]) {
    return { status: 'normalized', row: index.byNorm[nk], logoUrl: index.byNorm[nk].logo_url };
  }

  return { status: 'unresolved' };
}

async function loadTeamLogoRows(sb, sport) {
  if (!sb) return [];
  var { data, error } = await sb
    .from('team_logos')
    .select('*')
    .eq('sport', sport || SPORT)
    .eq('active', true)
    .limit(5000);
  if (error) throw error;
  return data || [];
}

function auditProviderNames(providerNames, index) {
  var exact = [], alias = [], normalized = [], unresolved = [], ambiguous = [];
  (providerNames || []).forEach(function (name) {
    var r = resolveTeamLogo(name, index);
    var item = { name: name, status: r.status, matched: r.row && r.row.canonical_name };
    if (r.status === 'exact') exact.push(item);
    else if (r.status === 'alias') alias.push(item);
    else if (r.status === 'normalized') normalized.push(item);
    else if (r.status === 'ambiguous') ambiguous.push(item);
    else unresolved.push(item);
  });
  return {
    total: (providerNames || []).length,
    exact: exact.length,
    alias: alias.length,
    normalized: normalized.length,
    unresolved: unresolved,
    ambiguous: ambiguous,
    matched: exact.length + alias.length + normalized.length
  };
}

module.exports = {
  SPORT,
  PROVIDER,
  VERIFIED_ALIASES,
  AMBIGUOUS_BARE,
  normKey,
  isSchoolTeam,
  fetchEspnFbsTeams,
  fetchEspnFcsTeams,
  syncNcaafTeamLogos,
  upsertTeamLogo,
  rowFromEspnTeam,
  buildResolverIndex,
  resolveTeamLogo,
  loadTeamLogoRows,
  auditProviderNames,
  ESPN_NCAA_LOGO
};
