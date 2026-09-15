'use strict';

/**
 * Live odds repricing helpers — American odds comparison + policy resolution.
 * Pure functions; safe for unit tests without DB.
 *
 * Policies (player-facing):
 *   ask            — Ask Me (default): any price move requires confirmation
 *   accept_better  — auto-accept only when new price is better for the bettor
 *   accept_all     — auto-accept any price move on the SAME wager (not line)
 *
 * Legacy club_risk_settings aliases map into the above.
 */

var POLICY_ASK = 'ask';
var POLICY_ACCEPT_BETTER = 'accept_better';
var POLICY_ACCEPT_ALL = 'accept_all';

var LEGACY_ALIASES = Object.freeze({
  reject: POLICY_ASK,
  ask_me: POLICY_ASK,
  ask: POLICY_ASK,
  accept_better: POLICY_ACCEPT_BETTER,
  better: POLICY_ACCEPT_BETTER,
  accept_all: POLICY_ACCEPT_ALL,
  accept_any: POLICY_ACCEPT_ALL,
  accept_any_with_confirm: POLICY_ACCEPT_ALL
});

/**
 * Normalize a policy string to ask | accept_better | accept_all.
 * Unknown / empty → ask (safe default).
 */
function normalizeOddsChangePolicy(raw) {
  if (raw == null || raw === '') return POLICY_ASK;
  var key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return LEGACY_ALIASES[key] || POLICY_ASK;
}

/**
 * Compare American odds from the bettor's perspective.
 * Higher American number is always better for the bettor
 * (+130 > +120 > +105 > -105 > -110 > -130).
 *
 * @returns {'same'|'better'|'worse'|'invalid'}
 */
function compareAmericanOddsForBettor(submitted, server) {
  var a = Number(submitted);
  var b = Number(server);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0 || b === 0) {
    return 'invalid';
  }
  if (a === b) return 'same';
  return b > a ? 'better' : 'worse';
}

/**
 * Decide whether a price change may auto-continue under policy.
 * Line / market identity changes are NOT handled here — caller must
 * reject those before calling this.
 *
 * @returns {{ action:'continue'|'confirm'|'reject', comparison:string, policy:string }}
 */
function resolveOddsChangeAction(policy, submittedOdds, serverOdds) {
  var normalized = normalizeOddsChangePolicy(policy);
  var comparison = compareAmericanOddsForBettor(submittedOdds, serverOdds);
  if (comparison === 'invalid') {
    return { action: 'reject', comparison: comparison, policy: normalized };
  }
  if (comparison === 'same') {
    return { action: 'continue', comparison: comparison, policy: normalized };
  }
  if (normalized === POLICY_ACCEPT_ALL) {
    return { action: 'continue', comparison: comparison, policy: normalized };
  }
  if (normalized === POLICY_ACCEPT_BETTER) {
    return {
      action: comparison === 'better' ? 'continue' : 'confirm',
      comparison: comparison,
      policy: normalized
    };
  }
  // ask (default)
  return { action: 'confirm', comparison: comparison, policy: normalized };
}

/**
 * Build a structured odds_changed (or related) rejection payload.
 */
function buildOddsChangedPayload(opts) {
  opts = opts || {};
  return {
    ok: false,
    code: 'odds_changed',
    leg: opts.leg,
    legIndex: opts.legIndex,
    submittedOdds: opts.submittedOdds,
    serverOdds: opts.serverOdds,
    comparison: opts.comparison || null,
    policy: opts.policy || POLICY_ASK,
    reason: opts.reason || 'confirmation_required',
    userMessage: opts.userMessage || 'Odds changed — please review and confirm.',
    requiresConfirmation: true
  };
}

/**
 * Build a structured line_changed rejection — always requires confirmation
 * regardless of odds policy.
 */
function buildLineChangedPayload(opts) {
  opts = opts || {};
  return {
    ok: false,
    code: 'line_changed',
    leg: opts.leg,
    legIndex: opts.legIndex,
    submittedPointLine: opts.submittedPointLine != null ? opts.submittedPointLine : null,
    serverPointLine: opts.serverPointLine != null ? opts.serverPointLine : null,
    submittedOdds: opts.submittedOdds,
    serverOdds: opts.serverOdds,
    reason: opts.reason || 'exact_line_required',
    userMessage: opts.userMessage || 'Line changed — please review and confirm.',
    requiresConfirmation: true
  };
}

module.exports = {
  POLICY_ASK: POLICY_ASK,
  POLICY_ACCEPT_BETTER: POLICY_ACCEPT_BETTER,
  POLICY_ACCEPT_ALL: POLICY_ACCEPT_ALL,
  normalizeOddsChangePolicy: normalizeOddsChangePolicy,
  compareAmericanOddsForBettor: compareAmericanOddsForBettor,
  resolveOddsChangeAction: resolveOddsChangeAction,
  buildOddsChangedPayload: buildOddsChangedPayload,
  buildLineChangedPayload: buildLineChangedPayload
};
