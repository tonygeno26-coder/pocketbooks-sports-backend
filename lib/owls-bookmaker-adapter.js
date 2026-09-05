'use strict';

/**
 * Narrow Owls Bookmaker.eu v2 adapter for Golf + Rugby + NASCAR.
 *
 * Unified GET /api/v1/{sport}/odds does not support golf/rugby/nascar (404).
 * Bookmaker Source API:
 *   GET /api/v2/bookmaker/{sport}/leagues
 *   GET /api/v2/bookmaker/{sport}?league={leagueKey}
 *
 * Sport groups: golf, rugby, motorsport (Bookmaker's own slugs).
 * Lobby key `nascar` polls the `motorsport` group filtered to nascar-* leagues.
 */

var BOOKMAKER_V2_SPORTS = {
  golf: 'golf',
  rugby: 'rugby',
  nascar: 'motorsport'
};

/** Substring filter on leagueKey/leagueName (lowercase). Unlisted sports keep all leagues. */
var BOOKMAKER_LEAGUE_FILTER = {
  nascar: 'nascar'
};

function isBookmakerV2Sport(sportKey) {
  var k = String(sportKey || '').toLowerCase();
  return !!BOOKMAKER_V2_SPORTS[k];
}

function bookmakerSportSlug(sportKey) {
  var k = String(sportKey || '').toLowerCase();
  return BOOKMAKER_V2_SPORTS[k] || null;
}

/**
 * Narrow discovered leagues to the lobby sport (e.g. nascar ⊂ motorsport).
 * Returns the input list unchanged when no filter is configured.
 */
function filterLeaguesForLobbySport(sportKey, leagues) {
  var k = String(sportKey || '').toLowerCase();
  var needle = BOOKMAKER_LEAGUE_FILTER[k];
  if (!needle) return leagues || [];
  return (leagues || []).filter(function(l) {
    if (!l) return false;
    var key = String(l.leagueKey || '').toLowerCase();
    var name = String(l.leagueName || '').toLowerCase();
    return key.indexOf(needle) >= 0 || name.indexOf(needle) >= 0;
  });
}

function isUnsetWireValue(v) {
  if (v == null) return true;
  var s = String(v).trim();
  return !s || s === '-' || s === '—' || s.toLowerCase() === 'n/a';
}

