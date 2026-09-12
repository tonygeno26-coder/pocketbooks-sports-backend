'use strict';
/**
 * PocketBooks — Props data foundation (inventory normalize + capability).
 *
 * Preserves Owls prop inventory for a future dedicated Props UI.
 * Does NOT invent odds/lines. Does NOT enable SGP. Settlement untouched.
 *
 * Support statuses:
 *   SUPPORTED_NORMALIZED — mapped market; may be bettable when line-allowed
 *   UNKNOWN_RAW          — retained for audit/debug; NEVER bettable
 *   UNSUPPORTED          — known unusable (combos / multi-player); retained; NEVER bettable
 */

var SUPPORT = Object.freeze({
  SUPPORTED_NORMALIZED: 'SUPPORTED_NORMALIZED',
  UNKNOWN_RAW: 'UNKNOWN_RAW',
  UNSUPPORTED: 'UNSUPPORTED'
});

var PHOTO_POLICY = 'PRESENTATION_ONLY';

/** Sports that can carry player props when Owls publishes inventory. */
var PROPS_CAPABLE_SPORTS = Object.freeze([
  'mlb', 'nba', 'nfl', 'nhl', 'ncaab', 'ncaaf', 'wnba'
]);

/** Sports that must never fake empty Props tabs as “available inventory”. */
var PROPS_NEVER_FAKE = Object.freeze([
  'nhl', 'soccer', 'tennis', 'mma', 'boxing', 'ncaab'
]);

// Display labels for known Owls category keys (plus aliases).
var CATEGORY_LABELS = Object.freeze({
  hits: 'Hits', runs: 'Runs Scored', rbis: 'RBIs', home_runs: 'Home Runs',
  stolen_bases: 'Stolen Bases', total_bases: 'Total Bases',
  strikeouts_pitcher: 'Strikeouts', strikeouts_batter: 'Strikeouts',
  walks: 'Walks', earned_runs: 'Earned Runs', outs_recorded: 'Pitching Outs',
  hits_allowed: 'Hits Allowed', hits_runs_rbis: 'Hits + Runs + RBIs',
  singles: 'Singles', doubles: 'Doubles', triples: 'Triples',
  walks_allowed: 'Walks Allowed', pitching_outs: 'Pitching Outs',
  points: 'Points', rebounds: 'Rebounds', assists: 'Assists',
  threes_made: '3-Pointers Made', steals: 'Steals', blocks: 'Blocks',
  pts_rebs: 'Pts + Reb', pts_asts: 'Pts + Ast', rebs_asts: 'Reb + Ast',
  pts_rebs_asts: 'Pts + Reb + Ast',
  passing_yards: 'Passing Yards', passing_tds: 'Passing TDs',
  pass_yards: 'Passing Yards', pass_tds: 'Passing TDs',
  pass_completions: 'Pass Completions', completions: 'Pass Completions',
  pass_attempts: 'Pass Attempts', attempts: 'Pass Attempts',
  pass_interceptions: 'Interceptions Thrown', interceptions: 'Interceptions Thrown',
  rushing_yards: 'Rushing Yards', rushing_tds: 'Rushing TDs',
  rush_yards: 'Rushing Yards', rush_tds: 'Rushing TDs',
  rush_attempts: 'Rushing Attempts', rushing_attempts: 'Rushing Attempts',
  receiving_yards: 'Receiving Yards', reception_yards: 'Receiving Yards',
  receiving_tds: 'Receiving TDs', reception_tds: 'Receiving TDs',
  receptions: 'Receptions',
  touchdowns: 'Anytime TD', anytime_td: 'Anytime TD',
  first_td: 'First TD', player_first_td: 'First TD',
  first_touchdown_scorer: 'First TD',
  touchdowns_1h: 'Anytime TD 1H', touchdowns_1q: 'Anytime TD 1Q',
  longest_reception: 'Longest Reception', longest_rush: 'Longest Rush',
  longest_pass: 'Longest Pass',
  pass_rush_yards: 'Pass + Rush Yards',
  sacks: 'Sacks', player_sacks: 'Sacks',
  tackles: 'Tackles', player_tackles: 'Tackles',
  player_tackles_assists: 'Tackles + Asts', tackles_assists: 'Tackles + Asts',
  goals: 'Goals', hockey_assists: 'Assists', hockey_points: 'Points',
  shots_on_goal: 'Shots on Goal',
  combos: 'Combos'
});

/** Known normalized labels preserved in inventory (not all are bettable). */
var KNOWN_PROP_TYPES = Object.freeze({
  'Passing Yards': 1, 'Passing TDs': 1, 'Pass Completions': 1, 'Pass Attempts': 1,
  'Interceptions Thrown': 1, 'Rushing Yards': 1, 'Rushing Attempts': 1,
  'Rushing TDs': 1, 'Receiving Yards': 1, 'Receptions': 1, 'Receiving TDs': 1,
  'Anytime TD': 1, 'First TD': 1, 'Anytime TD 1H': 1, 'Anytime TD 1Q': 1,
  'Sacks': 1, 'Tackles': 1, 'Tackles + Asts': 1,
  'Longest Reception': 1, 'Longest Rush': 1, 'Longest Pass': 1, 'Pass + Rush Yards': 1,
  'Points': 1, 'Rebounds': 1, 'Assists': 1, '3-Pointers Made': 1,
  'Steals': 1, 'Blocks': 1, 'Turnovers': 1,
  'Pts + Reb + Ast': 1, 'Pts + Reb': 1, 'Pts + Ast': 1, 'Reb + Ast': 1,
  'Hits': 1, 'Strikeouts': 1, 'Home Runs': 1, 'RBIs': 1, 'Total Bases': 1,
  'Stolen Bases': 1, 'Runs Scored': 1, 'Walks': 1, 'Hits + Runs + RBIs': 1,
  'Pitching Outs': 1, 'Earned Runs': 1, 'Walks Allowed': 1, 'Hits Allowed': 1,
  'Singles': 1, 'Doubles': 1, 'Triples': 1,
  'Goals': 1, 'Shots on Goal': 1, 'Goalie Saves': 1
});

