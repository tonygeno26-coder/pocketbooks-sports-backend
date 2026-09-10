'use strict';
/**
 * PocketBooks — Parlay correlation protection (pre-beta, fail-closed).
 *
 * Detects dangerous multi-leg combinations. Does NOT invent correlation-
 * adjusted odds. Product-of-standalone odds is only allowed for INDEPENDENT
 * legs. Same-event unknowns fail closed as UNSUPPORTED_CORRELATION.
 *
 * Relationships:
 *   INDEPENDENT | DUPLICATE | MUTUALLY_EXCLUSIVE |
 *   CORRELATED_SGP_REQUIRED | UNSUPPORTED_CORRELATION | DEPENDENT_FUTURE
 */

var RELATIONSHIP = Object.freeze({
  INDEPENDENT: 'INDEPENDENT',
  DUPLICATE: 'DUPLICATE',
  MUTUALLY_EXCLUSIVE: 'MUTUALLY_EXCLUSIVE',
  CORRELATED_SGP_REQUIRED: 'CORRELATED_SGP_REQUIRED',
  UNSUPPORTED_CORRELATION: 'UNSUPPORTED_CORRELATION',
  DEPENDENT_FUTURE: 'DEPENDENT_FUTURE'
});

var SEVERITY = Object.freeze({
  INDEPENDENT: 0,
  CORRELATED_SGP_REQUIRED: 1,
  DEPENDENT_FUTURE: 2,
  UNSUPPORTED_CORRELATION: 3,
  MUTUALLY_EXCLUSIVE: 4,
  DUPLICATE: 5
});

var UX = Object.freeze({
  DUPLICATE: 'Duplicate selection — remove the repeated leg.',
  MUTUALLY_EXCLUSIVE: 'These picks cannot both win — remove one.',
  CORRELATED_SGP_REQUIRED: 'This combination isn\'t currently available as a parlay.',
  UNSUPPORTED_CORRELATION: 'This combination isn\'t currently available as a parlay.',
  DEPENDENT_FUTURE: 'Futures / dependent outcomes cannot be combined in a parlay.',
  SGP_ENGINE_UNAVAILABLE: 'This combination isn\'t currently available as a parlay.'
});

function _lc(v) {
  return String(v == null ? '' : v).toLowerCase().trim();
}

function _normSport(leg) {
  var s = _lc(leg && (leg.sport || leg.sportKey || leg.league));
  if (!s) {
    var gk = _lc(leg && (leg.canonicalGameKey || leg.canonical_game_key || ''));
    if (gk) s = gk.split('|')[0] || '';
  }
  if (s.indexOf('soccer') >= 0 || s === 'football' || s === 'epl' || s === 'mls') return 'soccer';
  if (s.indexOf('tennis') >= 0 || s === 'atp' || s === 'wta') return 'tennis';
  if (s.indexOf('golf') >= 0 || s === 'pga') return 'golf';
  if (s.indexOf('racing') >= 0 || s.indexOf('nascar') >= 0 || s.indexOf('f1') >= 0 || s === 'horse') return 'racing';
  if (s.indexOf('nba') >= 0) return 'nba';
  if (s.indexOf('nfl') >= 0) return 'nfl';
  if (s.indexOf('mlb') >= 0) return 'mlb';
  if (s.indexOf('nhl') >= 0) return 'nhl';
  if (s.indexOf('ncaaf') >= 0 || s.indexOf('cfb') >= 0) return 'ncaaf';
  if (s.indexOf('ncaab') >= 0 || s.indexOf('cbb') >= 0) return 'ncaab';
  return s || 'unknown';
}

