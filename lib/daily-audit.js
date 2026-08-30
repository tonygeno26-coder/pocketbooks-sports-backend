'use strict';

// Daily read-only integrity audit. Never mutates tickets, balances, or ledger rows.

const MS_DAY = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const ISSUE_CAP = 100;
const AMT_EPS = 0.02;

// Canonical names from LEDGER_EVENT_TYPES / _writeLedgerEntry in index.js.
const CANONICAL_EVENT_TYPES = [
  'BET_PLACED', 'BET_CANCELED_REFUND', 'BET_GRADED_WIN', 'BET_GRADED_LOSS',
  'BET_GRADED_PUSH', 'SETTLEMENT_APPLIED', 'WEEKLY_ROLLOVER', 'BALANCE_ADJUSTMENT'
];

// Operational ledger_entries.type values written by place_bet_tx / grade_ticket_tx / cancel_bet_tx.
const PLACEMENT_TYPES = new Set(['BET_PLACED', 'bet_placed', 'TICKET_PLACED', 'ticket_placed']);
const WIN_TYPES = new Set(['BET_GRADED_WIN', 'bet_won', 'bet_graded_win']);
const LOSS_TYPES = new Set(['BET_GRADED_LOSS', 'bet_lost', 'bet_graded_loss']);
const PUSH_TYPES = new Set(['BET_GRADED_PUSH', 'bet_push', 'bet_graded_push']);
const VOID_CANCEL_TYPES = new Set([
  'BET_CANCELED_REFUND', 'bet_canceled', 'bet_cancelled', 'bet_void', 'BET_VOID', 'void'
]);
const NON_TICKET_TYPES = new Set([
  'SETTLEMENT_APPLIED', 'WEEKLY_ROLLOVER', 'BALANCE_ADJUSTMENT',
  'HOST_DIAMOND_TOPUP', 'HOST_ACTIVE_BETTOR_CHARGE', 'HOST_DIAMOND_ADJUSTMENT',
  'HOST_DIAMOND_REFUND', 'HOST_DIAMOND_PURCHASE'
]);

const GRADED_STATUSES = new Set(['won', 'lost', 'push', 'pushed', 'void', 'voided', 'canceled', 'cancelled']);
const KNOWN_TYPES = new Set([
  ...CANONICAL_EVENT_TYPES,
  ...PLACEMENT_TYPES, ...WIN_TYPES, ...LOSS_TYPES, ...PUSH_TYPES, ...VOID_CANCEL_TYPES,
  ...NON_TICKET_TYPES
]);

function rnd(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  return Math.round(n * 100) / 100;
}

function absDelta(a, b) {
  return Math.abs(rnd(a) - rnd(b));
}

function typeOf(row) {
  return String(row && (row.event_type || row.type) || '');
}

function expectsTicketId(row) {
  const t = typeOf(row);
  if (!t) return !!row.ticket_id;
  if (NON_TICKET_TYPES.has(t)) return false;
  return PLACEMENT_TYPES.has(t) || WIN_TYPES.has(t) || LOSS_TYPES.has(t)
    || PUSH_TYPES.has(t) || VOID_CANCEL_TYPES.has(t) || !!row.ticket_id;
}

function gradeTypesForStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'won') return WIN_TYPES;
  if (s === 'lost') return LOSS_TYPES;
  if (s === 'push' || s === 'pushed') return PUSH_TYPES;
  if (s === 'void' || s === 'voided' || s === 'canceled' || s === 'cancelled') return VOID_CANCEL_TYPES;
  return null;
}

function expectedGradeAmount(ticket) {
  const s = String(ticket.status || '').toLowerCase();
  const risk = rnd(ticket.risk_amount);
  const profit = rnd(ticket.potential_profit);
  if (s === 'won') return rnd(risk + profit);
  if (s === 'lost') return 0;
  if (s === 'push' || s === 'pushed') return risk;
  if (s === 'void' || s === 'voided' || s === 'canceled' || s === 'cancelled') return risk;
  return null;
}

