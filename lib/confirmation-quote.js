'use strict';

/**
 * Short-TTL server confirmation quotes for bet finalization.
 *
 * When live/prematch prices move under Ask Me (or Accept Better on a worse
 * tick), the server returns odds_changed with a signed quote binding the
 * authoritative market identity + price the player may confirm.
 *
 * A valid quote is the atomic commit point: subsequent place requests that
 * carry the quote commit that price without an unbound second provider
 * refresh re-opening the odds_changed loop. Identity, line, and market
 * availability checks remain mandatory.
 *
 * Quote is: server-minted, club/player scoped, per-leg event/market/
 * selection/line/price specific, short-lived, HMAC tamper-resistant,
 * and single-consumption (jti) after a successful money mutation.
 */

var crypto = require('crypto');

var DEFAULT_TTL_MS = 25 * 1000;
var MAX_TTL_MS = 60 * 1000;
var QUOTE_VERSION = 1;

/** @type {Map<string, number>} jti → expiresAtMs (consumed quotes) */
var _consumedJtis = new Map();

function _b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function _b64urlDecode(s) {
  var pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function _timingSafeEqualStr(a, b) {
  var ba = Buffer.from(String(a || ''), 'utf8');
  var bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function _pruneConsumed(nowMs) {
  if (_consumedJtis.size < 64) return;
  nowMs = nowMs || Date.now();
  _consumedJtis.forEach(function(exp, jti) {
    if (exp <= nowMs) _consumedJtis.delete(jti);
  });
}

function _normMarket(m) {
  return String(m || '').toLowerCase().trim();
}

function _normPick(p) {
  return String(p || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function _normKey(k) {
  return String(k || '').trim();
}

function _lineEqual(a, b) {
  if (a == null && b == null) return true;
  var na = Number(a);
  var nb = Number(b);
  if (!Number.isFinite(na) && !Number.isFinite(nb)) return true;
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return Math.abs(na - nb) < 0.000001;
}

function _oddsEqual(a, b) {
  var na = Number(a);
  var nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return na === nb;
}

/**
 * Build unsigned leg bindings from an odds_changed / line_changed reject payload.
 */
function legsFromConfirmReject(payoutResult) {
  var out = [];
  var src = (payoutResult && Array.isArray(payoutResult.confirmLegs) && payoutResult.confirmLegs.length)
    ? payoutResult.confirmLegs
    : (payoutResult && Array.isArray(payoutResult.legs) ? payoutResult.legs : null);
  if (!src || !src.length) {
    if (!payoutResult) return out;
    out.push({
      legIndex: typeof payoutResult.legIndex === 'number' ? payoutResult.legIndex : 0,
      pick: payoutResult.leg || payoutResult.pick || null,
      market: payoutResult.market || null,
      canonicalGameKey: payoutResult.canonicalGameKey || null,
      gameId: payoutResult.gameId || null,
      acceptedOdds: payoutResult.serverOdds != null ? Number(payoutResult.serverOdds) : null,
      acceptedPointLine: payoutResult.serverPointLine != null
        ? Number(payoutResult.serverPointLine)
        : (payoutResult.code === 'line_changed' ? null : undefined)
    });
    return out;
  }
  for (var i = 0; i < src.length; i++) {
    var c = src[i];
    out.push({
      legIndex: typeof c.legIndex === 'number' ? c.legIndex : i,
      pick: c.leg || c.pick || null,
      market: c.market || null,
      canonicalGameKey: c.canonicalGameKey || null,
      gameId: c.gameId || null,
      acceptedOdds: c.serverOdds != null ? Number(c.serverOdds) : null,
      acceptedPointLine: c.serverPointLine != null ? Number(c.serverPointLine) : null
    });
  }
  return out;
}

/**
 * Enrich quote legs with identity from the request legs array when reject
 * payloads omit market/game keys (common for single-leg odds_changed).
 */
function enrichLegsFromRequest(quoteLegs, requestLegs) {
  var legs = Array.isArray(quoteLegs) ? quoteLegs : [];
  var req = Array.isArray(requestLegs) ? requestLegs : [];
  return legs.map(function(ql) {
    var idx = typeof ql.legIndex === 'number' ? ql.legIndex : -1;
    var rl = idx >= 0 && idx < req.length ? req[idx] : null;
    if (!rl && ql.pick) {
      for (var i = 0; i < req.length; i++) {
        if (_normPick(req[i].pick) === _normPick(ql.pick)) { rl = req[i]; break; }
      }
    }
    return {
      legIndex: idx >= 0 ? idx : (rl ? req.indexOf(rl) : 0),
      pick: ql.pick || (rl && rl.pick) || null,
      market: ql.market || (rl && rl.market) || null,
      canonicalGameKey: ql.canonicalGameKey || (rl && rl.canonicalGameKey) || null,
      gameId: ql.gameId || (rl && (rl.gameId || rl.providerGameId)) || null,
      acceptedOdds: ql.acceptedOdds,
      acceptedPointLine: ql.acceptedPointLine != null
        ? ql.acceptedPointLine
        : (rl && rl.line != null ? Number(rl.line) : null)
    };
  });
}

/**
 * Mint a signed confirmation quote token.
 *
 * @returns {{ token:string, payload:object, expiresAt:number }|null}
 */
function mintConfirmationQuote(opts) {
  opts = opts || {};
  var secret = opts.secret;
  if (!secret) return null;
  var nowMs = opts.nowMs != null ? Number(opts.nowMs) : Date.now();
  var ttlMs = Math.min(MAX_TTL_MS, Math.max(5000, Number(opts.ttlMs) || DEFAULT_TTL_MS));
  var legs = Array.isArray(opts.legs) ? opts.legs : [];
  if (!opts.clubId || !opts.playerId || !legs.length) return null;

  var cleanLegs = [];
  for (var i = 0; i < legs.length; i++) {
    var L = legs[i] || {};
    var odds = Number(L.acceptedOdds);
    if (!Number.isFinite(odds) || odds === 0) return null;
    cleanLegs.push({
      legIndex: typeof L.legIndex === 'number' ? L.legIndex : i,
      pick: L.pick != null ? String(L.pick) : null,
      market: L.market != null ? _normMarket(L.market) : null,
      canonicalGameKey: L.canonicalGameKey != null ? String(L.canonicalGameKey) : null,
      gameId: L.gameId != null ? String(L.gameId) : null,
      acceptedOdds: odds,
      acceptedPointLine: L.acceptedPointLine != null && Number.isFinite(Number(L.acceptedPointLine))
        ? Number(L.acceptedPointLine)
        : null
    });
  }

  var payload = {
    v: QUOTE_VERSION,
    clubId: String(opts.clubId),
    playerId: String(opts.playerId),
    stake: Math.round(Number(opts.stake) * 100) / 100,
    legs: cleanLegs,
    iat: nowMs,
    exp: nowMs + ttlMs,
    jti: 'cq_' + nowMs.toString(36) + '_' + crypto.randomBytes(8).toString('hex')
  };

  var body = _b64url(JSON.stringify(payload));
  var sig = _b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return {
    token: body + '.' + sig,
    payload: payload,
    expiresAt: payload.exp
  };
}

/**
 * Verify a confirmation quote token against the place request context.
 *
 * @returns {{ ok:true, payload:object, legByIndex:Object }|{ ok:false, code:string, reason?:string }}
 */
function verifyConfirmationQuote(token, ctx) {
  ctx = ctx || {};
  var secret = ctx.secret;
  var nowMs = ctx.nowMs != null ? Number(ctx.nowMs) : Date.now();
  if (!token || typeof token !== 'string' || !secret) {
    return { ok: false, code: 'confirmation_quote_invalid', reason: 'missing' };
  }
  var parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, code: 'confirmation_quote_invalid', reason: 'malformed' };
  }
  var body = parts[0];
  var sig = parts[1];
  var expected = _b64url(crypto.createHmac('sha256', secret).update(body).digest());
  if (!_timingSafeEqualStr(sig, expected)) {
    return { ok: false, code: 'confirmation_quote_invalid', reason: 'bad_signature' };
  }

  var payload;
  try {
    payload = JSON.parse(_b64urlDecode(body).toString('utf8'));
  } catch (_e) {
    return { ok: false, code: 'confirmation_quote_invalid', reason: 'malformed_payload' };
  }
  if (!payload || payload.v !== QUOTE_VERSION) {
    return { ok: false, code: 'confirmation_quote_invalid', reason: 'version' };
  }
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= nowMs) {
    return { ok: false, code: 'confirmation_quote_expired', reason: 'expired' };
  }
  if (payload.jti && _consumedJtis.has(String(payload.jti))) {
    return { ok: false, code: 'confirmation_quote_consumed', reason: 'already_used' };
  }
  if (String(payload.clubId) !== String(ctx.clubId)) {
    return { ok: false, code: 'confirmation_quote_invalid', reason: 'club_mismatch' };
  }
  if (String(payload.playerId) !== String(ctx.playerId)) {
    return { ok: false, code: 'confirmation_quote_invalid', reason: 'player_mismatch' };
  }
  var stake = Number(ctx.stake);
  if (!Number.isFinite(stake) || Math.abs(Number(payload.stake) - stake) > 0.005) {
    return { ok: false, code: 'confirmation_quote_invalid', reason: 'stake_mismatch' };
  }

  var qLegs = Array.isArray(payload.legs) ? payload.legs : [];
  var rLegs = Array.isArray(ctx.legs) ? ctx.legs : [];
  if (!qLegs.length || qLegs.length > rLegs.length) {
    return { ok: false, code: 'confirmation_quote_invalid', reason: 'leg_count' };
  }

  var legByIndex = Object.create(null);
  for (var i = 0; i < qLegs.length; i++) {
    var ql = qLegs[i];
    var idx = typeof ql.legIndex === 'number' ? ql.legIndex : i;
    if (idx < 0 || idx >= rLegs.length) {
      return { ok: false, code: 'confirmation_quote_invalid', reason: 'leg_index' };
    }
    var rl = rLegs[idx];
    if (ql.pick != null && _normPick(ql.pick) !== _normPick(rl.pick)) {
      return { ok: false, code: 'confirmation_quote_invalid', reason: 'pick_mismatch' };
    }
    if (ql.market != null && _normMarket(ql.market) !== _normMarket(rl.market)) {
      return { ok: false, code: 'confirmation_quote_invalid', reason: 'market_mismatch' };
    }
    if (ql.canonicalGameKey != null && _normKey(ql.canonicalGameKey) &&
        _normKey(ql.canonicalGameKey) !== _normKey(rl.canonicalGameKey)) {
      // Allow either key to be a prefix/candidate of the other for Owls fill.
      var qk = _normKey(ql.canonicalGameKey);
      var rk = _normKey(rl.canonicalGameKey);
      if (qk !== rk && qk.indexOf(rk) !== 0 && rk.indexOf(qk) !== 0) {
        return { ok: false, code: 'confirmation_quote_invalid', reason: 'game_key_mismatch' };
      }
    }
    if (ql.gameId != null && rl.gameId != null && String(ql.gameId) !== String(rl.gameId)) {
      return { ok: false, code: 'confirmation_quote_invalid', reason: 'game_id_mismatch' };
    }
    if (!_oddsEqual(ql.acceptedOdds, rl.odds)) {
      return { ok: false, code: 'confirmation_quote_invalid', reason: 'odds_mismatch' };
    }
    if (ql.acceptedPointLine != null) {
      var submittedLine = rl.line != null ? Number(rl.line)
        : (rl.pointLine != null ? Number(rl.pointLine) : NaN);
      if (!_lineEqual(ql.acceptedPointLine, submittedLine)) {
        return { ok: false, code: 'confirmation_quote_invalid', reason: 'line_mismatch' };
      }
    }
    legByIndex[idx] = ql;
  }

  return { ok: true, payload: payload, legByIndex: legByIndex };
}

/**
 * Mark quote jti consumed after a successful money mutation.
 */
function consumeConfirmationQuote(payloadOrToken, opts) {
  opts = opts || {};
  var nowMs = opts.nowMs != null ? Number(opts.nowMs) : Date.now();
  _pruneConsumed(nowMs);
  var jti = null;
  var exp = nowMs + MAX_TTL_MS;
  if (payloadOrToken && typeof payloadOrToken === 'object' && payloadOrToken.jti) {
    jti = String(payloadOrToken.jti);
    if (Number.isFinite(Number(payloadOrToken.exp))) exp = Number(payloadOrToken.exp) + 60000;
  } else if (typeof payloadOrToken === 'string') {
    try {
      var body = payloadOrToken.split('.')[0];
      var p = JSON.parse(_b64urlDecode(body).toString('utf8'));
      jti = p && p.jti ? String(p.jti) : null;
      if (p && Number.isFinite(Number(p.exp))) exp = Number(p.exp) + 60000;
    } catch (_e) { /* ignore */ }
  }
  if (jti) _consumedJtis.set(jti, exp);
}

/** Test helper — clear consumed set. */
function _resetConsumedForTests() {
  _consumedJtis.clear();
}

/**
 * Resolve price action when a verified quote leg is present.
 * Returns 'commit_quote' when the submitted odds match the quoted price —
 * caller must still enforce market availability + line identity against live snap.
 */
function resolveQuotedPriceAction(quoteLeg, submittedOdds, serverOdds, policy) {
  if (!quoteLeg) return { action: 'no_quote' };
  if (!_oddsEqual(quoteLeg.acceptedOdds, submittedOdds)) {
    return { action: 'reject', reason: 'submitted_ne_quote' };
  }
  // Quoted price is the commit point. Provider may have ticked again.
  // Under accept_all / accept_better, still allow auto-continue on CURRENT
  // server price when policy says so (better / any) — but never require a
  // second confirm loop for the already-accepted quote price.
  var oddsChangePolicy = require('./odds-change-policy');
  var decision = oddsChangePolicy.resolveOddsChangeAction(policy, submittedOdds, serverOdds);
  if (decision.action === 'continue') {
    // Current provider price is acceptable under policy (same/better/all).
    return {
      action: 'continue_server',
      comparison: decision.comparison,
      acceptedOdds: Number(serverOdds),
      fromQuote: true
    };
  }
  // Ask Me (or Accept Better on worse): commit the quoted accepted price.
  return {
    action: 'commit_quote',
    comparison: decision.comparison,
    acceptedOdds: Number(quoteLeg.acceptedOdds),
    fromQuote: true
  };
}

function americanToDecimal(american) {
  var a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? (a / 100) + 1 : (100 / Math.abs(a)) + 1;
}

module.exports = {
  DEFAULT_TTL_MS: DEFAULT_TTL_MS,
  MAX_TTL_MS: MAX_TTL_MS,
  QUOTE_VERSION: QUOTE_VERSION,
  legsFromConfirmReject: legsFromConfirmReject,
  enrichLegsFromRequest: enrichLegsFromRequest,
  mintConfirmationQuote: mintConfirmationQuote,
  verifyConfirmationQuote: verifyConfirmationQuote,
  consumeConfirmationQuote: consumeConfirmationQuote,
  resolveQuotedPriceAction: resolveQuotedPriceAction,
  americanToDecimal: americanToDecimal,
  _resetConsumedForTests: _resetConsumedForTests,
  _oddsEqual: _oddsEqual,
  _lineEqual: _lineEqual
};
