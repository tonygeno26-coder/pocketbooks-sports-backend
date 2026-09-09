'use strict';
/**
 * Carried settlement / ledger position — pure helpers.
 *
 * Sign convention (player POV):
 *   negative = player owes host (outstanding)
 *   positive = host owes player (outstanding)
 *   zero     = settled / cleared
 *
 * Authoritative derivation (no parallel client math):
 *   carry = ticketSettledNet(after epoch)
 *         + Σ recorded player_paid_host
 *         − Σ recorded host_paid_player
 *
 * Host RECORDS an off-platform settlement toward zero only and must not cross zero.
 * PocketBooks does not move funds — recording updates ledger position only.
 * Betting/ticket nets may cross zero. Weekly rollover must NOT clear carry.
 */

function rnd(v) {
  return Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;
}

function sign(v) {
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
}

/**
 * Apply a recorded settlement toward zero (ledger math only).
 * Prefer reject (not silent cap) when amount would cross zero — matches API UX.
 *
 * @returns {{ ok:true, before:number, after:number, applied:number, direction:string }
 *          |{ ok:false, error:string, before:number, maxAmount:number, attempted:number }}
 */
function applyPartialSettlement(currentBalance, settlementAmount) {
  var before = rnd(currentBalance);
  var amt = rnd(parseFloat(settlementAmount));

  if (!Number.isFinite(amt) || amt <= 0) {
    return { ok: false, error: 'no_op_zero_or_blank', before: before, maxAmount: 0, attempted: amt };
  }
  if (Math.abs(before) < 0.005) {
    return { ok: false, error: 'balance_already_zero', before: before, maxAmount: 0, attempted: amt };
  }

  var maxAmount = rnd(Math.abs(before));
  if (amt > maxAmount + 0.01) {
    return {
      ok: false,
      error: 'over_settlement_blocked',
      before: before,
      maxAmount: maxAmount,
      attempted: amt,
      message: 'Recorded settlement cannot cross zero. Max amount settled is $' + maxAmount.toFixed(2)
    };
  }

  var applied = Math.min(amt, maxAmount);
  var after = rnd(sign(before) * Math.max(Math.abs(before) - applied, 0));
  if (Math.abs(after) < 0.005) after = 0;
  // Direction encodes which off-platform transfer is being recorded.
  var direction = before < 0 ? 'player_paid_host' : 'host_paid_player';

  return {
    ok: true,
    before: before,
    after: after,
    applied: rnd(applied),
    direction: direction,
    maxAmount: maxAmount
  };
}

/**
 * Derive carried ledger position from opening + ticket nets + confirmed settlement records.
 * @param {number} ticketSettledNet  player POV (+ host owes / − player owes)
 * @param {number} playerPaidHost    confirmed recorded amount settled player→host after epoch
 * @param {number} hostPaidPlayer    confirmed recorded amount settled host→player after epoch
 * @param {number} [openingBalance]  explicit bootstrap opening (default 0; not lifetime)
 */
function deriveSettlementCarry(ticketSettledNet, playerPaidHost, hostPaidPlayer, openingBalance) {
  return rnd(
    rnd(openingBalance || 0) +
    rnd(ticketSettledNet) +
    rnd(playerPaidHost || 0) -
    rnd(hostPaidPlayer || 0)
  );
}

/**
 * Map signed carry → owesHost / hostOwes display fields.
 */
function splitOwes(carry) {
  var c = rnd(carry);
  if (c < -0.005) return { owesHost: rnd(Math.abs(c)), hostOwes: 0, settlementBalance: c };
  if (c > 0.005) return { owesHost: 0, hostOwes: rnd(c), settlementBalance: c };
  return { owesHost: 0, hostOwes: 0, settlementBalance: 0 };
}

/**
 * Week-to-week carry (betting may cross zero):
 * next = priorCarried + newWeekNet
 */
function carryIntoNextWeek(priorCarriedBalance, newWeekNet) {
  return rnd(rnd(priorCarriedBalance) + rnd(newWeekNet));
}

/**
 * True when a ledger_entries row is a historical weekly epoch marker
 * (used so unpaid weeks cleared by past rollovers are not resurrected).
 * New rollovers must NOT write these; new recorded settlements must NOT advance epoch.
 */
function isHistoricalEpochMarker(row) {
  if (!row) return false;
  var t = String(row.type || '');
  if (t === 'weekly_rollover' || t === 'WEEKLY_ROLLOVER') return true;
  if (t === 'SETTLEMENT_APPLIED' || t === 'settlement_applied') {
    var id = String(row.id || '');
    var reason = String(row.reason || '');
    // Rollover-written markers only — settlement records must NOT advance ticket epoch
    if (id.indexOf('SETTLEMENT_APPLIED_') === 0) return true;
    if (reason.indexOf('weekly_rollover:') === 0) return true;
  }
  return false;
}

module.exports = {
  rnd: rnd,
  sign: sign,
  applyPartialSettlement: applyPartialSettlement,
  deriveSettlementCarry: deriveSettlementCarry,
  splitOwes: splitOwes,
  carryIntoNextWeek: carryIntoNextWeek,
  isHistoricalEpochMarker: isHistoricalEpochMarker
};
