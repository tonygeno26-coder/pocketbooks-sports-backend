'use strict';

const fs = require('fs');
const path = require('path');
const mon = require('../lib/unresolved-grading-monitor');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log('  OK ' + name); pass++; }
  catch (e) { console.error('  FAIL ' + name + '\n     ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'expected true'); }

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

console.log('\n-- unresolved grading monitor --');

test('does not auto-grade', function() {
  assert(indexSource.includes("app.get('/api/host/unresolved-grading'"));
  assert(!/autoGrade:\s*true/.test(indexSource));
  const report = mon.buildReport({ tickets: [], nowMs: Date.now() });
  assert(report.autoGrade === false);
});

test('classifies missing snapshot as EVENT_NOT_FOUND', function() {
  assert(mon.classifyUnresolvedReason({ canonical_game_key: 'mlb|A|B|2026-09-01' }, null) === 'EVENT_NOT_FOUND');
});

test('classifies missing canonical key as EVENT_MAPPING_FAILED', function() {
  assert(mon.classifyUnresolvedReason({ pick: 'Yankees' }, { status: 'final' }) === 'EVENT_MAPPING_FAILED');
});

test('classifies live/scheduled as NO_FINAL_SCORE', function() {
  assert(mon.classifyUnresolvedReason({ canonical_game_key: 'k' }, { status: 'live' }) === 'NO_FINAL_SCORE');
  assert(mon.classifyUnresolvedReason({ canonical_game_key: 'k' }, { status: 'scheduled' }) === 'NO_FINAL_SCORE');
});

test('classifies postponed/canceled without inventing a score', function() {
  assert(mon.classifyUnresolvedReason({ canonical_game_key: 'k' }, { status: 'postponed' }) === 'POSTPONED');
  assert(mon.classifyUnresolvedReason({ canonical_game_key: 'k' }, { status: 'canceled' }) === 'CANCELED');
});

test('final snapshot on still-active ticket is PROVIDER_MISMATCH, not a grade', function() {
  const r = mon.classifyUnresolvedReason(
    { canonical_game_key: 'k' },
    { status: 'final', home_score: 3, away_score: 1 }
  );
  assert(r === 'PROVIDER_MISMATCH');
});

test('age buckets nested >24 / >48 / >72', function() {
  const now = Date.parse('2026-09-01T21:00:00Z');
  const tickets = [
    { id: 'T24', status: 'active', placed_at: '2026-08-31T20:00:00Z', player_id: 'p1' },
    { id: 'T48', status: 'active', placed_at: '2026-08-30T20:00:00Z', player_id: 'p2' },
    { id: 'T72', status: 'active', placed_at: '2026-08-29T20:00:00Z', player_id: 'p3' },
    { id: 'TFRESH', status: 'active', placed_at: '2026-09-01T20:00:00Z', player_id: 'p4' },
    { id: 'TWON', status: 'won', placed_at: '2026-08-01T00:00:00Z', player_id: 'p5' }
  ];
  const report = mon.buildReport({
    nowMs: now,
    tickets,
    legsByTicket: {
      T24: [{ canonical_game_key: 'baseball_mlb|A|B|2026-08-31', sport: 'mlb', pick: 'A', away_team: 'A', home_team: 'B' }],
      T48: [{ canonical_game_key: 'baseball_mlb|C|D|2026-08-30', sport: 'mlb', pick: 'C', away_team: 'C', home_team: 'D' }],
      T72: [{ canonical_game_key: 'baseball_mlb|E|F|2026-08-29', sport: 'mlb', pick: 'E', away_team: 'E', home_team: 'F' }],
      TFRESH: [{ canonical_game_key: 'baseball_mlb|G|H|2026-09-01', sport: 'mlb', pick: 'G', away_team: 'G', home_team: 'H' }]
    },
    snapshotsByKey: {}
  });
  assert(report.counts.unresolved === 4);
  assert(report.counts.over24 === 3);
  assert(report.counts.over48 === 2);
  assert(report.counts.over72 === 1);
  assert(report.buckets['UNRESOLVED > 72 HOURS'].map(function(t){ return t.ticketId; }).join() === 'T72');
  assert(report.tickets.every(function(t){ return t.reasonUnresolved === 'EVENT_NOT_FOUND'; }));
});

test('Owls dropped + ESPN source is reported, not graded', function() {
  const report = mon.buildReport({
    nowMs: Date.parse('2026-09-01T21:00:00Z'),
    tickets: [{ id: 'Tespn', status: 'active', placed_at: '2026-08-30T00:00:00Z', player_id: 'p1', player_username: 'p1' }],
    legsByTicket: {
      Tespn: [{ canonical_game_key: 'k1', sport: 'mlb', scheduled_start: '2026-08-30T17:00:00Z', away_team: 'Owls Gone', home_team: 'ESPN Final' }]
    },
    snapshotsByKey: {
      k1: { status: 'final', source: 'espn', home_score: 4, away_score: 2 }
    }
  });
  const row = report.tickets[0];
  assert(row.owlsMatchStatus === 'dropped_or_absent');
  assert(row.espnMatchStatus === 'final');
  assert(row.reasonUnresolved === 'PROVIDER_MISMATCH');
  assert(row.currentStatus === 'active');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
