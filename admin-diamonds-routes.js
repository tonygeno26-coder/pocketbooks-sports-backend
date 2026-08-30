'use strict';
module.exports = function registerAdminDiamondRoutes(ctx) {
  const app = ctx.app;
  const requireActor = ctx.requireActor;
  const ROLE_RANK = ctx.ROLE_RANK;
  const getSupabase = ctx.getSupabase;
  const _getWeekStart = ctx._getWeekStart;
  const _verifyCryptoTx = ctx._verifyCryptoTx;
  const _persistCryptoScan = ctx._persistCryptoScan;
  const _creditHostDiamondPurchase = ctx._creditHostDiamondPurchase;
  const _writeHostDiamondLedger = ctx._writeHostDiamondLedger;
  const emitEvent = ctx.emitEvent;
  const _writeAuthAudit = ctx._writeAuthAudit;

// ════════════════════════════════════════════════════════════════════════════
// ADMIN DIAMOND MANAGEMENT (read-only audit; ledger is source of truth)
// ════════════════════════════════════════════════════════════════════════════

function _requireDiamondAdmin(req, res) {
  const actor = requireActor(req);
  if (actor.error) {
    res.status(actor.status||401).json({ ok:false, error:actor.error });
    return null;
  }
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin') {
    res.status(403).json({ ok:false, error:'insufficient_role', required:'full_admin' });
    return null;
  }
  return actor;
}

function _diamondScopeClubId(actor, req) {
  return String(req._clubId || (req.query && req.query.clubId) || (req.body && req.body.clubId) || '').trim() || null;
}

function _diamondMeta(row) {
  const m = row && row.metadata_json;
  if (!m) return {};
  if (typeof m === 'string') { try { return JSON.parse(m) || {}; } catch (_e) { return {}; } }
  return m;
}

function _isDiamondPurchaseRow(row) {
  if (!row) return false;
  if (row.event_type === 'HOST_DIAMOND_PURCHASE') return true;
  if (row.event_type !== 'HOST_DIAMOND_TOPUP') return false;
  const meta = _diamondMeta(row);
  return !!(meta.source === 'crypto_purchase' || meta.txHash || meta.method === 'crypto');
}

function _diamondDisplayType(row) {
  if (_isDiamondPurchaseRow(row)) return 'DIAMOND_PURCHASE';
  if (row.event_type === 'HOST_ACTIVE_BETTOR_CHARGE') return 'ACTIVE_BETTOR_CHARGE';
  if (row.event_type === 'HOST_DIAMOND_ADJUSTMENT') return 'ADMIN_ADJUSTMENT';
  if (row.event_type === 'HOST_DIAMOND_REFUND') return 'REFUND';
  return row.event_type;
}

function _diamondLedgerReference(row) {
  const meta = _diamondMeta(row);
  return meta.txHash || meta.intentId || meta.playerId || meta.weekStart || row.reason || row.idempotency_key || row.ledger_id || null;
}

async function _sbAllRows(makeQuery, pageSize) {
  pageSize = pageSize || 1000;
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const chunk = data || [];
    all.push.apply(all, chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
    if (from >= 20000) break;
  }
  return all;
}

async function _loadHostBalanceRow(sb, hostId) {
  if (!hostId) return null;
  const { data: byClub } = await sb.from('host_diamond_balances').select('*').eq('club_id', hostId).limit(1);
  if (byClub && byClub[0]) return byClub[0];
  const { data: byHost } = await sb.from('host_diamond_balances').select('*').eq('host_actor_id', hostId).limit(1);
  return (byHost && byHost[0]) || null;
}

function _flagWeeklyCharge(row, ledgerRows) {
  const flags = [];
  const hab = (ledgerRows||[]).filter(function(r) {
    if (r.event_type !== 'HOST_ACTIVE_BETTOR_CHARGE' || r.club_id !== row.club_id) return false;
    const m = _diamondMeta(r);
    const samePlayer = String(m.playerId||'') === String(row.player_id||'');
    const sameWeek = String(m.weekStart||'') === String(row.week_start||'');
    const sameLedger = r.ledger_id === row.charge_ledger_id || r.idempotency_key === row.charge_ledger_id;
    return sameLedger || (samePlayer && sameWeek);
  });
  if (hab.length > 1) flags.push('charged_twice');
  if (!row.first_ticket_id) flags.push('charged_without_qualifying_activity');
  if (row.charge_ledger_id) {
    const found = (ledgerRows||[]).some(function(r) {
      return r.ledger_id === row.charge_ledger_id || r.idempotency_key === row.charge_ledger_id;
    });
    if (!found) flags.push('missing_ledger_entry');
  } else flags.push('missing_ledger_entry');
  return flags;
}

