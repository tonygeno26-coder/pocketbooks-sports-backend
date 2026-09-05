/**
 * Soccer team crest/logo database — ESPN sync + strict alias resolution.
 *
 * Reuses public.team_logos (sport = 'soccer') from the NCAAF logo infrastructure.
 *
 * Resolution order (no loose fuzzy matching):
 *  1. provider team ID when supplied
 *  2. exact canonical / display name
 *  3. exact verified alias
 *  4. normalized exact match
 *  5. unresolved / ambiguous
 *
 * Never cross-map dangerous pairs (Man United↔Man City, Inter Milan↔Inter Miami,
 * Real Madrid↔Real Sociedad, Sporting CP↔Sporting KC, etc.).
 */
'use strict';

const { execFile } = require('child_process');

const SPORT = 'soccer';
const PROVIDER = 'espn';
const ESPN_SOCCER_LOGO = function (id) {
  return 'https://a.espncdn.com/i/teamlogos/soccer/500/' + id + '.png';
};
const ESPN_COUNTRY_LOGO = function (abbr) {
  return 'https://a.espncdn.com/i/teamlogos/countries/500/' + String(abbr || '').toLowerCase() + '.png';
};

/**
 * ESPN league slugs to sync. Broad coverage for competitions PocketBooks/Owls
 * commonly surfaces — domestic tops, cups, UEFA clubs, internationals.
 * conference column stores league name; classification is club|national.
 */
const ESPN_LEAGUE_SLUGS = [
  // Big-5 + Americas majors
  'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1',
  'usa.1', 'mex.1', 'arg.1', 'bra.1',
  // Other strong domestics present on Owls boards
  'por.1', 'ned.1', 'bel.1', 'tur.1', 'sco.1',
  'eng.2', 'esp.2', 'ger.2', 'fra.2', 'ita.2', 'ned.2',
  'den.1', 'nor.1', 'swe.1', 'sui.1', 'aut.1', 'gre.1', 'wal.1',
  'isr.1', 'cyp.1', 'rus.1', 'irl.1',
  'arg.2', 'bra.2', 'por.2', 'bel.2', 'tur.2', 'sco.2', 'eng.3',
  'uefa.super_cup', 'fifa.friendly', 'club.friendly',
  // UEFA club competitions
  'uefa.champions', 'uefa.europa', 'uefa.europa.conf',
  'uefa.champions_qual', 'uefa.europa_qual', 'uefa.europa.conf_qual',
  // Internationals / nationals
  'fifa.world', 'fifa.worldq.uefa', 'fifa.worldq.concacaf', 'fifa.worldq.conmebol',
  'fifa.worldq.caf', 'fifa.worldq.afc', 'uefa.euro', 'uefa.euroq', 'uefa.nations',
  'concacaf.gold', 'conmebol.america', 'caf.nations', 'afc.asian.cup'
];