function coerceMarketType(raw) {
  if (!raw) return null;
  var k = _lc(raw).replace(/-/g, '_').replace(/\s+/g, '_');
  var spaced = _lc(raw);
  if (k === 'moneyline' || k === 'h2h' || k === 'to_win' || k === 'win' || spaced === 'to win' || k === 'ml')
    return 'moneyline';
  if (k === 'spread' || k === 'spreads' || k === 'run_line' || k === 'runline' || spaced === 'run line'
    || k === 'puck_line' || k === 'puckline' || spaced === 'puck line' || spaced.indexOf('handicap') >= 0
    || k.indexOf('alt_spread') === 0 || spaced.indexOf('alternate spread') >= 0 || spaced.indexOf('point spread') >= 0)
    return 'spread';
  if (k === 'team_total' || k === 'team_totals' || spaced.indexOf('team total') >= 0)
    return 'team_total';
  if (k === 'total' || k === 'totals' || k.indexOf('alt_total') === 0
    || spaced.indexOf('alternate total') >= 0 || spaced === 'o/u' || spaced.indexOf('over/under') >= 0)
    return 'total';
  if (k === 'player_prop' || k === 'prop' || k.indexOf('player_') === 0 || spaced.indexOf('prop') === 0)
    return 'player_prop';
  if (/^(period|quarter|inning|half|h1|h2|q1|q2|q3|q4)_moneyline$/.test(k)
    || k === 'first_half_moneyline' || k === 'h2h_h1' || k === 'moneyline_h1')
    return 'period_moneyline';
  if (/^(period|quarter|inning|half|h1|h2|q1|q2|q3|q4)_spread$/.test(k)
    || k === 'first_half_spread' || k === 'spreads_h1' || k === 'spread_h1')
    return 'period_spread';
  if (/^(period|quarter|inning|half|h1|h2|q1|q2|q3|q4)_total$/.test(k)
    || k === 'first_half_total' || k === 'totals_h1' || k === 'total_h1')
    return 'period_total';
  if (spaced.indexOf('1st half') >= 0 || spaced.indexOf('first half') >= 0 || spaced.indexOf('2nd half') >= 0
    || /\bq[1-4]\b/.test(spaced) || spaced.indexOf('period') >= 0 || spaced.indexOf('inning') >= 0) {
    if (spaced.indexOf('spread') >= 0 || spaced.indexOf('handicap') >= 0) return 'period_spread';
    if (spaced.indexOf('total') >= 0 || spaced.indexOf('over') >= 0 || spaced.indexOf('under') >= 0) return 'period_total';
    if (spaced.indexOf('moneyline') >= 0 || spaced.indexOf('winner') >= 0 || spaced.indexOf('to win') >= 0)
      return 'period_moneyline';
  }
  if (spaced.indexOf('future') >= 0 || spaced.indexOf('outright') >= 0 || spaced.indexOf('to win tournament') >= 0
    || spaced.indexOf('championship') >= 0 || k === 'futures' || k === 'outright')
    return 'futures';
  if (spaced.indexOf('moneyline') >= 0 || spaced.indexOf('to win') >= 0) return 'moneyline';
  if (spaced.indexOf('spread') >= 0 || spaced.indexOf('run line') >= 0 || spaced.indexOf('puck line') >= 0)
    return 'spread';
  if (spaced.indexOf('team total') >= 0) return 'team_total';
  if (spaced.indexOf('total') >= 0 || spaced.indexOf('over') >= 0 || spaced.indexOf('under') >= 0) return 'total';
  return null;
}

function eventKey(leg) {
  if (!leg) return null;
  var k = leg.canonicalGameKey || leg.canonical_game_key || null;
  if (k) return String(k);
  var gid = leg.gameId || leg.providerGameId || leg.provider_game_id || leg.eventId || null;
  if (gid) return 'gid:' + String(gid);
  if (leg.game) return 'game:' + String(leg.game);
  return null;
}

function sameEvent(a, b) {
  var ka = eventKey(a);
  var kb = eventKey(b);
  if (ka && kb && ka === kb) return true;
  return false;
}

function _extractLine(leg) {
  if (leg && leg.line != null && leg.line !== '' && Number.isFinite(Number(leg.line)))
    return Math.abs(Number(leg.line));
  var pick = String((leg && leg.pick) || '');
  var m = pick.match(/([+-]?\d+\.?\d*)/);
  if (!m) return null;
  var n = Math.abs(parseFloat(m[1]));
  return Number.isFinite(n) ? n : null;
}

function _ouSide(leg) {
  var pick = _lc(leg && leg.pick);
  var side = _lc(leg && leg.side);
  if (side === 'over' || side === 'o' || side === 'under' || side === 'u') return side.charAt(0) === 'o' ? 'over' : 'under';
  if (/\bover\b/.test(pick) || pick.indexOf(' o ') >= 0 || /^o\s*\d/.test(pick)) return 'over';
  if (/\bunder\b/.test(pick) || pick.indexOf(' u ') >= 0 || /^u\s*\d/.test(pick)) return 'under';
  return null;
}