async function _runDiamondAuditReadOnly(sb, clubId) {
  // READ ONLY — never update host_diamond_balances or ledger.
  const bals = await _sbAllRows(function() {
    let q = sb.from('host_diamond_balances').select('*');
    if (clubId) q = q.eq('club_id', clubId);
    return q;
  });
  const ledger = await _sbAllRows(function() {
    let q = sb.from('host_diamond_ledger').select('*');
    if (clubId) q = q.eq('club_id', clubId);
    return q;
  });
  const intents = await _sbAllRows(function() {
    let q = sb.from('crypto_deposit_intents').select('*');
    if (clubId) q = q.eq('club_id', clubId);
    return q;
  });
  const charges = await _sbAllRows(function() {
    let q = sb.from('weekly_active_bettors').select('*');
    if (clubId) q = q.eq('club_id', clubId);
    return q;
  });
  const mismatches = [];
  const byClub = {};
  ledger.forEach(function(r) {
    if (!byClub[r.club_id]) byClub[r.club_id] = { credits:0, debits:0 };
    const amt = parseFloat(r.amount_diamonds) || 0;
    if (r.direction === 'credit') byClub[r.club_id].credits += amt;
    else byClub[r.club_id].debits += amt;
  });
  bals.forEach(function(h) {
    const agg = byClub[h.club_id] || { credits:0, debits:0 };
    const expected = Math.round((agg.credits - agg.debits) * 100) / 100;
    const stored = parseFloat(h.balance_diamonds) || 0;
    if (Math.abs(expected - stored) > 0.009) {
      mismatches.push({ check:'balance_integrity', clubId:h.club_id, hostId:h.host_actor_id,
        expectedBalance:expected, storedBalance:stored, flag:'MISMATCH' });
    }
  });
  const purchaseLedger = ledger.filter(_isDiamondPurchaseRow);
  (intents||[]).forEach(function(i) {
    if (i.status !== 'credited') return;
    const iKey = 'CRYPTO_HD_' + (i.tx_hash || i.intent_id);
    const found = purchaseLedger.some(function(r) {
      const meta = _diamondMeta(r);
      return r.idempotency_key === iKey || r.idempotency_key === i.idempotency_key
        || (meta.txHash && i.tx_hash && meta.txHash === i.tx_hash)
        || (r.reason && String(r.reason).indexOf(i.intent_id) >= 0);
    });
    if (!found) mismatches.push({ check:'purchase_integrity', intentId:i.intent_id, clubId:i.club_id,
      txHash:i.tx_hash||null, flag:'credited_without_ledger' });
  });
  const hashMap = {};
  (intents||[]).forEach(function(i) {
    if (!i.tx_hash || i.status === 'rejected' || i.status === 'expired') return;
    if (!hashMap[i.tx_hash]) hashMap[i.tx_hash] = [];
    hashMap[i.tx_hash].push(i.intent_id);
  });
  Object.keys(hashMap).forEach(function(h) {
    if (hashMap[h].length > 1)
      mismatches.push({ check:'duplicate_txHash', txHash:h, intentIds:hashMap[h], flag:'DUPLICATE' });
  });
  const habCount = {};
  ledger.forEach(function(r) {
    if (r.event_type !== 'HOST_ACTIVE_BETTOR_CHARGE') return;
    const m = _diamondMeta(r);
    const k = r.club_id + '|' + (m.playerId||'') + '|' + (m.weekStart||'');
    habCount[k] = (habCount[k]||0) + 1;
  });
  Object.keys(habCount).forEach(function(k) {
    if (habCount[k] > 1)
      mismatches.push({ check:'weekly_charge_integrity', key:k, count:habCount[k], flag:'charged_twice' });
  });
  (charges||[]).forEach(function(c) {
    _flagWeeklyCharge(c, ledger).forEach(function(flag) {
      mismatches.push({ check:'weekly_charge_integrity', clubId:c.club_id, playerId:c.player_id,
        weekStart:c.week_start, ledgerId:c.charge_ledger_id||null, flag:flag });
    });
  });
  return {
    autoFix: false, mismatchCount: mismatches.length, mismatches: mismatches,
    checks: ['balance_integrity','purchase_integrity','duplicate_txHash','weekly_charge_integrity'],
    totals: { hosts:bals.length, ledgerRows:ledger.length, intents:intents.length, weeklyCharges:charges.length }
  };
}