const LEAGUE_LABELS = {
  'eng.1': 'Premier League',
  'esp.1': 'La Liga',
  'ita.1': 'Serie A',
  'ger.1': 'Bundesliga',
  'fra.1': 'Ligue 1',
  'usa.1': 'MLS',
  'mex.1': 'Liga MX',
  'arg.1': 'Liga Profesional',
  'bra.1': 'Brasileirão',
  'por.1': 'Primeira Liga',
  'ned.1': 'Eredivisie',
  'bel.1': 'Belgian Pro League',
  'tur.1': 'Süper Lig',
  'sco.1': 'Scottish Premiership',
  'eng.2': 'EFL Championship',
  'esp.2': 'LaLiga 2',
  'ger.2': '2. Bundesliga',
  'fra.2': 'Ligue 2',
  'ita.2': 'Serie B',
  'ned.2': 'Eerste Divisie',
  'den.1': 'Danish Superliga',
  'nor.1': 'Eliteserien',
  'swe.1': 'Allsvenskan',
  'sui.1': 'Swiss Super League',
  'aut.1': 'Austrian Bundesliga',
  'gre.1': 'Super League Greece',
  'wal.1': 'Cymru Premier',
  'isr.1': 'Israeli Premier League',
  'cyp.1': 'Cypriot First Division',
  'rus.1': 'Russian Premier League',
  'irl.1': 'League of Ireland Premier',
  'arg.2': 'Primera Nacional',
  'bra.2': 'Série B',
  'por.2': 'Liga Portugal 2',
  'bel.2': 'Challenger Pro League',
  'tur.2': '1. Lig',
  'sco.2': 'Scottish Championship',
  'eng.3': 'EFL League One',
  'uefa.champions': 'UEFA Champions League',
  'uefa.europa': 'UEFA Europa League',
  'uefa.europa.conf': 'UEFA Conference League',
  'uefa.champions_qual': 'UCL Qualifying',
  'uefa.europa_qual': 'UEL Qualifying',
  'uefa.europa.conf_qual': 'UECL Qualifying',
  'fifa.world': 'FIFA World Cup',
  'fifa.worldq.uefa': 'World Cup Qualifiers (UEFA)',
  'fifa.worldq.concacaf': 'World Cup Qualifiers (CONCACAF)',
  'fifa.worldq.conmebol': 'World Cup Qualifiers (CONMEBOL)',
  'fifa.worldq.caf': 'World Cup Qualifiers (CAF)',
  'fifa.worldq.afc': 'World Cup Qualifiers (AFC)',
  'uefa.euro': 'UEFA European Championship',
  'uefa.euroq': 'Euro Qualifiers',
  'uefa.nations': 'UEFA Nations League',
  'concacaf.gold': 'Gold Cup',
  'conmebol.america': 'Copa América',
  'caf.nations': 'AFCON',
  'afc.asian.cup': 'AFC Asian Cup'
};

/**
 * Verified Owls/odds-provider aliases → ESPN canonical displayName.
 * Only exact, hand-verified mappings. Never add dangerous bare tokens.
 */
