'use strict';

/**
 * Active-bet duplicate identity for SINGLE (and per-leg) placement gates.
 *
 * Exact duplicate = same event + market + selection + line.
 * Distinct markets on the same game do NOT conflict.
 * Opposite sides of the same market (e.g. Royals ML vs Astros ML) do NOT
 * conflict here — that is not "exact duplicate" protection.
 *
 * Parlay same-game correlation remains separate (parlay-correlation.js).
 * Idempotency (same client key) remains separate (idempotency-engine).
 */

function _normPart(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
}

function _normLine(v) {
  if (v == null || v === '') return '';
  var n = Number(v);
  if (!isFinite(n)) return _normPart(v);
  // Normalize -0 / 1.50 → stable string without trailing noise
  return String(n);
}

function _selectionPart(leg) {
  if (!leg || typeof leg !== 'object') return '';
  return _normPart(
    leg.canonicalSelectionKey ||
    leg.canonical_selection_key ||
    leg.side ||
    leg.pick ||
    ''
  );
}

function _marketPart(leg) {
  if (!leg || typeof leg !== 'object') return '';
  return _normPart(leg.market || leg.market_type || '');
}

function _gameKeyPart(leg) {
  if (!leg || typeof leg !== 'object') return '';
  return String(leg.canonicalGameKey || leg.canonical_game_key || '').trim();
}

function _linePart(leg) {
  if (!leg || typeof leg !== 'object') return '';
  var raw = leg.acceptedPointLine != null ? leg.acceptedPointLine
    : (leg.accepted_point_line != null ? leg.accepted_point_line
      : (leg.line != null ? leg.line : ''));
  return _normLine(raw);
}

/**
 * Build exact-duplicate token for an incoming place leg or a stored ticket_leg.
 * Returns null when identity is incomplete (fail-open for that leg — placement
 * still has snapshot/idempotency gates).
 */
function activeBetDuplicateToken(leg) {
  var gKey = _gameKeyPart(leg);
  var market = _marketPart(leg);
  var sel = _selectionPart(leg);
  if (!gKey || !market || !sel) return null;
  return gKey + '|' + market + '|' + sel + '|' + _linePart(leg);
}

/**
 * True when newLeg conflicts with an existing active leg under exact-duplicate rules.
 */
function isExactActiveBetDuplicate(newLeg, existingLeg) {
  var a = activeBetDuplicateToken(newLeg);
  var b = activeBetDuplicateToken(existingLeg);
  return !!(a && b && a === b);
}

module.exports = {
  activeBetDuplicateToken: activeBetDuplicateToken,
  isExactActiveBetDuplicate: isExactActiveBetDuplicate,
  _normPart: _normPart,
  _normLine: _normLine
};