/**
 * Subset that may be bettable today (fail-closed for everything else).
 * Expanded MLB lines stay within these already-recognized markets only.
 */
var BETTABLE_PROP_TYPES = Object.freeze({
  'Passing Yards': 1, 'Passing TDs': 1, 'Pass Completions': 1, 'Pass Attempts': 1,
  'Interceptions Thrown': 1, 'Rushing Yards': 1, 'Rushing TDs': 1,
  'Receiving Yards': 1, 'Receptions': 1, 'Receiving TDs': 1,
  'Anytime TD': 1, 'First TD': 1, 'Sacks': 1, 'Tackles': 1, 'Tackles + Asts': 1,
  'Points': 1, 'Rebounds': 1, 'Assists': 1, '3-Pointers Made': 1,
  'Steals': 1, 'Blocks': 1, 'Turnovers': 1,
  'Pts + Reb + Ast': 1, 'Pts + Reb': 1, 'Pts + Ast': 1, 'Reb + Ast': 1,
  'Hits': 1, 'Strikeouts': 1, 'Home Runs': 1, 'RBIs': 1, 'Total Bases': 1,
  'Stolen Bases': 1, 'Runs Scored': 1, 'Walks': 1, 'Hits + Runs + RBIs': 1,
  'Pitching Outs': 1, 'Earned Runs': 1, 'Walks Allowed': 1, 'Hits Allowed': 1,
  'Goals': 1, 'Shots on Goal': 1, 'Goalie Saves': 1
});

/** Discrete allowlisted lines (exact). Expanded MLB only where mapping is safe. */
var ALLOWED_LINES_BY_CATEGORY = Object.freeze({
  Hits: [0.5, 1.5, 2.5, 3.5, 4.5],
  Strikeouts: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5],
  'Home Runs': [0.5, 1.5, 2.5],
  RBIs: [0.5, 1.5, 2.5, 3.5, 4.5],
  Singles: [0.5, 1.5, 2.5, 3.5],
  Doubles: [0.5, 1.5, 2.5],
  Triples: [0.5, 1.5],
  'Stolen Bases': [0.5, 1.5, 2.5, 3.5],
  'Runs Scored': [0.5, 1.5, 2.5, 3.5],
  Walks: [0.5, 1.5, 2.5, 3.5],
  'Hits + Runs + RBIs': [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]
});

/** Continuous ranges for NFL/NBA-style counting + yardage (+ MLB pitching). */
var LINE_RANGES_BY_CATEGORY = Object.freeze({
  'Passing Yards': { min: 0.5, max: 499.5 },
  'Rushing Yards': { min: 0.5, max: 249.5 },
  'Receiving Yards': { min: 0.5, max: 249.5 },
  'Pass + Rush Yards': { min: 0.5, max: 499.5 },
  'Longest Reception': { min: 0.5, max: 99.5 },
  'Longest Rush': { min: 0.5, max: 99.5 },
  'Longest Pass': { min: 0.5, max: 99.5 },
  'Passing TDs': { min: 0.5, max: 7.5 },
  'Rushing TDs': { min: 0.5, max: 5.5 },
  'Receiving TDs': { min: 0.5, max: 5.5 },
  'Anytime TD': { min: 0.5, max: 0.5 },
  'First TD': { min: 0.5, max: 0.5 },
  'Anytime TD 1H': { min: 0.5, max: 0.5 },
  'Anytime TD 1Q': { min: 0.5, max: 0.5 },
  Receptions: { min: 0.5, max: 20.5 },
  'Pass Completions': { min: 0.5, max: 55.5 },
  'Pass Attempts': { min: 0.5, max: 70.5 },
  'Rushing Attempts': { min: 0.5, max: 40.5 },
  'Interceptions Thrown': { min: 0.5, max: 5.5 },
  Sacks: { min: 0.5, max: 6.5 },
  Tackles: { min: 0.5, max: 20.5 },
  'Tackles + Asts': { min: 0.5, max: 20.5 },
  Points: { min: 0.5, max: 79.5 },
  Rebounds: { min: 0.5, max: 29.5 },
  Assists: { min: 0.5, max: 24.5 },
  '3-Pointers Made': { min: 0.5, max: 12.5 },
  Steals: { min: 0.5, max: 8.5 },
  Blocks: { min: 0.5, max: 8.5 },
  Turnovers: { min: 0.5, max: 12.5 },
  'Pts + Reb + Ast': { min: 0.5, max: 99.5 },
  'Pts + Reb': { min: 0.5, max: 79.5 },
  'Pts + Ast': { min: 0.5, max: 79.5 },
  'Reb + Ast': { min: 0.5, max: 49.5 },
  'Total Bases': { min: 0.5, max: 10.5 },
  'Pitching Outs': { min: 0.5, max: 27.5 },
  'Earned Runs': { min: 0.5, max: 10.5 },
  'Walks Allowed': { min: 0.5, max: 10.5 },
  'Hits Allowed': { min: 0.5, max: 15.5 },
  Goals: { min: 0.5, max: 5.5 },
  'Shots on Goal': { min: 0.5, max: 12.5 },
  'Goalie Saves': { min: 0.5, max: 49.5 }
});