const VERIFIED_ALIASES = {
  // Premier League / England
  'Man United': 'Manchester United',
  'Man Utd': 'Manchester United',
  'Manchester Utd': 'Manchester United',
  'Man City': 'Manchester City',
  'Spurs': 'Tottenham Hotspur',
  'Tottenham': 'Tottenham Hotspur',
  'Wolves': 'Wolverhampton Wanderers',
  'Wolverhampton': 'Wolverhampton Wanderers',
  'Nottingham Forest': 'Nottingham Forest',
  'Nottm Forest': 'Nottingham Forest',
  'Newcastle': 'Newcastle United',
  'West Ham': 'West Ham United',
  'Brighton': 'Brighton & Hove Albion',
  'Leicester': 'Leicester City',
  'Leeds': 'Leeds United',
  'Sheffield Utd': 'Sheffield United',
  'Sheffield United': 'Sheffield United',
  'Hull': 'Hull City',
  'Hull City': 'Hull City',
  'Schalke': 'Schalke 04',
  'Schalke 04': 'Schalke 04',

  // Spain
  'Atletico Madrid': 'Atlético Madrid',
  'Atlético Madrid': 'Atlético Madrid',
  'Atleti': 'Atlético Madrid',
  'Athletic': 'Athletic Club',
  'Athletic Bilbao': 'Athletic Club',
  'Real Sociedad': 'Real Sociedad',
  'Real Madrid': 'Real Madrid',
  'Barca': 'Barcelona',
  'Barça': 'Barcelona',
  'Celta': 'Celta Vigo',
  'Celta Vigo': 'Celta Vigo',
  'Vallecano': 'Rayo Vallecano',
  'Rayo': 'Rayo Vallecano',
  'Rayo Vallecano': 'Rayo Vallecano',
  'Real Valladolid': 'Real Valladolid',
  'Valladolid': 'Real Valladolid',
  'Racing Santander': 'Racing Santander',
  'Betis': 'Real Betis',
  'Sevilla': 'Sevilla',
  'Villarreal': 'Villarreal',
  'Espanyol': 'Espanyol',
  'Osasuna': 'Osasuna',
  'Getafe': 'Getafe',
  'Girona': 'Girona',
  'Alaves': 'Alavés',
  'Alavés': 'Alavés',
  'FC Andorra': 'FC Andorra',

  // Italy
  'Inter': 'Internazionale',
  'Inter Milan': 'Internazionale',
  'Internazionale': 'Internazionale',
  'AC Milan': 'AC Milan',
  'Milan': 'AC Milan',
  'AS Roma': 'AS Roma',
  'Roma': 'AS Roma',
  'Napoli': 'Napoli',
  'Juventus': 'Juventus',
  'Lazio': 'Lazio',
  'Atalanta': 'Atalanta',
  'Fiorentina': 'Fiorentina',

  // Germany
  'Bayern': 'Bayern München',
  'Bayern Munich': 'Bayern München',
  'Bayern München': 'Bayern München',
  'Dortmund': 'Borussia Dortmund',
  'Borussia Dortmund': 'Borussia Dortmund',
  'Leverkusen': 'Bayer Leverkusen',
  'Gladbach': 'Borussia Mönchengladbach',
  'Leipzig': 'RB Leipzig',
  'RB Leipzig': 'RB Leipzig',
  'Cologne': '1. FC Köln',
  'Koln': '1. FC Köln',

  // France
  'PSG': 'Paris Saint-Germain',
  'Paris SG': 'Paris Saint-Germain',
  'Paris Saint Germain': 'Paris Saint-Germain',
  'Paris Saint-Germain': 'Paris Saint-Germain',
  'Lens': 'Lens',
  'Lorient': 'Lorient',
  'Marseille': 'Olympique de Marseille',
  'OM': 'Olympique de Marseille',
  'Lyon': 'Olympique Lyonnais',
  'OL': 'Olympique Lyonnais',
  'Monaco': 'AS Monaco',
  'AS Monaco': 'AS Monaco',

  // Portugal / Netherlands / Belgium / Switzerland / Nordics
  'Sporting Lisbon': 'Sporting CP',
  'Sporting CP': 'Sporting CP',
  'Sporting': 'Sporting CP', // Owls domestic PT boards; Sporting KC always "Sporting Kansas City"/"SKC"
  'Benfica': 'Benfica',
  'Braga': 'Braga',
  'Alverca': 'Alverca',
  'Maritimo': 'Marítimo',
  'Marítimo': 'Marítimo',
  'Ajax': 'Ajax',
  'Ajax Amsterdam': 'Ajax',
  'PSV': 'PSV Eindhoven',
  'Feyenoord': 'Feyenoord',
  'FC Utrecht': 'FC Utrecht',
  'Utrecht': 'FC Utrecht',
  'Go Ahead Eagles': 'Go Ahead Eagles',
  'Westerlo': 'KVC Westerlo',
  'KVC Westerlo': 'KVC Westerlo',
  'Yellow-Red Mechelen': 'KV Mechelen',
  'YR Mechelen': 'KV Mechelen',
  'Mechelen': 'KV Mechelen',
  'Club Brugge': 'Club Brugge',
  'Anderlecht': 'Anderlecht',
  'Young Boys': 'Young Boys',
  'BSC Young Boys': 'Young Boys',
  'Lausanne': 'Lausanne Sports',
  'Lausanne Sports': 'Lausanne Sports',
  'Luzern': 'FC Luzern',
  'FC Luzern': 'FC Luzern',
  'FC Vaduz': 'FC Vaduz',
  'AGF': 'AGF',
  'Silkeborg': 'Silkeborg IF',
  'Silkeborg IF': 'Silkeborg IF',
  'Brann': 'SK Brann',
  'SK Brann': 'SK Brann',
  'Lillestrom': 'Lillestrøm SK',
  'Lillestrøm': 'Lillestrøm SK',
  'Sirius': 'IK Sirius',
  'IK Sirius': 'IK Sirius',
  'Vasteras': 'Västerås SK',
  'Vasteras SK': 'Västerås SK',
  'Västerås SK': 'Västerås SK',
  'Valur': 'Valur Reykjavik',
  'Valur Reykjavik': 'Valur Reykjavik',

  // Eastern / SE Europe / Caucasus / Israel / Cyprus
  'Olympiacos': 'Olympiacos',
  'Olympiacos Piraeus': 'Olympiacos',
  'NFC Volos': 'Volos NFC',
  'Volos': 'Volos NFC',
  'Dinamo Zagreb': 'Dinamo Zagreb',
  'Viktoria Plzen': 'Viktoria Plzen',
  'CSKA Sofia': 'CSKA Sofia',
  'Cukaricki': 'Cukaricki Belgrade',
  'Cukaricki Belgrade': 'Cukaricki Belgrade',
  'Anorthosis': 'Anorthosis',
  'Apollon Limassol': 'Apollon Limassol',
  'Hapoel Jerusalem': 'Hapoel Jerusalem',
  'Hapoel Kiryat Shmona': 'Hapoel Kiryat Shmona',
  'Ironi Tiberias': 'Ironi Tiberias',
  'Maccabi Petach Tikva': 'Maccabi Petah-Tikva',
  'Maccabi Petah Tikva': 'Maccabi Petah-Tikva',
  'Neftchi Baku': 'Neftchi',
  'Neftchi': 'Neftchi',
  'Partizani Tirana': 'Partizani Tirana',
  'Vllaznia Shkoder': 'Vllaznia Shkoder',
  'Trencin': 'AS Trencin',
  'AS Trencin': 'AS Trencin',
  'Zilina': 'MSK Zilina',
  'MSK Zilina': 'MSK Zilina',
  'Nomme Kalju': 'Nomme Kalju',
  'Fakel Voronezh': 'Fakel Voronezh',
  'Rostov': 'Rostov',
  'The New Saints': 'The New Saints',
  'TNS': 'The New Saints',
  'Barry Town Utd': 'Barry Town',
  'Barry Town': 'Barry Town',
  'AD Ceuta FC': 'Ceuta',
  'Ceuta': 'Ceuta',
  'FC Iberia 1999': 'Iberia 1999',
  'Iberia 1999': 'Iberia 1999',
  'Omonia FC Aradippou': 'Omonia Aradippou',
  'Omonia Aradippou': 'Omonia Aradippou',

  // Americas
  'Inter Miami': 'Inter Miami CF',
  'Inter Miami CF': 'Inter Miami CF',
  'NYCFC': 'New York City FC',
  'NY Red Bulls': 'New York Red Bulls',
  'New York Red Bulls': 'New York Red Bulls',
  'Sporting KC': 'Sporting Kansas City',
  'Sporting Kansas City': 'Sporting Kansas City',
  'SKC': 'Sporting Kansas City',
  'LAFC': 'Los Angeles FC',
  'LA Galaxy': 'LA Galaxy',
  'Atlanta United': 'Atlanta United FC',
  'CF Montreal': 'CF Montréal',
  'CF Montréal': 'CF Montréal',
  'Aldosivi': 'Aldosivi',
  'Banfield': 'Banfield',

  // Additional Owls board aliases (verified ESPN display names only)
  'Acassuso': 'Acassuso',
  'All Boys': 'All Boys',
  'CA Atlanta': 'Atlanta',
  'Chacarita': 'Chacarita Juniors',
  'CS Petrocub': 'Petrocub',
  'Petrocub': 'Petrocub',
  'Debreceni VSC': 'Debrecen',
  'Debrecen': 'Debrecen',
  'Dinamo Bucharest': 'Dinamo Bucuresti',
  'Dinamo Bucuresti': 'Dinamo Bucuresti',
  'Hapoel Petach Tikva': 'Hapoel Petah Tikva',
  'Hapoel Petah Tikva': 'Hapoel Petah Tikva',
  'Moss': 'Moss FK',
  'Moss FK': 'Moss FK',
  'Olimpija': 'Olimpija Ljubljana',
  'Olimpija Ljubljana': 'Olimpija Ljubljana',
  'PFC Levski Sofia': 'Levski Sofia',
  'Levski Sofia': 'Levski Sofia',
  'Paks': 'Paksi SE',
  'Paksi SE': 'Paksi SE',
  'Vikingur Gota': 'Víkingur',
  'Klaksvikar Itrottarfelag': 'KI Klaksvik',
  'KI Klaksvik': 'KI Klaksvik',
  'San Martin de Tucuman': 'San Martín (Tucumán)',
  'San Martín de Tucumán': 'San Martín (Tucumán)',
  'FC Zurich': 'FC Zürich',
  'FC Zürich': 'FC Zürich',
  'Grasshoppers Zurich': 'Grasshoppers',
  'Grasshoppers': 'Grasshoppers'
};

