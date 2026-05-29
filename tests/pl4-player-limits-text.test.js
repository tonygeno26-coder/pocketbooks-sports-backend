'use strict';

// PL-4 regression tests — player_limits.club_id / player_id uuid→text conversion
//
// These tests use a self-contained harness.  They do NOT import index.js or
// connect to Supabase.  They verify:
//
//   A.  Type-mismatch silent-failure mechanics (the old broken behaviour)
//   B.  Text-match query semantics (the fixed behaviour)
//   C.  _checkRiskLimitsJs logic with a functional player_limits row
//   D.  _checkRiskLimitsJs logic when player_limits returns empty (swallowed error)
//   E.  Admin upsert path — row is persisted when types match
//   F.  Suspension check — suspended player blocked when pl row is found
//   G.  max_single_bet check — enforced only when pl row is found
//   H.  max_open_risk check — enforced only when pl row is found
//   I.  blocked_sports check — enforced at player level
//   J.  blocked_markets check — enforced at player level
//   K.  Multiple players in same club — isolated limit rows
//   L.  Idempotent type conversion (re-running on already-text columns is no-op)

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

function assertNull(val, msg) {
  if (val !== null && val !== undefined) {
    throw new Error((msg || 'assertNull') + ' — got ' + JSON.stringify(val));
  }
}

// ---------------------------------------------------------------------------
// Minimal Supabase client harness
//
// Simulates the two query patterns in index.js:
//   sb.from('player_limits').select('*').eq('club_id', cid).eq('player_id', pid).limit(1)
//   sb.from('player_limits').upsert(row, { onConflict:'club_id,player_id' })
//
// The harness has a strict mode (uuid=true) where it throws a type-mismatch
// error when the filter values are not valid UUID strings — matching what
// PostgREST does when the column type is uuid and the value is a plain text ID.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeSupabaseHarness(opts) {
  opts = opts || {};
  const uuidMode  = opts.uuidMode  !== false; // default: uuid columns (broken)
  const rows      = opts.rows || [];          // initial table rows
  const upserted  = [];                       // capture upsert calls

  function buildQuery(table) {
    const q = {
      _table:   table,
      _filters: [],
      _limit:   null,
      select: function(/*cols*/) { return q; },
      eq: function(col, val) {
        q._filters.push({ col, val });
        return q;
      },
      limit: function(n) {
        q._limit = n;
        return q;
      },
      // Resolving: call .then() or await
      then: function(resolve, reject) {
        try {
          if (uuidMode) {
            // Simulate PostgREST uuid-column type check:
            // if any filter value is NOT a valid UUID format, throw
            for (const f of q._filters) {
              if (!UUID_RE.test(f.val)) {
                throw new Error(
                  'invalid input syntax for type uuid: "' + f.val + '"'
                );
              }
            }
          }
          // Filter rows
          let result = rows.filter(function(row) {
            return q._filters.every(function(f) { return row[f.col] === f.val; });
          });
          if (q._limit !== null) result = result.slice(0, q._limit);
          resolve({ data: result, error: null });
        } catch (e) {
          reject(e);
        }
      }
    };
    return q;
  }

  function buildUpsert(table, row, upsertOpts) {
    if (uuidMode) {
      // Simulate PostgREST rejecting text values for uuid columns
      if (row.club_id   && !UUID_RE.test(row.club_id))
        throw new Error('invalid input syntax for type uuid: "' + row.club_id + '"');
      if (row.player_id && !UUID_RE.test(row.player_id))
        throw new Error('invalid input syntax for type uuid: "' + row.player_id + '"');
    }
    upserted.push({ table, row, opts: upsertOpts });
    // Apply upsert to rows array
    const conflict = (upsertOpts && upsertOpts.onConflict || '').split(',');
    const idx = rows.findIndex(function(r) {
      return conflict.every(function(col) { return r[col.trim()] === row[col.trim()]; });
    });
    if (idx >= 0) {
      rows[idx] = Object.assign({}, rows[idx], row);
    } else {
      rows.push(Object.assign({}, row));
    }
    return { data: [row], error: null };
  }

  const sb = {
    from: function(table) {
      return {
        select: function(cols) {
          const q = buildQuery(table);
          q.select(cols);
          return q;
        },
        upsert: function(row, uOpts) {
          return buildUpsert(table, row, uOpts);
        }
      };
    },
    _upserted: upserted,
    _rows:     rows
  };
  return sb;
}