var UI_CATEGORY_GROUPS = Object.freeze({
  Popular: ['Anytime TD', 'First TD', 'Passing Yards', 'Rushing Yards', 'Receiving Yards',
    'Receptions', 'Points', 'Rebounds', 'Assists', 'Hits', 'Home Runs', 'Strikeouts'],
  Passing: ['Passing Yards', 'Passing TDs', 'Pass Completions', 'Pass Attempts',
    'Interceptions Thrown', 'Longest Pass', 'Pass + Rush Yards'],
  Rushing: ['Rushing Yards', 'Rushing Attempts', 'Rushing TDs', 'Longest Rush'],
  Receiving: ['Receiving Yards', 'Receptions', 'Receiving TDs', 'Longest Reception'],
  Touchdowns: ['Anytime TD', 'First TD', 'Anytime TD 1H', 'Anytime TD 1Q',
    'Passing TDs', 'Rushing TDs', 'Receiving TDs'],
  Points: ['Points', 'Pts + Reb', 'Pts + Ast', 'Pts + Reb + Ast', '3-Pointers Made'],
  Rebounds: ['Rebounds', 'Pts + Reb', 'Reb + Ast'],
  Assists: ['Assists', 'Pts + Ast', 'Reb + Ast'],
  Batting: ['Hits', 'Home Runs', 'RBIs', 'Total Bases', 'Runs Scored', 'Stolen Bases',
    'Walks', 'Hits + Runs + RBIs', 'Singles', 'Doubles', 'Triples'],
  Pitching: ['Strikeouts', 'Pitching Outs', 'Earned Runs', 'Walks Allowed', 'Hits Allowed'],
  Defense: ['Sacks', 'Tackles', 'Tackles + Asts', 'Steals', 'Blocks'],
  Other: []
});

function _lc(v) {
  return String(v == null ? '' : v).toLowerCase().trim();
}

function _toAmericanOdds(price) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  if (Math.abs(price) <= 30 && price > 0) {
    if (price >= 2) return Math.round((price - 1) * 100);
    return Math.round(-100 / (price - 1));
  }
  return Math.round(price);
}

function _betterAmericanOdds(a, b) {
  if (typeof a !== 'number' || isNaN(a)) return b;
  if (typeof b !== 'number' || isNaN(b)) return a;
  return a > b ? a : b;
}

function _isHalfPointLine(line) {
  return Number.isFinite(line) && (Math.abs(line * 2) % 1 < 1e-9);
}

