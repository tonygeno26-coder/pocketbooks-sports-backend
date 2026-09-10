'use strict';
/**
 * Designated Test Club only — minimal-stake idempotency cutover smoke.
 * Never prints tokens.
 */
const BASE = process.env.PLACE_BET_BASE
  || 'https://pocketbooks-sports-backend-production.up.railway.app';
const ACTOR_A = '2a3e6819-be2f-4df3-8112-54ce19d0929e';
const ACTOR_B = '0a1885b8-0fe3-4e75-aeda-f89662c87d49';
const CLUB = 'd616dc2a-95a6-473a-97b1-7da330878479';

async function http(method, path, body, token, extra) {
  const headers = Object.assign({
    'Content-Type': 'application/json',
    'X-Club-Id': CLUB
  }, extra || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  if (method === 'POST' && path.indexOf('/api/bets/') === 0) {
    headers['Idempotency-Key'] = (body && body.idempotencyKey) || ('IK_' + Date.now());
  }
  const ac = new AbortController();
  const t = setTimeout(function () { ac.abort(); }, 20000);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text.slice(0, 300) }; }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(t);
  }
}

function amToDec(o) {
  const n = Number(o);
  if (!n) return 1;
  return n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1;
}

function payout(stake, legs) {
  const product = legs.reduce((p, l) => p * amToDec(l.odds), 1);
  return Math.round(stake * product * 100) / 100;
}

