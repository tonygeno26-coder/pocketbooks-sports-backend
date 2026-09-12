'use strict';

const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', 'PROPOSED_cancel_bet_tx_club_isolation.sql'),
  'utf8'
);
const functionBody = sql.slice(sql.indexOf('AS $function$'));

describe('deployed cancel_bet_tx isolation contract', () => {
  test('requires ticket, club, player, and idempotency scopes', () => {
    expect(sql).toContain("error', 'missing_ticket_id'");
    expect(sql).toContain("error', 'missing_club_id'");
    expect(sql).toContain("error', 'missing_player_id'");
    expect(sql).toContain("error', 'missing_idempotency_key'");
  });

  test('rejects ticket player and club mismatches', () => {
    expect(sql).toContain('v_ticket.player_id IS DISTINCT FROM p_player_id');
    expect(sql).toContain("error', 'ticket_player_mismatch'");
    expect(sql).toContain('v_ticket.club_id IS DISTINCT FROM p_club_id');
    expect(sql).toContain("error', 'ticket_club_mismatch'");
  });

  test('hard-scopes membership and balance aggregation', () => {
    expect(sql).toMatch(
      /FROM club_members[\s\S]*WHERE player_id = p_player_id[\s\S]*AND club_id\s+= p_club_id/
    );
    expect(sql).toMatch(
      /FROM tickets[\s\S]*WHERE player_id = p_player_id[\s\S]*AND club_id\s+= p_club_id/
    );
  });

  test('hard-scopes the status update to ticket, club, and player', () => {
    expect(sql).toMatch(
      /UPDATE tickets[\s\S]*WHERE id = p_ticket_id[\s\S]*AND club_id = p_club_id[\s\S]*AND player_id = p_player_id/
    );
  });

  test('missing membership cannot invent a phantom balance', () => {
    expect(functionBody).toContain("error', 'no_club_member_balance_found'");
    expect(functionBody).not.toMatch(/coalesce\s*\(\s*balance_start\s*,\s*1000/i);
    expect(functionBody).not.toMatch(/v_start_balance\s*:=\s*1000/i);
  });

  test('already canceled tickets cannot receive another refund', () => {
    const alreadyAt = sql.indexOf("v_prev_status IN ('canceled', 'cancelled', 'voided')");
    const ledgerInsertAt = sql.indexOf('INSERT INTO ledger_entries');
    expect(alreadyAt).toBeGreaterThan(-1);
    expect(alreadyAt).toBeLessThan(ledgerInsertAt);
    expect(sql.slice(alreadyAt, ledgerInsertAt)).toContain("'refund', 0");
  });

  test('idempotent replay validates ticket, player, club, and type', () => {
    const replay = sql.slice(
      sql.indexOf('IF FOUND THEN'),
      sql.indexOf('-- Lock ticket by id')
    );
    expect(replay).toContain('v_existing_ledger.ticket_id = p_ticket_id');
    expect(replay).toContain('v_existing_ledger.player_id = p_player_id');
    expect(replay).toContain('v_existing_ledger.club_id = p_club_id');
    expect(replay).toContain("v_existing_ledger.type = 'bet_canceled'");
  });
});