function categoryLabel(category, rawMarketName) {
  var k = _lc(category).replace(/[\s-]+/g, '_');
  if (!k || k === 'unknown') {
    if (rawMarketName) return String(rawMarketName).trim();
    return 'Unknown';
  }
  if (CATEGORY_LABELS[k]) return CATEGORY_LABELS[k];
  return k.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

function propLineCategory(propType) {
  var t = String(propType || '').trim();
  if (t === 'Hits' || /to record a hit/i.test(t)) return 'Hits';
  if (t === 'Strikeouts' || /\bstrikeouts?\b/i.test(t)) {
    if (/pass|rush|receiv|sack|yard|completion|attempt|td|touchdown/i.test(t)) return null;
    return 'Strikeouts';
  }
  if (t === 'Home Runs' || /home\s*runs?/i.test(t)) return 'Home Runs';
  if (t === 'RBIs' || /\brbis?\b/i.test(t)) return 'RBIs';
  if (t === 'Singles' || /^singles$/i.test(t)) return 'Singles';
  if (t === 'Doubles' || /^doubles$/i.test(t)) return 'Doubles';
  if (t === 'Triples' || /^triples$/i.test(t)) return 'Triples';
  if (t === 'Stolen Bases' || /stolen\s*bases?/i.test(t)) return 'Stolen Bases';
  if (t === 'Runs Scored' || /^runs$/i.test(t) || /runs?\s*scored/i.test(t)) return 'Runs Scored';
  if (t === 'Walks' || /^walks$/i.test(t)) return 'Walks';
  if (t === 'Hits + Runs + RBIs' || /hits?\s*\+?\s*runs?\s*\+?\s*rbis?/i.test(t)) return 'Hits + Runs + RBIs';
  if (t === 'Total Bases' || /total\s*bases?/i.test(t)) return 'Total Bases';
  if (t === 'Pitching Outs' || /outs?\s*recorded|pitching\s*outs?/i.test(t)) return 'Pitching Outs';
  if (t === 'Earned Runs' || /earned\s*runs?/i.test(t)) return 'Earned Runs';
  if (t === 'Walks Allowed' || /walks?\s*allowed/i.test(t)) return 'Walks Allowed';
  if (t === 'Hits Allowed' || /hits?\s*allowed/i.test(t)) return 'Hits Allowed';
  if (t === 'Passing Yards' || /passing\s*yards?/i.test(t) || /pass\s*yards?/i.test(t)) return 'Passing Yards';
  if (t === 'Rushing Yards' || /rushing\s*yards?/i.test(t) || /rush\s*yards?/i.test(t)) return 'Rushing Yards';
  if (t === 'Receiving Yards' || /receiving\s*yards?/i.test(t) || /reception\s*yards?/i.test(t)) return 'Receiving Yards';
  if (t === 'Pass + Rush Yards' || /pass\s*\+?\s*rush\s*yards?/i.test(t)) return 'Pass + Rush Yards';
  if (t === 'Longest Reception' || /longest\s*reception/i.test(t)) return 'Longest Reception';
  if (t === 'Longest Rush' || /longest\s*rush/i.test(t)) return 'Longest Rush';
  if (t === 'Longest Pass' || /longest\s*pass/i.test(t)) return 'Longest Pass';
  if (t === 'Passing TDs' || /passing\s*t(?:d|ouchdown)s?/i.test(t)) return 'Passing TDs';
  if (t === 'Rushing TDs' || /rushing\s*t(?:d|ouchdown)s?/i.test(t)) return 'Rushing TDs';
  if (t === 'Receiving TDs' || /receiving\s*t(?:d|ouchdown)s?/i.test(t)) return 'Receiving TDs';
  if (t === 'Anytime TD 1H' || /anytime\s*td\s*1h|touchdowns?\s*1h/i.test(t)) return 'Anytime TD 1H';
  if (t === 'Anytime TD 1Q' || /anytime\s*td\s*1q|touchdowns?\s*1q/i.test(t)) return 'Anytime TD 1Q';
  if (t === 'Anytime TD' || /anytime\s*t(?:d|ouchdown)/i.test(t) || /^touchdowns$/i.test(t)) return 'Anytime TD';
  if (t === 'First TD' || /first\s*t(?:d|ouchdown)/i.test(t)) return 'First TD';
  if (t === 'Receptions' || /^receptions$/i.test(t)) return 'Receptions';
  if (t === 'Pass Completions' || /pass\s*completions?/i.test(t)) return 'Pass Completions';
  if (t === 'Pass Attempts' || /pass\s*attempts?/i.test(t)) return 'Pass Attempts';
  if (t === 'Rushing Attempts' || /rush(?:ing)?\s*attempts?/i.test(t)) return 'Rushing Attempts';
  if (t === 'Interceptions Thrown' || /interceptions?\s*(thrown)?$/i.test(t)) return 'Interceptions Thrown';
  if (t === 'Sacks' || /^sacks?$/i.test(t)) return 'Sacks';
  if (t === 'Tackles' || /^tackles$/i.test(t)) return 'Tackles';
  if (t === 'Tackles + Asts' || /tackles?\s*\+?\s*asts?/i.test(t)) return 'Tackles + Asts';
  if (t === 'Points' || /^points$/i.test(t)) return 'Points';
  if (t === 'Rebounds' || /^rebounds$/i.test(t)) return 'Rebounds';
  if (t === 'Assists' || /^assists$/i.test(t)) return 'Assists';
  if (t === '3-Pointers Made' || /3[- ]?pointers?/i.test(t) || /threes?/i.test(t)) return '3-Pointers Made';
  return null;
}

function isAllowedPropLine(propType, line) {
  if (typeof line !== 'number' || isNaN(line)) return false;
  var cat = propLineCategory(propType) || String(propType || '').trim();
  if (!cat) return true;
  var allowed = ALLOWED_LINES_BY_CATEGORY[cat];
  if (allowed) return allowed.indexOf(line) >= 0;
  var range = LINE_RANGES_BY_CATEGORY[cat];
  if (range) {
    if (line < range.min || line > range.max) return false;
    return _isHalfPointLine(line) || Number.isInteger(line);
  }
  // Unknown categories: keep for inventory; betting gated separately.
  return true;
}

function classifySupportStatus(opts) {
  opts = opts || {};
  var rawCategory = _lc(opts.rawCategory);
  var propType = String(opts.propType || '').trim();
  var playerName = String(opts.playerName || '');
  var rawMarketName = opts.rawMarketName || null;

  if (/&|\+|\/|,/.test(playerName) && /\s&\s|\sand\s/i.test(playerName)) {
    return SUPPORT.UNSUPPORTED;
  }
  if (rawCategory === 'combos' || propType === 'Combos') return SUPPORT.UNSUPPORTED;
  if (!propType || propType === 'Unknown' || rawCategory === 'unknown') {
    return SUPPORT.UNKNOWN_RAW;
  }
  if (KNOWN_PROP_TYPES[propType] || BETTABLE_PROP_TYPES[propType]) {
    return SUPPORT.SUPPORTED_NORMALIZED;
  }
  if (rawMarketName && (!rawCategory || rawCategory === 'unknown')) return SUPPORT.UNKNOWN_RAW;
  return SUPPORT.UNKNOWN_RAW;
}

function isBettablePropSelection(sel) {
  if (!sel) return false;
  if (sel.supportStatus && sel.supportStatus !== SUPPORT.SUPPORTED_NORMALIZED) return false;
  var propType = sel.propType || sel.prop_type;
  if (!BETTABLE_PROP_TYPES[String(propType || '').trim()]) return false;
  if (typeof sel.odds !== 'number' || !Number.isFinite(sel.odds)) return false;
  if (Math.abs(sel.odds) > 2000) return false;
  if (!isAllowedPropLine(propType, sel.line)) return false;
  if (!sel.playerName) return false;
  return true;
}

function isBettablePropType(propType) {
  return !!BETTABLE_PROP_TYPES[String(propType || '').trim()];
}

/**
 * Normalize nested Owls alternateLines into authoritative alt selections.
 * Does NOT synthesize missing under/over prices.
 */
function expandPropAlternateLines(primary, altLines, meta) {
  meta = meta || {};
  var out = [];
  if (!Array.isArray(altLines) || !altLines.length) return out;
  var primaryLine = primary && primary.line;
  for (var i = 0; i < altLines.length; i++) {
    var alt = altLines[i];
    if (!alt || typeof alt !== 'object') continue;
    var line = alt.line != null ? Number(alt.line)
      : (alt.point != null ? Number(alt.point)
      : (alt.handicap != null ? Number(alt.handicap) : NaN));
    if (!Number.isFinite(line)) continue;
    // Skip exact duplicate of primary line+side when odds already captured.
    var overP = alt.overPrice != null ? alt.overPrice : alt.overOdds;
    var underP = alt.underPrice != null ? alt.underPrice : alt.underOdds;
    var singleOdds = alt.odds != null ? alt.odds
      : (alt.price != null ? alt.price
      : (alt.american != null ? alt.american : null));

    function pushSide(side, rawOdds) {
      var odds = _toAmericanOdds(typeof rawOdds === 'number' ? rawOdds : parseFloat(rawOdds));
      if (odds == null || !Number.isFinite(odds)) return;
      if (Number.isFinite(primaryLine) && line === primaryLine && side === (meta.primarySide || null)) {
        // Same as primary side+line — skip duplicate; primary wins identity.
        return;
      }
      out.push({
        line: line,
        side: side,
        odds: odds,
        isPrimary: false,
        isAlternate: true,
        kind: alt.kind || meta.marketStructure || null,
        source: meta.source || null,
        book: meta.book || null,
        lastUpdate: alt.lastUpdate || meta.lastUpdate || null,
        selectionId: alt.selectionId || null,
        marketId: alt.marketId || null
      });
    }

    if (overP != null || underP != null) {
      if (overP != null) pushSide('over', overP);
      if (underP != null) pushSide('under', underP);
    } else if (singleOdds != null) {
      // Owls nested alts are typically single-sided (over / milestone). Never invent under.
      pushSide('over', singleOdds);
    }
  }
  return out;
}

/**
 * Expand nested alternateLines on odds-feed outcomes (spread/total/player_prop).
 * Returns entries suitable for push into the markets cache.
 */
function expandOwlsOutcomeAlternates(oc, mt, baseEntry, buildKeysFn) {
  var altLines = (oc && (oc.alternateLines || oc.alternate_lines)) || null;
  if (!Array.isArray(altLines) || !altLines.length) return [];
  if (mt !== 'spread' && mt !== 'total' && mt !== 'player_prop') return [];
  var out = [];
  for (var i = 0; i < altLines.length; i++) {
    var alt = altLines[i];
    if (!alt || typeof alt !== 'object') continue;
    var altPoint = alt.point != null ? alt.point
      : alt.line != null ? alt.line
      : alt.handicap != null ? alt.handicap
      : alt.spread != null ? alt.spread : undefined;
    if (altPoint == null) continue;

    if (mt === 'total' && (alt.overPrice != null || alt.underPrice != null
        || alt.over != null || alt.under != null)) {
      var overP = alt.overPrice != null ? alt.overPrice : alt.over;
      var underP = alt.underPrice != null ? alt.underPrice : alt.under;
      if (overP != null) {
        var overEntry = Object.assign({}, baseEntry, {
          teamOrSide: 'Over', line: altPoint,
          odds: _toAmericanOdds(parseFloat(overP) || 0),
          overUnder: 'Over', isAlternate: true, isPrimary: false
        });
        if (typeof buildKeysFn === 'function') buildKeysFn(overEntry);
        out.push(overEntry);
      }
      if (underP != null) {
        var underEntry = Object.assign({}, baseEntry, {
          teamOrSide: 'Under', line: altPoint,
          odds: _toAmericanOdds(parseFloat(underP) || 0),
          overUnder: 'Under', isAlternate: true, isPrimary: false
        });
        if (typeof buildKeysFn === 'function') buildKeysFn(underEntry);
        out.push(underEntry);
      }
      continue;
    }

    var altPrice = alt.price != null ? alt.price
      : alt.odds != null ? alt.odds
      : alt.american != null ? alt.american
      : alt.overPrice != null ? alt.overPrice : null;
    if (altPrice == null) continue;
    var altEntry = Object.assign({}, baseEntry, {
      line: altPoint,
      odds: _toAmericanOdds(parseFloat(altPrice) || 0),
      isAlternate: true,
      isPrimary: false
    });
    if (mt === 'player_prop') {
      // Single-odds nested prop alts are over/milestone — do not invent under.
      if (!altEntry.overUnder) altEntry.overUnder = 'over';
      if (alt.kind) altEntry.altKind = alt.kind;
    }
    if (typeof buildKeysFn === 'function') buildKeysFn(altEntry);
    out.push(altEntry);
  }
  return out;
}

function selectionDedupeKey(s) {
  return [
    _lc(s.playerName),
    _lc(s.propType),
    String(s.line),
    _lc(s.side),
    String(s.gameId || s.canonicalGameKey || '')
  ].join('|');
}

function marketGroupKey(s) {
  return [
    _lc(s.playerName),
    _lc(s.propType),
    String(s.gameId || s.canonicalGameKey || '')
  ].join('|');
}

function sortSelections(list) {
  return (list || []).slice().sort(function(a, b) {
    if (a.propType !== b.propType) return a.propType < b.propType ? -1 : 1;
    if (a.playerName !== b.playerName) return (a.playerName || '').localeCompare(b.playerName || '');
    if (!!b.isPrimary !== !!a.isPrimary) return a.isPrimary ? -1 : 1;
    if (a.line !== b.line) return Number(a.line) - Number(b.line);
    return (a.side || '').localeCompare(b.side || '');
  });
}

/**
 * Normalize a raw Owls /props payload into flat selections with primary + alts preserved.
 */
function normalizeOwlsPropsApiResponse(owlsData, sportShort, helpers) {
  helpers = helpers || {};
  var selectBooks = helpers.selectBooks || function(books) { return books || []; };
  if (!owlsData || owlsData.success === false) return [];
  var games = Array.isArray(owlsData.data) ? owlsData.data
    : (Array.isArray(owlsData.games) ? owlsData.games
    : (Array.isArray(owlsData) ? owlsData : []));
  var sportLabel = String(sportShort || '').toUpperCase();
  var bestByKey = Object.create(null);

  function consider(sel) {
    if (!sel || !sel.playerName) return;
    if (typeof sel.odds !== 'number' || !Number.isFinite(sel.odds)) return;
    var key = selectionDedupeKey(sel);
    var prev = bestByKey[key];
    if (!prev) {
      bestByKey[key] = sel;
      return;
    }
    // Prefer primary over alternate for same line/side; else better American odds.
    if (sel.isPrimary && !prev.isPrimary) {
      bestByKey[key] = sel;
      return;
    }
    if (prev.isPrimary && !sel.isPrimary) return;
    if (sel.odds > prev.odds) bestByKey[key] = sel;
  }

  for (var gi = 0; gi < games.length; gi++) {
    var game = games[gi];
    if (!game) continue;
    var home = game.homeTeam || game.home_team || '';
    var away = game.awayTeam || game.away_team || '';
    var gameId = game.gameId || game.id || null;
    var scheduledStart = game.commenceTime || game.commence_time || game.startTime || null;
    var books = selectBooks(game.books || game.bookmakers || []);
    if ((!books || !books.length) && Array.isArray(game.props) && game.props.length) {
      books = [{ key: 'owls', props: game.props }];
    }
    for (var bi = 0; bi < books.length; bi++) {
      var book = books[bi];
      var bookKey = book && book.key ? String(book.key).toLowerCase() : null;
      var props = Array.isArray(book && book.props) ? book.props
        : (Array.isArray(book && book.markets) ? book.markets : []);
      for (var pi = 0; pi < props.length; pi++) {
        var prop = props[pi];
        if (!prop) continue;
        var playerName = prop.playerName || prop.player || prop.name || null;
        if (!playerName) continue;
        var rawCategory = prop.category || prop.propType || prop.market || prop.marketKey || prop.key || null;
        var propType = categoryLabel(rawCategory, prop.rawMarketName);
        var line = prop.line;
        if (typeof line !== 'number' || isNaN(line)) {
          if (/anytime\s*td|first\s*td|last\s*td/i.test(propType) || prop.yesPrice != null || prop.noPrice != null) {
            line = 0.5;
          } else {
            continue;
          }
        }
        var overOdds = (typeof prop.overPrice === 'number') ? prop.overPrice
          : ((typeof prop.overOdds === 'number') ? prop.overOdds : null);
        var underOdds = (typeof prop.underPrice === 'number') ? prop.underPrice
          : ((typeof prop.underOdds === 'number') ? prop.underOdds : null);
        if (overOdds == null && underOdds == null) {
          if (typeof prop.yesPrice === 'number') overOdds = prop.yesPrice;
          else if (typeof prop.yesOdds === 'number') overOdds = prop.yesOdds;
          else if (typeof prop.price === 'number' && prop.side !== 'no' && prop.side !== 'under') overOdds = prop.price;
          if (typeof prop.noPrice === 'number') underOdds = prop.noPrice;
          else if (typeof prop.noOdds === 'number') underOdds = prop.noOdds;
        }
        var supportStatus = classifySupportStatus({
          rawCategory: rawCategory,
          propType: propType,
          playerName: playerName,
          rawMarketName: prop.rawMarketName
        });
        var team = prop.team || prop.playerTeam || null;
        var lastUpdate = prop.lastUpdate || prop.last_update || null;
        var baseMeta = {
          gameId: gameId,
          canonicalGameKey: game.canonicalGameKey || null,
          home: home,
          away: away,
          scheduledStart: scheduledStart,
          sport: sportLabel,
          propType: propType,
          category: rawCategory,
          rawMarketName: prop.rawMarketName || null,
          marketStructure: prop.marketStructure || null,
          playerName: playerName,
          team: team,
          identity: {
            playerName: playerName,
            team: team,
            photoPolicy: PHOTO_POLICY
          },
          supportStatus: supportStatus,
          bettable: false,
          source: bookKey || 'owls',
          book: bookKey,
          lastUpdate: lastUpdate,
          propId: prop.propId || null
        };

        function emitPrimary(side, rawOdds) {
          var odds = _toAmericanOdds(typeof rawOdds === 'number' ? rawOdds : parseFloat(rawOdds));
          if (odds == null) return;
          var sel = Object.assign({}, baseMeta, {
            line: line,
            side: side,
            odds: odds,
            isPrimary: true,
            isAlternate: false,
            pick: playerName + ' ' + (side === 'over' ? 'Over' : 'Under') + ' ' + line + ' ' + propType
          });
          sel.bettable = isBettablePropSelection(sel);
          consider(sel);
        }

        if (typeof overOdds === 'number') emitPrimary('over', overOdds);
        if (typeof underOdds === 'number') emitPrimary('under', underOdds);

        var alts = expandPropAlternateLines(
          { line: line },
          prop.alternateLines || prop.alternate_lines,
          {
            source: bookKey,
            book: bookKey,
            lastUpdate: lastUpdate,
            marketStructure: prop.marketStructure || null
          }
        );
        for (var ai = 0; ai < alts.length; ai++) {
          var a = alts[ai];
          var altSel = Object.assign({}, baseMeta, {
            line: a.line,
            side: a.side,
            odds: a.odds,
            isPrimary: false,
            isAlternate: true,
            kind: a.kind || null,
            selectionId: a.selectionId || null,
            marketId: a.marketId || null,
            lastUpdate: a.lastUpdate || lastUpdate,
            pick: playerName + ' ' + (a.side === 'over' ? 'Over' : 'Under') + ' ' + a.line + ' ' + propType
          });
          altSel.bettable = isBettablePropSelection(altSel);
          consider(altSel);
        }
      }
    }
  }

  return sortSelections(Object.keys(bestByKey).map(function(k) { return bestByKey[k]; }));
}

/**
 * Filter for legacy flat display / bettable board (does not drop inventory tree).
 * Unknowns retained only when opts.retainUnknown is true (default false for legacy UI).
 */
function filterPropsForDisplay(props, opts) {
  opts = opts || {};
  var retainUnknown = !!opts.retainUnknown;
  var bettableOnly = opts.bettableOnly !== false && !retainUnknown;
  var list = Array.isArray(props) ? props : [];
  var bestByKey = Object.create(null);
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!p || !p.playerName) continue;
    if (typeof p.odds !== 'number' || isNaN(p.odds)) continue;
    if (!retainUnknown && Math.abs(p.odds) > 2000) continue;
    if (String(p.sport || '').toUpperCase() === 'NFL' && String(p.propType || '') === 'Points') continue;
    var status = p.supportStatus || classifySupportStatus({
      propType: p.propType,
      playerName: p.playerName,
      rawCategory: p.category,
      rawMarketName: p.rawMarketName
    });
    if (bettableOnly) {
      if (status !== SUPPORT.SUPPORTED_NORMALIZED) continue;
      if (!isAllowedPropLine(p.propType, p.line)) continue;
      if (!isBettablePropType(p.propType)) continue;
      if (Math.abs(p.odds) > 2000) continue;
    } else if (!retainUnknown && status === SUPPORT.UNSUPPORTED) {
      continue;
    } else if (!retainUnknown && !isAllowedPropLine(p.propType, p.line)
        && status === SUPPORT.SUPPORTED_NORMALIZED) {
      continue;
    }
    var dedupeKey = selectionDedupeKey(p);
    var prev = bestByKey[dedupeKey];
    if (!prev || p.odds > prev.odds || (p.isPrimary && !prev.isPrimary)) bestByKey[dedupeKey] = p;
  }
  return sortSelections(Object.keys(bestByKey).map(function(k) { return bestByKey[k]; }));
}

