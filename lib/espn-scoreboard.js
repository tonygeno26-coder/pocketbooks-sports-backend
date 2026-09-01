'use strict';

// ESPN site.api scoreboard → PocketBooks game rows.
// Payload shape: { leagues, events, provider }. Games live on `events`, not
// `leagues[0].events`. Each event uses competitions[0].competitors
// (homeAway + team.displayName + score) and competitions[0].status.type
// (completed / name / state post|in|pre).

function espnRootKeys(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  return Object.keys(data);
}

function espnEventsFromPayload(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.events) && data.events.length) return data.events;
  const nestedLeagues = (data.sports && data.sports[0] && data.sports[0].leagues) || data.leagues || [];
  if (Array.isArray(nestedLeagues)) {
    for (let i = 0; i < nestedLeagues.length; i++) {
      const ev = nestedLeagues[i] && nestedLeagues[i].events;
      if (Array.isArray(ev) && ev.length) return ev;
    }
  }
  if (data.scoreboard && Array.isArray(data.scoreboard.events) && data.scoreboard.events.length)
    return data.scoreboard.events;
  return Array.isArray(data.events) ? data.events : [];
}

function espnStatusFromType(st, canceled) {
  if (canceled) return 'canceled';
  st = st || {};
  const name = String(st.name || '').toUpperCase();
  const state = String(st.state || '').toLowerCase();
  const completed = st.completed === true || st.completed === 'true';
  if (completed || name === 'STATUS_FINAL' || name === 'STATUS_FULL_TIME' || state === 'post')
    return 'final';
  if (state === 'in' || /IN_PROGRESS|HALFTIME|END_PERIOD|DELAY|RAIN|WARMUP|STATUS_IN/i.test(name))
    return 'live';
  return 'upcoming';
}

function espnScoreboardToGames(data) {
  const events = espnEventsFromPayload(data);
  return events.map(function(e) {
    const c = (e && e.competitions || [])[0] || {};
    const st = (c.status && c.status.type) || (e && e.status && e.status.type) || {};
    let home = '', away = '', homeAbbrev = '', awayAbbrev = '', homeShort = '', awayShort = '';
    let hs = null, as = null;
    (c.competitors || []).forEach(function(x) {
      const t = (x && x.team) || {};
      const name = t.displayName || t.shortDisplayName || t.name || '';
      const score = (x.score !== '' && x.score != null) ? parseInt(x.score, 10) : null;
      if (x.homeAway === 'home') {
        home = name; homeAbbrev = t.abbreviation || ''; homeShort = t.shortDisplayName || t.name || '';
        hs = Number.isNaN(score) ? null : score;
      } else if (x.homeAway === 'away') {
        away = name; awayAbbrev = t.abbreviation || ''; awayShort = t.shortDisplayName || t.name || '';
        as = Number.isNaN(score) ? null : score;
      }
    });
    const statusName = String(st.name || st.state || '');
    const canceled = /postponed|canceled|cancelled|abandoned/i.test(statusName);
    const status = espnStatusFromType(st, canceled);
    return {
      id: (e && e.id) || c.id,
      home: home, away: away,
      homeAbbrev: homeAbbrev, awayAbbrev: awayAbbrev,
      homeShort: homeShort, awayShort: awayShort,
      completed: status === 'final',
      canceled: canceled,
      status: status,
      home_score: hs,
      away_score: as,
      commence_time: c.date || (e && e.date) || null
    };
  });
}

function espnGamesToOddsScores(games, sportKey) {
  return (games || []).map(function(g) {
    const canceled = !!g.canceled;
    const status = g.status || (g.completed ? 'final' : (canceled ? 'canceled' : 'upcoming'));
    return {
      id: String(g.id || ''),
      sport_key: sportKey,
      home_team: g.home,
      away_team: g.away,
      commence_time: g.commence_time,
      completed: !!g.completed && !canceled,
      canceled: canceled,
      status: status,
      scores: [
        { name: g.home, score: g.home_score == null ? null : String(g.home_score) },
        { name: g.away, score: g.away_score == null ? null : String(g.away_score) }
      ]
    };
  }).filter(function(g) { return g.id && g.home_team && g.away_team; });
}

function toPublicScore(g, sport, source) {
  const scores = (g && g.scores) || [];
  const homeName = g.home_team || g.homeTeam || g.home || '';
  const awayName = g.away_team || g.awayTeam || g.away || '';
  function scoreFor(name) {
    if (name && scores.length) {
      const hit = scores.find(function(s) { return s && s.name === name; });
      if (hit && hit.score !== '' && hit.score != null) {
        const n = parseInt(hit.score, 10);
        return Number.isNaN(n) ? null : n;
      }
    }
    return null;
  }
  let hs = scoreFor(homeName);
  let as_ = scoreFor(awayName);
  if (hs == null && g.home_score != null && g.home_score !== '') {
    const n = parseInt(g.home_score, 10); hs = Number.isNaN(n) ? null : n;
  }
  if (hs == null && g.homeScore != null && g.homeScore !== '') {
    const n = parseInt(g.homeScore, 10); hs = Number.isNaN(n) ? null : n;
  }
  if (as_ == null && g.away_score != null && g.away_score !== '') {
    const n = parseInt(g.away_score, 10); as_ = Number.isNaN(n) ? null : n;
  }
  if (as_ == null && g.awayScore != null && g.awayScore !== '') {
    const n = parseInt(g.awayScore, 10); as_ = Number.isNaN(n) ? null : n;
  }
  let status = String(g.status || g.state || '').toLowerCase();
  if (g.completed || status === 'post' || status === 'final' || status === 'complete' || status === 'completed')
    status = 'final';
  else if (status === 'in' || status === 'in_progress' || status === 'inprogress' || status === 'live')
    status = 'live';
  else if (status === 'canceled' || status === 'cancelled')
    status = 'upcoming';
  else
    status = 'upcoming';
  const completed = status === 'final';
  return {
    id: g.id,
    homeTeam: homeName,
    awayTeam: awayName,
    homeScore: hs,
    awayScore: as_,
    status: status,
    completed: completed,
    sport: g.sport_title || sport,
    home: homeName,
    away: awayName,
    home_score: hs,
    away_score: as_,
    commence_time: g.commence_time || null,
    last_update: g.last_update || null,
    source: source || null
  };
}

module.exports = {
  espnRootKeys,
  espnEventsFromPayload,
  espnStatusFromType,
  espnScoreboardToGames,
  espnGamesToOddsScores,
  toPublicScore
};