function toIso(v) {
  if (!v) return null;
  const ms = new Date(v).getTime();
  if (isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function isUpcoming(game, nowMs) {
  const status = String(game.status || '').toLowerCase();
  if (status === 'live' || status === 'final' || status === 'canceled' || status === 'cancelled') return false;
  const iso = toIso(game.scheduledStart || game.time);
  if (!iso) return false;
  return new Date(iso).getTime() > nowMs + 60 * 1000;
}

function mlLeg(game) {
  const ml = (game.moneyline || []).find(function (m) { return m && m.odds; });
  if (!ml) return null;
  const iso = toIso(game.scheduledStart || game.time || ml.scheduledStart);
  if (!iso) return null;
  return {
    pick: String(ml.team || ml.name || '').replace(/\s+to\s+win\s*$/i, '').trim(),
    market: 'moneyline',
    odds: Number(ml.odds),
    line: null,
    canonicalGameKey: String(game.canonicalGameKey || ml.canonicalGameKey || ''),
    scheduledStart: iso,
    gameId: String(game.id || game.providerGameId || '')
  };
}

function totalLeg(game) {
  const ov = (game.totals || []).find(function (t) { return t && /over/i.test(t.name || ''); })
    || (game.totals || []).find(function (t) { return t && t.odds; });
  if (!ov || ov.line == null || !ov.odds) return null;
  const iso = toIso(game.scheduledStart || game.time || ov.scheduledStart);
  if (!iso) return null;
  return {
    pick: 'Over ' + ov.line,
    market: 'total',
    odds: Number(ov.odds),
    line: Number(ov.line),
    canonicalGameKey: String(game.canonicalGameKey || ov.canonicalGameKey || ''),
    scheduledStart: iso,
    gameId: String(game.id || game.providerGameId || '')
  };
}

async function mint(actorId) {
  const r = await http('POST', '/api/auth/token', { actorId, clubId: CLUB });
  if (r.status !== 200 || !r.body || !r.body.token) throw new Error('mint failed ' + r.status);
  return r.body.token;
}

async function loadGames(token) {
  const sports = ['mlb', 'nba', 'nhl', 'nfl'];
  let games = [];
  for (const s of sports) {
    const r = await http('GET', '/api/odds/' + s, null, token);
    if (r.status === 200 && Array.isArray(r.body)) games = games.concat(r.body);
    else if (r.body && Array.isArray(r.body.games)) games = games.concat(r.body.games);
  }
  return games.filter(function (g) { return isUpcoming(g, Date.now()); });
}

function placePayload(playerId, betType, legs, stake, key) {
  const po = payout(stake, legs);
  return {
    clubId: CLUB,
    playerId,
    betType,
    stake,
    payout: po,
    potentialProfit: Math.round((po - stake) * 100) / 100,
    idempotencyKey: key,
    legs
  };
}

async function placeAvoidingConflict(token, playerId, candidates, stake, keyPrefix) {
  const blocked = {};
  const maxTries = Math.min(candidates.length, 12);
  let last = null;
  for (let i = 0; i < maxTries; i++) {
    const leg = candidates[i];
    if (!leg || !leg.canonicalGameKey) continue;
    if (blocked[leg.canonicalGameKey]) continue;
    process.stderr.write('place_try ' + keyPrefix + ' i=' + i + ' game=' + leg.canonicalGameKey.slice(0, 48) + '\n');
    const key = keyPrefix + '_' + Date.now() + '_' + i;
    const body = placePayload(playerId, 'Single', [leg], stake, key);
    const r = await http('POST', '/api/bets/place', body, token);
    last = { r, body, leg, key };
    if (r.status === 200 && r.body && r.body.ok) {
      return last;
    }
    if (r.status === 409 && /conflict_active_bet/.test(String(r.body && r.body.error || ''))) {
      blocked[leg.canonicalGameKey] = true;
      continue;
    }
    if (r.status === 409 && r.body && r.body.code === 'odds_changed' && Number.isFinite(Number(r.body.serverOdds))) {
      body.legs[0].odds = Number(r.body.serverOdds);
      body.idempotencyKey = key + '_oa';
      body.payout = payout(stake, body.legs);
      const r2 = await http('POST', '/api/bets/place', body, token);
      last = { r: r2, body, leg: body.legs[0], key: body.idempotencyKey };
      if (r2.status === 200 && r2.body && r2.body.ok) return last;
    }
  }
  return last;
}

function extractTickets(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.tickets)) return payload.tickets;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

async function main() {
  const out = {
    health: null,
    exactRetry: null,
    concurrent2x: null,
    changedRequest: null,
    correlation: null,
    cancel: null,
    authAB: null,
    authBA: null,
    ticketIds: []
  };

  const health = await http('GET', '/api/health', null, null);
  out.health = {
    status: health.status,
    sha: health.body && (health.body.gitSha || health.body.bakedSHA),
    ok: !!(health.body && health.body.ok)
  };
  if (!String(out.health.sha || '').startsWith('55b52d1')) {
    throw new Error('Railway not on cutover SHA: ' + out.health.sha);
  }

  const tokenA = await mint(ACTOR_A);
  const tokenB = await mint(ACTOR_B);
  const games = await loadGames(tokenA);
  games.sort(function (a, b) {
    return new Date(b.scheduledStart || b.time || 0) - new Date(a.scheduledStart || a.time || 0);
  });
  const mlLegs = games.map(mlLeg).filter(function (l) { return l && l.pick && l.canonicalGameKey; });
  process.stderr.write('games=' + games.length + ' mlLegs=' + mlLegs.length + '\n');
  if (mlLegs.length < 2) throw new Error('need >=2 ML legs, got ' + mlLegs.length);

  // A) Exact retry
  const placed = await placeAvoidingConflict(tokenA, ACTOR_A, mlLegs, 1, 'SMOKE_EXACT');
  if (!placed || !(placed.r.body && placed.r.body.ok)) {
    throw new Error('exact place failed ' + JSON.stringify(placed && placed.r));
  }
  const replay = await http('POST', '/api/bets/place', placed.body, tokenA);
  out.exactRetry = {
    firstStatus: placed.r.status,
    firstTicket: placed.r.body.ticketId,
    firstIdempotent: !!placed.r.body.idempotent,
    secondStatus: replay.status,
    secondTicket: replay.body && replay.body.ticketId,
    secondIdempotent: !!(replay.body && replay.body.idempotent),
    sameTicket: placed.r.body.ticketId === (replay.body && replay.body.ticketId),
    pass: placed.r.status === 200 && replay.status === 200
      && placed.r.body.ticketId === (replay.body && replay.body.ticketId)
  };
  out.ticketIds.push(placed.r.body.ticketId);

  // B) Concurrent 2x on fresh key + different game if possible
  const otherLegs = mlLegs.filter(function (l) { return l.canonicalGameKey !== placed.leg.canonicalGameKey; });
  const leg2 = otherLegs[0] || mlLegs[1];
  const key2 = 'SMOKE_2X_' + Date.now();
  const body2 = placePayload(ACTOR_A, 'Single', [leg2], 1, key2);
  const [c1, c2] = await Promise.all([
    http('POST', '/api/bets/place', body2, tokenA),
    http('POST', '/api/bets/place', body2, tokenA)
  ]);
  // If conflict_active_bet on both, try next legs sequentially for concurrent
  let conc = { c1, c2, body: body2 };
  if (!(c1.status === 200 || c2.status === 200)) {
    for (let i = 1; i < otherLegs.length; i++) {
      const k = 'SMOKE_2X_' + Date.now() + '_' + i;
      const b = placePayload(ACTOR_A, 'Single', [otherLegs[i]], 1, k);
      const pair = await Promise.all([
        http('POST', '/api/bets/place', b, tokenA),
        http('POST', '/api/bets/place', b, tokenA)
      ]);
      if (pair[0].status === 200 || pair[1].status === 200) {
        conc = { c1: pair[0], c2: pair[1], body: b };
        break;
      }
    }
  }
  const tickets2 = [conc.c1.body && conc.c1.body.ticketId, conc.c2.body && conc.c2.body.ticketId].filter(Boolean);
  const uniq2 = Array.from(new Set(tickets2));
  out.concurrent2x = {
    statuses: [conc.c1.status, conc.c2.status],
    uniqueTickets: uniq2.length,
    ticket: uniq2[0] || null,
    pass: uniq2.length === 1 && (conc.c1.status === 200 || conc.c1.status === 409)
      && (conc.c2.status === 200 || conc.c2.status === 409)
      && tickets2.length >= 1
      && !/conflict_active_bet/.test(String((conc.c1.body && conc.c1.body.error) || '') + (conc.c2.body && conc.c2.body.error || ''))
  };
  if (uniq2[0]) out.ticketIds.push(uniq2[0]);

  // C) Changed request
  const chPlace = await placeAvoidingConflict(tokenA, ACTOR_A, otherLegs.slice(1), 1, 'SMOKE_CHG');
  if (!chPlace || !(chPlace.r.body && chPlace.r.body.ok)) {
    out.changedRequest = { pass: false, error: 'could_not_place_first', detail: chPlace && chPlace.r };
  } else {
    const changed = Object.assign({}, chPlace.body, { stake: 2 });
    changed.payout = payout(2, changed.legs);
    changed.potentialProfit = Math.round((changed.payout - 2) * 100) / 100;
    // keep same idempotencyKey
    const ch2 = await http('POST', '/api/bets/place', changed, tokenA);
    out.changedRequest = {
      firstStatus: chPlace.r.status,
      firstTicket: chPlace.r.body.ticketId,
      secondStatus: ch2.status,
      secondError: ch2.body && (ch2.body.error || ch2.body.reason),
      pass: chPlace.r.status === 200 && ch2.status === 409
    };
    out.ticketIds.push(chPlace.r.body.ticketId);
  }

  // D) Correlation: same-game ML + Over
  let corrGame = null;
  for (const g of games) {
    if (mlLeg(g) && totalLeg(g)) { corrGame = g; break; }
  }
  if (!corrGame) throw new Error('no game with ML+total for correlation smoke');
  const keyCorr = 'SMOKE_CORR_' + Date.now();
  const corrBody = placePayload(ACTOR_A, 'Parlay', [mlLeg(corrGame), totalLeg(corrGame)], 1, keyCorr);
  const corr1 = await http('POST', '/api/bets/place', corrBody, tokenA);
  const corr2 = await http('POST', '/api/bets/place', corrBody, tokenA);
  out.correlation = {
    firstStatus: corr1.status,
    firstOk: !!(corr1.body && corr1.body.ok),
    firstError: corr1.body && (corr1.body.error || corr1.body.code || corr1.body.relationship),
    firstTicket: corr1.body && corr1.body.ticketId || null,
    financialMutation: corr1.body && corr1.body.financialMutation,
    secondStatus: corr2.status,
    secondOk: !!(corr2.body && corr2.body.ok),
    secondTicket: corr2.body && corr2.body.ticketId || null,
    pass: corr1.status === 422 && corr1.body && corr1.body.ok === false
      && !corr1.body.ticketId
      && corr2.status === 422 && corr2.body && corr2.body.ok === false
      && !corr2.body.ticketId
      && (corr1.body.financialMutation === 'NONE' || !!corr1.body.error)
  };

  // Cancel exact-retry ticket
  const cancelTid = out.exactRetry.firstTicket;
  const cancelKey = 'SMOKE_CANCEL_' + Date.now();
  const can = await http('POST', '/api/bets/cancel', {
    clubId: CLUB,
    playerId: ACTOR_A,
    ticketId: cancelTid,
    idempotencyKey: cancelKey,
    reason: 'cutover_smoke'
  }, tokenA);
  out.cancel = {
    status: can.status,
    ok: !!(can.body && can.body.ok),
    error: can.body && (can.body.error || (can.body.errors && can.body.errors.join(',')))
  };

  // Auth A↔B tickets
  const aTicketsB = await http('GET', '/api/tickets?playerId=' + encodeURIComponent(ACTOR_B), null, tokenA);
  const bTicketsA = await http('GET', '/api/tickets?playerId=' + encodeURIComponent(ACTOR_A), null, tokenB);
  const aList = extractTickets(aTicketsB.body);
  const bList = extractTickets(bTicketsA.body);
  out.authAB = {
    status: aTicketsB.status,
    pass: aTicketsB.status === 401 || aTicketsB.status === 403
      || (aTicketsB.status === 200 && aList.every(function (t) {
        return String(t.player_id || t.playerId || ACTOR_A) === ACTOR_A;
      }))
  };
  out.authBA = {
    status: bTicketsA.status,
    pass: bTicketsA.status === 401 || bTicketsA.status === 403
      || (bTicketsA.status === 200 && bList.every(function (t) {
        return String(t.player_id || t.playerId || ACTOR_B) === ACTOR_B;
      }))
  };

  console.log(JSON.stringify(out, null, 2));
  const hardFail = !(out.exactRetry && out.exactRetry.pass)
    || !(out.concurrent2x && out.concurrent2x.pass)
    || !(out.changedRequest && out.changedRequest.pass)
    || !(out.correlation && out.correlation.pass);
  process.exit(hardFail ? 1 : 0);
}

main().catch(function (e) {
  console.error(JSON.stringify({ fatal: String(e && e.message || e) }));
  process.exit(2);
});