/**
 * Build GAME → CATEGORY → PLAYER → MARKET → PRIMARY → ALTS tree for future UI.
 */
function buildPropsInventoryTree(selections, opts) {
  opts = opts || {};
  var list = Array.isArray(selections) ? selections : [];
  var games = Object.create(null);

  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (!s) continue;
    var gKey = String(s.gameId || s.canonicalGameKey || (s.away + '@' + s.home) || 'unknown');
    var g = games[gKey] || (games[gKey] = {
      gameId: s.gameId || null,
      canonicalGameKey: s.canonicalGameKey || null,
      home: s.home || null,
      away: s.away || null,
      scheduledStart: s.scheduledStart || null,
      sport: s.sport || null,
      categories: Object.create(null),
      selectionCount: 0,
      bettableCount: 0,
      unknownCount: 0
    });
    g.selectionCount++;
    if (s.bettable || isBettablePropSelection(s)) g.bettableCount++;
    if (s.supportStatus === SUPPORT.UNKNOWN_RAW || s.supportStatus === SUPPORT.UNSUPPORTED) g.unknownCount++;

    var catName = s.propType || 'Other';
    var cat = g.categories[catName] || (g.categories[catName] = {
      category: catName,
      uiGroup: uiGroupForPropType(catName),
      players: Object.create(null)
    });
    var pName = s.playerName || 'Unknown';
    var player = cat.players[pName] || (cat.players[pName] = {
      playerName: pName,
      team: s.team || null,
      identity: s.identity || { playerName: pName, team: s.team || null, photoPolicy: PHOTO_POLICY },
      markets: Object.create(null)
    });
    if (!player.team && s.team) player.team = s.team;

    var mKey = String(s.propType);
    var market = player.markets[mKey] || (player.markets[mKey] = {
      propType: s.propType,
      supportStatus: s.supportStatus || SUPPORT.UNKNOWN_RAW,
      primary: null,
      primaryOver: null,
      primaryUnder: null,
      alternates: []
    });
    if (s.isPrimary || (!s.isAlternate && !market.primary)) {
      if (s.side === 'over') market.primaryOver = s;
      else if (s.side === 'under') market.primaryUnder = s;
      if (!market.primary || s.isPrimary) market.primary = s;
    } else {
      market.alternates.push(s);
    }
  }

  var gameList = Object.keys(games).map(function(gk) {
    var g = games[gk];
    var categories = Object.keys(g.categories).sort().map(function(ck) {
      var cat = g.categories[ck];
      var players = Object.keys(cat.players).sort().map(function(pk) {
        var pl = cat.players[pk];
        var markets = Object.keys(pl.markets).sort().map(function(mk) {
          var m = pl.markets[mk];
          m.alternates = sortSelections(m.alternates);
          return m;
        });
        return {
          playerName: pl.playerName,
          team: pl.team,
          identity: pl.identity,
          markets: markets
        };
      });
      return {
        category: cat.category,
        uiGroup: cat.uiGroup,
        players: players
      };
    });
    return {
      gameId: g.gameId,
      canonicalGameKey: g.canonicalGameKey,
      home: g.home,
      away: g.away,
      scheduledStart: g.scheduledStart,
      sport: g.sport,
      selectionCount: g.selectionCount,
      bettableCount: g.bettableCount,
      unknownCount: g.unknownCount,
      categories: categories
    };
  });

  gameList.sort(function(a, b) {
    return String(a.scheduledStart || '').localeCompare(String(b.scheduledStart || ''));
  });

  var maxAltSample = 0;
  for (var gi = 0; gi < gameList.length; gi++) {
    var cats = gameList[gi].categories || [];
    for (var ci = 0; ci < cats.length; ci++) {
      var players = cats[ci].players || [];
      for (var pi = 0; pi < players.length; pi++) {
        var mkts = players[pi].markets || [];
        for (var mi = 0; mi < mkts.length; mi++) {
          maxAltSample = Math.max(maxAltSample, (mkts[mi].alternates || []).length);
        }
      }
    }
  }

  return {
    games: gameList,
    gameCount: gameList.length,
    selectionCount: list.length,
    maxAltSample: maxAltSample,
    photoPolicy: PHOTO_POLICY,
    categoryGroups: Object.keys(UI_CATEGORY_GROUPS),
    contract: 'GAME>CATEGORY>PLAYER>MARKET>PRIMARY>ALTS'
  };
}

