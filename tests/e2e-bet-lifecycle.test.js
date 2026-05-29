'use strict';

// End-to-end bet lifecycle smoke tests
//
// Exercises the full lifecycle against an in-memory harness that mirrors
// the Postgres RPC contracts (place_bet_tx, cancel_bet_tx, grade_ticket_tx).
// No network calls, no real DB — pure JS state machines.
//
// Scenarios:
//   1. Single bet placed → ticket created, ledger debit, balance reduced
//   2. Grade as won      → payout credited, balance increased
//   3. Parlay placed     → all legs created, composite odds correct
//   4. Cancel a bet      → stake refunded, balance restored
//   5. Postponed leg     → grades as push, stake refunded (GRD-7)
//
// Additional coverage:
//   6. Insufficient balance rejected before ticket created
//   7. Grading lost single bet → balance unchanged after placement
//   8. Cancel already-canceled ticket → rejected (invalid_transition)
//   9. Parlay with one lost leg → whole ticket lost
//  10. Parlay with one postponed leg → push-reduced (GRD-2 × GRD-7)
//  11. Grade idempotency → second grade call rejected (invalid_transition)
//  12. Ledger entries are append-only (count grows with each operation)

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  OK  ' + name);
    pass++;
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'expected true');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      (msg || 'assertEq') +
      ' — got ' + JSON.stringify(actual) +
      ', expected ' + JSON.stringify(expected)
    );
  }
}

