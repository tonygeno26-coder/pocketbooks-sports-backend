'use strict';

// Historical regression tests for the GRD-2/RR containment block.
//
// NOTE (Phase 3): The rr_temporarily_disabled containment block was removed
// from index.js in Phase 3.  Round Robin placements now flow through the full
// placement path (place_rr_tx RPC).  These tests document the ordering
// properties that held during containment and use a self-contained harness —
// they do NOT import index.js, so they remain green regardless of the live code.
//
// Kept as historical documentation of the Phase 1 guard ordering contract.
//
// Original test coverage:
//   1. RoundRobin → rejects with rr_temporarily_disabled
//   2. Single     → passes the RR gate, reaches normal validation path
//   3. Parlay     → passes the RR gate, reaches normal validation path
//   4. Teaser     → passes the RR gate, reaches normal validation path
//   5. HAB charge does NOT fire for RoundRobin rejection
//   6. Snapshot verification does NOT fire for RoundRobin rejection
//   7. RPC (ticket insert) does NOT fire for RoundRobin rejection

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
    pass++;
  } catch (e) {
    console.error('  FAIL ' + name + '\n     ' + e.message);
    fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'expected true');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      (msg || 'values differ') +
      ' — got ' + JSON.stringify(actual) +
      ' expected ' + JSON.stringify(expected)
    );
  }
}

// ---------------------------------------------------------------------------
// Minimal harness that mirrors the route handler's gate ordering:
//   1. Basic param validation (errors array)
//   2. RR containment guard              ← new, must fire here
//   3. HAB charge
//   4. Snapshot verification
//   5. RPC (ticket + ledger insert)
// ---------------------------------------------------------------------------
function makePlaceHarness() {
  const state = {
    habCharges:       0,
    snapshotChecks:   0,
    rpcCalls:         0
  };

  function placeBet(opts) {
    opts = opts || {};
    const betType = opts.betType || 'Single';
    const stake   = opts.stake   || 10;
    const legs    = opts.legs    || [{ pick:'Home', market:'moneyline',
                                       canonicalGameKey:'test|A|B|2026-05-30',
                                       odds:-110, scheduledStart:'2026-05-30T18:00:00Z' }];

    // --- 1. Basic param validation ---
    if (!betType || !stake || !legs.length) {
      return { ok:false, errors:['validation_error'] };
    }

    // --- 2. RR containment guard (mirrors index.js guard) ---
    if (betType === 'RoundRobin') {
      return {
        ok:      false,
        error:   'rr_temporarily_disabled',
        code:    'rr_temporarily_disabled',
        message: 'Round Robin betting is temporarily disabled while combo settlement is being upgraded.'
      };
    }

    // --- 3. HAB charge ---
    state.habCharges++;

    // --- 4. Snapshot verification ---
    state.snapshotChecks++;
    if (opts.snapshotOk === false) {
      return { ok:false, error: opts.snapshotCode || 'odds_service_unavailable' };
    }

    // --- 5. RPC (ticket + ledger insert) ---
    state.rpcCalls++;
    return { ok:true, ticketId:'T_TEST', betType };
  }

  return { state, placeBet };
}

console.log('\n-- RR placement containment --');

// 1. RoundRobin is rejected
test('RoundRobin placement returns rr_temporarily_disabled', function() {
  const h = makePlaceHarness();
  const r = h.placeBet({ betType:'RoundRobin' });
  assert(!r.ok, 'expected rejection');
  assertEq(r.error,   'rr_temporarily_disabled', 'error field');
  assertEq(r.code,    'rr_temporarily_disabled', 'code field');
  assert(typeof r.message === 'string' && r.message.length > 0, 'message should be non-empty string');
});

// 2. HAB does NOT fire for RR rejection
test('HAB charge does not fire on RoundRobin rejection', function() {
  const h = makePlaceHarness();
  h.placeBet({ betType:'RoundRobin' });
  assertEq(h.state.habCharges, 0, 'HAB charge count after RR rejection');
});

// 3. Snapshot check does NOT fire for RR rejection
test('Snapshot verification does not fire on RoundRobin rejection', function() {
  const h = makePlaceHarness();
  h.placeBet({ betType:'RoundRobin' });
  assertEq(h.state.snapshotChecks, 0, 'snapshot check count after RR rejection');
});