function _teamToken(leg) {
  var pick = String((leg && leg.pick) || '');
  // Strip line / OU tokens for team identity
  var cleaned = pick
    .replace(/\b(over|under|o|u)\b/ig, '')
    .replace(/[+-]?\d+(\.\d+)?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (cleaned === 'draw' || cleaned === 'x' || cleaned === 'tie') return 'draw';
  return cleaned || null;
}

function _playerToken(leg) {
  if (leg && (leg.playerName || leg.player)) return _lc(leg.playerName || leg.player);
  var pick = String((leg && leg.pick) || '');
  var m = pick.match(/^(.+?)\s+(over|under|o|u)\b/i);
  if (m) return _lc(m[1]);
  return _lc(pick.split(/\d/)[0]);
}

function _isPeriod(mt) {
  return mt === 'period_moneyline' || mt === 'period_spread' || mt === 'period_total';
}

function _isSide(mt) {
  return mt === 'moneyline' || mt === 'spread' || mt === 'period_moneyline' || mt === 'period_spread';
}

function _isTotalFamily(mt) {
  return mt === 'total' || mt === 'team_total' || mt === 'period_total';
}

function _result(relationship, reason, message) {
  return {
    relationship: relationship,
    reason: reason || relationship,
    message: message || UX[relationship] || UX.UNSUPPORTED_CORRELATION
  };
}

/**
 * No production SGP pricing source is wired. Fail closed — never invent
 * correlation-adjusted odds or multiply standalone prices for correlated legs.
 * Hook for a future engine: return true only when that source prices the combo.
 */
function sgpEngineSupportsCombination(/* legs, pairMeta */) {
  return false;
}

/**
 * Classify the relationship between two legs.
 * @returns {{ relationship, reason, message }}
 */
function classifyLegRelationship(legA, legB) {
  if (!legA || !legB) {
    return _result(RELATIONSHIP.UNSUPPORTED_CORRELATION, 'missing_leg', UX.UNSUPPORTED_CORRELATION);
  }

  var mtA = coerceMarketType(legA.market || legA.marketType);
  var mtB = coerceMarketType(legB.market || legB.marketType);
  var sport = _normSport(legA) !== 'unknown' ? _normSport(legA) : _normSport(legB);
  var futuresA = mtA === 'futures' || !!legA.isFuture || !!legA.future;
  var futuresB = mtB === 'futures' || !!legB.isFuture || !!legB.future;

  if (futuresA || futuresB) {
    return _result(RELATIONSHIP.DEPENDENT_FUTURE, 'DEPENDENT_FUTURE', UX.DEPENDENT_FUTURE);
  }

  if (!sameEvent(legA, legB)) {
    // Different events: independent for standard game markets.
    // Sport hooks (tennis/golf/racing): if event keys missing, fail closed below.
    if (!eventKey(legA) || !eventKey(legB)) {
      return _result(RELATIONSHIP.UNSUPPORTED_CORRELATION, 'missing_event_key', UX.UNSUPPORTED_CORRELATION);
    }
    return _result(RELATIONSHIP.INDEPENDENT, 'different_events', 'Different events — independent.');
  }

  // ── Same event ──────────────────────────────────────────────────────────
  if (!mtA || !mtB) {
    return _result(RELATIONSHIP.UNSUPPORTED_CORRELATION, 'unknown_market_same_event', UX.UNSUPPORTED_CORRELATION);
  }

  var teamA = _teamToken(legA);
  var teamB = _teamToken(legB);
  var lineA = _extractLine(legA);
  var lineB = _extractLine(legB);
  var ouA = _ouSide(legA);
  var ouB = _ouSide(legB);

  // Exact / near-exact duplicate
  if (mtA === mtB) {
    if (mtA === 'moneyline' || mtA === 'period_moneyline') {
      if (teamA && teamB && teamA === teamB)
        return _result(RELATIONSHIP.DUPLICATE, 'duplicate_moneyline', UX.DUPLICATE);
      // Two different moneylines same event → mutually exclusive (incl. soccer draw)
      return _result(RELATIONSHIP.MUTUALLY_EXCLUSIVE, 'two_moneylines_same_event', UX.MUTUALLY_EXCLUSIVE);
    }

    if (mtA === 'spread' || mtA === 'period_spread') {
      if (teamA && teamB && teamA === teamB) {
        if (lineA != null && lineB != null && Math.abs(lineA - lineB) < 0.001)
          return _result(RELATIONSHIP.DUPLICATE, 'duplicate_spread', UX.DUPLICATE);
        // Same team overlapping alt spreads
        return _result(RELATIONSHIP.CORRELATED_SGP_REQUIRED, 'overlapping_alt_spreads', UX.CORRELATED_SGP_REQUIRED);
      }
      // Opposite teams / two spreads same game
      if (lineA != null && lineB != null && Math.abs(lineA - lineB) < 0.001)
        return _result(RELATIONSHIP.MUTUALLY_EXCLUSIVE, 'opposite_spreads_same_line', UX.MUTUALLY_EXCLUSIVE);
      return _result(RELATIONSHIP.MUTUALLY_EXCLUSIVE, 'two_spreads_same_event', UX.MUTUALLY_EXCLUSIVE);
    }

    if (mtA === 'total' || mtA === 'period_total') {
      if (ouA && ouB && ouA === ouB) {
        if (lineA != null && lineB != null && Math.abs(lineA - lineB) < 0.001)
          return _result(RELATIONSHIP.DUPLICATE, 'duplicate_total', UX.DUPLICATE);
        return _result(RELATIONSHIP.CORRELATED_SGP_REQUIRED, 'overlapping_alt_totals', UX.CORRELATED_SGP_REQUIRED);
      }
      if (ouA && ouB && ouA !== ouB)
        return _result(RELATIONSHIP.MUTUALLY_EXCLUSIVE, 'over_under_same_event', UX.MUTUALLY_EXCLUSIVE);
      return _result(RELATIONSHIP.MUTUALLY_EXCLUSIVE, 'two_totals_same_event', UX.MUTUALLY_EXCLUSIVE);
    }

    if (mtA === 'team_total') {
      if (teamA && teamB && teamA === teamB) {
        if (ouA && ouB && ouA === ouB && lineA != null && lineB != null && Math.abs(lineA - lineB) < 0.001)
          return _result(RELATIONSHIP.DUPLICATE, 'duplicate_team_total', UX.DUPLICATE);
        if (ouA && ouB && ouA !== ouB)
          return _result(RELATIONSHIP.MUTUALLY_EXCLUSIVE, 'team_total_over_under', UX.MUTUALLY_EXCLUSIVE);
        return _result(RELATIONSHIP.CORRELATED_SGP_REQUIRED, 'overlapping_team_totals', UX.CORRELATED_SGP_REQUIRED);
      }
      // Different teams' totals same game — still correlated
      return _result(RELATIONSHIP.CORRELATED_SGP_REQUIRED, 'two_team_totals_same_event', UX.CORRELATED_SGP_REQUIRED);
    }

    if (mtA === 'player_prop') {
      var pA = _playerToken(legA);
      var pB = _playerToken(legB);
      if (pA && pB && pA === pB) {
        if (ouA && ouB && ouA !== ouB)
          return _result(RELATIONSHIP.MUTUALLY_EXCLUSIVE, 'player_prop_over_under', UX.MUTUALLY_EXCLUSIVE);
        if (ouA && ouB && ouA === ouB && lineA != null && lineB != null && Math.abs(lineA - lineB) < 0.001)
          return _result(RELATIONSHIP.DUPLICATE, 'duplicate_player_prop', UX.DUPLICATE);
        return _result(RELATIONSHIP.CORRELATED_SGP_REQUIRED, 'same_player_props', UX.CORRELATED_SGP_REQUIRED);
      }
      return _result(RELATIONSHIP.CORRELATED_SGP_REQUIRED, 'multi_player_props_same_event', UX.CORRELATED_SGP_REQUIRED);
    }
  }

  // ML + spread (any team) same event
  if ((mtA === 'moneyline' && mtB === 'spread') || (mtA === 'spread' && mtB === 'moneyline')
    || (mtA === 'period_moneyline' && mtB === 'period_spread') || (mtA === 'period_spread' && mtB === 'period_moneyline')) {
    return _result(RELATIONSHIP.CORRELATED_SGP_REQUIRED, 'moneyline_plus_spread', UX.CORRELATED_SGP_REQUIRED);
  }

  // Game total + team total
  if ((mtA === 'total' && mtB === 'team_total') || (mtA === 'team_total' && mtB === 'total')) {
    return _result(RELATIONSHIP.CORRELATED_SGP_REQUIRED, 'total_plus_team_total', UX.CORRELATED_SGP_REQUIRED);
  }

  // Player prop + team/game markets
  if (mtA === 'player_prop' || mtB === 'player_prop') {
    var other = mtA === 'player_prop' ? mtB : mtA;
    if (other === 'moneyline' || other === 'spread' || other === 'total' || other === 'team_total'
      || _isPeriod(other)) {
      return _result(RELATIONSHIP.CORRELATED_SGP_REQUIRED, 'player_prop_plus_game_market', UX.CORRELATED_SGP_REQUIRED);
    }
  }

  // Period ↔ full-game correlation
  if ((_isPeriod(mtA) && !_isPeriod(mtB)) || (_isPeriod(mtB) && !_isPeriod(mtA))) {
    return _result(RELATIONSHIP.CORRELATED_SGP_REQUIRED, 'period_plus_full_game', UX.CORRELATED_SGP_REQUIRED);
  }

  // Side + total same event (classic SGP) — needs real SGP engine
  if ((_isSide(mtA) && _isTotalFamily(mtB)) || (_isSide(mtB) && _isTotalFamily(mtA))) {
    return _result(RELATIONSHIP.CORRELATED_SGP_REQUIRED, 'side_plus_total_same_event', UX.CORRELATED_SGP_REQUIRED);
  }

  // Sport-specific hooks: tennis / golf / racing / soccer — unknown same-event → fail closed
  if (sport === 'tennis' || sport === 'golf' || sport === 'racing' || sport === 'soccer') {
    return _result(RELATIONSHIP.UNSUPPORTED_CORRELATION, sport + '_same_event_unknown', UX.UNSUPPORTED_CORRELATION);
  }

  // Any other same-event pair we did not explicitly allow → fail closed
  return _result(RELATIONSHIP.UNSUPPORTED_CORRELATION, 'unknown_same_event_combo', UX.UNSUPPORTED_CORRELATION);
}

function classifyAllPairs(legs) {
  var arr = Array.isArray(legs) ? legs : [];
  var pairs = [];
  for (var i = 0; i < arr.length; i++) {
    for (var j = i + 1; j < arr.length; j++) {
      var rel = classifyLegRelationship(arr[i], arr[j]);
      pairs.push({
        i: i,
        j: j,
        legA: arr[i],
        legB: arr[j],
        relationship: rel.relationship,
        reason: rel.reason,
        message: rel.message
      });
    }
  }
  return pairs;
}

function worstPair(pairs) {
  var worst = null;
  var worstSev = -1;
  (pairs || []).forEach(function(p) {
    var sev = SEVERITY[p.relationship] != null ? SEVERITY[p.relationship] : 3;
    if (sev > worstSev) {
      worstSev = sev;
      worst = p;
    }
  });
  return worst;
}

/**
 * Gate multi-leg placement. Singles (1 leg) always pass.
 * Rejected correlation → caller must not create tickets / mutate bankroll / ledger.
 */
function assertParlayCorrelationAllowed(legs, options) {
  options = options || {};
  var arr = Array.isArray(legs) ? legs : [];
  var betType = String(options.betType || options.type || 'Parlay').toLowerCase();

  if (arr.length <= 1 || betType === 'single' || betType === 'straight') {
    return { ok: true, relationship: RELATIONSHIP.INDEPENDENT, pairs: [] };
  }

  var pairs = classifyAllPairs(arr);
  var blocking = pairs.filter(function(p) {
    return p.relationship !== RELATIONSHIP.INDEPENDENT;
  });

  if (!blocking.length) {
    return { ok: true, relationship: RELATIONSHIP.INDEPENDENT, pairs: pairs };
  }

  var worst = worstPair(blocking);
  var onlySgpRequired = blocking.every(function(p) {
    return p.relationship === RELATIONSHIP.CORRELATED_SGP_REQUIRED;
  });

  if (onlySgpRequired && (betType === 'sgp') && sgpEngineSupportsCombination(arr, blocking)) {
    return {
      ok: true,
      relationship: RELATIONSHIP.CORRELATED_SGP_REQUIRED,
      sgpRouted: true,
      pairs: pairs,
      message: null
    };
  }

  var code = worst.relationship;
  var message = worst.message;
  if (onlySgpRequired && !sgpEngineSupportsCombination(arr, blocking)) {
    message = UX.SGP_ENGINE_UNAVAILABLE;
  }

  return {
    ok: false,
    code: code,
    error: 'parlay_correlation_rejected',
    reason: worst.reason,
    relationship: code,
    message: message,
    pairs: pairs,
    blocking: blocking,
    financialMutation: 'NONE'
  };
}

function classifySlip(legs) {
  var pairs = classifyAllPairs(legs);
  if (!pairs.length) return { relationship: RELATIONSHIP.INDEPENDENT, pairs: pairs };
  var worst = worstPair(pairs);
  return {
    relationship: worst ? worst.relationship : RELATIONSHIP.INDEPENDENT,
    reason: worst ? worst.reason : 'none',
    message: worst ? worst.message : null,
    pairs: pairs
  };
}

var api = {
  RELATIONSHIP: RELATIONSHIP,
  UX: UX,
  coerceMarketType: coerceMarketType,
  eventKey: eventKey,
  sameEvent: sameEvent,
  classifyLegRelationship: classifyLegRelationship,
  classifyAllPairs: classifyAllPairs,
  classifySlip: classifySlip,
  assertParlayCorrelationAllowed: assertParlayCorrelationAllowed,
  sgpEngineSupportsCombination: sgpEngineSupportsCombination,
  worstPair: worstPair
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof globalThis !== 'undefined') {
  globalThis.PocketBooksParlayCorrelation = api;
}