function assertClose(actual, expected, tol, msg) {
  tol = tol == null ? 0.01 : tol;
  if (Math.abs(actual - expected) > tol) {
    throw new Error(
      (msg || 'assertClose') +
      ' — got ' + actual + ', expected ' + expected + ' (tol ' + tol + ')'
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Odds math helpers (mirrored from index.js _sgAmToDecimal)
// ────────────────────────────────────────────────────────────────────────────

function amToDecimal(o) {
  var n = parseInt(String(o || 0).replace('+', ''));
  if (!n || isNaN(n)) return 1;
  return n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1;
}

function americanPayout(stake, odds) {
  return Math.round(stake * amToDecimal(odds) * 100) / 100;
}

function parlayPayout(stake, oddsArr) {
  var dec = oddsArr.reduce(function(p, o) { return p * amToDecimal(o); }, 1);
  return Math.round(stake * dec * 100) / 100;
}

// ────────────────────────────────────────────────────────────────────────────
// _deriveLegOutcome — inlined from index.js (GRD-7 included)
// ────────────────────────────────────────────────────────────────────────────

var CANCELED_STATUSES = new Set(['canceled','cancelled','postponed','abandoned','suspended','forfeit']);

function _deriveLegOutcome(leg, result) {
  if (!result) return { outcome: 'error', reason: 'result_missing' };
  if (CANCELED_STATUSES.has(result.status)) {
    return { outcome: 'push', reason: 'event_' + result.status };
  }
  if (result.status !== 'final') {
    return { outcome: 'pending', reason: 'result_not_final', status: result.status };
  }
  var market   = (leg.market || 'moneyline').toLowerCase();
  var pick     = (leg.pick || '').toLowerCase();
  var homeTeam = (result.home_team || '').toLowerCase();
  var awayTeam = (result.away_team || '').toLowerCase();
  var homeScore = parseInt(result.home_score, 10) || 0;
  var awayScore = parseInt(result.away_score, 10) || 0;

  if (market === 'moneyline' || market === 'h2h') {
    if (homeScore === awayScore) return { outcome: 'push', reason: 'tie' };
    var pickedHome = pick.includes(homeTeam);
    var pickedAway = pick.includes(awayTeam);
    if (result.winner === 'home' && pickedHome) return { outcome: 'won' };
    if (result.winner === 'away' && pickedAway) return { outcome: 'won' };
    return { outcome: 'lost' };
  }
  if (market === 'total' || market === 'totals') {
    var total = homeScore + awayScore;
    var line  = parseFloat(leg.line || 0);
    var over  = pick.includes('over');
    if (Math.abs(total - line) < 0.001) return { outcome: 'push' };
    return (over ? total > line : total < line) ? { outcome: 'won' } : { outcome: 'lost' };
  }
  return { outcome: 'error', reason: 'unsupported_market:' + market };
}

// ────────────────────────────────────────────────────────────────────────────
// _deriveTicketOutcome — inlined from index.js (GRD-2 push-reduced included)
// ────────────────────────────────────────────────────────────────────────────

function _deriveTicketOutcome(ticket, legs, resultsByKey) {
  var type = (ticket.type || 'single').toLowerCase();
  if (!legs.length) return { outcome: 'error', reason: 'no_legs' };
  var legOutcomes = legs.map(function(leg) {
    var result = resultsByKey[leg.canonical_game_key || ''] || null;
    return Object.assign({ leg: leg.pick }, _deriveLegOutcome(leg, result));
  });
  var pending = legOutcomes.find(function(l) {
    return l.outcome === 'pending' || l.outcome === 'error';
  });
  if (pending) return { outcome: pending.outcome, reason: pending.reason, leg: pending.leg };
  if (type === 'single' || type === 'straight') return legOutcomes[0];
  var anyLost = legOutcomes.find(function(l) { return l.outcome === 'lost'; });
  if (anyLost) return { outcome: 'lost' };
  var wonLegs  = legs.filter(function(_, i) { return legOutcomes[i].outcome === 'won'; });
  var pushLegs = legs.filter(function(_, i) { return legOutcomes[i].outcome === 'push'; });
  if (pushLegs.length > 0 && wonLegs.length > 0) {
    return { outcome: 'won', pushReduced: true, wonLegObjects: wonLegs, pushLegCount: pushLegs.length };
  }
  if (pushLegs.length === legs.length) return { outcome: 'push' };
  return wonLegs.length === legs.length ? { outcome: 'won' } : { outcome: 'lost' };
}

// ────────────────────────────────────────────────────────────────────────────
// In-memory database harness
// Mirrors the Postgres RPC contracts exactly:
//   place_bet_tx   — atomic balance debit + ticket + ledger insert
//   cancel_bet_tx  — atomic balance credit + ticket status update + ledger
//   grade_ticket_tx — atomic grade + balance adjust + ledger
// ────────────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  opts = opts || {};
  var initialBalance = opts.balance != null ? opts.balance : 500;
  var clubId   = opts.clubId   || 'club_test';
  var playerId = opts.playerId || 'player_test';

  // Tables (JS arrays as append-only stores; tickets keyed by id)
  var members       = [{ club_id: clubId, player_id: playerId, balance_start: initialBalance }];
  var tickets       = [];
  var ticketLegs    = [];
  var ledgerEntries = [];

  function getMember() {
    return members.find(function(m) { return m.club_id === clubId && m.player_id === playerId; });
  }

  function getBalance() {
    var m = getMember();
    return m ? m.balance_start : 0;
  }

  function setBalance(v) {
    var m = getMember();
    if (m) m.balance_start = Math.round(v * 100) / 100;
  }

  function getTicket(id) {
    return tickets.find(function(t) { return t.id === id; }) || null;
  }

  // ── place_bet_tx ──────────────────────────────────────────────────────────
  function place_bet_tx(p) {
    var bal = getBalance();
    if (bal < p.p_stake) {
      return { ok: false, error: 'insufficient_balance' };
    }
    setBalance(bal - p.p_stake);
    var ticket = {
      id:                p.p_ticket_id,
      club_id:           p.p_club_id,
      player_id:         p.p_player_id,
      type:              p.p_bet_type || 'Single',
      status:            'active',
      risk_amount:       p.p_stake,
      potential_profit:  p.p_potential_profit,
      estimated_payout:  p.p_estimated_payout,
      odds:              p.p_odds,
      placed_at:         new Date().toISOString()
    };
    tickets.push(ticket);
    var ledgerEntry = {
      id:             p.p_idempotency_key,
      club_id:        p.p_club_id,
      player_id:      p.p_player_id,
      ticket_id:      p.p_ticket_id,
      type:           'debit',
      amount:         -p.p_stake,
      balance_before: bal,
      balance_after:  getBalance(),
      created_at:     new Date().toISOString()
    };
    ledgerEntries.push(ledgerEntry);
    return {
      ok:            true,
      ticket_id:     ticket.id,
      balance_after: getBalance(),
      ledger_id:     ledgerEntry.id
    };
  }

  // ── cancel_bet_tx ─────────────────────────────────────────────────────────
  function cancel_bet_tx(p) {
    var ticket = getTicket(p.p_ticket_id);
    if (!ticket) return { ok: false, error: 'ticket_not_found' };
    if (ticket.status !== 'active') {
      return { ok: false, error: 'invalid_transition', detail: 'cannot cancel ' + ticket.status + ' ticket' };
    }
    var bal = getBalance();
    setBalance(bal + ticket.risk_amount);
    ticket.status = 'canceled';
    ledgerEntries.push({
      id:             p.p_idempotency_key || ('cancel_' + ticket.id),
      club_id:        ticket.club_id,
      player_id:      ticket.player_id,
      ticket_id:      ticket.id,
      type:           'cancel_refund',
      amount:         +ticket.risk_amount,
      balance_before: bal,
      balance_after:  getBalance(),
      created_at:     new Date().toISOString()
    });
    return { ok: true, balance_after: getBalance() };
  }

  // ── grade_ticket_tx ───────────────────────────────────────────────────────
  // p.p_grade = 'won' | 'lost' | 'push'
  // For push-reduced wins, p.p_payout overrides the ticket's estimated_payout.
  function grade_ticket_tx(p) {
    var ticket = getTicket(p.p_ticket_id);
    if (!ticket) return { ok: false, error: 'ticket_not_found' };
    if (ticket.status !== 'active') {
      return { ok: false, error: 'invalid_transition', detail: 'ticket already ' + ticket.status };
    }
    var bal = getBalance();
    var payout  = p.p_payout != null ? p.p_payout : ticket.estimated_payout;
    var profit  = p.p_profit != null ? p.p_profit : ticket.potential_profit;
    var credit  = 0;
    var entryType;

    if (p.p_grade === 'won') {
      credit    = payout;
      entryType = 'win_payout';
    } else if (p.p_grade === 'push') {
      credit    = ticket.risk_amount; // refund stake only
      entryType = 'push_refund';
    } else {
      // lost: no credit
      credit    = 0;
      entryType = 'loss';
    }

    setBalance(bal + credit);
    ticket.status   = p.p_grade;
    ticket.graded_at = new Date().toISOString();

    ledgerEntries.push({
      id:             p.p_idempotency_key || ('grade_' + ticket.id),
      club_id:        ticket.club_id,
      player_id:      ticket.player_id,
      ticket_id:      ticket.id,
      type:           entryType,
      amount:         credit,
      balance_before: bal,
      balance_after:  getBalance(),
      created_at:     new Date().toISOString()
    });

    return {
      ok:            true,
      grade:         p.p_grade,
      balance_after: getBalance(),
      payout:        credit
    };
  }

  // ── insert ticket legs ────────────────────────────────────────────────────
  function insertLegs(legs) {
    legs.forEach(function(leg) { ticketLegs.push(leg); });
  }

  return {
    place_bet_tx,
    cancel_bet_tx,
    grade_ticket_tx,
    insertLegs,
    getBalance,
    getTicket,
    tickets,
    ticketLegs,
    ledgerEntries,
    clubId,
    playerId
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Test data helpers
// ────────────────────────────────────────────────────────────────────────────

var BASE_LEGS = {
  nfl_game: {
    canonical_game_key: 'NFL|chiefs|eagles|2026-01-12',
    sport: 'nfl', pick: 'Kansas City Chiefs', market: 'moneyline',
    odds: -110, home_team: 'Kansas City Chiefs', away_team: 'Philadelphia Eagles'
  },
  nba_game: {
    canonical_game_key: 'NBA|lakers|celtics|2026-01-15',
    sport: 'nba', pick: 'Los Angeles Lakers', market: 'moneyline',
    odds: +130, home_team: 'Los Angeles Lakers', away_team: 'Boston Celtics'
  },
  mlb_game: {
    canonical_game_key: 'MLB|yankees|red-sox|2026-04-01',
    sport: 'mlb', pick: 'New York Yankees', market: 'moneyline',
    odds: -150, home_team: 'New York Yankees', away_team: 'Boston Red Sox'
  }
};

// Simulated result snapshots
var RESULTS = {
  // Chiefs won at home
  nfl_chiefs_won: {
    canonical_game_key: 'NFL|chiefs|eagles|2026-01-12',
    status: 'final', winner: 'home',
    home_team: 'Kansas City Chiefs', away_team: 'Philadelphia Eagles',
    home_score: 27, away_score: 21
  },
  // Chiefs lost (Eagles won)
  nfl_chiefs_lost: {
    canonical_game_key: 'NFL|chiefs|eagles|2026-01-12',
    status: 'final', winner: 'away',
    home_team: 'Kansas City Chiefs', away_team: 'Philadelphia Eagles',
    home_score: 21, away_score: 28
  },
  // Lakers won
  nba_lakers_won: {
    canonical_game_key: 'NBA|lakers|celtics|2026-01-15',
    status: 'final', winner: 'home',
    home_team: 'Los Angeles Lakers', away_team: 'Boston Celtics',
    home_score: 112, away_score: 105
  },
  // Yankees won
  mlb_yankees_won: {
    canonical_game_key: 'MLB|yankees|red-sox|2026-04-01',
    status: 'final', winner: 'home',
    home_team: 'New York Yankees', away_team: 'Boston Red Sox',
    home_score: 7, away_score: 3
  },
  // NFL game postponed (GRD-7)
  nfl_postponed: {
    canonical_game_key: 'NFL|chiefs|eagles|2026-01-12',
    status: 'postponed',
    home_team: 'Kansas City Chiefs', away_team: 'Philadelphia Eagles'
  },
  // NBA game canceled (GRD-7)
  nba_canceled: {
    canonical_game_key: 'NBA|lakers|celtics|2026-01-15',
    status: 'canceled',
    home_team: 'Los Angeles Lakers', away_team: 'Boston Celtics'
  }
};

function makeResultsByKey(resultArr) {
  return resultArr.reduce(function(acc, r) { acc[r.canonical_game_key] = r; return acc; }, {});
}

// ────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Place a single bet
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 1: Place a single bet --');

test('1a: place_bet_tx creates ticket with status=active', function() {
  var db = makeDb({ balance: 500 });
  var stake = 50;
  var payout = americanPayout(stake, -110);
  var r = db.place_bet_tx({
    p_ticket_id:       'T_001',
    p_club_id:         db.clubId,
    p_player_id:       db.playerId,
    p_bet_type:        'Single',
    p_stake:           stake,
    p_potential_profit: payout - stake,
    p_estimated_payout: payout,
    p_odds:            '-110',
    p_idempotency_key: 'idem_001'
  });
  assert(r.ok, 'place_bet_tx should succeed');
  assertEq(r.ticket_id, 'T_001', 'ticket_id in response');
  var t = db.getTicket('T_001');
  assert(t !== null, 'ticket row created');
  assertEq(t.status, 'active', 'ticket status');
  assertEq(t.type,   'Single', 'ticket type');
  assertClose(t.risk_amount, stake, 0.001, 'risk_amount');
});

test('1b: balance is reduced by stake amount after placement', function() {
  var db = makeDb({ balance: 500 });
  db.place_bet_tx({
    p_ticket_id: 'T_002', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 75, p_potential_profit: 68, p_estimated_payout: 143,
    p_odds: '-110', p_idempotency_key: 'idem_002'
  });
  assertClose(db.getBalance(), 425, 0.001, 'balance after $75 stake from $500');
});

test('1c: ledger debit entry written with correct amount and balance_after', function() {
  var db = makeDb({ balance: 500 });
  db.place_bet_tx({
    p_ticket_id: 'T_003', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'idem_003'
  });
  assertEq(db.ledgerEntries.length, 1, 'one ledger entry');
  var e = db.ledgerEntries[0];
  assertEq(e.type, 'debit', 'entry type');
  assertClose(e.amount, -100, 0.001, 'debit amount');
  assertClose(e.balance_before, 500, 0.001, 'balance_before');
  assertClose(e.balance_after,  400, 0.001, 'balance_after');
  assertEq(e.ticket_id, 'T_003', 'ticket_id on ledger entry');
});

test('1d: response includes balance_after equal to post-debit balance', function() {
  var db = makeDb({ balance: 300 });
  var r = db.place_bet_tx({
    p_ticket_id: 'T_004', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 50, p_potential_profit: 45.45, p_estimated_payout: 95.45,
    p_odds: '-110', p_idempotency_key: 'idem_004'
  });
  assertClose(r.balance_after, 250, 0.001, 'response balance_after');
  assertClose(db.getBalance(),  250, 0.001, 'actual balance');
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 2 — Grade as won
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 2: Grade ticket as won --');

test('2a: grade_ticket_tx with won grade credits full payout', function() {
  var db = makeDb({ balance: 500 });
  var stake  = 100;
  var payout = americanPayout(stake, -110); // 190.91
  db.place_bet_tx({
    p_ticket_id: 'T_010', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: stake, p_potential_profit: payout - stake, p_estimated_payout: payout,
    p_odds: '-110', p_idempotency_key: 'place_010'
  });
  var balAfterPlace = db.getBalance(); // 400
  var r = db.grade_ticket_tx({
    p_ticket_id:       'T_010',
    p_grade:           'won',
    p_payout:          payout,
    p_idempotency_key: 'grade_010'
  });
  assert(r.ok, 'grade should succeed');
  assertEq(r.grade, 'won', 'grade in response');
  assertClose(r.balance_after, balAfterPlace + payout, 0.01, 'balance after win payout');
  assertClose(db.getBalance(),  balAfterPlace + payout, 0.01, 'actual balance after win');
});

test('2b: won ticket status set to won', function() {
  var db = makeDb({ balance: 500 });
  db.place_bet_tx({ p_ticket_id: 'T_011', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 50, p_potential_profit: 45.45, p_estimated_payout: 95.45,
    p_odds: '-110', p_idempotency_key: 'place_011' });
  db.grade_ticket_tx({ p_ticket_id: 'T_011', p_grade: 'won', p_payout: 95.45, p_idempotency_key: 'grade_011' });
  assertEq(db.getTicket('T_011').status, 'won', 'ticket status after win grade');
});

test('2c: win ledger entry written with correct type and amount', function() {
  var db = makeDb({ balance: 500 });
  db.place_bet_tx({ p_ticket_id: 'T_012', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'place_012' });
  db.grade_ticket_tx({ p_ticket_id: 'T_012', p_grade: 'won', p_payout: 190.91, p_idempotency_key: 'grade_012' });
  var winEntry = db.ledgerEntries.find(function(e) { return e.type === 'win_payout'; });
  assert(winEntry, 'win_payout ledger entry exists');
  assertClose(winEntry.amount, 190.91, 0.01, 'win_payout amount = full payout');
  assertClose(winEntry.balance_before, 400, 0.01, 'balance_before on win entry');
  assertClose(winEntry.balance_after,  590.91, 0.01, 'balance_after on win entry');
});

test('2d: net balance after place+win = initial + profit', function() {
  var db = makeDb({ balance: 200 });
  var stake  = 100;
  var payout = americanPayout(stake, +150); // $250
  var profit = payout - stake;
  db.place_bet_tx({ p_ticket_id: 'T_013', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: stake, p_potential_profit: profit, p_estimated_payout: payout,
    p_odds: '+150', p_idempotency_key: 'place_013' });
  db.grade_ticket_tx({ p_ticket_id: 'T_013', p_grade: 'won', p_payout: payout, p_idempotency_key: 'grade_013' });
  assertClose(db.getBalance(), 200 + profit, 0.01, 'net balance = initial + profit');
});

test('2e: _deriveLegOutcome correctly identifies winning moneyline', function() {
  var leg    = BASE_LEGS.nfl_game;
  var result = RESULTS.nfl_chiefs_won;
  var o = _deriveLegOutcome(leg, result);
  assertEq(o.outcome, 'won', 'Chiefs picked home, Chiefs won → won');
});

test('2f: _deriveTicketOutcome single won leg produces won ticket', function() {
  var ticket = { type: 'Single' };
  var legs   = [BASE_LEGS.nfl_game];
  var resultsByKey = makeResultsByKey([RESULTS.nfl_chiefs_won]);
  var o = _deriveTicketOutcome(ticket, legs, resultsByKey);
  assertEq(o.outcome, 'won', 'single ticket with won leg = won');
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Place a parlay
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 3: Place a parlay --');

test('3a: parlay ticket created with correct composite odds', function() {
  var db    = makeDb({ balance: 500 });
  var stake = 50;
  var legs  = [BASE_LEGS.nfl_game, BASE_LEGS.nba_game, BASE_LEGS.mlb_game];
  var payout = parlayPayout(stake, legs.map(function(l) { return l.odds; }));
  var r = db.place_bet_tx({
    p_ticket_id: 'T_PAR_001', p_club_id: db.clubId, p_player_id: db.playerId,
    p_bet_type: 'Parlay', p_stake: stake,
    p_potential_profit: payout - stake, p_estimated_payout: payout,
    p_odds: 'parlay', p_idempotency_key: 'place_par_001'
  });
  assert(r.ok, 'parlay placement should succeed');
  assertEq(db.getTicket('T_PAR_001').type, 'Parlay', 'ticket type');
  assertClose(db.getBalance(), 450, 0.001, 'balance after $50 parlay');
});

test('3b: all parlay legs inserted into ticket_legs', function() {
  var db = makeDb({ balance: 500 });
  var legs = [BASE_LEGS.nfl_game, BASE_LEGS.nba_game, BASE_LEGS.mlb_game];
  db.place_bet_tx({
    p_ticket_id: 'T_PAR_002', p_club_id: db.clubId, p_player_id: db.playerId,
    p_bet_type: 'Parlay', p_stake: 50, p_potential_profit: 200, p_estimated_payout: 250,
    p_odds: 'parlay', p_idempotency_key: 'place_par_002'
  });
  // Legs are inserted by the application layer after the RPC
  db.insertLegs(legs.map(function(l, i) {
    return Object.assign({ id: 'T_PAR_002_leg' + i, ticket_id: 'T_PAR_002' }, l);
  }));
  assertEq(db.ticketLegs.filter(function(l) { return l.ticket_id === 'T_PAR_002'; }).length, 3, '3 legs inserted');
});

test('3c: parlay legs have correct canonical_game_key values', function() {
  var db = makeDb({ balance: 500 });
  var legs = [BASE_LEGS.nfl_game, BASE_LEGS.nba_game];
  db.place_bet_tx({
    p_ticket_id: 'T_PAR_003', p_club_id: db.clubId, p_player_id: db.playerId,
    p_bet_type: 'Parlay', p_stake: 30, p_potential_profit: 100, p_estimated_payout: 130,
    p_odds: 'parlay', p_idempotency_key: 'place_par_003'
  });
  db.insertLegs(legs.map(function(l, i) {
    return Object.assign({ id: 'T_PAR_003_leg' + i, ticket_id: 'T_PAR_003' }, l);
  }));
  var inserted = db.ticketLegs.filter(function(l) { return l.ticket_id === 'T_PAR_003'; });
  assertEq(inserted[0].canonical_game_key, 'NFL|chiefs|eagles|2026-01-12', 'leg 0 key');
  assertEq(inserted[1].canonical_game_key, 'NBA|lakers|celtics|2026-01-15', 'leg 1 key');
});

test('3d: _deriveTicketOutcome parlay — all won → ticket won', function() {
  var ticket = { type: 'Parlay' };
  var legs   = [BASE_LEGS.nfl_game, BASE_LEGS.nba_game, BASE_LEGS.mlb_game];
  var resultsByKey = makeResultsByKey([RESULTS.nfl_chiefs_won, RESULTS.nba_lakers_won, RESULTS.mlb_yankees_won]);
  var o = _deriveTicketOutcome(ticket, legs, resultsByKey);
  assertEq(o.outcome, 'won', '3-leg parlay all won = ticket won');
});

test('3e: parlay composite payout is product of all leg decimals times stake', function() {
  var stake = 50;
  var legs  = [BASE_LEGS.nfl_game, BASE_LEGS.nba_game, BASE_LEGS.mlb_game];
  var expectedDec = amToDecimal(-110) * amToDecimal(+130) * amToDecimal(-150);
  var expected    = Math.round(stake * expectedDec * 100) / 100;
  var actual      = parlayPayout(stake, [-110, +130, -150]);
  assertClose(actual, expected, 0.001, 'composite payout math');
  assert(actual > stake, 'payout must exceed stake');
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 4 — Cancel a bet
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 4: Cancel a bet --');

test('4a: cancel_bet_tx refunds stake to balance', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_CAN_001', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 75, p_potential_profit: 68.18, p_estimated_payout: 143.18,
    p_odds: '-110', p_idempotency_key: 'place_can_001' });
  assertClose(db.getBalance(), 225, 0.001, 'balance after placement');
  var r = db.cancel_bet_tx({ p_ticket_id: 'T_CAN_001', p_idempotency_key: 'cancel_can_001' });
  assert(r.ok, 'cancel should succeed');
  assertClose(db.getBalance(), 300, 0.001, 'balance fully restored after cancel');
});

test('4b: canceled ticket status updated to canceled', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_CAN_002', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 50, p_potential_profit: 45.45, p_estimated_payout: 95.45,
    p_odds: '-110', p_idempotency_key: 'place_can_002' });
  db.cancel_bet_tx({ p_ticket_id: 'T_CAN_002', p_idempotency_key: 'cancel_can_002' });
  assertEq(db.getTicket('T_CAN_002').status, 'canceled', 'ticket status after cancel');
});

test('4c: cancel ledger entry written with type=cancel_refund', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_CAN_003', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'place_can_003' });
  db.cancel_bet_tx({ p_ticket_id: 'T_CAN_003', p_idempotency_key: 'cancel_can_003' });
  var refund = db.ledgerEntries.find(function(e) { return e.type === 'cancel_refund'; });
  assert(refund, 'cancel_refund ledger entry exists');
  assertClose(refund.amount, 100, 0.001, 'refund amount = original stake');
  assertClose(refund.balance_after, 300, 0.001, 'balance_after restored to original');
});

test('4d: net balance after place+cancel = initial balance (zero net)', function() {
  var db = makeDb({ balance: 250 });
  var initialBal = db.getBalance();
  db.place_bet_tx({ p_ticket_id: 'T_CAN_004', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'place_can_004' });
  db.cancel_bet_tx({ p_ticket_id: 'T_CAN_004', p_idempotency_key: 'cancel_can_004' });
  assertClose(db.getBalance(), initialBal, 0.001, 'balance restored exactly after cancel');
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 5 — Postponed game leg grades as push (GRD-7)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 5: Postponed game leg grades as push --');

test('5a: _deriveLegOutcome postponed game → outcome=push', function() {
  var leg    = BASE_LEGS.nfl_game;
  var result = RESULTS.nfl_postponed;
  var o = _deriveLegOutcome(leg, result);
  assertEq(o.outcome, 'push', 'postponed game → push');
  assert(o.reason.startsWith('event_'), 'reason starts with event_');
  assertEq(o.reason, 'event_postponed', 'reason is event_postponed');
});

test('5b: _deriveLegOutcome canceled game → outcome=push', function() {
  var leg    = BASE_LEGS.nba_game;
  var result = RESULTS.nba_canceled;
  var o = _deriveLegOutcome(leg, result);
  assertEq(o.outcome, 'push', 'canceled game → push');
  assertEq(o.reason, 'event_canceled', 'reason is event_canceled');
});

test('5c: single bet, postponed game → _deriveTicketOutcome = push', function() {
  var ticket = { type: 'Single' };
  var legs   = [BASE_LEGS.nfl_game];
  var resultsByKey = makeResultsByKey([RESULTS.nfl_postponed]);
  var o = _deriveTicketOutcome(ticket, legs, resultsByKey);
  assertEq(o.outcome, 'push', 'single ticket with postponed leg = push');
});

test('5d: grade_ticket_tx push → stake fully refunded, balance restored', function() {
  var db = makeDb({ balance: 400 });
  var stake = 100;
  db.place_bet_tx({ p_ticket_id: 'T_PUSH_001', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: stake, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'place_push_001' });
  assertClose(db.getBalance(), 300, 0.001, 'balance after placement');
  var r = db.grade_ticket_tx({ p_ticket_id: 'T_PUSH_001', p_grade: 'push', p_idempotency_key: 'grade_push_001' });
  assert(r.ok, 'push grade should succeed');
  assertClose(db.getBalance(), 400, 0.001, 'balance restored to original after push');
});

test('5e: push grade ticket status updated to push', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_PUSH_002', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 50, p_potential_profit: 45.45, p_estimated_payout: 95.45,
    p_odds: '-110', p_idempotency_key: 'place_push_002' });
  db.grade_ticket_tx({ p_ticket_id: 'T_PUSH_002', p_grade: 'push', p_idempotency_key: 'grade_push_002' });
  assertEq(db.getTicket('T_PUSH_002').status, 'push', 'ticket status = push');
});

test('5f: push ledger entry type=push_refund with amount=stake', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_PUSH_003', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 75, p_potential_profit: 68.18, p_estimated_payout: 143.18,
    p_odds: '-110', p_idempotency_key: 'place_push_003' });
  db.grade_ticket_tx({ p_ticket_id: 'T_PUSH_003', p_grade: 'push', p_idempotency_key: 'grade_push_003' });
  var pushEntry = db.ledgerEntries.find(function(e) { return e.type === 'push_refund'; });
  assert(pushEntry, 'push_refund ledger entry exists');
  assertClose(pushEntry.amount, 75, 0.001, 'push refund = original stake');
});