/** Bare tokens that must never auto-resolve without a verified alias. */
const AMBIGUOUS_BARE = {
  inter: ['Internazionale', 'Inter Miami CF', 'FC Inter Turku'],
  sporting: ['Sporting CP', 'Sporting Kansas City'],
  real: ['Real Madrid', 'Real Sociedad', 'Real Betis', 'Real Valladolid'],
  america: ['Club América', 'América de Cali'],
  city: ['Manchester City', 'Leicester City', 'Norwich City', 'Hull City', 'New York City FC'],
  united: ['Manchester United', 'Newcastle United', 'West Ham United', 'Leeds United', 'Sheffield United', 'Atlanta United FC'],
  athletic: ['Athletic Club'],
  national: [], // never map bare "national"
  draw: [] // moneyline Draw is not a club
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
        '-sS', '-L', '--max-time', String(Math.ceil((timeoutMs || 15000) / 1000)),
        '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        '-H', 'Accept: application/json',
        url
      ],
      { timeout: (timeoutMs || 15000) + 2000, maxBuffer: 8 * 1024 * 1024 },
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

function pickLogoUrl(team) {
  var logos = (team && team.logos) || [];
  var isNational = !!(team && (team.isNational === true || team.classification === 'national'));
  for (var i = 0; i < logos.length; i++) {
    var href = logos[i] && logos[i].href;
    if (!href) continue;
    if (href.indexOf('dark') >= 0) continue;
    if (isNational && href.indexOf('/countries/') >= 0) return href;
    if (!isNational && href.indexOf('/soccer/500/') >= 0) return href;
  }
  if (logos[0] && logos[0].href) return logos[0].href;
  var id = team && (team.id || team.provider_team_id);
  if (isNational && team.abbreviation) return ESPN_COUNTRY_LOGO(team.abbreviation);
  return id ? ESPN_SOCCER_LOGO(id) : '';
}