function uiGroupForPropType(propType) {
  var t = String(propType || '');
  var keys = Object.keys(UI_CATEGORY_GROUPS);
  for (var i = 0; i < keys.length; i++) {
    var g = keys[i];
    if (g === 'Other') continue;
    if (UI_CATEGORY_GROUPS[g].indexOf(t) >= 0) return g;
  }
  return 'Other';
}

/**
 * Data-derived sport props capability for /api/sports.
 */
function sportPropsCapability(sportKey, selectionCount) {
  var key = _lc(sportKey);
  var capable = PROPS_CAPABLE_SPORTS.indexOf(key) >= 0;
  var count = Number(selectionCount) || 0;
  if (!capable) {
    return {
      hasProps: false,
      propsStatus: 'unsupported',
      propsCount: 0,
      propsCapable: false
    };
  }
  if (count > 0) {
    return {
      hasProps: true,
      propsStatus: 'live',
      propsCount: count,
      propsCapable: true
    };
  }
  // Empty capable sports: tell FE truthfully — no fake inventory.
  return {
    hasProps: false,
    propsStatus: 'empty',
    propsCount: 0,
    propsCapable: true
  };
}

function paginateProps(list, opts) {
  opts = opts || {};
  var offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  var limit = parseInt(opts.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 500;
  if (limit > 2000) limit = 2000;
  var slice = (list || []).slice(offset, offset + limit);
  return {
    items: slice,
    offset: offset,
    limit: limit,
    total: (list || []).length,
    hasMore: offset + slice.length < (list || []).length
  };
}

function measurePayloadBytes(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj), 'utf8');
  } catch (_e) {
    return -1;
  }
}

