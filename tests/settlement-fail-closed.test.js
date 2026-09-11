'use strict';

// Fail-closed settlement default. Missing env must not arm settlement,
// and the worker must not call grade_ticket_tx when the flags are off.

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

console.log('\n-- settlement fail-closed --');

test('settlement flags default OFF when env is absent', function() {
  assert(src.indexOf("_envFlag('GRADING_SETTLEMENT_ENABLED', false)") !== -1,
    'GRADING_SETTLEMENT_ENABLED must default false');
  assert(src.indexOf("_envFlag('WORKER_GRADE_SETTLEMENT_ENABLED', false)") !== -1,
    'WORKER_GRADE_SETTLEMENT_ENABLED must default false');
  assert(src.indexOf("_envFlag('MANUAL_GRADE_SETTLEMENT_ENABLED', false)") !== -1,
    'MANUAL_GRADE_SETTLEMENT_ENABLED must default false');
  assert(src.indexOf("_envFlag('GRADE_RUN_DRY_RUN_ENABLED', true)") !== -1,
    'grade/run must default to dry-run so it cannot write when settlement is off');
  assert(src.indexOf("process.env.NODE_ENV === 'production'") === -1 ||
    src.indexOf('const _LIVE_BETTING_DEFAULT_ON = process.env.NODE_ENV === \'production\'') !== -1,
    'production NODE_ENV must not be the settlement default');
  assert(src.indexOf('const _GRADING_DEFAULT_ON = process.env.NODE_ENV === \'production\'') === -1,
    'production default-on settlement helper must be removed');
});

test('worker skips grade_ticket_tx when settlement flags are off', function() {
  var gate = src.indexOf('if (!GRADING_SETTLEMENT_ENABLED || !WORKER_GRADE_SETTLEMENT_ENABLED)');
  var rpc = src.indexOf("const gr = await _callMoneyRpc('grade_ticket_tx'");
  assert(gate !== -1, 'worker settlement gate missing');
  assert(rpc !== -1, 'worker grade_ticket_tx call missing');
  assert(gate < rpc, 'settlement gate must run before grade_ticket_tx');
  assert(src.indexOf("bumpSkip('settlement_blocked')") !== -1,
    'blocked grades must skip without writing');
});

test('manual grade and grade/run cannot write when settlement is off', function() {
  assert(src.indexOf('grading_settlement_disabled') !== -1,
    'manual grade must refuse when settlement is disabled');
  assert(src.indexOf("if (!GRADING_SETTLEMENT_ENABLED)") !== -1,
    'grade/run must check settlement before writing');
  assert(src.indexOf('settlementDisabled:!GRADING_SETTLEMENT_ENABLED') !== -1,
    'grade/run response must report settlement disabled');
});

test('health reports settlement flags without secret values', function() {
  assert(src.indexOf('settlementEnabled: !!GRADING_SETTLEMENT_ENABLED') !== -1,
    'health must report settlementEnabled');
  assert(src.indexOf('workerSettlementEnabled: !!WORKER_GRADE_SETTLEMENT_ENABLED') !== -1,
    'health must report workerSettlementEnabled');
});

console.log('\nSettlement fail-closed tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