function isNationalTeam(team, leagueSlug) {
  if (!team) return false;
  if (team.isNational === true) return true;
  var slug = String(leagueSlug || '');
  if (/^(fifa\.|uefa\.euro|uefa\.nations|uefa\.euroq|concacaf\.gold|conmebol\.america|caf\.nations|afc\.asian)/.test(slug)) {
    // Club competitions that share prefixes are handled above; these are national.
    if (slug.indexOf('champions') >= 0 || slug.indexOf('europa') >= 0) return false;
    return true;
  }
  var logo = pickLogoUrl(Object.assign({}, team, { isNational: true }));
  // Heuristic: country crest path
  var logos = team.logos || [];
  for (var i = 0; i < logos.length; i++) {
    if (String(logos[i].href || '').indexOf('/countries/') >= 0) return true;
  }
  return false;
}

function buildAliasesForTeam(team, allTeams) {
  var aliases = {};
  function add(a) {
    var s = String(a || '').trim();
    if (!s) return;
    if (/^draw$/i.test(s)) return;
    var nk = normKey(s);
    if (AMBIGUOUS_BARE[nk] && AMBIGUOUS_BARE[nk].length > 1) {
      // Only keep if it is a verified alias targeting this team
      if (VERIFIED_ALIASES[s] && VERIFIED_ALIASES[s] === team.displayName) {
        aliases[s] = true;
      }
      return;
    }
    aliases[s] = true;
  }

  add(team.displayName);
  add(team.shortDisplayName);
  add(team.abbreviation);
  add(team.nickname);
  add(team.name);
  if (team.location && team.name && team.location !== team.name) {
    add(team.location + ' ' + team.name);
  }

  // Unique shortDisplayName / nickname across set
  ['shortDisplayName', 'nickname', 'abbreviation'].forEach(function (field) {
    var val = team[field];
    var key = normKey(val);
    if (!key) return;
    var hits = allTeams.filter(function (t) { return normKey(t[field]) === key; });
    if (hits.length === 1) add(val);
  });

  Object.keys(VERIFIED_ALIASES).forEach(function (k) {
    if (VERIFIED_ALIASES[k] === team.displayName) add(k);
  });

  return Object.keys(aliases).filter(function (a) {
    return normKey(a) !== normKey(team.displayName);
  });
}