function dashboardAvailable(startBal, tickets) {
  let openRisk = 0, settledGains = 0, settledLosses = 0;
  (tickets || []).forEach(function(t) {
    const s = String(t.status || '').toLowerCase();
    const r = rnd(t.risk_amount);
    const p = rnd(t.potential_profit);
    if (s === 'canceled' || s === 'voided' || s === 'deleted' || s === 'cancelled' || s === 'void') return;
    if (s === 'active' || s === 'open') openRisk += r;
    else if (s === 'won') settledGains += p;
    else if (s === 'lost') settledLosses += r;
  });
  if (startBal == null) return { available: null, openRisk: rnd(openRisk), settledGains: rnd(settledGains), settledLosses: rnd(settledLosses) };
  return {
    available: rnd(startBal - openRisk - settledLosses + settledGains),
    openRisk: rnd(openRisk),
    settledGains: rnd(settledGains),
    settledLosses: rnd(settledLosses)
  };
}

function ledgerSum(rows) {
  let credits = 0, debits = 0, signed = 0;
  (rows || []).forEach(function(r) {
    const amt = rnd(r.amount != null ? r.amount : r.amount_diamonds);
    const dir = String(r.direction || '').toLowerCase();
    if (dir === 'credit') { credits += amt; signed += amt; }
    else if (dir === 'debit') { debits += amt; signed -= amt; }
    else signed += amt;
  });
  return { credits: rnd(credits), debits: rnd(debits), signed: rnd(signed) };
}

function msUntilNext4amUtc(nowMs) {
  const now = nowMs != null ? new Date(nowMs) : new Date();
  const today4 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 0, 0, 0);
  const target = now.getTime() > today4 ? today4 + MS_DAY : today4;
  return target - now.getTime();
}

async function fetchAll(sb, table, columns, apply) {
  const out = [];
  let offset = 0;
  while (true) {
    let q = sb.from(table).select(columns);
    if (apply) q = apply(q);
    const { data, error } = await q.range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = data || [];
    out.push.apply(out, batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset > 200000) break;
  }
  return out;
}

async function fetchAllOrEmpty(sb, table, columns, apply) {
  try {
    return await fetchAll(sb, table, columns, apply);
  } catch (e) {
    return { _error: e.message || String(e), rows: [] };
  }
}

function indexByTicket(rows) {
  const map = {};
  (rows || []).forEach(function(r) {
    const id = r.ticket_id;
    if (!id) return;
    if (!map[id]) map[id] = [];
    map[id].push(r);
  });
  return map;
}

function capIssues(issues) {
  if (!issues || issues.length <= ISSUE_CAP) return issues || [];
  return issues.slice(0, ISSUE_CAP).concat([{
    severity: 'warning',
    code: 'issue_cap',
    detail: 'truncated ' + (issues.length - ISSUE_CAP) + ' additional issues'
  }]);
}

function summarizeCheck(name, scanned, issues) {
  let critical = 0, warning = 0;
  (issues || []).forEach(function(i) {
    if (i.severity === 'critical') critical++;
    else warning++;
  });
  return {
    name: name,
    scanned: scanned,
    issueCount: (issues || []).length,
    critical: critical,
    warning: warning,
    ok: critical === 0,
    issues: capIssues(issues)
  };
}

function checkBetPlacement(tickets, ledgerByTicket) {
  const issues = [];
  (tickets || []).forEach(function(t) {
    const rows = ledgerByTicket[t.id] || [];
    const hits = rows.filter(function(r) { return PLACEMENT_TYPES.has(typeOf(r)); });
    if (!hits.length) {
      issues.push({
        severity: 'critical',
        code: 'missing_placement_debit',
        ticketId: t.id,
        playerId: t.player_id,
        clubId: t.club_id,
        riskAmount: rnd(t.risk_amount),
        detail: 'no BET_PLACED/bet_placed ledger debit for ticket'
      });
      return;
    }
    const amt = rnd(hits[0].amount != null ? hits[0].amount : hits[0].amount_diamonds);
    if (absDelta(Math.abs(amt), t.risk_amount) > AMT_EPS) {
      issues.push({
        severity: 'warning',
        code: 'placement_amount_mismatch',
        ticketId: t.id,
        expected: rnd(t.risk_amount),
        actual: amt
      });
    }
  });
  return summarizeCheck('bet_placement', (tickets || []).length, issues);
}

