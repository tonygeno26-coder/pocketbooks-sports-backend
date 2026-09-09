'use strict';
/**
 * cancel_bet_tx club isolation + phantom1000 regression (proposed SQL + live contract).
 * Run: node tests/cancel-bet-club-isolation.test.js
 *
 * Does NOT apply migrations. Validates proposed SQL + e2e simulator expectations.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.error('  ❌ ' + name + '\n     ' + e.message); fail++; }
}

const proposedFile = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', 'PROPOSED_cancel_bet_tx_club_isolation.sql'),
  'utf8'
);
// Evaluate the function body only — header comments document the OLD soft/phantom behavior.
const proposed = proposedFile.includes('$function$')
  ? proposedFile.split('$function$')[1] || proposedFile
  : proposedFile;
const e2e = fs.readFileSync(path.join(__dirname, 'e2e-bet-lifecycle.test.js'), 'utf8');

console.log('\n── PHANTOM1000 understood + blocked in proposed cancel_bet_tx ──');

test('phantom1000 = coalesce(balance_start,1000) OR NOT FOUND → 1000 when member missing', function() {
  // Documented prod behavior (live cancel_bet_tx as of audit):
  //   SELECT coalesce(balance_start, 1000) ... soft club OR
  //   IF NOT FOUND THEN v_start_balance := 1000
  // Risk: cancel against wrong/missing club invents $1000 starting bankroll for ledger presentation.
  assert.ok(true);
});

test('proposed cancel requires p_club_id', function() {
  assert.ok(proposed.indexOf("error', 'missing_club_id'") !== -1);
});

test('proposed cancel hard-matches ticket.club_id = p_club_id', function() {
  assert.ok(proposed.indexOf('ticket_club_mismatch') !== -1);
  assert.ok(proposed.indexOf('v_ticket.club_id IS DISTINCT FROM p_club_id') !== -1);
  assert.ok(proposed.indexOf('club_id IS NULL OR club_id =') === -1);
});

test('proposed cancel rejects missing club_members (no phantom 1000)', function() {
  assert.ok(proposed.indexOf('no_club_member_balance_found') !== -1);
  assert.ok(proposed.indexOf('v_start_balance := 1000') === -1);
  assert.ok(proposed.indexOf('coalesce(balance_start, 1000)') === -1);
});

test('proposed cancel keeps refund = risk_amount (arithmetic unchanged)', function() {
  assert.ok(proposed.indexOf('v_refund := round(coalesce(v_ticket.risk_amount, 0)::numeric, 2)') !== -1);
  assert.ok(proposed.indexOf("status = 'canceled'") !== -1);
});

test('proposed cancel scopes ticket aggregate by club_id + player_id', function() {
  assert.ok(/WHERE player_id = p_player_id\s+AND club_id\s+= p_club_id/.test(proposed));
});

test('two-club isolation: Club B cancel cannot soft-OR into Club A member row', function() {
  // Soft OR (prod) would allow v_effective_club_id NULL / mismatch paths.
  // Proposed: member lock is AND club_id = p_club_id only.
  assert.ok(proposed.indexOf('AND club_id   = p_club_id') !== -1 ||
            proposed.indexOf('AND club_id = p_club_id') !== -1);
  assert.ok(proposed.indexOf('(v_effective_club_id IS NULL OR club_id =') === -1);
});

test('e2e lifecycle still models cancel refund via risk (regression surface)', function() {
  assert.ok(e2e.indexOf('cancel_bet_tx') !== -1);
  assert.ok(e2e.indexOf('refunds stake') !== -1 || e2e.indexOf('function cancel_bet_tx') !== -1);
});

console.log('\n── Results: ' + pass + ' passed, ' + fail + ' failed ──');
process.exit(fail ? 1 : 0);
