'use strict';
/**
 * In-memory simulator of PROPOSED_cancel_bet_tx_club_isolation.sql
 * Mirrors hard club lock + no phantom1000. Used when local Postgres is unavailable.
 * Does NOT change cancel economics: refund = risk_amount.
 */

function rnd(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function createStore(seed) {
  return {
    club_members: (seed && seed.club_members) ? seed.club_members.slice() : [],
    tickets: (seed && seed.tickets) ? seed.tickets.map(function(t){ return Object.assign({}, t); }) : [],
    ledger_entries: (seed && seed.ledger_entries) ? seed.ledger_entries.map(function(e){ return Object.assign({}, e); }) : []
  };
}

/**
 * @param {object} store
 * @param {{ticketId,clubId,playerId,idempotencyKey,reason,createdBy}} p
 */
function cancelBetTx(store, p) {
  var p_ticket_id = p.ticketId;
  var p_club_id = p.clubId;
  var p_player_id = p.playerId;
  var p_idempotency_key = p.idempotencyKey;
  var p_reason = p.reason || 'player_request';
  var p_created_by = p.createdBy || p_player_id;

  if (!p_ticket_id) return { ok: false, error: 'missing_ticket_id' };
  if (!p_club_id) return { ok: false, error: 'missing_club_id' };
  if (!p_player_id) return { ok: false, error: 'missing_player_id' };
  if (!p_idempotency_key) return { ok: false, error: 'missing_idempotency_key' };

  var existing = store.ledger_entries.find(function(e){ return e.id === p_idempotency_key; });
  if (existing) {
    if (existing.ticket_id === p_ticket_id && existing.player_id === p_player_id &&
        (existing.club_id == null || existing.club_id === p_club_id) &&
        existing.type === 'bet_canceled') {
      return {
        ok: true, idempotent: true, ticket_id: existing.ticket_id, status: 'canceled',
        refund: existing.amount, ledger_entry_id: existing.id,
        balance_after: existing.balance_after, replay_of: existing.id
      };
    }
    return {
      ok: false, error: 'idempotency_key_conflict',
      ledger_entry_id: existing.id, ticket_id: existing.ticket_id,
      existing_type: existing.type, requested_type: 'bet_canceled'
    };
  }

  var ticket = store.tickets.find(function(t){ return t.id === p_ticket_id; });
  if (!ticket) return { ok: false, error: 'ticket_not_found', ticket_id: p_ticket_id };

  var prev = String(ticket.status || '').toLowerCase();
  if (ticket.player_id !== p_player_id) {
    return { ok: false, error: 'ticket_player_mismatch', ticket_id: p_ticket_id };
  }
  if (ticket.club_id == null || ticket.club_id !== p_club_id) {
    return {
      ok: false, error: 'ticket_club_mismatch', ticket_id: p_ticket_id,
      ticket_club_id: ticket.club_id, requested_club_id: p_club_id
    };
  }
  if (prev !== 'active' && prev !== 'open') {
    return { ok: false, error: 'invalid_transition', ticket_id: p_ticket_id, status: ticket.status };
  }

  var refund = rnd(ticket.risk_amount);
  if (refund < 0) {
    return { ok: false, error: 'invalid_risk_amount', ticket_id: p_ticket_id, risk_amount: ticket.risk_amount };
  }

  var member = store.club_members.find(function(m){
    return m.player_id === p_player_id && m.club_id === p_club_id;
  });
  if (!member || member.balance_start == null) {
    return {
      ok: false,
      error: 'no_club_member_balance_found',
      code: 'no_club_member_balance_found',
      hint: 'No balance record found for this player at this club'
    };
  }

  var start = Number(member.balance_start);
  var openRisk = 0, gains = 0, losses = 0;
  store.tickets.forEach(function(t){
    if (t.player_id !== p_player_id || t.club_id !== p_club_id) return;
    var s = String(t.status || '').toLowerCase();
    if (s === 'active' || s === 'open') openRisk += Number(t.risk_amount) || 0;
    else if (s === 'won') gains += Number(t.potential_profit) || 0;
    else if (s === 'lost') losses += Number(t.risk_amount) || 0;
  });

  var balance_before = rnd(start - openRisk - losses + gains);
  var balance_after = rnd(balance_before + refund);

  store.ledger_entries.push({
    id: p_idempotency_key,
    club_id: p_club_id,
    player_id: p_player_id,
    ticket_id: p_ticket_id,
    type: 'bet_canceled',
    amount: refund,
    balance_before: balance_before,
    balance_after: balance_after,
    reason: 'cancel:' + p_reason,
    created_at: new Date().toISOString(),
    created_by: p_created_by
  });

  ticket.status = 'canceled';

  return {
    ok: true,
    idempotent: false,
    ticket_id: p_ticket_id,
    status: 'canceled',
    previous_status: prev,
    refund: refund,
    ledger_entry_id: p_idempotency_key,
    balance_before: balance_before,
    balance_after: balance_after
  };
}

/** Legacy phantom1000 path (for regression documentation only). */
function cancelBetTxLegacyPhantom(store, p) {
  var member = store.club_members.find(function(m){
    return m.player_id === p.playerId && (m.club_id == null || m.club_id === p.clubId);
  });
  var start = member && member.balance_start != null ? Number(member.balance_start) : 1000;
  if (!member) start = 1000; // PHANTOM1000
  return { phantomStart: start, usedPhantom: !member || member.balance_start == null };
}

module.exports = {
  createStore: createStore,
  cancelBetTx: cancelBetTx,
  cancelBetTxLegacyPhantom: cancelBetTxLegacyPhantom
};