function checkGrading(tickets, ledgerByTicket) {
  const issues = [];
  (tickets || []).forEach(function(t) {
    const wanted = gradeTypesForStatus(t.status);
    if (!wanted) return;
    const rows = ledgerByTicket[t.id] || [];
    const hits = rows.filter(function(r) { return wanted.has(typeOf(r)); });
    if (!hits.length) {
      issues.push({
        severity: 'critical',
        code: 'missing_grade_ledger',
        ticketId: t.id,
        playerId: t.player_id,
        status: t.status,
        detail: 'no matching win/loss/push/void ledger row'
      });
      return;
    }
    const expected = expectedGradeAmount(t);
    const amt = rnd(hits[0].amount != null ? hits[0].amount : hits[0].amount_diamonds);
    if (expected != null && absDelta(Math.abs(amt), Math.abs(expected)) > AMT_EPS) {
      issues.push({
        severity: 'warning',
        code: 'grade_amount_mismatch',
        ticketId: t.id,
        status: t.status,
        expected: expected,
        actual: amt
      });
    }
  });
  return summarizeCheck('grading', (tickets || []).length, issues);
}

function checkBalances(members, tickets, ledgerRows) {
  const issues = [];
  const tixByPlayer = {};
  (tickets || []).forEach(function(t) {
    const key = String(t.club_id || '') + '|' + String(t.player_id || '');
    if (!tixByPlayer[key]) tixByPlayer[key] = [];
    tixByPlayer[key].push(t);
  });
  const ledByPlayer = {};
  (ledgerRows || []).forEach(function(r) {
    const key = String(r.club_id || '') + '|' + String(r.player_id || '');
    if (!ledByPlayer[key]) ledByPlayer[key] = [];
    ledByPlayer[key].push(r);
  });
  (members || []).forEach(function(m) {
    const key = String(m.club_id || '') + '|' + String(m.player_id || '');
    const start = m.balance_start == null ? null : rnd(m.balance_start);
    const dash = dashboardAvailable(start, tixByPlayer[key] || []);
    const led = ledgerSum(ledByPlayer[key] || []);
    const ledgerAvailable = start == null ? null : rnd(start + led.signed);
    if (start == null) {
      issues.push({
        severity: 'warning',
        code: 'missing_balance_start',
        clubId: m.club_id,
        playerId: m.player_id
      });
      return;
    }
    if (dash.available != null && ledgerAvailable != null && absDelta(dash.available, ledgerAvailable) > AMT_EPS) {
      issues.push({
        severity: 'critical',
        code: 'balance_mismatch',
        clubId: m.club_id,
        playerId: m.player_id,
        startingBalance: start,
        dashboardAvailable: dash.available,
        ledgerAvailable: ledgerAvailable,
        openRisk: dash.openRisk,
        settledGains: dash.settledGains,
        settledLosses: dash.settledLosses
      });
    }
  });
  return summarizeCheck('balance', (members || []).length, issues);
}

function checkDiamonds(balances, ledgerRows) {
  const issues = [];
  const byClub = {};
  (ledgerRows || []).forEach(function(r) {
    const id = r.club_id;
    if (!byClub[id]) byClub[id] = [];
    byClub[id].push(r);
  });
  (balances || []).forEach(function(b) {
    const rows = byClub[b.club_id] || [];
    const summed = ledgerSum(rows);
    const stored = rnd(b.balance_diamonds);
    if (!rows.length && stored !== 0) {
      issues.push({
        severity: 'warning',
        code: 'diamond_ledger_empty',
        clubId: b.club_id,
        stored: stored,
        ledgerCreditsMinusDebits: 0,
        detail: 'host_diamond_ledger has no rows; stored balance cannot be derived from credits-debits'
      });
      return;
    }
    if (absDelta(stored, summed.signed) > AMT_EPS) {
      issues.push({
        severity: 'critical',
        code: 'diamond_balance_mismatch',
        clubId: b.club_id,
        stored: stored,
        ledgerCreditsMinusDebits: summed.signed
      });
    }
  });
  return summarizeCheck('diamond', (balances || []).length, issues);
}

