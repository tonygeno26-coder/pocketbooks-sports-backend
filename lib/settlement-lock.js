'use strict';
/**
 * Deterministic settlement advisory-lock key material (club_id + player_id).
 * Mirrors SQL in migrations/PROPOSED_settle_payment_option_a_tx.sql
 * (md5 → two int4 keys for pg_advisory_xact_lock(k1, k2)).
 *
 * Scope: NOT global. Different players concurrent; same player @ different clubs independent.
 */

const crypto = require('crypto');

const SETTLEMENT_LOCK_NAMESPACE = 'settle_v1';
/** Default lock_timeout for settle txn (ms). Failed acquire → no payment row. */
const DEFAULT_LOCK_TIMEOUT_MS = 3000;

/**
 * Hex md5 of namespaced club|player — same string SQL uses.
 */
function settlementLockDigest(clubId, playerId) {
  var payload =
    SETTLEMENT_LOCK_NAMESPACE +
    '|' +
    String(clubId == null ? '' : clubId) +
    '|' +
    String(playerId == null ? '' : playerId);
  return crypto.createHash('md5').update(payload, 'utf8').digest('hex');
}

/**
 * Two signed int32 keys for pg_advisory_xact_lock(key1, key2).
 * Uses first / second 8 hex chars of md5 (same as SQL bit(32)::int).
 */
function settlementLockKeys(clubId, playerId) {
  var h = settlementLockDigest(clubId, playerId);
  return {
    key1: hex8ToInt32(h.slice(0, 8)),
    key2: hex8ToInt32(h.slice(8, 16)),
    digest: h,
    namespace: SETTLEMENT_LOCK_NAMESPACE,
    scope: 'club_id+player_id'
  };
}

function hex8ToInt32(hex8) {
  var u = parseInt(hex8, 16);
  // Match PostgreSQL bit(32)::int signed interpretation
  if (u >= 0x80000000) return u - 0x100000000;
  return u;
}

function lockTimeoutMs(envMs) {
  var n = parseInt(envMs != null ? envMs : process.env.SETTLEMENT_LOCK_TIMEOUT_MS, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOCK_TIMEOUT_MS;
  return Math.min(n, 30000);
}

module.exports = {
  SETTLEMENT_LOCK_NAMESPACE: SETTLEMENT_LOCK_NAMESPACE,
  DEFAULT_LOCK_TIMEOUT_MS: DEFAULT_LOCK_TIMEOUT_MS,
  settlementLockDigest: settlementLockDigest,
  settlementLockKeys: settlementLockKeys,
  hex8ToInt32: hex8ToInt32,
  lockTimeoutMs: lockTimeoutMs
};