test('5g: net balance after place+push = initial (zero net)', function() {
  var db = makeDb({ balance: 500 });
  db.place_bet_tx({ p_ticket_id: 'T_PUSH_004', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 200, p_potential_profit: 181.82, p_estimated_payout: 381.82,
    p_odds: '-110', p_idempotency_key: 'place_push_004' });
  db.grade_ticket_tx({ p_ticket_id: 'T_PUSH_004', p_grade: 'push', p_idempotency_key: 'grade_push_004' });
  assertClose(db.getBalance(), 500, 0.001, 'balance = initial after push');
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 6 — Insufficient balance rejection
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 6: Insufficient balance rejection --');

test('6a: place_bet_tx with stake > balance returns insufficient_balance', function() {
  var db = makeDb({ balance: 50 });
  var r = db.place_bet_tx({ p_ticket_id: 'T_INSUF', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'place_insuf' });
  assert(!r.ok, 'should be rejected');
  assertEq(r.error, 'insufficient_balance', 'error code');
});

test('6b: balance unchanged after insufficient_balance rejection', function() {
  var db = makeDb({ balance: 50 });
  db.place_bet_tx({ p_ticket_id: 'T_INSUF2', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'place_insuf2' });
  assertClose(db.getBalance(), 50, 0.001, 'balance unchanged after rejection');
});

test('6c: no ticket created after insufficient_balance rejection', function() {
  var db = makeDb({ balance: 50 });
  db.place_bet_tx({ p_ticket_id: 'T_INSUF3', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90, p_estimated_payout: 190,
    p_odds: '-110', p_idempotency_key: 'place_insuf3' });
  assertEq(db.tickets.length, 0, 'no ticket row created on rejection');
  assertEq(db.ledgerEntries.length, 0, 'no ledger entry created on rejection');
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 7 — Grade lost single bet
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 7: Grade as lost --');

test('7a: lost bet does not credit balance', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_LOST_001', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'place_lost_001' });
  db.grade_ticket_tx({ p_ticket_id: 'T_LOST_001', p_grade: 'lost', p_idempotency_key: 'grade_lost_001' });
  assertClose(db.getBalance(), 200, 0.001, 'balance stays at post-stake amount after loss');
});

test('7b: _deriveLegOutcome identifies losing moneyline', function() {
  var leg    = BASE_LEGS.nfl_game;
  var result = RESULTS.nfl_chiefs_lost;
  var o = _deriveLegOutcome(leg, result);
  assertEq(o.outcome, 'lost', 'Chiefs picked but lost → lost');
});

test('7c: lost ticket status = lost, loss ledger entry amount = 0', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_LOST_002', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 50, p_potential_profit: 45.45, p_estimated_payout: 95.45,
    p_odds: '-110', p_idempotency_key: 'place_lost_002' });
  db.grade_ticket_tx({ p_ticket_id: 'T_LOST_002', p_grade: 'lost', p_idempotency_key: 'grade_lost_002' });
  assertEq(db.getTicket('T_LOST_002').status, 'lost', 'ticket status');
  var lossEntry = db.ledgerEntries.find(function(e) { return e.type === 'loss'; });
  assert(lossEntry, 'loss ledger entry exists');
  assertEq(lossEntry.amount, 0, 'loss ledger amount = 0 (no credit)');
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 8 — Cancel already-canceled ticket (invalid_transition)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 8: Double-cancel rejected --');

test('8a: canceling an already-canceled ticket returns invalid_transition', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_DC', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 50, p_potential_profit: 45.45, p_estimated_payout: 95.45,
    p_odds: '-110', p_idempotency_key: 'place_dc' });
  db.cancel_bet_tx({ p_ticket_id: 'T_DC', p_idempotency_key: 'cancel_dc_1' });
  var r2 = db.cancel_bet_tx({ p_ticket_id: 'T_DC', p_idempotency_key: 'cancel_dc_2' });
  assert(!r2.ok, 'second cancel should fail');
  assertEq(r2.error, 'invalid_transition', 'error code');
});