function checkOrphans(ledgerRows, ticketIds) {
  const issues = [];
  const ids = ticketIds instanceof Set ? ticketIds : new Set(ticketIds || []);
  (ledgerRows || []).forEach(function(r) {
    if (!expectsTicketId(r)) return;
    if (!r.ticket_id) {
      issues.push({
        severity: 'warning',
        code: 'ledger_missing_ticket_id',
        ledgerId: r.ledger_id || r.id,
        type: typeOf(r)
      });
      return;
    }
    if (!ids.has(r.ticket_id)) {
      issues.push({
        severity: 'warning',
        code: 'orphan_ledger_ticket',
        ledgerId: r.ledger_id || r.id,
        ticketId: r.ticket_id,
        type: typeOf(r)
      });
    }
  });
  return summarizeCheck('orphan', (ledgerRows || []).length, issues);
}

function checkDuplicates(entryRows, canonicalRows, diamondRows) {
  const issues = [];
  function scan(rows, keyFn, source) {
    const counts = {};
    (rows || []).forEach(function(r) {
      const key = keyFn(r);
      if (!key) return;
      if (!counts[key]) counts[key] = [];
      counts[key].push(r.ledger_id || r.id);
    });
    Object.keys(counts).forEach(function(key) {
      if (counts[key].length > 1) {
        issues.push({
          severity: 'critical',
          code: 'duplicate_idempotency_key',
          source: source,
          idempotencyKey: key,
          count: counts[key].length,
          ids: counts[key].slice(0, 10)
        });
      }
    });
  }
  scan(entryRows, function(r) { return r.id || null; }, 'ledger_entries');
  scan(canonicalRows, function(r) { return r.idempotency_key || null; }, 'ledger');
  scan(diamondRows, function(r) { return r.idempotency_key || null; }, 'host_diamond_ledger');
  return summarizeCheck('duplicate', (entryRows || []).length + (canonicalRows || []).length + (diamondRows || []).length, issues);
}

function inWindow(iso, sinceIso) {
  if (!iso) return false;
  return String(iso) >= sinceIso;
}

async function loadTables(sb) {
  const gaps = [];
  const tickets = await fetchAll(sb, 'tickets', 'id,club_id,player_id,status,risk_amount,potential_profit,placed_at,graded_at,canceled_at');
  const members = await fetchAll(sb, 'club_members', 'club_id,player_id,balance_start,status');
  const entriesOr = await fetchAllOrEmpty(sb, 'ledger_entries', 'id,club_id,player_id,ticket_id,type,amount,created_at');
  const canonicalOr = await fetchAllOrEmpty(sb, 'ledger', 'ledger_id,club_id,player_id,ticket_id,event_type,amount,direction,idempotency_key,created_at');
  const diamondBal = await fetchAll(sb, 'host_diamond_balances', 'club_id,host_actor_id,balance_diamonds,updated_at');
  const diamondLed = await fetchAll(sb, 'host_diamond_ledger', 'ledger_id,club_id,event_type,amount_diamonds,direction,idempotency_key,created_at');

  let entries = entriesOr;
  if (entriesOr && entriesOr._error) {
    gaps.push('ledger_entries unavailable: ' + entriesOr._error);
    entries = [];
  }
  let canonical = canonicalOr;
  if (canonicalOr && canonicalOr._error) {
    gaps.push('canonical ledger table missing or unreadable (' + canonicalOr._error + '); using ledger_entries');
    canonical = [];
  }
  if (!diamondLed.length) gaps.push('host_diamond_ledger is empty');

  return { tickets, members, entries, canonical, diamondBal, diamondLed, gaps };
}

