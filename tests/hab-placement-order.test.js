'use strict';

let _pass = 0;
let _fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
    _pass++;
  } catch (e) {
    console.error('  FAIL ' + name + '\n     ' + e.message);
    _fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'expected true');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'values differ') +
      ' — got ' + JSON.stringify(actual) + ' expected ' + JSON.stringify(expected));
  }
}

function makeHarness() {
  const state = {
    habCharges: 0,
    completedKeys: new Set()
  };

  function processHab() {
    state.habCharges++;
    return { ok:true, charged:true };
  }

  function placeBet(opts) {
    opts = opts || {};

    // Idempotency middleware replay happens before the handler body can mutate.
    if (state.completedKeys.has(opts.idempotencyKey)) {
      return { ok:true, idempotent:true, replayed:true };
    }

    if (opts.balanceOk === false) return { ok:false, error:'insufficient_balance' };
    if (opts.snapshotOk === false) return { ok:false, error:opts.snapshotCode || 'odds_service_unavailable' };
    if (opts.riskOk === false) return { ok:false, error:'risk_rejected' };
    if (opts.conflict === true) return { ok:false, error:'conflict_active_bet' };
    if (opts.rpcOk === false) return { ok:false, error:'placement_failed' };
    if (opts.legsOk === false) return { ok:false, error:'ticket_legs_insert_failed' };

    const hab = processHab();
    if (!hab.ok) return { ok:false, error:'active_bettor_charge_failed' };

    state.completedKeys.add(opts.idempotencyKey);
    return { ok:true, ticketId:'T_TEST' };
  }

  return { state, placeBet };
}

console.log('\n-- HAB placement ordering --');

test('odds_changed rejection does not charge active-bettor fee', function() {
  const h = makeHarness();
  const r = h.placeBet({ idempotencyKey:'K1', snapshotOk:false, snapshotCode:'odds_changed' });
  assert(!r.ok, 'placement should reject');
  assertEq(r.error, 'odds_changed');
  assertEq(h.state.habCharges, 0, 'HAB charge count');
});

test('stale snapshot rejection does not charge active-bettor fee', function() {
  const h = makeHarness();
  const r = h.placeBet({ idempotencyKey:'K1', snapshotOk:false, snapshotCode:'odds_stale' });
  assert(!r.ok, 'placement should reject');
  assertEq(r.error, 'odds_stale');
  assertEq(h.state.habCharges, 0, 'HAB charge count');
});

test('successful first bet charges active-bettor fee once', function() {
  const h = makeHarness();
  const r = h.placeBet({ idempotencyKey:'K1' });
  assert(r.ok, 'placement should succeed');
  assertEq(h.state.habCharges, 1, 'HAB charge count');
});

test('idempotent duplicate placement does not charge active-bettor fee twice', function() {
  const h = makeHarness();
  const r1 = h.placeBet({ idempotencyKey:'K1' });
  const r2 = h.placeBet({ idempotencyKey:'K1' });
  assert(r1.ok, 'first placement should succeed');
  assert(r2.ok && r2.idempotent, 'second placement should replay');
  assertEq(h.state.habCharges, 1, 'HAB charge count');
});

test('risk rejection does not charge active-bettor fee', function() {
  const h = makeHarness();
  const r = h.placeBet({ idempotencyKey:'K1', riskOk:false });
  assert(!r.ok, 'placement should reject');
  assertEq(h.state.habCharges, 0, 'HAB charge count');
});

test('conflict rejection does not charge active-bettor fee', function() {
  const h = makeHarness();
  const r = h.placeBet({ idempotencyKey:'K1', conflict:true });
  assert(!r.ok, 'placement should reject');
  assertEq(h.state.habCharges, 0, 'HAB charge count');
});

console.log('\nHAB placement ordering tests: ' + _pass + ' passed, ' + _fail + ' failed');
if (_fail > 0) process.exit(1);