/**
 * Bulk-fetch teams for one ESPN soccer league via site.web.api (names + logos).
 */
async function fetchEspnLeagueTeams(leagueSlug) {
  var url = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/' +
    encodeURIComponent(leagueSlug) + '/teams?limit=400';
  var data = await httpsJson(url, 20000);
  var out = [];
  var sports = (data && data.sports) || [];
  sports.forEach(function (sp) {
    ((sp && sp.leagues) || []).forEach(function (lg) {
      var leagueName = (lg && (lg.name || lg.abbreviation)) || LEAGUE_LABELS[leagueSlug] || leagueSlug;
      var country = (lg && lg.country) || null;
      ((lg && lg.teams) || []).forEach(function (wrap) {
        var t = (wrap && wrap.team) || wrap || {};
        if (!t.id) return;
        var national = isNationalTeam(t, leagueSlug);
        out.push({
          id: String(t.id),
          abbreviation: t.abbreviation || '',
          displayName: t.displayName || t.name || '',
          name: t.name || '',
          shortDisplayName: t.shortDisplayName || '',
          nickname: t.nickname || '',
          location: t.location || '',
          country: country || null,
          league: leagueName,
          leagueSlug: leagueSlug,
          logos: t.logos || [],
          isActive: t.isActive !== false,
          isNational: national,
          classification: national ? 'national' : 'club'
        });
      });
    });
  });
  return out;
}

async function fetchEspnSoccerTeams(opts) {
  opts = opts || {};
  var slugs = opts.leagues || ESPN_LEAGUE_SLUGS;
  var byId = Object.create(null);
  var leaguesOk = [];
  var leaguesFail = [];

  for (var i = 0; i < slugs.length; i++) {
    var slug = slugs[i];
    try {
      var teams = await fetchEspnLeagueTeams(slug);
      if (!teams.length) {
        leaguesFail.push({ slug: slug, reason: 'empty' });
      } else {
        leaguesOk.push({ slug: slug, count: teams.length });
        teams.forEach(function (t) {
          var prev = byId[t.id];
          if (!prev) {
            byId[t.id] = t;
            return;
          }
          // Prefer club domestic league label when merging cup/UCL appearances
          if (prev.classification === 'national' && t.classification === 'club') {
            byId[t.id] = t;
            return;
          }
          if (prev.classification === 'club' && t.classification === 'national') {
            return;
          }
          // Keep first domestic; append league hint into aliases later via league field merge
          if (!prev.league && t.league) prev.league = t.league;
        });
      }
    } catch (_e) {
      leaguesFail.push({ slug: slug, reason: 'error' });
    }
    await sleep(60);
  }

  var list = Object.keys(byId).map(function (id) { return byId[id]; });
  list.forEach(function (team) {
    team.logo = pickLogoUrl(team);
    team.aliases = buildAliasesForTeam(team, list);
  });

  return {
    teams: list,
    leagues_ok: leaguesOk,
    leagues_fail: leaguesFail
  };
}

/**
 * Strict ESPN search for a single provider name. Only accepts exact /
 * normalized displayName hits (never first-result fuzzy).
 */
async function searchEspnSoccerTeamExact(name) {
  var raw = String(name || '').trim();
  if (!raw || /^draw$/i.test(raw)) return null;
  var url = 'https://site.web.api.espn.com/apis/common/v3/search?query=' +
    encodeURIComponent(raw) + '&sport=soccer&type=team&limit=8';
  var data = await httpsJson(url, 15000);
  var items = (data && data.items) || [];
  var want = normKey(raw);
  var exact = null;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || !it.id) continue;
    var dn = String(it.displayName || it.name || '').trim();
    if (!dn) continue;
    if (dn === raw || normKey(dn) === want) {
      exact = it;
      break;
    }
  }
  // Verified alias target may differ in display — allow if alias table maps here
  if (!exact && VERIFIED_ALIASES[raw]) {
    var target = VERIFIED_ALIASES[raw];
    for (var j = 0; j < items.length; j++) {
      var it2 = items[j];
      if (!it2 || !it2.id) continue;
      var dn2 = String(it2.displayName || it2.name || '').trim();
      if (dn2 === target || normKey(dn2) === normKey(target)) {
        exact = it2;
        break;
      }
    }
  }
  if (!exact) return null;
  return {
    id: String(exact.id),
    abbreviation: exact.abbreviation || '',
    displayName: exact.displayName || exact.name || raw,
    name: exact.name || exact.displayName || raw,
    shortDisplayName: exact.shortDisplayName || '',
    nickname: exact.nickname || '',
    location: exact.location || '',
    logos: exact.logos || [],
    isActive: true,
    isNational: !!(exact.isNational),
    classification: exact.isNational ? 'national' : 'club',
    league: null,
    leagueSlug: null
  };
}