function unifyLedger(entries, canonical) {
  const fromEntries = (entries || []).map(function(r) {
    return {
      id: r.id,
      ledger_id: r.id,
      club_id: r.club_id,
      player_id: r.player_id,
      ticket_id: r.ticket_id,
      type: r.type,
      event_type: r.type,
      amount: r.amount,
      direction: parseFloat(r.amount) < 0 ? 'debit' : (parseFloat(r.amount) > 0 ? 'credit' : 'neutral'),
      created_at: r.created_at,
      idempotency_key: r.id
    };
  });
  const fromCanon = (canonical || []).map(function(r) {
    return {
      id: r.ledger_id,
      ledger_id: r.ledger_id,
      club_id: r.club_id,
      player_id: r.player_id,
      ticket_id: r.ticket_id,
      type: r.event_type,
      event_type: r.event_type,
      amount: r.amount,
      direction: r.direction,
      created_at: r.created_at,
      idempotency_key: r.idempotency_key
    };
  });
  return fromEntries.concat(fromCanon);
}

function runChecks(data, sinceIso) {
  const allLedger = unifyLedger(data.entries, data.canonical);
  const recentTickets = (data.tickets || []).filter(function(t) { return inWindow(t.placed_at, sinceIso); });
  const gradedTickets = (data.tickets || []).filter(function(t) {
    const s = String(t.status || '').toLowerCase();
    if (!GRADED_STATUSES.has(s)) return false;
    return inWindow(t.graded_at, sinceIso) || inWindow(t.canceled_at, sinceIso)
      || (!t.graded_at && !t.canceled_at && inWindow(t.placed_at, sinceIso));
  });
  const recentLedger = allLedger.filter(function(r) { return inWindow(r.created_at, sinceIso); });
  const ledgerByTicket = indexByTicket(allLedger);
  const ticketIds = new Set((data.tickets || []).map(function(t) { return t.id; }));
  const typesSeen = [];
  const seen = {};
  allLedger.forEach(function(r) {
    const t = typeOf(r);
    if (t && !seen[t]) { seen[t] = true; typesSeen.push(t); }
  });
  const unknownTypes = typesSeen.filter(function(t) { return !KNOWN_TYPES.has(t); });
  const gaps = (data.gaps || []).slice();
  if (unknownTypes.length) gaps.push('unknown ledger event types: ' + unknownTypes.join(','));

  const checks = [
    checkBetPlacement(recentTickets, ledgerByTicket),
    checkGrading(gradedTickets, ledgerByTicket),
    checkBalances(data.members, data.tickets, allLedger),
    checkDiamonds(data.diamondBal, data.diamondLed),
    checkOrphans(recentLedger, ticketIds),
    checkDuplicates(data.entries, data.canonical, data.diamondLed)
  ];

  let issuesFound = 0, criticalCount = 0, warningCount = 0;
  const checkSummaries = {};
  checks.forEach(function(c) {
    issuesFound += c.issueCount;
    criticalCount += c.critical;
    warningCount += c.warning;
    checkSummaries[c.name] = {
      ok: c.ok,
      scanned: c.scanned,
      issueCount: c.issueCount,
      critical: c.critical,
      warning: c.warning
    };
  });

  return {
    checks: checks,
    checkSummaries: checkSummaries,
    issuesFound: issuesFound,
    criticalCount: criticalCount,
    warningCount: warningCount,
    typesSeen: typesSeen,
    unknownTypes: unknownTypes,
    gaps: gaps,
    windowStart: sinceIso
  };
}