// 4. RPC does NOT fire for RR rejection
test('RPC (ticket insert) does not fire on RoundRobin rejection', function() {
  const h = makePlaceHarness();
  h.placeBet({ betType:'RoundRobin' });
  assertEq(h.state.rpcCalls, 0, 'RPC call count after RR rejection');
});

// 5. Single passes the RR gate and reaches placement
test('Single passes RR gate and reaches placement path', function() {
  const h = makePlaceHarness();
  const r = h.placeBet({ betType:'Single' });
  assert(r.ok, 'Single should succeed: ' + JSON.stringify(r));
  assertEq(h.state.habCharges,     1, 'HAB charge count for Single');
  assertEq(h.state.snapshotChecks, 1, 'snapshot check count for Single');
  assertEq(h.state.rpcCalls,       1, 'RPC call count for Single');
});

// 6. Parlay passes the RR gate and reaches placement
test('Parlay passes RR gate and reaches placement path', function() {
  const h = makePlaceHarness();
  const r = h.placeBet({ betType:'Parlay' });
  assert(r.ok, 'Parlay should succeed: ' + JSON.stringify(r));
  assertEq(h.state.habCharges,     1, 'HAB charge count for Parlay');
  assertEq(h.state.snapshotChecks, 1, 'snapshot check count for Parlay');
  assertEq(h.state.rpcCalls,       1, 'RPC call count for Parlay');
});

// 7. Teaser passes the RR gate and reaches placement
test('Teaser passes RR gate and reaches placement path', function() {
  const h = makePlaceHarness();
  const r = h.placeBet({ betType:'Teaser' });
  assert(r.ok, 'Teaser should succeed: ' + JSON.stringify(r));
  assertEq(h.state.habCharges,     1, 'HAB charge count for Teaser');
  assertEq(h.state.snapshotChecks, 1, 'snapshot check count for Teaser');
  assertEq(h.state.rpcCalls,       1, 'RPC call count for Teaser');
});

// 8. Multiple RR attempts: all rejected, HAB never fires
test('Multiple RoundRobin attempts all rejected with zero HAB charges', function() {
  const h = makePlaceHarness();
  const r1 = h.placeBet({ betType:'RoundRobin' });
  const r2 = h.placeBet({ betType:'RoundRobin' });
  const r3 = h.placeBet({ betType:'RoundRobin' });
  assert(!r1.ok && !r2.ok && !r3.ok, 'all three should be rejected');
  assertEq(h.state.habCharges, 0, 'HAB charge count after 3 RR rejections');
  assertEq(h.state.rpcCalls,   0, 'RPC call count after 3 RR rejections');
});

// 9. Mixed: RR rejected, then Single succeeds in same session
test('RR rejection followed by Single placement succeeds correctly', function() {
  const h = makePlaceHarness();
  const rr = h.placeBet({ betType:'RoundRobin' });
  const sg = h.placeBet({ betType:'Single' });
  assert(!rr.ok, 'RR should be rejected');
  assert(sg.ok,  'Single should succeed after prior RR rejection');
  assertEq(h.state.habCharges, 1,     'only the Single charges HAB');
  assertEq(h.state.rpcCalls,   1,     'only the Single calls RPC');
});

// 10. Snapshot failure on Single still does not affect RR guard logic
test('Single with snapshot failure does not interfere with RR gate', function() {
  const h = makePlaceHarness();
  const sg = h.placeBet({ betType:'Single', snapshotOk:false, snapshotCode:'odds_changed' });
  const rr = h.placeBet({ betType:'RoundRobin' });
  assert(!sg.ok, 'Single with bad snapshot should fail');
  assertEq(sg.error, 'odds_changed', 'single error');
  assert(!rr.ok, 'RR should still be rejected');
  assertEq(rr.code, 'rr_temporarily_disabled', 'rr code');
  // Single hits HAB (before snapshot check in harness); RR does not
  assertEq(h.state.habCharges,     1, 'HAB fires once (for Single)');
  assertEq(h.state.snapshotChecks, 1, 'snapshot checked once (for Single)');
  assertEq(h.state.rpcCalls,       0, 'RPC not called (Single failed at snapshot)');
});

console.log('\nRR placement containment tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