function rowFromEspnTeam(team) {
  var now = new Date().toISOString();
  var national = team.classification === 'national' || team.isNational === true;
  return {
    sport: SPORT,
    provider: PROVIDER,
    provider_team_id: String(team.id),
    canonical_name: team.displayName,
    display_name: team.displayName,
    abbreviation: team.abbreviation || null,
    mascot: team.nickname || team.name || null,
    location: team.country || team.location || null,
    conference: team.league || null,
    classification: national ? 'national' : 'club',
    logo_url: team.logo || pickLogoUrl(team) || ESPN_SOCCER_LOGO(team.id),
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
    .select('id, aliases, logo_url, canonical_name, active, conference, classification, location')
    .eq('sport', row.sport)
    .eq('provider', row.provider)
    .eq('provider_team_id', row.provider_team_id)
    .maybeSingle();
  if (findErr) throw findErr;

  if (existing) {
    var mergedAliases = Array.from(new Set([].concat(existing.aliases || [], row.aliases || [])));
    var { error } = await sb.from('team_logos').update({
      canonical_name: row.canonical_name,
      display_name: row.display_name,
      abbreviation: row.abbreviation,
      mascot: row.mascot,
      location: row.location || existing.location,
      conference: row.conference || existing.conference,
      classification: row.classification || existing.classification,
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

async function syncSoccerTeamLogos(sb, opts) {
  opts = opts || {};
  var fetched = await fetchEspnSoccerTeams({ leagues: opts.leagues });
  var teams = fetched.teams.slice();

  // Optional: resolve extra board names via strict search (does not fuzzy-pick)
  var extraNames = opts.extraProviderNames || [];
  var searchHits = 0;
  for (var ei = 0; ei < extraNames.length; ei++) {
    var pname = String(extraNames[ei] || '').trim();
    if (!pname || /^draw$/i.test(pname)) continue;
    var already = teams.some(function (t) {
      return normKey(t.displayName) === normKey(pname) ||
        (t.aliases || []).some(function (a) { return normKey(a) === normKey(pname); }) ||
        VERIFIED_ALIASES[pname] && normKey(VERIFIED_ALIASES[pname]) === normKey(t.displayName);
    });
    if (already) {
      // Ensure provider alias is stored on the matched club
      teams.forEach(function (t) {
        if (VERIFIED_ALIASES[pname] && normKey(VERIFIED_ALIASES[pname]) === normKey(t.displayName)) {
          t.aliases = Array.from(new Set([].concat(t.aliases || [], [pname])));
        }
      });
      continue;
    }
    try {
      var hit = await searchEspnSoccerTeamExact(pname);
      // If provider name miss but verified alias target exists, search the target
      if (!hit && VERIFIED_ALIASES[pname]) {
        hit = await searchEspnSoccerTeamExact(VERIFIED_ALIASES[pname]);
      }
      if (!hit) continue;
      hit.logo = pickLogoUrl(hit);
      hit.aliases = Array.from(new Set([pname, VERIFIED_ALIASES[pname] || '', hit.displayName].filter(Boolean)));
      // Avoid duplicate IDs
      if (!teams.some(function (t) { return t.id === hit.id; })) {
        teams.push(hit);
        searchHits++;
      } else {
        teams.forEach(function (t) {
          if (t.id === hit.id) {
            t.aliases = Array.from(new Set([].concat(t.aliases || [], [pname])));
          }
        });
        searchHits++;
      }
    } catch (_e) {}
    await sleep(80);
  }

  // Rebuild aliases with full set uniqueness
  teams.forEach(function (team) {
    team.aliases = Array.from(new Set([].concat(team.aliases || [], buildAliasesForTeam(team, teams))));
  });

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
    espn_retrieved: teams.length,
    leagues_ok: fetched.leagues_ok,
    leagues_fail: fetched.leagues_fail,
    search_hits: searchHits,
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

  Object.keys(VERIFIED_ALIASES).forEach(function (alias) {
    var target = VERIFIED_ALIASES[alias];
    var row = byExact[target] || byNorm[normKey(target)];
    if (!row) return;
    register(alias, row, byExact);
    register(normKey(alias), row, byNorm);
  });

  return { byExact: byExact, byNorm: byNorm, byId: byId, ambiguousNorm: ambiguousNorm };
}

function resolveTeamLogo(name, index, providerTeamId) {
  if (providerTeamId && index && index.byId[String(providerTeamId)]) {
    var byId = index.byId[String(providerTeamId)];
    return { status: 'provider_id', row: byId, logoUrl: byId.logo_url };
  }
  var raw = String(name || '').trim();
  if (!raw || !index) return { status: 'unresolved' };
  if (/^draw$/i.test(raw)) return { status: 'unresolved' };

  if (index.byExact[raw]) {
    return { status: 'exact', row: index.byExact[raw], logoUrl: index.byExact[raw].logo_url };
  }
  var ci = Object.keys(index.byExact).find(function (k) {
    return k.toLowerCase() === raw.toLowerCase();
  });
  if (ci) {
    return { status: 'alias', row: index.byExact[ci], logoUrl: index.byExact[ci].logo_url };
  }

  if (VERIFIED_ALIASES[raw] || VERIFIED_ALIASES[raw.toUpperCase()]) {
    var target = VERIFIED_ALIASES[raw] || VERIFIED_ALIASES[raw.toUpperCase()];
    var via = index.byExact[target] || index.byNorm[normKey(target)];
    if (via) return { status: 'alias', row: via, logoUrl: via.logo_url };
  }

  var nk = normKey(raw);
  if (!nk) return { status: 'unresolved' };

  if (AMBIGUOUS_BARE[nk] && AMBIGUOUS_BARE[nk].length > 1 && !VERIFIED_ALIASES[raw] && !index.byExact[raw]) {
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
  var all = [];
  var pageSize = 1000;
  var from = 0;
  for (;;) {
    var { data, error } = await sb
      .from('team_logos')
      .select('*')
      .eq('sport', sport || SPORT)
      .eq('active', true)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    var chunk = data || [];
    all = all.concat(chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
    if (from > 20000) break;
  }
  return all;
}

function auditProviderNames(providerNames, index) {
  var exact = [], alias = [], normalized = [], providerId = [], unresolved = [], ambiguous = [];
  (providerNames || []).forEach(function (name) {
    var r = resolveTeamLogo(name, index);
    var item = { name: name, status: r.status, matched: r.row && r.row.canonical_name };
    if (r.status === 'exact') exact.push(item);
    else if (r.status === 'alias') alias.push(item);
    else if (r.status === 'normalized') normalized.push(item);
    else if (r.status === 'provider_id') providerId.push(item);
    else if (r.status === 'ambiguous') ambiguous.push(item);
    else unresolved.push(item);
  });
  return {
    total: (providerNames || []).length,
    exact: exact.length,
    alias: alias.length,
    normalized: normalized.length,
    provider_id: providerId.length,
    unresolved: unresolved,
    ambiguous: ambiguous,
    matched: exact.length + alias.length + normalized.length + providerId.length
  };
}

module.exports = {
  SPORT,
  PROVIDER,
  ESPN_LEAGUE_SLUGS,
  LEAGUE_LABELS,
  VERIFIED_ALIASES,
  AMBIGUOUS_BARE,
  normKey,
  fetchEspnLeagueTeams,
  fetchEspnSoccerTeams,
  searchEspnSoccerTeamExact,
  syncSoccerTeamLogos,
  upsertTeamLogo,
  rowFromEspnTeam,
  buildResolverIndex,
  resolveTeamLogo,
  loadTeamLogoRows,
  auditProviderNames,
  ESPN_SOCCER_LOGO,
  ESPN_COUNTRY_LOGO,
  pickLogoUrl
};