function _mapPurchaseRow(intent, hostMap) {
  const host = hostMap[intent.club_id] || {};
  return {
    id: intent.intent_id, intentId: intent.intent_id, date: intent.created_at,
    hostId: host.host_actor_id || intent.player_id, clubId: intent.club_id,
    diamonds: parseFloat(intent.package_amount_diamonds||0),
    usd: parseFloat(intent.expected_usd||0), crypto: intent.crypto_symbol,
    network: intent.network, txHash: intent.tx_hash || null, status: intent.status,
    credited: intent.status === 'credited', rejectReason: intent.reject_reason || null
  };
}

function _mapLedgerRow(row) {
  const meta = _diamondMeta(row);
  const amt = parseFloat(row.amount_diamonds||0);
  return {
    ledgerId: row.ledger_id, displayType: _diamondDisplayType(row), eventType: row.event_type,
    clubId: row.club_id, hostId: row.host_actor_id, who: row.host_actor_id,
    amount: row.direction === 'debit' ? -amt : amt, amountDiamonds: amt, direction: row.direction,
    balanceBefore: parseFloat(row.balance_before), balanceAfter: parseFloat(row.balance_after),
    reference: _diamondLedgerReference(row), reason: row.reason || null,
    createdAt: row.created_at, createdBy: row.created_by,
    txHash: meta.txHash || null, bettor: meta.playerId || null, weekStart: meta.weekStart || null
  };
}