async function runDailyAudit(sb, opts) {
  const optsSafe = opts || {};
  const now = optsSafe.now || new Date();
  const nowIso = now.toISOString();
  const sinceIso = new Date(now.getTime() - MS_DAY).toISOString();
  const auditType = optsSafe.auditType === 'manual' ? 'manual' : 'daily';
  const triggeredBy = optsSafe.triggeredBy || 'scheduler';
  const data = await loadTables(sb);
  const computed = runChecks(data, sinceIso);
  const results = {
    windowStart: sinceIso,
    windowEnd: nowIso,
    eventTypesMatched: {
      placement: Array.from(PLACEMENT_TYPES),
      win: Array.from(WIN_TYPES),
      loss: Array.from(LOSS_TYPES),
      push: Array.from(PUSH_TYPES),
      voidCancel: Array.from(VOID_CANCEL_TYPES),
      canonical: CANONICAL_EVENT_TYPES
    },
    eventTypesSeen: computed.typesSeen,
    unknownEventTypes: computed.unknownTypes,
    gaps: computed.gaps,
    checks: computed.checks,
    readOnly: true
  };
  return {
    runAt: nowIso,
    auditType: auditType,
    triggeredBy: triggeredBy,
    checksRun: computed.checks.length,
    issuesFound: computed.issuesFound,
    criticalCount: computed.criticalCount,
    warningCount: computed.warningCount,
    checkSummaries: computed.checkSummaries,
    results: results
  };
}

async function persistAuditLog(sb, result) {
  const row = {
    run_at: result.runAt,
    audit_type: result.auditType,
    checks_run: result.checksRun,
    issues_found: result.issuesFound,
    critical_count: result.criticalCount,
    warning_count: result.warningCount,
    results_json: result.results,
    triggered_by: result.triggeredBy
  };
  const { data, error } = await sb.from('audit_log').insert(row).select('id,run_at').limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

async function runAndPersist(sb, opts) {
  const result = await runDailyAudit(sb, opts);
  let persisted = null;
  let persistError = null;
  try {
    persisted = await persistAuditLog(sb, result);
  } catch (e) {
    persistError = e.message || String(e);
    console.warn('[DAILY_AUDIT] persist failed: ' + persistError);
  }
  return {
    result: result,
    persisted: persisted,
    summary: {
      ok: !persistError,
      id: persisted && persisted.id,
      runAt: result.runAt,
      auditType: result.auditType,
      checksRun: result.checksRun,
      issuesFound: result.issuesFound,
      criticalCount: result.criticalCount,
      warningCount: result.warningCount,
      checks: result.checkSummaries,
      triggeredBy: result.triggeredBy,
      persistError: persistError,
      gaps: result.results && result.results.gaps
    }
  };
}

let _auditTimer = null;

function startScheduler(opts) {
  const options = opts || {};
  const getSb = options.getSupabase;
  const schedule = options.setTimeoutFn || setTimeout;
  if (process.env.DAILY_AUDIT_DISABLED === 'true') {
    console.log('[DAILY_AUDIT] disabled');
    return { delayMs: null, disabled: true };
  }
  const tick = async function() {
    try {
      const sb = typeof getSb === 'function' ? getSb() : null;
      if (!sb) console.warn('[DAILY_AUDIT] skipped supabase_not_configured');
      else {
        const out = await runAndPersist(sb, { auditType: 'daily', triggeredBy: 'scheduler' });
        console.log('[DAILY_AUDIT] completed issues=' + out.summary.issuesFound
          + ' critical=' + out.summary.criticalCount + ' id=' + (out.summary.id || 'unpersisted'));
      }
    } catch (e) {
      console.warn('[DAILY_AUDIT] tick=' + e.message);
    }
    const delay = msUntilNext4amUtc();
    _auditTimer = schedule(tick, delay);
    console.log('[DAILY_AUDIT] next run in ' + delay + 'ms (04:00 UTC)');
  };
  const delay = msUntilNext4amUtc();
  _auditTimer = schedule(tick, delay);
  console.log('[DAILY_AUDIT] scheduled in ' + delay + 'ms (next 04:00 UTC)');
  return { delayMs: delay, disabled: false };
}

module.exports = {
  CANONICAL_EVENT_TYPES,
  PLACEMENT_TYPES,
  WIN_TYPES,
  LOSS_TYPES,
  PUSH_TYPES,
  VOID_CANCEL_TYPES,
  msUntilNext4amUtc,
  dashboardAvailable,
  ledgerSum,
  checkBetPlacement,
  checkGrading,
  checkBalances,
  checkDiamonds,
  checkOrphans,
  checkDuplicates,
  runDailyAudit,
  persistAuditLog,
  runAndPersist,
  startScheduler
};