module.exports = {
  SUPPORT: SUPPORT,
  PHOTO_POLICY: PHOTO_POLICY,
  PROPS_CAPABLE_SPORTS: PROPS_CAPABLE_SPORTS,
  PROPS_NEVER_FAKE: PROPS_NEVER_FAKE,
  CATEGORY_LABELS: CATEGORY_LABELS,
  KNOWN_PROP_TYPES: KNOWN_PROP_TYPES,
  BETTABLE_PROP_TYPES: BETTABLE_PROP_TYPES,
  ALLOWED_LINES_BY_CATEGORY: ALLOWED_LINES_BY_CATEGORY,
  LINE_RANGES_BY_CATEGORY: LINE_RANGES_BY_CATEGORY,
  UI_CATEGORY_GROUPS: UI_CATEGORY_GROUPS,
  categoryLabel: categoryLabel,
  propLineCategory: propLineCategory,
  isAllowedPropLine: isAllowedPropLine,
  classifySupportStatus: classifySupportStatus,
  isBettablePropSelection: isBettablePropSelection,
  isBettablePropType: isBettablePropType,
  expandPropAlternateLines: expandPropAlternateLines,
  expandOwlsOutcomeAlternates: expandOwlsOutcomeAlternates,
  selectionDedupeKey: selectionDedupeKey,
  sortSelections: sortSelections,
  normalizeOwlsPropsApiResponse: normalizeOwlsPropsApiResponse,
  filterPropsForDisplay: filterPropsForDisplay,
  buildPropsInventoryTree: buildPropsInventoryTree,
  uiGroupForPropType: uiGroupForPropType,
  sportPropsCapability: sportPropsCapability,
  paginateProps: paginateProps,
  measurePayloadBytes: measurePayloadBytes
};