/** Parse Bookmaker American price strings ("+111", "-148", "EVEN"). */
function parseBookmakerAmericanPrice(v) {
  if (isUnsetWireValue(v)) return null;
  var s = String(v).trim();
  if (/^even$/i.test(s) || /^ev$/i.test(s)) return -110;
  var n = parseInt(s.replace(/[^0-9+\-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse Bookmaker handicap / total lines ("+1½", "-17½", "56½", "+2").
 * Returns null when unset / unparseable.
 */
function parseBookmakerLine(v) {
  if (isUnsetWireValue(v)) return null;
  var s = String(v).trim()
    .replace(/½/g, '.5')
    .replace(/¼/g, '.25')
    .replace(/¾/g, '.75')
    .replace(/,/g, '');
  if (/^pk$/i.test(s) || /^pick'?em$/i.test(s)) return 0;
  var n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function _pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function _laParts(ms) {
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23'
  });
  var parts = fmt.formatToParts(new Date(ms));
  var out = {};
  parts.forEach(function(p) {
    if (p.type !== 'literal') out[p.type] = p.value;
  });
  var hour = parseInt(out.hour, 10);
  // Some engines emit hourCycle h23 as "24" at midnight.
  if (hour === 24) hour = 0;
  return {
    year: parseInt(out.year, 10),
    month: parseInt(out.month, 10),
    day: parseInt(out.day, 10),
    hour: hour,
    minute: parseInt(out.minute, 10)
  };
}

/**
 * Parse Bookmaker startTime strings like "9/06 12:20am PT" into ISO UTC.
 * Returns '' when unparseable (caller may still emit the event).
 */
function parseBookmakerStartTime(raw, nowMs) {
  var s = String(raw || '').trim();
  if (!s) return '';
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*PT$/i);
  if (!m) {
    var t = Date.parse(s);
    return isNaN(t) ? '' : new Date(t).toISOString();
  }
  var month = parseInt(m[1], 10);
  var day = parseInt(m[2], 10);
  var hour = parseInt(m[3], 10);
  var minute = parseInt(m[4], 10);
  var ap = m[5].toLowerCase();
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;

  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var year = new Date(now).getFullYear();
  // Prefer year that keeps the event near "now" (season wrap).
  var candidates = [year - 1, year, year + 1];
  var best = null;
  var bestAbs = Infinity;

  candidates.forEach(function(y) {
    // Initial guess: treat wall time as UTC-7 (PDT), then converge via LA parts.
    var guess = Date.UTC(y, month - 1, day, hour + 7, minute, 0);
    for (var i = 0; i < 6; i++) {
      var p = _laParts(guess);
      var deltaMin =
        (hour - p.hour) * 60 + (minute - p.minute) +
        (day - p.day) * 24 * 60 +
        (month - p.month) * 30 * 24 * 60 +
        (y - p.year) * 365 * 24 * 60;
      if (deltaMin === 0) break;
      guess += deltaMin * 60 * 1000;
    }
    var p2 = _laParts(guess);
    if (p2.year !== y || p2.month !== month || p2.day !== day ||
        p2.hour !== hour || p2.minute !== minute) {
      return;
    }
    var abs = Math.abs(guess - now);
    if (abs < bestAbs) {
      bestAbs = abs;
      best = guess;
    }
  });

  return best == null ? '' : new Date(best).toISOString();
}

function extractLeagueKeys(leaguesPayload) {
  var leagues = (leaguesPayload && leaguesPayload.leagues) || [];
  if (!Array.isArray(leagues)) return [];
  return leagues
    .map(function(l) {
      return {
        leagueKey: l && (l.leagueKey || l.key || l.league || l.slug || l.id) || null,
        leagueName: l && (l.leagueName || l.name || l.title) || null,
        marketCount: l && (l.marketCount != null ? l.marketCount : null)
      };
    })
    .filter(function(l) { return !!l.leagueKey; });
}

function _pushMoneyline(markets, team, odds, meta) {
  if (!team || odds == null || !Number.isFinite(odds)) return;
  markets.push(Object.assign({
    marketType: 'moneyline',
    sportsbook: 'bookmaker',
    sportsbookName: 'Bookmaker.eu',
    teamOrSide: team,
    odds: odds,
    marketStatus: 'active',
    eventStatus: meta.gameStatus,
    eventCompleted: false,
    eventCanceled: false,
    eventLive: meta.gameStatus === 'live'
  }, meta.base || {}));
}

function _pushSpread(markets, team, line, odds, meta) {
  // Bookmaker often ships spread lines without vig prices. Only emit when
  // we have a real American price — never invent -110.
  if (!team || line == null || !Number.isFinite(line)) return;
  if (odds == null || !Number.isFinite(odds)) return;
  markets.push(Object.assign({
    marketType: 'spread',
    sportsbook: 'bookmaker',
    sportsbookName: 'Bookmaker.eu',
    teamOrSide: team,
    line: line,
    odds: odds,
    marketStatus: 'active',
    eventStatus: meta.gameStatus,
    eventCompleted: false,
    eventCanceled: false,
    eventLive: meta.gameStatus === 'live'
  }, meta.base || {}));
}

function _pushTotal(markets, side, line, odds, meta) {
  if (!side || line == null || !Number.isFinite(line)) return;
  if (odds == null || !Number.isFinite(odds)) return;
  markets.push(Object.assign({
    marketType: 'total',
    sportsbook: 'bookmaker',
    sportsbookName: 'Bookmaker.eu',
    teamOrSide: side,
    overUnder: side,
    line: line,
    odds: odds,
    marketStatus: 'active',
    eventStatus: meta.gameStatus,
    eventCompleted: false,
    eventCanceled: false,
    eventLive: meta.gameStatus === 'live'
  }, meta.base || {}));
}

function _deriveGameStatus(commenceIso, nowMs) {
  if (!commenceIso) return 'upcoming';
  var ms = Date.parse(commenceIso);
  if (isNaN(ms)) return 'upcoming';
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  // Bookmaker is not a live feed; treat past start as live until graded elsewhere.
  if (now >= ms) return 'live';
  return 'upcoming';
}

/**
 * Normalize one Bookmaker market blob into zero or one internal game.
 * Returns null when there are no usable priced markets.
 */
function normalizeBookmakerMarket(marketId, market, opts) {
  opts = opts || {};
  var sportKey = opts.sportKey || 'unknown';
  var leagueKey = opts.leagueKey || '';
  var nowMs = opts.nowMs;
  if (!market || typeof market !== 'object') return null;
  var kind = String(market.kind || '').toLowerCase();

  if (kind === 'game') {
    var visitor = market.visitor || {};
    var home = market.home || {};
    var awayName = String(visitor.team || '').trim();
    var homeName = String(home.team || '').trim();
    if (!awayName || !homeName) return null;

    var commence = parseBookmakerStartTime(market.startTime, nowMs);
    var date = commence ? commence.slice(0, 10) : '';
    var ck = sportKey + '|' + awayName + '|' + homeName + '|' + date;
    var evId = 'bm:' + sportKey + ':' + leagueKey + ':' + marketId;
    var gameStatus = _deriveGameStatus(commence, nowMs);
    var markets = [];
    var meta = { gameStatus: gameStatus, base: { providerGameId: evId, canonicalKey: ck, lastUpdate: market.pageLastUpdate || '' } };

    _pushMoneyline(markets, awayName, parseBookmakerAmericanPrice(visitor.moneyline), meta);
    _pushMoneyline(markets, homeName, parseBookmakerAmericanPrice(home.moneyline), meta);
    if (market.draw && market.draw.team) {
      _pushMoneyline(markets, String(market.draw.team), parseBookmakerAmericanPrice(market.draw.moneyline), meta);
    }

    // Spread/total only when priced (Bookmaker usually omits vig on these).
    var awaySp = parseBookmakerLine(visitor.spread);
    var homeSp = parseBookmakerLine(home.spread);
    // No separate spread price field in Bookmaker game shape — skip unless
    // a future payload adds visitor.spreadPrice / home.spreadPrice.
    var awaySpOdds = parseBookmakerAmericanPrice(visitor.spreadPrice || visitor.spreadOdds);
    var homeSpOdds = parseBookmakerAmericanPrice(home.spreadPrice || home.spreadOdds);
    _pushSpread(markets, awayName, awaySp, awaySpOdds, meta);
    _pushSpread(markets, homeName, homeSp, homeSpOdds, meta);

    var totalLine = parseBookmakerLine(visitor.total) != null
      ? parseBookmakerLine(visitor.total)
      : parseBookmakerLine(home.total);
    var overOdds = parseBookmakerAmericanPrice(visitor.totalOver || visitor.overPrice || market.over);
    var underOdds = parseBookmakerAmericanPrice(home.totalUnder || home.underPrice || market.under);
    _pushTotal(markets, 'Over', totalLine, overOdds, meta);
    _pushTotal(markets, 'Under', totalLine, underOdds, meta);

    if (!markets.length) return null;

    return {
      id: evId,
      sport_key: sportKey,
      commence_time: commence || null,
      home_team: homeName,
      away_team: awayName,
      canonicalKey: ck,
      status: gameStatus,
      completed: false,
      canceled: false,
      isLive: gameStatus === 'live',
      leagueKey: leagueKey,
      leagueName: opts.leagueName || leagueKey,
      section: market.section || null,
      source: 'bookmaker-v2',
      markets: markets
    };
  }

  if (kind === 'futures' || kind === 'proposition') {
    var options = Array.isArray(market.options) ? market.options : [];
    var priced = [];
    options.forEach(function(opt) {
      if (!opt) return;
      var name = String(opt.name || '').trim();
      var price = parseBookmakerAmericanPrice(opt.price);
      if (price == null && opt.text) {
        var tm = String(opt.text).trim().match(/^(.*)\s([+\-]\d+|EVEN|EV)$/i);
        if (tm) {
          if (!name) name = tm[1].trim();
          price = parseBookmakerAmericanPrice(tm[2]);
        }
      }
      if (!name || price == null) return;
      priced.push({ name: name, price: price });
    });
    if (!priced.length) return null;

    var title = String(market.title || market.subtitle || marketId).trim() || marketId;
    var awayNameF = title;
    var homeNameF = kind === 'proposition' ? 'Proposition' : 'Outright';
    var commenceF = parseBookmakerStartTime(market.startTime, nowMs);
    var dateF = commenceF ? commenceF.slice(0, 10) : '';
    var ckF = sportKey + '|' + awayNameF + '|' + homeNameF + '|' + dateF;
    var evIdF = 'bm:' + sportKey + ':' + leagueKey + ':' + marketId;
    var statusF = _deriveGameStatus(commenceF, nowMs);
    var marketsF = [];
    var metaF = {
      gameStatus: statusF,
      base: { providerGameId: evIdF, canonicalKey: ckF, lastUpdate: market.pageLastUpdate || '' }
    };
    priced.forEach(function(p) {
      _pushMoneyline(marketsF, p.name, p.price, metaF);
    });

    return {
      id: evIdF,
      sport_key: sportKey,
      commence_time: commenceF || null,
      home_team: homeNameF,
      away_team: awayNameF,
      canonicalKey: ckF,
      status: statusF,
      completed: false,
      canceled: false,
      isLive: statusF === 'live',
      leagueKey: leagueKey,
      leagueName: opts.leagueName || leagueKey,
      section: market.section || market.title || null,
      source: 'bookmaker-v2',
      kind: kind,
      markets: marketsF
    };
  }

  return null;
}

/**
 * Normalize a full Bookmaker league payload into internal games[].
 */
function normalizeBookmakerLeaguePayload(payload, opts) {
  opts = opts || {};
  var sportKey = opts.sportKey || (payload && payload.sport) || 'unknown';
  var leagueKey = opts.leagueKey || (payload && payload.league) || '';
  var leagueName = opts.leagueName || leagueKey;
  var nowMs = opts.nowMs;
  var data = (payload && payload.data) || {};
  var games = [];
  var warnings = [];
  var skippedUnpriced = 0;

  Object.keys(data).forEach(function(marketId) {
    var g = normalizeBookmakerMarket(marketId, data[marketId], {
      sportKey: sportKey,
      leagueKey: leagueKey,
      leagueName: leagueName,
      nowMs: nowMs
    });
    if (g) games.push(g);
    else skippedUnpriced++;
  });

  if (skippedUnpriced) {
    warnings.push('skipped_unpriced:' + leagueKey + ':' + skippedUnpriced);
  }

  return { games: games, warnings: warnings, skippedUnpriced: skippedUnpriced };
}

/**
 * Build the final fetch result shape matching _normalizeOwlsResponse.
 * stampMarket(entry, game) optional — stamps canonicalMarketKey / selectionKey.
 */
function buildBookmakerFetchResult(gameList, opts) {
  opts = opts || {};
  var warnings = opts.warnings || [];
  var meta = opts.meta || {};
  var stampMarket = typeof opts.stampMarket === 'function' ? opts.stampMarket : null;
  var games = [];
  var mkByCK = {};
  var mkByPGI = {};

  (gameList || []).forEach(function(g) {
    if (!g || !Array.isArray(g.markets) || !g.markets.length) return;
    var markets = g.markets.map(function(m) {
      var entry = Object.assign({}, m);
      if (stampMarket) stampMarket(entry, g);
      return entry;
    });
    var game = Object.assign({}, g, { markets: markets });
    games.push(game);
    var ck = game.canonicalKey;
    var evId = game.id;
    if (!mkByCK[ck]) mkByCK[ck] = [];
    if (!mkByPGI[evId]) mkByPGI[evId] = [];
    markets.forEach(function(m) {
      mkByCK[ck].push(m);
      mkByPGI[evId].push(m);
    });
  });

  return {
    ok: true,
    games: games,
    marketsByCanonicalKey: mkByCK,
    marketsByProviderGameId: mkByPGI,
    sourceStatus: games.length ? 'live' : 'empty',
    warnings: warnings,
    meta: Object.assign({ source: 'bookmaker-v2' }, meta)
  };
}

module.exports = {
  BOOKMAKER_V2_SPORTS: BOOKMAKER_V2_SPORTS,
  BOOKMAKER_LEAGUE_FILTER: BOOKMAKER_LEAGUE_FILTER,
  isBookmakerV2Sport: isBookmakerV2Sport,
  bookmakerSportSlug: bookmakerSportSlug,
  filterLeaguesForLobbySport: filterLeaguesForLobbySport,
  isUnsetWireValue: isUnsetWireValue,
  parseBookmakerAmericanPrice: parseBookmakerAmericanPrice,
  parseBookmakerLine: parseBookmakerLine,
  parseBookmakerStartTime: parseBookmakerStartTime,
  extractLeagueKeys: extractLeagueKeys,
  normalizeBookmakerMarket: normalizeBookmakerMarket,
  normalizeBookmakerLeaguePayload: normalizeBookmakerLeaguePayload,
  buildBookmakerFetchResult: buildBookmakerFetchResult
};