// GET /api/admin/diamonds/overview
app.get('/api/admin/diamonds/overview', async (req, res) => {
  const actor = _requireDiamondAdmin(req, res);
  if (!actor) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const clubId = _diamondScopeClubId(actor, req);
  try {
    const bals = await _sbAllRows(function() {
      let q = sb.from('host_diamond_balances').select('*');
      if (clubId) q = q.eq('club_id', clubId);
      return q;
    });
    const ledger = await _sbAllRows(function() {
      let q = sb.from('host_diamond_ledger').select('*');
      if (clubId) q = q.eq('club_id', clubId);
      return q;
    });
    let iq = sb.from('crypto_deposit_intents').select('*', { count:'exact', head:true })
      .in('status', ['hash_submitted','pending_review','confirmed']);
    if (clubId) iq = iq.eq('club_id', clubId);
    const pending = await iq;
    const weekStart = _getWeekStart();
    let wq = sb.from('weekly_active_bettors').select('*').eq('week_start', weekStart);
    if (clubId) wq = wq.eq('club_id', clubId);
    const { data: weekRows } = await wq;
    let totalHeld = 0, totalPurchased = 0, totalDebited = 0, weeklyCharges = 0;
    (bals||[]).forEach(function(h){ totalHeld += parseFloat(h.balance_diamonds)||0; });
    (ledger||[]).forEach(function(r) {
      const amt = parseFloat(r.amount_diamonds)||0;
      if (_isDiamondPurchaseRow(r) && r.direction === 'credit') totalPurchased += amt;
      else if (r.event_type === 'HOST_DIAMOND_TOPUP' && r.direction === 'credit') totalPurchased += amt;
      if (r.direction === 'debit') totalDebited += amt;
      if (r.event_type === 'HOST_ACTIVE_BETTOR_CHARGE' && String((_diamondMeta(r).weekStart)||'') === weekStart)
        weeklyCharges += amt;
    });
    if (!weeklyCharges) {
      weeklyCharges = (weekRows||[]).reduce(function(s,r){ return s + (parseFloat(r.charged_diamonds)||0); }, 0);
    }
    const hostsWithBalances = (bals||[]).filter(function(h){ return parseFloat(h.balance_diamonds)>0; });
    res.json({
      ok:true,
      totalDiamondsHeld: Math.round(totalHeld*100)/100,
      totalPurchased: Math.round(totalPurchased*100)/100,
      totalDebited: Math.round(totalDebited*100)/100,
      pendingVerifications: pending.count || 0,
      hostsWithBalances: hostsWithBalances.length,
      weeklyCharges: Math.round(weeklyCharges*100)/100,
      weekStart: weekStart,
      hosts: (bals||[]).map(function(h){
        return { clubId:h.club_id, hostId:h.host_actor_id, storedBalance:parseFloat(h.balance_diamonds)||0, updatedAt:h.updated_at };
      })
    });
  } catch(e) {
    console.error('[admin/diamonds/overview]', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// GET /api/admin/diamonds/purchases
app.get('/api/admin/diamonds/purchases', async (req, res) => {
  const actor = _requireDiamondAdmin(req, res);
  if (!actor) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const clubId = _diamondScopeClubId(actor, req);
  const q = req.query || {};
  try {
    let pq = sb.from('crypto_deposit_intents').select('*').order('created_at', { ascending:false }).limit(200);
    if (clubId) pq = pq.eq('club_id', clubId);
    if (q.status) pq = pq.eq('status', q.status);
    if (q.txHash) pq = pq.eq('tx_hash', q.txHash);
    if (q.host) pq = pq.eq('club_id', q.host);
    if (q.from) pq = pq.gte('created_at', q.from);
    if (q.to) pq = pq.lte('created_at', q.to);
    const { data, error } = await pq;
    if (error) throw new Error(error.message);
    const bals = await _sbAllRows(function() {
      let bq = sb.from('host_diamond_balances').select('*');
      if (clubId) bq = bq.eq('club_id', clubId);
      return bq;
    });
    const hostMap = {};
    (bals||[]).forEach(function(h){ hostMap[h.club_id] = h; });
    res.json({ ok:true, purchases:(data||[]).map(function(i){ return _mapPurchaseRow(i, hostMap); }) });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/admin/diamonds/purchases/:id/verify — scan only, never credit
app.post('/api/admin/diamonds/purchases/:id/verify', async (req, res) => {
  const actor = _requireDiamondAdmin(req, res);
  if (!actor) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const { data } = await sb.from('crypto_deposit_intents').select('*').eq('intent_id', req.params.id).limit(1);
    const intent = data && data[0];
    if (!intent) return res.status(404).json({ ok:false, error:'intent_not_found' });
    if (!intent.tx_hash) return res.status(400).json({ ok:false, error:'no_tx_hash_on_intent' });
    const scanResult = await _verifyCryptoTx(intent.tx_hash, intent.network, null, intent.crypto_symbol);
    const persisted = await _persistCryptoScan(sb, intent, scanResult);
    res.json({
      ok:true, intentId:intent.intent_id, credited:false, autoFix:false,
      scanStatus: scanResult.status, valid: !!scanResult.valid,
      confirmations: scanResult.confirmations||0,
      matched: !!(persisted.matchResult && persisted.matchResult.matched),
      matchReason: (persisted.matchResult && persisted.matchResult.reason) || null,
      intentStatus: intent.status
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/admin/diamonds/purchases/:id/approve
app.post('/api/admin/diamonds/purchases/:id/approve', async (req, res) => {
  const actor = _requireDiamondAdmin(req, res);
  if (!actor) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const intentId = req.params.id;
  try {
    const { data } = await sb.from('crypto_deposit_intents').select('*').eq('intent_id', intentId).limit(1);
    const intent = data && data[0];
    if (!intent) return res.status(404).json({ ok:false, error:'intent_not_found' });
    const clubId = _diamondScopeClubId(actor, req);
    if (clubId && intent.club_id !== clubId && actor.platformRole !== 'platform_admin')
      return res.status(403).json({ ok:false, error:'club_scope_mismatch' });
    if (intent.status === 'credited')
      return res.json({ ok:true, idempotent:true, already_credited:true, intentId:intent.intent_id,
        diamonds:parseFloat(intent.package_amount_diamonds||0) });
    if (intent.status === 'rejected') return res.status(409).json({ ok:false, error:'intent_rejected' });
    if (intent.tx_hash) {
      const { data: dup } = await sb.from('crypto_deposit_intents')
        .select('intent_id,status').eq('tx_hash', intent.tx_hash).neq('intent_id', intent.intent_id)
        .in('status', ['credited','confirmed','hash_submitted','pending_review']).limit(1);
      if (dup && dup[0]) {
        if (dup[0].status === 'credited') {
          await sb.from('crypto_deposit_intents').update({
            status:'rejected', reject_reason:'duplicate_txHash', updated_at:new Date().toISOString()
          }).eq('intent_id', intent.intent_id).neq('status','credited');
        }
        return res.status(409).json({ ok:false, error:'duplicate_txHash', otherIntentId:dup[0].intent_id });
      }
    }
    const scanResult = {
      amountUsdEstimate: parseFloat(intent.expected_usd||0) || parseFloat(intent.package_amount_diamonds||0),
      amount_usd: parseFloat(intent.expected_usd||0)
    };
    const credit = await _creditHostDiamondPurchase(sb, intent, scanResult);
    if (credit && credit.ok) {
      const now = new Date().toISOString();
      await sb.from('crypto_deposit_intents').update({
        status:'credited', credited_at:now, credited_by:actor.actorId||'admin',
        idempotency_key: credit.ledgerId || ('CRYPTO_HD_'+(intent.tx_hash||intent.intent_id)),
        updated_at:now
      }).eq('intent_id', intent.intent_id);
      emitEvent('balance_changed', { clubId:intent.club_id, event:'host_diamond_purchase', diamonds:intent.package_amount_diamonds },
        { clubId:intent.club_id, playerId:intent.player_id }, req.requestId);
      _writeAuthAudit('diamond_purchase_approved', actor.actorId, intent.club_id,
        '/admin/diamonds/purchases/approve', { intentId, idempotent:!!credit.idempotent });
      return res.json({ ok:true, idempotent:!!credit.idempotent, intentId, diamonds:parseFloat(intent.package_amount_diamonds||0),
        ledgerId: credit.ledgerId || null, status:'credited' });
    }
    if (credit && credit.error === 'duplicate_tx') {
      await sb.from('crypto_deposit_intents').update({
        status:'rejected', reject_reason:'duplicate_txHash', updated_at:new Date().toISOString()
      }).eq('intent_id', intent.intent_id).neq('status','credited');
      return res.status(409).json({ ok:false, error:'duplicate_txHash' });
    }
    return res.status(409).json({ ok:false, error:(credit && credit.error) || 'credit_failed' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/admin/diamonds/purchases/:id/reject
app.post('/api/admin/diamonds/purchases/:id/reject', async (req, res) => {
  const actor = _requireDiamondAdmin(req, res);
  if (!actor) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const reason = ((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ ok:false, error:'missing_reason' });
  try {
    const { data } = await sb.from('crypto_deposit_intents').select('*').eq('intent_id', req.params.id).limit(1);
    const intent = data && data[0];
    if (!intent) return res.status(404).json({ ok:false, error:'intent_not_found' });
    if (intent.status === 'credited') return res.status(409).json({ ok:false, error:'already_credited' });
    await sb.from('crypto_deposit_intents').update({
      status:'rejected', reject_reason:reason, updated_at:new Date().toISOString()
    }).eq('intent_id', req.params.id);
    _writeAuthAudit('diamond_purchase_rejected', actor.actorId, intent.club_id,
      '/admin/diamonds/purchases/reject', { intentId:req.params.id, reason:reason });
    res.json({ ok:true, intentId:req.params.id, status:'rejected' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/admin/diamonds/ledger
app.get('/api/admin/diamonds/ledger', async (req, res) => {
  const actor = _requireDiamondAdmin(req, res);
  if (!actor) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const clubId = _diamondScopeClubId(actor, req);
  const q = req.query || {};
  try {
    let lq = sb.from('host_diamond_ledger').select('*').order('created_at', { ascending:false }).limit(500);
    if (clubId) lq = lq.eq('club_id', clubId);
    if (q.host) lq = lq.or('club_id.eq.'+q.host+',host_actor_id.eq.'+q.host);
    if (q.type) lq = lq.eq('event_type', q.type);
    if (q.from) lq = lq.gte('created_at', q.from);
    if (q.to) lq = lq.lte('created_at', q.to);
    const { data, error } = await lq;
    if (error) throw new Error(error.message);
    let rows = (data||[]).map(_mapLedgerRow);
    if (q.txHash) rows = rows.filter(function(r){ return r.txHash && r.txHash === q.txHash; });
    if (q.bettor) rows = rows.filter(function(r){ return r.bettor && String(r.bettor) === String(q.bettor); });
    if (q.displayType) rows = rows.filter(function(r){ return r.displayType === q.displayType; });
    res.json({ ok:true, ledger: rows });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/admin/diamonds/hosts/:hostId/audit
app.get('/api/admin/diamonds/hosts/:hostId/audit', async (req, res) => {
  const actor = _requireDiamondAdmin(req, res);
  if (!actor) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const host = await _loadHostBalanceRow(sb, req.params.hostId);
    if (!host) return res.status(404).json({ ok:false, error:'host_not_found' });
    const scope = _diamondScopeClubId(actor, req);
    if (scope && host.club_id !== scope && actor.platformRole !== 'platform_admin')
      return res.status(403).json({ ok:false, error:'club_scope_mismatch' });
    const { data: ledger, error } = await sb.from('host_diamond_ledger')
      .select('*').eq('club_id', host.club_id).order('created_at', { ascending:true });
    if (error) throw new Error(error.message);
    let credits = 0, debits = 0;
    (ledger||[]).forEach(function(r) {
      const amt = parseFloat(r.amount_diamonds)||0;
      if (r.direction === 'credit') credits += amt; else debits += amt;
    });
    const expected = Math.round((credits - debits)*100)/100;
    const stored = parseFloat(host.balance_diamonds)||0;
    const mismatch = Math.abs(expected - stored) > 0.009;
    res.json({
      ok:true, clubId:host.club_id, hostId:host.host_actor_id,
      expectedBalance:expected, storedBalance:stored,
      credits: Math.round(credits*100)/100, debits: Math.round(debits*100)/100,
      mismatch: mismatch, flag: mismatch ? 'MISMATCH' : 'OK',
      ledger: (ledger||[]).map(_mapLedgerRow)
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/admin/diamonds/weekly-charges
app.get('/api/admin/diamonds/weekly-charges', async (req, res) => {
  const actor = _requireDiamondAdmin(req, res);
  if (!actor) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const clubId = _diamondScopeClubId(actor, req);
  const q = req.query || {};
  try {
    let wq = sb.from('weekly_active_bettors').select('*').order('activated_at', { ascending:false }).limit(500);
    if (clubId) wq = wq.eq('club_id', clubId);
    if (q.host) wq = wq.eq('club_id', q.host);
    if (q.bettor) wq = wq.eq('player_id', q.bettor);
    if (q.from) wq = wq.gte('week_start', q.from);
    if (q.to) wq = wq.lte('week_start', q.to);
    const { data: charges, error } = await wq;
    if (error) throw new Error(error.message);
    const ledger = await _sbAllRows(function() {
      let lq = sb.from('host_diamond_ledger').select('*').eq('event_type','HOST_ACTIVE_BETTOR_CHARGE');
      if (clubId) lq = lq.eq('club_id', clubId);
      return lq;
    });
    const bals = await _sbAllRows(function() {
      let bq = sb.from('host_diamond_balances').select('*');
      if (clubId) bq = bq.eq('club_id', clubId);
      return bq;
    });
    const hostMap = {};
    (bals||[]).forEach(function(h){ hostMap[h.club_id] = h; });
    res.json({ ok:true, charges: (charges||[]).map(function(c) {
      const host = hostMap[c.club_id] || {};
      return {
        clubId: c.club_id, hostId: host.host_actor_id || c.club_id, bettor: c.player_id,
        period: c.week_start, amount: parseFloat(c.charged_diamonds)||0,
        ledgerId: c.charge_ledger_id || null, firstTicketId: c.first_ticket_id || null,
        flags: _flagWeeklyCharge(c, ledger)
      };
    }) });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/admin/diamonds/audit/run — persist result, never auto-fix balances
app.post('/api/admin/diamonds/audit/run', async (req, res) => {
  const actor = _requireDiamondAdmin(req, res);
  if (!actor) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const clubId = _diamondScopeClubId(actor, req);
  try {
    const summary = await _runDiamondAuditReadOnly(sb, clubId);
    const now = new Date().toISOString();
    const id = 'DAR_'+Date.now()+'_'+String(actor.actorId||'admin').slice(0,12);
    const { error } = await sb.from('diamond_audit_runs').insert({
      id: id, run_at: now, run_by: actor.actorId||'admin',
      summary_json: summary, mismatch_count: summary.mismatchCount||0, created_at: now
    });
    if (error) console.warn('[admin/diamonds/audit] persist failed:', error.message);
    _writeAuthAudit('diamond_audit_run', actor.actorId, clubId||null,
      '/admin/diamonds/audit/run', { mismatchCount:summary.mismatchCount, autoFix:false });
    res.json({ ok:true, auditId:id, autoFix:false, persisted:!error, ...summary });
  } catch(e) {
    console.error('[admin/diamonds/audit]', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// GET /api/admin/diamonds/audit/history
app.get('/api/admin/diamonds/audit/history', async (req, res) => {
  const actor = _requireDiamondAdmin(req, res);
  if (!actor) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const { data, error } = await sb.from('diamond_audit_runs')
      .select('*').order('run_at', { ascending:false }).limit(50);
    if (error) throw new Error(error.message);
    res.json({ ok:true, history: (data||[]).map(function(r){
      return { id:r.id, runAt:r.run_at, runBy:r.run_by, mismatchCount:r.mismatch_count,
        summary:r.summary_json, createdAt:r.created_at };
    }) });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/admin/diamonds/adjust — never mutate balance without ledger
app.post('/api/admin/diamonds/adjust', async (req, res) => {
  const actor = _requireDiamondAdmin(req, res);
  if (!actor) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const body = req.body || {};
  const clubId = body.clubId || body.hostId;
  const direction = body.direction;
  const reason = (body.reason || '').trim();
  const amt = parseFloat(body.amountDiamonds || body.amount);
  const idempotencyKey = body.idempotencyKey || req.headers['idempotency-key'] || null;
  if (!clubId || !reason) return res.status(400).json({ ok:false, error:'missing_clubId_or_reason' });
  if (!['credit','debit'].includes(direction)) return res.status(400).json({ ok:false, error:'invalid_direction' });
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ ok:false, error:'invalid_amount' });
  try {
    if (idempotencyKey) {
      const { data: existing } = await sb.from('host_diamond_ledger')
        .select('*').eq('idempotency_key', idempotencyKey).limit(1);
      if (existing && existing[0]) {
        return res.json({ ok:true, idempotent:true, ledgerId:existing[0].ledger_id,
          balanceBefore:parseFloat(existing[0].balance_before),
          balanceAfter:parseFloat(existing[0].balance_after), direction:existing[0].direction });
      }
    }
    const host = await _loadHostBalanceRow(sb, clubId);
    if (!host) return res.status(404).json({ ok:false, error:'host_balance_not_found' });
    const scope = _diamondScopeClubId(actor, req);
    if (scope && host.club_id !== scope && actor.platformRole !== 'platform_admin')
      return res.status(403).json({ ok:false, error:'club_scope_mismatch' });
    const balBefore = parseFloat(host.balance_diamonds);
    const balAfter = direction === 'credit' ? balBefore + amt : balBefore - amt;
    if (balAfter < 0 && actor.platformRole !== 'platform_admin')
      return res.status(400).json({ ok:false, error:'would_go_negative', balanceBefore:balBefore, wouldBe:balAfter });
    const ledgerId = idempotencyKey || ('ADJ_'+host.club_id+'_'+Date.now());
    const wrote = await _writeHostDiamondLedger(sb, {
      ledgerId, clubId:host.club_id, hostActorId:host.host_actor_id,
      eventType:'HOST_DIAMOND_ADJUSTMENT', amount:amt, direction,
      balanceBefore:balBefore, balanceAfter:balAfter,
      createdBy:actor.actorId||'admin', reason:reason,
      idempotencyKey: ledgerId, metadata:{ source:'admin_diamond_adjust' }
    });
    if (!wrote || !wrote.ok) {
      if (wrote && (wrote.idempotent || wrote.code === '23505' || /duplicate/i.test(wrote.error||'')))
        return res.json({ ok:true, idempotent:true, ledgerId:ledgerId });
      return res.status(500).json({ ok:false, error:'ledger_write_failed', detail:wrote && wrote.error });
    }
    const now = new Date().toISOString();
    const { error: balErr } = await sb.from('host_diamond_balances')
      .update({ balance_diamonds:balAfter, updated_at:now }).eq('club_id', host.club_id);
    if (balErr) {
      return res.status(500).json({ ok:false, error:'balance_update_failed_ledger_written',
        ledgerId, detail:balErr.message });
    }
    _writeAuthAudit('diamond_admin_adjust', actor.actorId, host.club_id,
      '/admin/diamonds/adjust', { amt, direction, balBefore, balAfter, reason });
    res.json({ ok:true, clubId:host.club_id, hostId:host.host_actor_id,
      balanceBefore:balBefore, balanceAfter:balAfter, direction, ledgerId, reason });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
// ────────────────────────────────────────────────────────────────────────────


};