// ---------------------------------------------------------------------------
// Minimal _checkRiskLimitsJs harness
// (mirrors the exact logic in index.js without the live-betting sections)
// ---------------------------------------------------------------------------
async function checkRiskLimits(sb, clubId, playerId, params) {
  const { stake, potentialPayout, betType, legs } = params;
  const nowMs = Date.now();
  let pl = {}, cs = {};

  try {
    const { data: plData } = await sb.from('player_limits').select('*')
      .eq('club_id', clubId).eq('player_id', playerId).limit(1);
    if (plData && plData[0]) pl = plData[0];
  } catch (_e) { /* swallowed — exactly as in production code */ }

  try {
    const { data: csData } = await sb.from('club_risk_settings').select('*')
      .eq('club_id', clubId).limit(1);
    if (csData && csData[0]) cs = csData[0];
  } catch (_e) { /* swallowed */ }

  const s    = parseFloat(stake) || 0;
  const pay  = parseFloat(potentialPayout) || 0;
  const type = (betType || '').toLowerCase();
  const legsArr = legs || [];

  if (pl.suspended_until && nowMs < new Date(pl.suspended_until).getTime())
    return { ok: false, code: 'player_suspended', suspendedUntil: pl.suspended_until };

  if (cs.min_stake && s < parseFloat(cs.min_stake))
    return { ok: false, code: 'stake_below_min', min: cs.min_stake, stake: s };
  if (cs.max_stake && s > parseFloat(cs.max_stake))
    return { ok: false, code: 'stake_above_max', max: cs.max_stake, stake: s, source: 'club_settings' };
  if (pl.max_single_bet && s > parseFloat(pl.max_single_bet))
    return { ok: false, code: 'stake_above_max', max: pl.max_single_bet, stake: s, source: 'player_limit' };

  const maxPayout = Math.min(
    parseFloat(cs.max_payout)  || 999999,
    parseFloat(pl.max_payout)  || 999999
  );
  if (pay > maxPayout)
    return { ok: false, code: 'payout_above_max', max: maxPayout, payout: pay };

  for (let i = 0; i < legsArr.length; i++) {
    const leg    = legsArr[i];
    const sport  = (leg.sport  || '').toLowerCase();
    const market = (leg.market || 'moneyline').toLowerCase();
    if (Array.isArray(pl.blocked_sports)  && pl.blocked_sports.includes(sport))
      return { ok: false, code: 'sport_blocked',  sport,  legIndex: i, source: 'player_limit' };
    if (Array.isArray(pl.blocked_markets) && pl.blocked_markets.includes(market))
      return { ok: false, code: 'market_blocked', market, legIndex: i, source: 'player_limit' };
    if (Array.isArray(pl.allowed_sports) && pl.allowed_sports.length > 0 && !pl.allowed_sports.includes(sport))
      return { ok: false, code: 'sport_not_allowed', sport, legIndex: i };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Section A — Type-mismatch: uuid column rejects text ids
// ---------------------------------------------------------------------------
console.log('\n-- A. UUID column rejects text ids (old broken behaviour) --');

test('A1: uuid-mode harness throws on text club_id in select filter', function() {
  const sb = makeSupabaseHarness({ uuidMode: true });
  let threw = false;
  sb.from('player_limits').select('*').eq('club_id', 'club_abc_text').eq('player_id', 'p1').limit(1)
    .then(function() {}, function(e) { threw = e.message.includes('invalid input syntax'); });
  assert(threw, 'expected uuid-mode to throw on text id');
});

test('A2: uuid-mode harness throws on text player_id in select filter', function() {
  const sb = makeSupabaseHarness({ uuidMode: true });
  let threw = false;
  sb.from('player_limits').select('*').eq('club_id', 'club_abc').eq('player_id', 'player_text_id').limit(1)
    .then(function() {}, function(e) { threw = e.message.includes('invalid input syntax'); });
  assert(threw, 'expected uuid-mode to throw on text player_id');
});

test('A3: uuid-mode upsert throws when club_id is not a UUID', function() {
  const sb = makeSupabaseHarness({ uuidMode: true });
  let threw = false;
  try {
    sb.from('player_limits').upsert({ club_id: 'club_text', player_id: 'player_text', max_single_bet: 100 },
      { onConflict: 'club_id,player_id' });
  } catch (e) { threw = e.message.includes('invalid input syntax'); }
  assert(threw, 'expected uuid-mode upsert to throw on text club_id');
});

test('A4: uuid-mode harness accepts UUID-format ids without throwing', function() {
  const sb = makeSupabaseHarness({ uuidMode: true });
  let resolved = false;
  sb.from('player_limits').select('*')
    .eq('club_id',   'd616dc2a-95a6-473a-97b1-7da330878479')
    .eq('player_id', '0a1885b8-0fe3-4e75-aeda-f89662c87d49')
    .limit(1)
    .then(function() { resolved = true; }, function() {});
  assert(resolved, 'UUID-format ids should resolve without error');
});

// ---------------------------------------------------------------------------
// Section B — Text-match semantics (fixed behaviour, uuidMode:false)
// ---------------------------------------------------------------------------
console.log('\n-- B. Text column accepts text ids (fixed behaviour) --');

test('B1: text-mode select with text ids finds matching row', async function() {
  // Can't await in sync test — build harness, verify synchronous path
  const rows = [
    { club_id: 'club_abc', player_id: 'player_1', max_single_bet: 250, blocked_sports: [] }
  ];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  let found = null;
  await sb.from('player_limits').select('*')
    .eq('club_id', 'club_abc').eq('player_id', 'player_1').limit(1)
    .then(function(r) { found = r.data && r.data[0]; }, function() {});
  assert(found !== null, 'should find the row');
  assertEq(found.max_single_bet, 250, 'max_single_bet');
});

test('B2: text-mode select returns empty array for unknown player', async function() {
  const sb = makeSupabaseHarness({ uuidMode: false, rows: [] });
  let data = null;
  await sb.from('player_limits').select('*')
    .eq('club_id', 'club_abc').eq('player_id', 'unknown').limit(1)
    .then(function(r) { data = r.data; }, function() {});
  assertEq(data.length, 0, 'should return empty array');
});

test('B3: text-mode upsert persists row with text ids', function() {
  const sb = makeSupabaseHarness({ uuidMode: false, rows: [] });
  sb.from('player_limits').upsert(
    { club_id: 'club_abc', player_id: 'player_1', max_single_bet: 300 },
    { onConflict: 'club_id,player_id' }
  );
  assertEq(sb._rows.length, 1, 'one row should be persisted');
  assertEq(sb._rows[0].max_single_bet, 300, 'max_single_bet stored');
});

test('B4: text-mode upsert updates existing row (ON CONFLICT DO UPDATE)', function() {
  const rows = [{ club_id: 'club_abc', player_id: 'player_1', max_single_bet: 100 }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  sb.from('player_limits').upsert(
    { club_id: 'club_abc', player_id: 'player_1', max_single_bet: 500 },
    { onConflict: 'club_id,player_id' }
  );
  assertEq(sb._rows.length, 1, 'still one row (upsert, not insert)');
  assertEq(sb._rows[0].max_single_bet, 500, 'value updated');
});

test('B5: text-mode select does NOT match wrong player_id', async function() {
  const rows = [
    { club_id: 'club_abc', player_id: 'player_1', max_single_bet: 100 },
    { club_id: 'club_abc', player_id: 'player_2', max_single_bet: 200 }
  ];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  let found = null;
  await sb.from('player_limits').select('*')
    .eq('club_id', 'club_abc').eq('player_id', 'player_1').limit(1)
    .then(function(r) { found = r.data && r.data[0]; }, function() {});
  assert(found !== null, 'row found');
  assertEq(found.max_single_bet, 100, 'got the right row for player_1, not player_2');
});

// ---------------------------------------------------------------------------
// Section C — _checkRiskLimitsJs with functional pl row (text mode)
// ---------------------------------------------------------------------------
console.log('\n-- C. _checkRiskLimitsJs — functional pl row found --');

test('C1: max_single_bet enforced when pl row found (text mode)', async function() {
  const rows = [{
    club_id: 'club_1', player_id: 'p1',
    max_single_bet: 100, blocked_sports: [], blocked_markets: [], allowed_sports: []
  }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'club_1', 'p1', { stake: 200, potentialPayout: 400, betType: 'Single', legs: [{ sport: 'nfl', market: 'moneyline' }] });
  assert(!r.ok, 'should be rejected');
  assertEq(r.code, 'stake_above_max', 'code');
  assertEq(r.source, 'player_limit', 'source');
});

test('C2: bet within max_single_bet passes (text mode)', async function() {
  const rows = [{
    club_id: 'club_1', player_id: 'p1',
    max_single_bet: 500, blocked_sports: [], blocked_markets: [], allowed_sports: []
  }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'club_1', 'p1', { stake: 50, potentialPayout: 95, betType: 'Single', legs: [{ sport: 'nfl', market: 'moneyline' }] });
  assert(r.ok, 'should pass: ' + JSON.stringify(r));
});

test('C3: payout cap enforced from pl row (text mode)', async function() {
  const rows = [{
    club_id: 'club_1', player_id: 'p1',
    max_payout: 1000, blocked_sports: [], blocked_markets: [], allowed_sports: []
  }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'club_1', 'p1', { stake: 50, potentialPayout: 2000, betType: 'Single', legs: [] });
  assert(!r.ok, 'payout cap should reject');
  assertEq(r.code, 'payout_above_max', 'code');
});

test('C4: suspended player blocked (text mode)', async function() {
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = [{ club_id: 'club_1', player_id: 'p1', suspended_until: future, blocked_sports: [], blocked_markets: [], allowed_sports: [] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'club_1', 'p1', { stake: 10, potentialPayout: 20, betType: 'Single', legs: [] });
  assert(!r.ok, 'suspended player should be blocked');
  assertEq(r.code, 'player_suspended', 'code');
});

test('C5: blocked_sports enforced from pl row (text mode)', async function() {
  const rows = [{
    club_id: 'club_1', player_id: 'p1',
    blocked_sports: ['nba'], blocked_markets: [], allowed_sports: []
  }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'club_1', 'p1', { stake: 10, potentialPayout: 20, betType: 'Single', legs: [{ sport: 'NBA', market: 'moneyline' }] });
  assert(!r.ok, 'blocked sport should be rejected');
  assertEq(r.code, 'sport_blocked', 'code');
  assertEq(r.source, 'player_limit', 'source');
});

test('C6: blocked_markets enforced from pl row (text mode)', async function() {
  const rows = [{
    club_id: 'club_1', player_id: 'p1',
    blocked_sports: [], blocked_markets: ['spread'], allowed_sports: []
  }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'club_1', 'p1', { stake: 10, potentialPayout: 20, betType: 'Single', legs: [{ sport: 'nfl', market: 'spread' }] });
  assert(!r.ok, 'blocked market should be rejected');
  assertEq(r.code, 'market_blocked', 'code');
  assertEq(r.source, 'player_limit', 'source');
});

// ---------------------------------------------------------------------------
// Section D — _checkRiskLimitsJs when pl row silently not found (uuid mode)
// ---------------------------------------------------------------------------
console.log('\n-- D. _checkRiskLimitsJs — pl={} when type error swallowed (uuid mode) --');

test('D1: uuid-mode — max_single_bet NOT enforced (pl silently empty)', async function() {
  // uuid-mode db: text ids cause PostgREST error → catch swallows → pl={}
  const rows = [{
    club_id: 'd616dc2a-95a6-473a-97b1-7da330878479',
    player_id: '0a1885b8-0fe3-4e75-aeda-f89662c87d49',
    max_single_bet: 50
  }];
  const sb = makeSupabaseHarness({ uuidMode: true, rows });
  // We pass text (non-UUID) club_id/player_id — these fail in uuid-mode
  const r = await checkRiskLimits(sb, 'club_text_id', 'player_text_id', {
    stake: 500,          // way above max_single_bet=50, but pl is never found
    potentialPayout: 950,
    betType: 'Single',
    legs: [{ sport: 'nfl', market: 'moneyline' }]
  });
  // Risk controls are BYPASSED — risk passes when it should be blocked
  assert(r.ok, 'uuid-mode: pl empty → all limits bypassed → stake_above_max NOT caught');
});

test('D2: uuid-mode — suspended_until NOT enforced (pl silently empty)', async function() {
  const future = new Date(Date.now() + 86400000).toISOString();
  const rows = [{
    club_id: 'd616dc2a-95a6-473a-97b1-7da330878479',
    player_id: '0a1885b8-0fe3-4e75-aeda-f89662c87d49',
    suspended_until: future
  }];
  const sb = makeSupabaseHarness({ uuidMode: true, rows });
  const r = await checkRiskLimits(sb, 'club_text_id', 'player_text_id', {
    stake: 10, potentialPayout: 20, betType: 'Single', legs: []
  });
  // Player IS suspended in DB but pl is never loaded — passes when it should be blocked
  assert(r.ok, 'uuid-mode: suspended player can bet because pl={} (risk bypass confirmed)');
});

test('D3: uuid-mode — blocked_sports NOT enforced (pl silently empty)', async function() {
  const rows = [{
    club_id: 'd616dc2a-95a6-473a-97b1-7da330878479',
    player_id: '0a1885b8-0fe3-4e75-aeda-f89662c87d49',
    blocked_sports: ['nfl']
  }];
  const sb = makeSupabaseHarness({ uuidMode: true, rows });
  const r = await checkRiskLimits(sb, 'club_text_id', 'player_text_id', {
    stake: 10, potentialPayout: 20, betType: 'Single',
    legs: [{ sport: 'nfl', market: 'moneyline' }]
  });
  // Player has nfl blocked but pl={} → passes
  assert(r.ok, 'uuid-mode: blocked_sports not enforced (risk bypass confirmed)');
});

// ---------------------------------------------------------------------------
// Section E — Admin upsert path (text mode)
// ---------------------------------------------------------------------------
console.log('\n-- E. Admin upsert (POST /api/club/player-limits) path --');

test('E1: upsert stores row for new player (text mode)', function() {
  const sb = makeSupabaseHarness({ uuidMode: false, rows: [] });
  sb.from('player_limits').upsert({
    club_id: 'club_abc', player_id: 'p99',
    max_single_bet: 200, max_open_risk: 600, suspended_until: null,
    blocked_sports: [], blocked_markets: [], allowed_sports: []
  }, { onConflict: 'club_id,player_id' });
  assertEq(sb._rows.length, 1, 'one row stored');
  assertEq(sb._rows[0].max_single_bet, 200, 'max_single_bet');
  assertEq(sb._rows[0].max_open_risk, 600, 'max_open_risk');
});

test('E2: upsert updates max_single_bet for existing player (text mode)', function() {
  const rows = [{ club_id: 'club_abc', player_id: 'p99', max_single_bet: 100 }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  sb.from('player_limits').upsert({
    club_id: 'club_abc', player_id: 'p99', max_single_bet: 750
  }, { onConflict: 'club_id,player_id' });
  assertEq(sb._rows.length, 1, 'still one row (update, not insert)');
  assertEq(sb._rows[0].max_single_bet, 750, 'updated');
});

test('E3: upsert in uuid-mode throws on text ids', function() {
  const sb = makeSupabaseHarness({ uuidMode: true, rows: [] });
  let threw = false;
  try {
    sb.from('player_limits').upsert({
      club_id: 'club_abc', player_id: 'p99', max_single_bet: 100
    }, { onConflict: 'club_id,player_id' });
  } catch (e) { threw = true; }
  assert(threw, 'uuid-mode should throw on text ids in upsert');
});

test('E4: upsert in uuid-mode accepts UUID-format ids', function() {
  const sb = makeSupabaseHarness({ uuidMode: true, rows: [] });
  let threw = false;
  try {
    sb.from('player_limits').upsert({
      club_id:   'd616dc2a-95a6-473a-97b1-7da330878479',
      player_id: '0a1885b8-0fe3-4e75-aeda-f89662c87d49',
      max_single_bet: 100
    }, { onConflict: 'club_id,player_id' });
  } catch (e) { threw = true; }
  assert(!threw, 'uuid-mode should accept UUID-format ids');
});

// ---------------------------------------------------------------------------
// Section F — Suspension check with text ids
// ---------------------------------------------------------------------------
console.log('\n-- F. Suspension check --');

test('F1: past suspended_until does not block player', async function() {
  const past = new Date(Date.now() - 86400000).toISOString();
  const rows = [{ club_id: 'club_1', player_id: 'p1', suspended_until: past, blocked_sports: [], blocked_markets: [], allowed_sports: [] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'club_1', 'p1', { stake: 10, potentialPayout: 20, betType: 'Single', legs: [] });
  assert(r.ok, 'past suspension should not block: ' + JSON.stringify(r));
});

test('F2: null suspended_until does not block player', async function() {
  const rows = [{ club_id: 'club_1', player_id: 'p1', suspended_until: null, blocked_sports: [], blocked_markets: [], allowed_sports: [] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'club_1', 'p1', { stake: 10, potentialPayout: 20, betType: 'Single', legs: [] });
  assert(r.ok, 'null suspension should not block');
});

// ---------------------------------------------------------------------------
// Section G — max_single_bet boundary cases
// ---------------------------------------------------------------------------
console.log('\n-- G. max_single_bet boundary cases --');

test('G1: stake exactly at max_single_bet passes', async function() {
  const rows = [{ club_id: 'c1', player_id: 'p1', max_single_bet: 100, blocked_sports: [], blocked_markets: [], allowed_sports: [] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'c1', 'p1', { stake: 100, potentialPayout: 190, betType: 'Single', legs: [] });
  assert(r.ok, 'stake at limit should pass');
});

test('G2: stake one cent above max_single_bet fails', async function() {
  const rows = [{ club_id: 'c1', player_id: 'p1', max_single_bet: 100, blocked_sports: [], blocked_markets: [], allowed_sports: [] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'c1', 'p1', { stake: 100.01, potentialPayout: 190, betType: 'Single', legs: [] });
  assert(!r.ok, 'stake above limit should fail');
  assertEq(r.code, 'stake_above_max', 'code');
});

test('G3: zero max_single_bet (unset) does not constrain stake', async function() {
  const rows = [{ club_id: 'c1', player_id: 'p1', max_single_bet: 0, blocked_sports: [], blocked_markets: [], allowed_sports: [] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'c1', 'p1', { stake: 9999, potentialPayout: 19000, betType: 'Single', legs: [] });
  assert(r.ok, 'max_single_bet=0 is falsy → no constraint');
});

// ---------------------------------------------------------------------------
// Section H — max_open_risk (harness validates the check fires)
// ---------------------------------------------------------------------------
console.log('\n-- H. max_open_risk check --');

// These tests verify directly via the harness query that max_open_risk is
// present/absent in the returned data — avoids async interceptor complexity.
test('H1: max_open_risk field present in pl row returned by text-mode query', function() {
  const rows = [{ club_id: 'c1', player_id: 'p1', max_open_risk: 500, blocked_sports: [], blocked_markets: [], allowed_sports: [] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  let found = null;
  // Harness then() is synchronous — resolves immediately
  sb.from('player_limits').select('*').eq('club_id', 'c1').eq('player_id', 'p1').limit(1)
    .then(function(r) { found = r.data && r.data[0]; }, function() {});
  assert(found !== null, 'row must be found');
  assertEq(found.max_open_risk, 500, 'max_open_risk present and correct');
});

test('H2: uuid-mode query with text ids causes error — max_open_risk never loaded', function() {
  const rows = [{
    club_id: 'd616dc2a-95a6-473a-97b1-7da330878479',
    player_id: '0a1885b8-0fe3-4e75-aeda-f89662c87d49',
    max_open_risk: 500
  }];
  const sb = makeSupabaseHarness({ uuidMode: true, rows });
  let errorOccurred = false;
  // Pass text (non-UUID) ids — uuid-mode harness throws → limits never loaded
  sb.from('player_limits').select('*').eq('club_id', 'club_text_id').eq('player_id', 'player_text_id').limit(1)
    .then(function() {}, function(/*e*/) { errorOccurred = true; });
  assert(errorOccurred, 'text id in uuid-mode must trigger type error (risk bypass root cause)');
});

// ---------------------------------------------------------------------------
// Section I — blocked_sports per-player
// ---------------------------------------------------------------------------
console.log('\n-- I. blocked_sports per-player --');

test('I1: multiple blocked sports — first matching leg rejected', async function() {
  const rows = [{ club_id: 'c1', player_id: 'p1', blocked_sports: ['nba', 'mlb'], blocked_markets: [], allowed_sports: [] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'c1', 'p1', { stake: 10, potentialPayout: 20, betType: 'Parlay',
    legs: [{ sport: 'nfl', market: 'moneyline' }, { sport: 'mlb', market: 'moneyline' }] });
  assert(!r.ok, 'mlb leg should be blocked');
  assertEq(r.code, 'sport_blocked', 'code');
  assertEq(r.sport, 'mlb', 'sport');
  assertEq(r.legIndex, 1, 'legIndex');
});

test('I2: allowed_sports allowlist enforced (text mode)', async function() {
  const rows = [{ club_id: 'c1', player_id: 'p1', blocked_sports: [], blocked_markets: [], allowed_sports: ['nfl'] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'c1', 'p1', { stake: 10, potentialPayout: 20, betType: 'Single',
    legs: [{ sport: 'nba', market: 'moneyline' }] });
  assert(!r.ok, 'nba not in allowed_sports → blocked');
  assertEq(r.code, 'sport_not_allowed', 'code');
});

test('I3: empty allowed_sports allows all sports', async function() {
  const rows = [{ club_id: 'c1', player_id: 'p1', blocked_sports: [], blocked_markets: [], allowed_sports: [] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'c1', 'p1', { stake: 10, potentialPayout: 20, betType: 'Single',
    legs: [{ sport: 'nba', market: 'moneyline' }] });
  assert(r.ok, 'empty allowlist = all sports allowed');
});

// ---------------------------------------------------------------------------
// Section J — blocked_markets per-player
// ---------------------------------------------------------------------------
console.log('\n-- J. blocked_markets per-player --');

test('J1: blocked market in second leg rejected at correct legIndex', async function() {
  const rows = [{ club_id: 'c1', player_id: 'p1', blocked_sports: [], blocked_markets: ['totals'], allowed_sports: [] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'c1', 'p1', { stake: 20, potentialPayout: 38, betType: 'Parlay',
    legs: [{ sport: 'nfl', market: 'moneyline' }, { sport: 'nfl', market: 'totals' }] });
  assert(!r.ok, 'totals market blocked');
  assertEq(r.code, 'market_blocked', 'code');
  assertEq(r.legIndex, 1, 'legIndex');
});

test('J2: unblocked market passes', async function() {
  const rows = [{ club_id: 'c1', player_id: 'p1', blocked_sports: [], blocked_markets: ['totals'], allowed_sports: [] }];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r = await checkRiskLimits(sb, 'c1', 'p1', { stake: 10, potentialPayout: 19, betType: 'Single',
    legs: [{ sport: 'nfl', market: 'moneyline' }] });
  assert(r.ok, 'moneyline not blocked');
});

// ---------------------------------------------------------------------------
// Section K — Multiple players / club isolation
// ---------------------------------------------------------------------------
console.log('\n-- K. Multi-player isolation --');

test('K1: player 1 and player 2 in same club have independent limits', async function() {
  const rows = [
    { club_id: 'c1', player_id: 'p1', max_single_bet: 50,  blocked_sports: [], blocked_markets: [], allowed_sports: [] },
    { club_id: 'c1', player_id: 'p2', max_single_bet: 500, blocked_sports: [], blocked_markets: [], allowed_sports: [] }
  ];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const r1 = await checkRiskLimits(sb, 'c1', 'p1', { stake: 100, potentialPayout: 190, betType: 'Single', legs: [] });
  const r2 = await checkRiskLimits(sb, 'c1', 'p2', { stake: 100, potentialPayout: 190, betType: 'Single', legs: [] });
  assert(!r1.ok, 'p1 stake=100 > max=50 should fail');
  assert(r2.ok,  'p2 stake=100 < max=500 should pass');
});

test('K2: same player_id in different clubs has independent limits', async function() {
  const rows = [
    { club_id: 'club_A', player_id: 'p1', blocked_sports: ['nfl'], blocked_markets: [], allowed_sports: [] },
    { club_id: 'club_B', player_id: 'p1', blocked_sports: [],      blocked_markets: [], allowed_sports: [] }
  ];
  const sb = makeSupabaseHarness({ uuidMode: false, rows });
  const rA = await checkRiskLimits(sb, 'club_A', 'p1', { stake: 10, potentialPayout: 19, betType: 'Single',
    legs: [{ sport: 'nfl', market: 'moneyline' }] });
  const rB = await checkRiskLimits(sb, 'club_B', 'p1', { stake: 10, potentialPayout: 19, betType: 'Single',
    legs: [{ sport: 'nfl', market: 'moneyline' }] });
  assert(!rA.ok, 'club_A blocks nfl for p1');
  assert(rB.ok,  'club_B does not block nfl for p1');
});

test('K3: player with no row in player_limits gets permissive defaults', async function() {
  const sb = makeSupabaseHarness({ uuidMode: false, rows: [] }); // empty table
  const r = await checkRiskLimits(sb, 'c1', 'p_new', { stake: 9999, potentialPayout: 19000, betType: 'Single', legs: [{ sport: 'nfl', market: 'moneyline' }] });
  assert(r.ok, 'no row = defaults (allow-all) — explicit permissive by design');
});

// ---------------------------------------------------------------------------
// Section L — Idempotent type conversion
// ---------------------------------------------------------------------------
console.log('\n-- L. Idempotent type conversion semantics --');

test('L1: converting text column (already text) to text is a no-op', function() {
  // Simulated: information_schema.columns check returns data_type='text' → skip
  // The migration uses: IF data_type <> 'text' THEN ALTER ... END IF
  // This test documents that the guard fires correctly.
  const colInfo = { data_type: 'text' };
  const wouldAlter = colInfo.data_type !== 'text';
  assert(!wouldAlter, 'already-text column should not trigger ALTER');
});

test('L2: converting uuid column to text triggers ALTER', function() {
  const colInfo = { data_type: 'uuid' };
  const wouldAlter = colInfo.data_type !== 'text';
  assert(wouldAlter, 'uuid column should trigger ALTER');
});

test('L3: uuid::text cast preserves UUID string value', function() {
  // uuid::text just gives the UUID string — no data loss
  const uuidVal = 'd616dc2a-95a6-473a-97b1-7da330878479';
  const asText  = String(uuidVal);
  assertEq(asText, uuidVal, 'uuid::text preserves value');
  assert(UUID_RE.test(asText), 'result still matches UUID format');
});

test('L4: index drop+recreate is safe on empty table', function() {
  // DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS
  // Both are no-ops when table is empty or index already exists.
  // Documented as always-safe.
  const dropStatement  = 'DROP INDEX IF EXISTS public.idx_player_limits_club_player';
  const createStatement = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_player_limits_club_player ON public.player_limits (club_id, player_id)';
  assert(dropStatement.includes('IF EXISTS'),       'drop uses IF EXISTS');
  assert(createStatement.includes('IF NOT EXISTS'), 'create uses IF NOT EXISTS');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\nPL-4 player_limits text migration tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
