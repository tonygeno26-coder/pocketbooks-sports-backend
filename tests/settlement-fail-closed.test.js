'use strict';

// Fail-closed defaults + grading/settlement decoupling.
// Ticket grading (grade_ticket_tx / bankroll) is independent of host↔player
// settlement recording. Missing env must not arm either path.

var fs = require('fs');
var path = require('path');

var pass = 0;
var fail = 0;

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

var src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

console.log('\n-- grading / settlement decoupling (fail-closed) --');

test('ticket grading flags default OFF when env is absent', function() {
  assert(src.indexOf("['TICKET_GRADING_ENABLED', 'GRADING_SETTLEMENT_ENABLED'], false)") !== -1,
    'TICKET_GRADING_ENABLED must default false (with legacy alias)');
  assert(src.indexOf("['WORKER_TICKET_GRADING_ENABLED', 'WORKER_GRADE_SETTLEMENT_ENABLED'], false)") !== -1,
    'WORKER_TICKET_GRADING_ENABLED must default false');
  assert(src.indexOf("['MANUAL_TICKET_GRADING_ENABLED', 'MANUAL_GRADE_SETTLEMENT_ENABLED'], false)") !== -1,
    'MANUAL_TICKET_GRADING_ENABLED must default false');
  assert(src.indexOf("_envFlag('GRADE_RUN_DRY_RUN_ENABLED', true)") !== -1,
    'grade/run must default to dry-run when ticket grading is off');
  assert(src.indexOf('const _GRADING_DEFAULT_ON = process.env.NODE_ENV === \'production\'') === -1,
    'production default-on grading helper must remain removed');
});

test('host settlement recording defaults OFF and is independent', function() {
  assert(src.indexOf("_envFlag('HOST_SETTLEMENT_RECORDING_ENABLED', false)") !== -1,
    'HOST_SETTLEMENT_RECORDING_ENABLED must default false');
  assert(src.indexOf('host_settlement_recording_disabled') !== -1,
    'host settlement writes must refuse with a dedicated error');
  assert(src.indexOf('if (!HOST_SETTLEMENT_RECORDING_ENABLED) return _hostSettlementRecordingBlocked(res);') !== -1,
    'settle-player / settlement write routes must gate on HOST_SETTLEMENT_RECORDING_ENABLED');
});

test('worker skips grade_ticket_tx when ticket grading flags are off', function() {
  var gate = src.indexOf('if (!TICKET_GRADING_ENABLED || !WORKER_TICKET_GRADING_ENABLED)');
  var rpc = src.indexOf("const gr = await _callMoneyRpc('grade_ticket_tx'");
  assert(gate !== -1, 'worker ticket-grading gate missing');
  assert(rpc !== -1, 'worker grade_ticket_tx call missing');
  assert(gate < rpc, 'ticket-grading gate must run before grade_ticket_tx');
  assert(src.indexOf("bumpSkip('ticket_grading_blocked')") !== -1,
    'blocked grades must skip without writing');
});

test('manual grade and grade/run cannot write when ticket grading is off', function() {
  assert(src.indexOf('ticket_grading_disabled') !== -1,
    'manual grade must refuse when ticket grading is disabled');
  assert(src.indexOf('if (!TICKET_GRADING_ENABLED)') !== -1,
    'grade/run must check ticket grading before writing');
  assert(src.indexOf('ticketGradingDisabled:!TICKET_GRADING_ENABLED') !== -1 ||
    src.indexOf('settlementDisabled:!TICKET_GRADING_ENABLED') !== -1,
    'grade/run response must report ticket grading disabled');
});

test('health reports ticket grading and host settlement separately', function() {
  assert(src.indexOf('ticketGradingEnabled: !!TICKET_GRADING_ENABLED') !== -1,
    'health must report ticketGradingEnabled');
  assert(src.indexOf('workerTicketGradingEnabled: !!WORKER_TICKET_GRADING_ENABLED') !== -1,
    'health must report workerTicketGradingEnabled');
  assert(src.indexOf('hostSettlementRecordingEnabled: !!HOST_SETTLEMENT_RECORDING_ENABLED') !== -1,
    'health must report hostSettlementRecordingEnabled');
});

test('worker gate does not reference host settlement recording', function() {
  var gate = src.indexOf('if (!TICKET_GRADING_ENABLED || !WORKER_TICKET_GRADING_ENABLED)');
  assert(gate !== -1, 'ticket grading gate missing');
  var around = src.slice(gate, gate + 280);
  assert(around.indexOf('HOST_SETTLEMENT_RECORDING_ENABLED') === -1,
    'worker grade path must not require HOST_SETTLEMENT_RECORDING_ENABLED');
});

console.log('\nSettlement fail-closed / decoupling tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