test('8b: balance not double-refunded on second cancel attempt', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_DC2', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'place_dc2' });
  db.cancel_bet_tx({ p_ticket_id: 'T_DC2', p_idempotency_key: 'cancel_dc2_1' });
  db.cancel_bet_tx({ p_ticket_id: 'T_DC2', p_idempotency_key: 'cancel_dc2_2' }); // rejected
  assertClose(db.getBalance(), 300, 0.001, 'balance not double-refunded');
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 9 — Parlay with one lost leg → whole ticket lost
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 9: Parlay with one lost leg --');

test('9a: parlay with one lost leg → _deriveTicketOutcome = lost', function() {
  var ticket = { type: 'Parlay' };
  var legs   = [BASE_LEGS.nfl_game, BASE_LEGS.nba_game];
  // Chiefs lost, Lakers won
  var resultsByKey = makeResultsByKey([RESULTS.nfl_chiefs_lost, RESULTS.nba_lakers_won]);
  var o = _deriveTicketOutcome(ticket, legs, resultsByKey);
  assertEq(o.outcome, 'lost', '2-leg parlay: 1 lost leg → lost ticket');
});

test('9b: lost parlay balance stays at post-stake amount', function() {
  var db = makeDb({ balance: 400 });
  db.place_bet_tx({ p_ticket_id: 'T_PLOS', p_club_id: db.clubId, p_player_id: db.playerId,
    p_bet_type: 'Parlay', p_stake: 100, p_potential_profit: 300, p_estimated_payout: 400,
    p_odds: 'parlay', p_idempotency_key: 'place_plos' });
  db.grade_ticket_tx({ p_ticket_id: 'T_PLOS', p_grade: 'lost', p_idempotency_key: 'grade_plos' });
  assertClose(db.getBalance(), 300, 0.001, 'balance after losing parlay = initial - stake');
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 10 — Parlay with one postponed leg → push-reduced (GRD-2 × GRD-7)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 10: Parlay with one postponed leg (GRD-2 × GRD-7) --');

test('10a: 2-leg parlay, 1 postponed + 1 won → pushReduced', function() {
  var ticket = { type: 'Parlay' };
  var legs   = [BASE_LEGS.nfl_game, BASE_LEGS.nba_game];
  // NFL postponed (push), NBA won
  var resultsByKey = makeResultsByKey([RESULTS.nfl_postponed, RESULTS.nba_lakers_won]);
  var o = _deriveTicketOutcome(ticket, legs, resultsByKey);
  assertEq(o.outcome, 'won', 'won leg survives push-reduced parlay');
  assertEq(o.pushReduced, true, 'pushReduced flag set');
  assertEq(o.pushLegCount, 1, '1 pushed leg');
  assertEq(o.wonLegObjects.length, 1, '1 won leg');
});

test('10b: 2-leg parlay all postponed → push (GRD-2 all-push path)', function() {
  var ticket = { type: 'Parlay' };
  var legs   = [BASE_LEGS.nfl_game, BASE_LEGS.nba_game];
  var resultsByKey = makeResultsByKey([RESULTS.nfl_postponed, RESULTS.nba_canceled]);
  var o = _deriveTicketOutcome(ticket, legs, resultsByKey);
  assertEq(o.outcome, 'push', 'all legs postponed/canceled → push');
});

test('10c: 3-leg parlay, 1 postponed + 1 won + 1 lost → lost (lost leg dominates)', function() {
  var ticket = { type: 'Parlay' };
  var legs   = [BASE_LEGS.nfl_game, BASE_LEGS.nba_game, BASE_LEGS.mlb_game];
  var resultsByKey = makeResultsByKey([RESULTS.nfl_postponed, RESULTS.nba_lakers_won, {
    canonical_game_key: 'MLB|yankees|red-sox|2026-04-01',
    status: 'final', winner: 'away',    // Yankees lost
    home_team: 'New York Yankees', away_team: 'Boston Red Sox',
    home_score: 2, away_score: 6
  }]);
  var o = _deriveTicketOutcome(ticket, legs, resultsByKey);
  assertEq(o.outcome, 'lost', 'lost leg in parlay dominates over pushed leg');
});

test('10d: push-reduced parlay: payout based only on winning legs', function() {
  // 2-leg parlay, 1 pushed → winner gets paid as if 1-leg parlay
  var wonLeg   = BASE_LEGS.nba_game;  // +130
  var stake    = 100;
  var singleLegPayout = americanPayout(stake, wonLeg.odds); // $230
  // In push-reduced path, only won legs remain → recalculate at single-leg odds
  var pushReducedPayout = parlayPayout(stake, [wonLeg.odds]);
  assertClose(pushReducedPayout, singleLegPayout, 0.01, 'push-reduced payout = single-leg payout on surviving leg');
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 11 — Grade idempotency (double-grade rejected)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 11: Grade idempotency --');

test('11a: grading an already-graded ticket returns invalid_transition', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_GR2', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 50, p_potential_profit: 45.45, p_estimated_payout: 95.45,
    p_odds: '-110', p_idempotency_key: 'place_gr2' });
  db.grade_ticket_tx({ p_ticket_id: 'T_GR2', p_grade: 'won', p_payout: 95.45, p_idempotency_key: 'grade_gr2_1' });
  var r2 = db.grade_ticket_tx({ p_ticket_id: 'T_GR2', p_grade: 'won', p_payout: 95.45, p_idempotency_key: 'grade_gr2_2' });
  assert(!r2.ok, 'second grade should fail');
  assertEq(r2.error, 'invalid_transition', 'error code');
});

test('11b: balance not double-credited on second grade attempt', function() {
  var db = makeDb({ balance: 300 });
  var stake = 100;
  var payout = americanPayout(stake, -110);
  db.place_bet_tx({ p_ticket_id: 'T_GR3', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: stake, p_potential_profit: payout - stake, p_estimated_payout: payout,
    p_odds: '-110', p_idempotency_key: 'place_gr3' });
  db.grade_ticket_tx({ p_ticket_id: 'T_GR3', p_grade: 'won', p_payout: payout, p_idempotency_key: 'grade_gr3_1' });
  db.grade_ticket_tx({ p_ticket_id: 'T_GR3', p_grade: 'won', p_payout: payout, p_idempotency_key: 'grade_gr3_2' }); // rejected
  assertClose(db.getBalance(), 300 - stake + payout, 0.01, 'balance not double-credited');
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 12 — Ledger append-only (count grows monotonically)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n-- Scenario 12: Ledger is append-only --');

test('12a: full lifecycle writes exactly 2 ledger entries (debit + win_payout)', function() {
  var db = makeDb({ balance: 500 });
  var payout = americanPayout(100, -110);
  db.place_bet_tx({ p_ticket_id: 'T_LE_001', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: payout - 100, p_estimated_payout: payout,
    p_odds: '-110', p_idempotency_key: 'place_le_001' });
  db.grade_ticket_tx({ p_ticket_id: 'T_LE_001', p_grade: 'won', p_payout: payout, p_idempotency_key: 'grade_le_001' });
  assertEq(db.ledgerEntries.length, 2, 'place + grade = 2 ledger entries total');
  assertEq(db.ledgerEntries[0].type, 'debit',      'first entry is debit');
  assertEq(db.ledgerEntries[1].type, 'win_payout', 'second entry is win_payout');
});

test('12b: place+cancel = 2 entries (debit + cancel_refund)', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_LE_002', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'place_le_002' });
  db.cancel_bet_tx({ p_ticket_id: 'T_LE_002', p_idempotency_key: 'cancel_le_002' });
  assertEq(db.ledgerEntries.length, 2, 'place + cancel = 2 entries');
  assertEq(db.ledgerEntries[1].type, 'cancel_refund', 'second entry is cancel_refund');
});

test('12c: place+push = 2 entries (debit + push_refund)', function() {
  var db = makeDb({ balance: 300 });
  db.place_bet_tx({ p_ticket_id: 'T_LE_003', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'place_le_003' });
  db.grade_ticket_tx({ p_ticket_id: 'T_LE_003', p_grade: 'push', p_idempotency_key: 'grade_le_003' });
  assertEq(db.ledgerEntries.length, 2, 'place + push = 2 entries');
  assertEq(db.ledgerEntries[1].type, 'push_refund', 'second entry is push_refund');
});

test('12d: multiple bets in same session each get isolated ledger entries', function() {
  var db = makeDb({ balance: 1000 });
  db.place_bet_tx({ p_ticket_id: 'T_MB_1', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 100, p_potential_profit: 90.91, p_estimated_payout: 190.91,
    p_odds: '-110', p_idempotency_key: 'place_mb_1' });
  db.place_bet_tx({ p_ticket_id: 'T_MB_2', p_club_id: db.clubId, p_player_id: db.playerId,
    p_stake: 50, p_potential_profit: 65, p_estimated_payout: 115,
    p_odds: '+130', p_idempotency_key: 'place_mb_2' });
  db.grade_ticket_tx({ p_ticket_id: 'T_MB_1', p_grade: 'won', p_payout: 190.91, p_idempotency_key: 'grade_mb_1' });
  db.cancel_bet_tx({ p_ticket_id: 'T_MB_2', p_idempotency_key: 'cancel_mb_2' });
  assertEq(db.ledgerEntries.length, 4, '2 placements + 1 win + 1 cancel = 4 entries');
  assertClose(db.getBalance(), 1000 - 100 + 190.91 - 50 + 50, 0.01, 'balance correct after mixed lifecycle');
});

// ────────────────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────────────────
console.log('\nE2E bet lifecycle smoke tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
