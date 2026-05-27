require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

// ════════════════════════════════════════════════════════════════════════════
// PHASE Q: PRODUCTION OPS HARDENING
// ════════════════════════════════════════════════════════════════════════════

// ─ Rate limiter (in-memory, Redis-ready abstraction) ───────────────────────────────
const _rlWindows = new Map();
function _rlCheck(key, maxReqs, windowMs) {
  const now = Date.now();
  const win = _rlWindows.get(key) || { count:0, resetAt: now+windowMs };
  if (now >= win.resetAt) { win.count=0; win.resetAt=now+windowMs; }
  win.count++;
  _rlWindows.set(key, win);
  const allowed = win.count <= maxReqs;
  return { allowed, count:win.count, max:maxReqs,
           retryAfterSec: allowed ? 0 : Math.ceil((win.resetAt-now)/1000) };
}

const RATE_LIMIT_CONFIG = {
  '/api/auth/token':         { maxReqs:10,  windowMs:60000, keyBy:'ip' },
  '/api/auth/refresh':       { maxReqs:10,  windowMs:60000, keyBy:'actor' },
  '/api/bets/place':         { maxReqs:30,  windowMs:60000, keyBy:'actor' },
  '/api/bets/cancel':        { maxReqs:30,  windowMs:60000, keyBy:'actor' },
  '/api/grade/run':          { maxReqs:5,   windowMs:60000, keyBy:'club' },
  '/api/grade/manual':       { maxReqs:5,   windowMs:60000, keyBy:'club' },
  '/api/markets/refresh':    { maxReqs:5,   windowMs:60000, keyBy:'club' },
  '/api/host/settlements':   { maxReqs:20,  windowMs:60000, keyBy:'actor' },
  '/api/club/members':       { maxReqs:20,  windowMs:60000, keyBy:'actor' },
  '/api/club/risk-settings': { maxReqs:20,  windowMs:60000, keyBy:'actor' }
};

function _getRlConfig(path) {
  if (RATE_LIMIT_CONFIG[path]) return RATE_LIMIT_CONFIG[path];
  for (const prefix of Object.keys(RATE_LIMIT_CONFIG)) {
    if (path.startsWith(prefix)) return RATE_LIMIT_CONFIG[prefix];
  }
  return null;
}

function _ipHash(req) {
  const ip = req.ip || (req.headers&&req.headers['x-forwarded-for'])||'unknown';
  // Simple 8-char hash — not cryptographic, just for key bucketing
  let h=0; for(let i=0;i<ip.length;i++) h=(Math.imul(31,h)+ip.charCodeAt(i))|0;
  return Math.abs(h).toString(16).slice(0,8);
}

function _envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === '') return !!defaultValue;
  return String(raw).toLowerCase() === 'true';
}

const GRADING_SETTLEMENT_ENABLED = _envFlag('GRADING_SETTLEMENT_ENABLED', false);
const GRADE_RUN_DRY_RUN_ENABLED = _envFlag('GRADE_RUN_DRY_RUN_ENABLED', true);
const WORKER_GRADE_SETTLEMENT_ENABLED = _envFlag('WORKER_GRADE_SETTLEMENT_ENABLED', false);
const MANUAL_GRADE_SETTLEMENT_ENABLED = _envFlag('MANUAL_GRADE_SETTLEMENT_ENABLED', false);
const BROWSER_TICKET_MIRROR_WRITES_ENABLED = _envFlag('BROWSER_TICKET_MIRROR_WRITES_ENABLED', false);
const BROWSER_LEDGER_MIRROR_WRITES_ENABLED = _envFlag('BROWSER_LEDGER_MIRROR_WRITES_ENABLED', false);
const GRADING_DISABLED_REASON = process.env.GRADING_DISABLED_REASON || 'grade_ticket_tx_missing';
const _BROWSER_TERMINAL_STATUSES = new Set(['won','lost','push','pushed','void','voided','refunded','settled','canceled','cancelled']);

function _gradingContainmentStatus() {
  return {
    settlementEnabled:GRADING_SETTLEMENT_ENABLED,
    gradeRunDryRunEnabled:GRADE_RUN_DRY_RUN_ENABLED,
    workerSettlementEnabled:WORKER_GRADE_SETTLEMENT_ENABLED,
    manualSettlementEnabled:MANUAL_GRADE_SETTLEMENT_ENABLED,
    browserTicketMirrorWritesEnabled:BROWSER_TICKET_MIRROR_WRITES_ENABLED,
    browserLedgerMirrorWritesEnabled:BROWSER_LEDGER_MIRROR_WRITES_ENABLED,
    reason:GRADING_SETTLEMENT_ENABLED?null:GRADING_DISABLED_REASON
  };
}

function _mirrorNoopPayload(reason, extra) {
  return Object.assign({ ok:true, queued:false, disabled:true, containment:true, reason }, extra||{});
}

function rateLimitMiddleware(req, res, next) {
  const cfg = _getRlConfig(req.path);
  if (!cfg) return next();
  const actor  = req._actor&&req._actor.actorId;
  const club   = req._actor&&req._actor.clubId;
  const keyId  = cfg.keyBy==='club' ? (club||actor||_ipHash(req))
                : cfg.keyBy==='actor' ? (actor||_ipHash(req))
                : _ipHash(req);
  const key = keyId+'|'+req.path;
  const result = _rlCheck(key, cfg.maxReqs, cfg.windowMs);
  res.setHeader('X-RateLimit-Limit',     cfg.maxReqs);
  res.setHeader('X-RateLimit-Remaining', Math.max(0,cfg.maxReqs-result.count));
  if (!result.allowed) {
    console.log('[rate-limit] 429 key='+key+' count='+result.count+' retryAfter='+result.retryAfterSec+'s');
    // Audit (fire-and-forget)
    try {
      const sb = getSupabase&&getSupabase();
      if (sb) sb.from('audit_events').insert({ event_type:'rate_limited',
        payload:{ key, count:result.count, path:req.path } }).then(()=>{}).catch(()=>{});
    } catch(_e){}
    res.setHeader('Retry-After', result.retryAfterSec);
    // Emit risk alert for repeated rate limits
    emitRiskAlert('repeated_rate_limit', null, keyId, { path:req.path, count:result.count });
    return res.status(429).json({ ok:false, error:'rate_limited',
      retryAfterSec:result.retryAfterSec, limitKey:key });
  }
  next();
}

// ─ CORS hardening ───────────────────────────────────────────────────────────────────
const _IS_PROD_CORS = process.env.NODE_ENV==='production';
const _ALLOWED_ORIGINS_RAW = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(function(s){ return s.trim(); })
  : ['https://pocketbooks-sports.vercel.app',
     'https://pocketbooks-sports-git-main.vercel.app'];

const _DEV_ORIGINS_EXTRA = ['http://localhost:3000','http://localhost:5000',
                             'http://localhost:8080','http://localhost:3001'];
const _CORS_ALLOWED = _IS_PROD_CORS
  ? _ALLOWED_ORIGINS_RAW
  : [..._ALLOWED_ORIGINS_RAW, ..._DEV_ORIGINS_EXTRA];

const _DEV_LOCALHOST_RE = /^https?:\/\/localhost(:\d+)?$/;

cors({
  origin: function(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server
    if (!_IS_PROD_CORS && _DEV_LOCALHOST_RE.test(origin)) return cb(null, true);
    if (_CORS_ALLOWED.includes(origin)) return cb(null, true);
    // Log and audit
    console.log('[cors] rejected origin:', origin);
    try {
      const sb = getSupabase&&getSupabase();
      if (sb) sb.from('audit_events').insert({ event_type:'cors_rejected',
        payload:{ origin } }).then(()=>{}).catch(()=>{});
    } catch(_e){}
    return cb(new Error('cors_rejected'), false);
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Actor-Id','X-Club-Id',
                   'X-Actor-Role','Idempotency-Key']
});

// Rebuild cors middleware with the hardened config
const _hardenedCors = cors({
  origin: function(origin, cb) {
    if (!origin) return cb(null, true);
    if (!_IS_PROD_CORS && _DEV_LOCALHOST_RE.test(origin)) return cb(null, true);
    if (_CORS_ALLOWED.includes(origin)) return cb(null, true);
    console.log('[cors] rejected origin:', origin);
    return cb(Object.assign(new Error('cors_rejected:'+origin), { statusCode:403 }), false);
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Actor-Id','X-Club-Id',
                   'X-Actor-Role','Idempotency-Key']
});

// ─ Security headers middleware ──────────────────────────────────────────────────────────────
const _SENSITIVE_PATHS_SEC = ['/api/auth','/api/bets','/api/host/settlements',
                               '/api/grade','/api/club'];
function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options',        'DENY');
  res.setHeader('Referrer-Policy',        'no-referrer');
  res.setHeader('Permissions-Policy',     'camera=(), microphone=(), geolocation=()');
  const isSensitive = _SENSITIVE_PATHS_SEC.some(function(p){ return req.path.startsWith(p); });
  if (isSensitive) res.setHeader('Cache-Control','no-store');
  next();
}

// ─ Payload size limiter ────────────────────────────────────────────────────────────────────
const _SENSITIVE_BET_PATHS = ['/api/bets/','/api/grade/','/api/host/settlements/'];
const _PAYLOAD_DEFAULT   = 100 * 1024;  // 100 KB
const _PAYLOAD_SENSITIVE =  50 * 1024;  //  50 KB

function payloadSizeMiddleware(req, res, next) {
  // Only check POST/PUT with Content-Length
  const cl = parseInt(req.headers['content-length']||0, 10);
  if (!cl || req.method==='GET') return next();
  const isSensitive = _SENSITIVE_BET_PATHS.some(function(p){ return req.path.startsWith(p); });
  const limit = isSensitive ? _PAYLOAD_SENSITIVE : _PAYLOAD_DEFAULT;
  if (cl > limit) {
    console.log('[payload] 413 path='+req.path+' size='+cl+' limit='+limit);
    try {
      const sb = getSupabase&&getSupabase();
      if (sb) sb.from('audit_events').insert({ event_type:'payload_too_large',
        payload:{ path:req.path, byteLength:cl, limit } }).then(()=>{}).catch(()=>{});
    } catch(_e){}
    return res.status(413).json({ ok:false, error:'payload_too_large', byteLength:cl, limit });
  }
  next();
}
// ════════════════════════════════════════════════════════════════════════════
// PHASE S: BACKGROUND JOB QUEUE + RETRY SAFETY
// ════════════════════════════════════════════════════════════════════════════

const JOB_TYPES_SET = new Set(['odds_refresh','result_refresh','grade_run',
                                'settlement_close_check','payment_reconciliation']);
const JOB_BACKOFF_MS = [30000,60000,120000,300000,600000]; // 30s,1m,2m,5m,10m
// In-memory job store (Supabase-backed when available)
const _jobMemStore = new Map();

function _jobCalcBackoff(attempts) {
  var idx = Math.min(attempts, JOB_BACKOFF_MS.length-1);
  return new Date(Date.now()+JOB_BACKOFF_MS[idx]).toISOString();
}

async function enqueueJob(type, payload, opts) {
  opts = opts||{};
  if (!JOB_TYPES_SET.has(type)) return { ok:false, error:'invalid_job_type:'+type };
  const now   = new Date().toISOString();
  const jobId = 'JOB_'+type+'_'+Date.now()+'_'+_crypto.randomBytes(3).toString('hex');
  const job   = {
    job_id:opts.jobId||jobId, type, club_id:opts.clubId||null,
    status:'queued', attempts:0, max_attempts:opts.maxAttempts||5,
    run_after:opts.runAfter||now, locked_at:null, locked_by:null,
    last_error:null, payload_json:payload||{},
    idempotency_key:opts.idempotencyKey||null,
    created_at:now, updated_at:now
  };
  // Idempotency: check mem store
  if (opts.idempotencyKey) {
    for (const [,j] of _jobMemStore) {
      if (j.idempotency_key===opts.idempotencyKey &&
          (j.status==='queued'||j.status==='running'))
        return { ok:true, idempotent:true, jobId:j.job_id };
    }
  }
  _jobMemStore.set(job.job_id, job);
  // Persist to Supabase
  try {
    const sb = getSupabase();
    if (sb) await sb.from('jobs').upsert({
      job_id:job.job_id, type, club_id:job.club_id,
      status:'queued', attempts:0, max_attempts:job.max_attempts,
      run_after:job.run_after, payload_json:payload||{},
      idempotency_key:job.idempotency_key
    }, { onConflict:'job_id' });
  } catch(_e) { console.warn('[jobs] enqueue DB error:', _e.message); }
  console.log('[jobs] enqueued', type, job.job_id);
  return { ok:true, jobId:job.job_id };
}

async function _claimNextJob(workerId) {
  const now = new Date().toISOString();
  // Try from Supabase first (atomic claim via UPDATE ... RETURNING)
  try {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('jobs').select('*')
        .eq('status','queued').is('locked_at',null).lte('run_after',now)
        .order('run_after').limit(1);
      const job = data&&data[0];
      if (job) {
        const lockTs = new Date().toISOString();
        const { error } = await sb.from('jobs')
          .update({ status:'running',locked_at:lockTs,locked_by:workerId,
                    attempts:job.attempts+1,updated_at:lockTs })
          .eq('job_id',job.job_id).eq('status','queued').is('locked_at',null);
        if (!error) {
          job.status='running'; job.locked_at=lockTs;
          job.locked_by=workerId; job.attempts+=1;
          _jobMemStore.set(job.job_id, job);
          return job;
        }
      }
    }
  } catch(_e) {}
  // Fallback: mem store
  for (const [,j] of _jobMemStore) {
    if (j.status==='queued' && !j.locked_at && j.run_after<=now) {
      j.status='running'; j.locked_at=now; j.locked_by=workerId; j.attempts++;
      j.updated_at=now;
      return j;
    }
  }
  return null;
}

async function _completeJob(jobId) {
  const now = new Date().toISOString();
  const j = _jobMemStore.get(jobId);
  if (j) { j.status='succeeded'; j.locked_at=null; j.locked_by=null; j.updated_at=now; }
  try { const sb=getSupabase(); if(sb) await sb.from('jobs')
    .update({status:'succeeded',locked_at:null,locked_by:null,updated_at:now})
    .eq('job_id',jobId); } catch(_e){}
}

async function _failJob(jobId, errorMsg) {
  const now = new Date().toISOString();
  const j = _jobMemStore.get(jobId);
  if (!j) return;
  j.last_error = errorMsg; j.locked_at=null; j.locked_by=null; j.updated_at=now;
  const isDead = j.attempts >= j.max_attempts;
  j.status     = isDead ? 'dead' : 'queued';
  j.run_after  = isDead ? now    : _jobCalcBackoff(j.attempts);
  try { const sb=getSupabase(); if(sb) await sb.from('jobs')
    .update({status:j.status,locked_at:null,locked_by:null,
             last_error:errorMsg,run_after:j.run_after,updated_at:now})
    .eq('job_id',jobId); } catch(_e){}
  if (isDead) emitEvent('job_failed',{ jobId, type:j.type, lastError:errorMsg, dead:true },{ clubId:j.club_id });
  console.log('[jobs] failed', jobId, isDead?'DEAD':'retry@'+j.run_after);
}

// ── JOB HANDLERS ────────────────────────────────────────────────────────────────────────
const _jobHandlers = {
  odds_refresh: async function(job) {
    await pollLiveOddsLoop();
    _upsertOddsSnapshots().catch(()=>{});
    logEvent('info','job:odds_refresh',{ jobId:job.job_id });
  },
  result_refresh: async function(job) {
    const p = job.payload_json||{};
    const sports = p.sports||(CACHE_SPORTS||['baseball_mlb']);
    for (const sport of sports) {
      try {
        const url = 'https://api.the-odds-api.com/v4/sports/'+sport+
          '/scores/?apiKey='+ODDS_KEY+'&daysFrom='+(p.daysBack||3);
        const data = await new Promise(function(resolve){
          const https=require('https');
          const req=https.get(url,function(res){ let d=''; res.on('data',function(c){d+=c;});
            res.on('end',function(){ try{resolve(JSON.parse(d));}catch(_e){resolve([]);} }); });
          req.on('error',function(){ resolve([]); }); req.setTimeout(8000,function(){ req.destroy(); resolve([]); });
        });
        if (Array.isArray(data)) await _upsertResultSnapshots(data, sport);
      } catch(_e) { logEvent('warn','job:result_refresh_sport_error',{ sport, err:_e.message }); }
    }
  },
  grade_run: async function(job) {
    // Trigger server grade for the club in payload, or globally
    const p = job.payload_json||{};
    const sb = getSupabase();
    if (!sb) throw new Error('supabase_not_configured');
    // Reuse existing grade/run logic via internal call simulation
    const fakeReq = { body:{ daysBack:p.daysBack||3, clubId:p.clubId }, _actor:{ actorId:'worker', role:'owner' }, _clubId:p.clubId||null };
    // Call the grade core function
    await _runGradeCore(fakeReq, sb);
  },
  settlement_close_check: async function(job) {
    // Check for clubs with no activity this week — log only, no auto-close
    logEvent('info','job:settlement_close_check',{ jobId:job.job_id });
  },
  payment_reconciliation: async function(job) {
    logEvent('info','job:payment_reconciliation',{ jobId:job.job_id });
  }
};

// Extracted grade core for reuse by worker
async function _runGradeCore(fakeReq, sb) {
  const { daysBack=3, playerId, clubId } = fakeReq.body||{};
  const nowMs = Date.now(); const gradedAt = new Date().toISOString();
  let tq = sb.from('tickets').select('id,type,status,risk_amount,potential_profit,estimated_payout,graded_at,player_id,club_id').in('status',['active','open']);
  if (playerId) tq = tq.eq('player_id',playerId);
  if (clubId)   tq = tq.eq('club_id',clubId);
  const { data:tickets } = await tq;
  if (!tickets||!tickets.length) return { graded:0, skipped:0 };
  const ticketIds = tickets.map(function(t){ return t.id; });
  const { data:allLegs } = await sb.from('ticket_legs').select('*').in('ticket_id',ticketIds);
  const uniqueKeys = [...new Set((allLegs||[]).map(function(l){ return l.canonical_game_key||''; }).filter(Boolean))];
  const { data:snapRows } = uniqueKeys.length ? await sb.from('result_snapshots').select('*').in('canonical_game_key',uniqueKeys) : { data:[] };
  const resultsByKey = {};
  (snapRows||[]).forEach(function(r){ resultsByKey[r.canonical_game_key]=r; });
  let graded=0, skipped=0;
  for (const ticket of tickets) {
    try {
      if (ticket.graded_at) { skipped++; continue; }
      const ticketLegs = (allLegs||[]).filter(function(l){ return l.ticket_id===ticket.id; });
      const outcome = _deriveTicketOutcome(ticket, ticketLegs, resultsByKey);
      if (outcome.outcome==='error'||outcome.outcome==='pending') { skipped++; continue; }
      const profit = parseFloat(ticket.potential_profit)||0;
      if (!GRADING_SETTLEMENT_ENABLED || !WORKER_GRADE_SETTLEMENT_ENABLED) {
        console.warn('[grading] worker settlement blocked ticketId='+ticket.id+
          ' outcome='+outcome.outcome+' reason='+GRADING_DISABLED_REASON);
        skipped++;
        continue;
      }
      const gr = await _callMoneyRpc('grade_ticket_tx',{
        p_ticket_id:ticket.id, p_club_id:ticket.club_id||'', p_player_id:ticket.player_id,
        p_grade_result:outcome.outcome, p_profit:profit,
        p_idempotency_key:'WK_'+outcome.outcome+'_'+ticket.id, p_created_by:'worker'
      });
      if (gr.ok||gr.idempotent) graded++; else skipped++;
    } catch(_e) { logEvent('error','grade_core_ticket_error',{ ticketId:ticket.id, err:_e.message }); skipped++; }
  }
  return { graded, skipped };
}

// ── WORKER LOOP ───────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const WORKER_ID = 'worker_'+crypto.randomBytes(4).toString('hex');
const WORKER_POLL_MS = parseInt(process.env.WORKER_POLL_MS)||20000; // 20s default

async function _workerTick() {
  const job = await _claimNextJob(WORKER_ID);
  if (!job) return;
  console.log('[worker] claimed', job.type, job.job_id, 'attempt', job.attempts);
  const handler = _jobHandlers[job.type];
  if (!handler) { await _failJob(job.job_id,'no_handler_for_type:'+job.type); return; }
  try {
    await handler(job);
    await _completeJob(job.job_id);
    console.log('[worker] completed', job.type, job.job_id);
    emitEvent('job_completed',{ type:job.type, jobId:job.job_id },{ clubId:job.club_id });
  } catch(e) {
    logEvent('error','worker_job_failed',{ type:job.type, jobId:job.job_id, err:e.message });
    await _failJob(job.job_id, e.message);
  }
}

if (process.env.ENABLE_WORKER==='true') {
  console.log('[worker] starting — poll every '+WORKER_POLL_MS+'ms id='+WORKER_ID);
  setInterval(_workerTick, WORKER_POLL_MS);
  _workerTick(); // immediate first tick
  // Seed recurring jobs
  enqueueJob('odds_refresh',{},{idempotencyKey:'BOOT_odds_refresh'});
  enqueueJob('result_refresh',{},{idempotencyKey:'BOOT_result_refresh'});
}
// ───────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// PHASE T: REAL-TIME POLLING BUS
// ════════════════════════════════════════════════════════════════════════════

const VALID_EV_TYPES = new Set([
  'ticket_placed','ticket_canceled','ticket_graded',
  'balance_changed','odds_refreshed','result_refreshed',
  'settlement_closed','payment_confirmed','payment_voided',
  'job_completed','job_failed','risk_limit_changed'
]);
const CLUB_WIDE_EV = new Set(['odds_refreshed','result_refreshed','settlement_closed',
                               'job_completed','job_failed','risk_limit_changed']);

// In-memory buffer (ring buffer per club, 500 events max)
const _evMem = {}; // clubId -> [events]
const EV_MEM_MAX = 500;

function emitEvent(type, payload, scope, requestId) {
  if (!VALID_EV_TYPES.has(type)) return;
  const ev = {
    event_id:   'EV_'+Date.now()+'_'+_crypto.randomBytes(3).toString('hex'),
    club_id:    scope&&scope.clubId  || null,
    actor_id:   scope&&scope.actorId || null,
    player_id:  scope&&scope.playerId|| null,
    type,
    payload_json: payload||{},
    created_at: new Date().toISOString(),
    request_id: requestId||null
  };
  // Ring buffer
  const cid = ev.club_id||'__global';
  if (!_evMem[cid]) _evMem[cid]=[];
  _evMem[cid].push(ev);
  if (_evMem[cid].length>EV_MEM_MAX) _evMem[cid].shift();
  // Persist fire-and-forget
try {
  const sb = getSupabase();

  if (sb) {
    sb.from('event_feed').insert({
      event_id: ev.event_id,
      club_id: ev.club_id,
      actor_id: ev.actor_id,
      player_id: ev.player_id,
      type,
      payload_json: payload || {}
    }).then(() => {}).catch(() => {});
  }

} catch (_e) {}
}

// Cleanup helper (run via admin job or cron)
async function _cleanupEventFeed() {
  const cutoff = new Date(Date.now()-7*86400000).toISOString();
  // Mem buffer
  Object.keys(_evMem).forEach(function(cid){
    _evMem[cid]=_evMem[cid].filter(function(e){ return e.created_at>=cutoff; });
    if(_evMem[cid].length>10000) _evMem[cid]=_evMem[cid].slice(-10000);
  });
  // Supabase
  try {
    const sb=getSupabase();
    if(sb) await sb.from('event_feed').delete().lt('created_at',cutoff);
  } catch(_e){}
}
// ───────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// PHASE W: CRYPTO DEPOSIT INTENTS
// ════════════════════════════════════════════════════════════════════════════

const CRYPTO_WALLETS = {
  USDT: { ERC20: process.env.WALLET_ERC20 || '0x61F74cD55bA283269eb86a2AA7a882B2e1a9225F' },
  USDC: { ERC20: process.env.WALLET_ERC20 || '0x61F74cD55bA283269eb86a2AA7a882B2e1a9225F' },
  ETH:  { ERC20: process.env.WALLET_ERC20 || '0x61F74cD55bA283269eb86a2AA7a882B2e1a9225F' },
  BTC:  { Bitcoin_SegWit: process.env.WALLET_BTC || 'bc1qu6um0h9qdy8nn6w3m2t4x3ava8lp6tm96erwc4' }
};
const INTENT_TTL_MS     = 60 * 60 * 1000;
const FLAG_MISSING_MS   = 30 * 60 * 1000;
const FLAG_UNCONF_MS    = 30 * 60 * 1000;

function _resolveWallet(symbol, network) {
  const s = CRYPTO_WALLETS[symbol];
  return s ? s[network]||null : null;
}

// POST /api/crypto/deposits/create-intent

const app = express();

app.post('/api/crypto/deposits/create-intent', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const { clubId, playerId, packageAmountDiamonds, expectedUsd, cryptoSymbol, network } = req.body||{};
  const errors = [];
  if (!clubId||!playerId)               errors.push('missing_clubId_or_playerId');
  if (!packageAmountDiamonds||parseFloat(packageAmountDiamonds)<=0) errors.push('invalid_package');
  if (!CRYPTO_WALLETS[cryptoSymbol])    errors.push('invalid_cryptoSymbol:'+cryptoSymbol);
  if (errors.length) return res.status(400).json({ ok:false, errors });
  const wallet = _resolveWallet(cryptoSymbol, network);
  if (!wallet) return res.status(400).json({ ok:false, error:'wallet_not_configured_for:'+cryptoSymbol+'/'+network });
  const now = new Date().toISOString();
  const intentId = 'DI_'+playerId+'_'+Date.now();
  const intent = {
    intent_id:intentId, club_id:clubId, player_id:playerId,
    package_amount_diamonds:parseFloat(packageAmountDiamonds),
    expected_usd:parseFloat(expectedUsd)||0, crypto_symbol:cryptoSymbol, network,
    assigned_wallet_address:wallet,
    qr_payload: cryptoSymbol==='BTC' ? 'bitcoin:'+wallet+'?amount='+expectedUsd
                                     : 'ethereum:'+wallet+'?value='+expectedUsd+'&token='+cryptoSymbol,
    status:'created', tx_hash:null, tx_hash_submitted_at:null,
    credited_at:null, credited_by:null, reject_reason:null,
    metadata_json:{}, created_at:now,
    expires_at: new Date(Date.now()+INTENT_TTL_MS).toISOString(),
    updated_at:now
  };
  const sb = getSupabase();
  if (sb) {
    try { await sb.from('crypto_deposit_intents').insert(intent); }
    catch(e) { return res.status(500).json({ ok:false, error:e.message }); }
  }
  console.log('[crypto/intent] created '+intentId+' player='+playerId+' '+cryptoSymbol+' '+packageAmountDiamonds+'d');
  emitEvent('balance_changed',{ playerId, event:'intent_created' },{ clubId, playerId });
  res.json({ ok:true, intentId, wallet, qrPayload:intent.qr_payload,
             expiresAt:intent.expires_at, cryptoSymbol, network });
});

// POST /api/crypto/deposits/submit-hash
app.post('/api/crypto/deposits/submit-hash', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const { intentId, txHash } = req.body||{};
  if (!intentId||!txHash) return res.status(400).json({ ok:false, error:'missing_intentId_or_txHash' });
  if (txHash.trim().length<10) return res.status(400).json({ ok:false, error:'invalid_txHash' });
  const sb = getSupabase();
  const now = new Date().toISOString();
  try {
    // Load intent
    let intent;
    if (sb) {
      const { data } = await sb.from('crypto_deposit_intents').select('*').eq('intent_id',intentId).limit(1);
      intent = data&&data[0];
    }
    if (!intent) return res.status(404).json({ ok:false, error:'intent_not_found' });
    // Ownership
    if (intent.player_id !== actor.actorId && actor.platformRole!=='platform_admin')
      return res.status(403).json({ ok:false, error:'not_owner' });
    if (intent.status==='credited') return res.status(409).json({ ok:false, error:'already_credited' });
    if (intent.status==='rejected') return res.status(409).json({ ok:false, error:'intent_rejected' });
    if (new Date(intent.expires_at).getTime() <= Date.now())
      return res.status(409).json({ ok:false, error:'intent_expired' });
    // Duplicate tx hash check
    if (sb) {
      const { data:dup } = await sb.from('crypto_deposit_intents').select('intent_id')
        .eq('tx_hash',txHash.trim()).neq('intent_id',intentId)
        .not('status','in','(rejected,expired)').limit(1);
      if (dup&&dup[0]) return res.status(409).json({ ok:false, error:'duplicate_txHash' });
      await sb.from('crypto_deposit_intents').update({
        tx_hash:txHash.trim(), tx_hash_submitted_at:now,
        status:'hash_submitted', updated_at:now
      }).eq('intent_id',intentId);
    }
    emitEvent('balance_changed',{ playerId:intent.player_id, event:'hash_submitted' },
      { clubId:intent.club_id, playerId:intent.player_id }, req.requestId);
    _writeAuthAudit('crypto_hash_submitted', actor.actorId, intent.club_id, '/crypto/deposits/submit-hash',
      { intentId, txHash:txHash.trim() });
    console.log('[crypto/hash] submitted intentId='+intentId+' tx='+txHash.trim().slice(0,20)+'...');
    res.json({ ok:true, intentId, status:'hash_submitted' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/admin/crypto/deposits
app.get('/api/admin/crypto/deposits', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const clubId  = req._clubId || req.query.clubId;
  const statusF = req.query.status;
  const nowMs   = Date.now();
  const sb      = getSupabase();
  try {
    let intents = [];
    if (sb) {
      let q = sb.from('crypto_deposit_intents').select('*').order('created_at',{ ascending:false }).limit(50);
      if (clubId && actor.platformRole!=='platform_admin') q=q.eq('club_id',clubId);
      if (statusF) q=q.eq('status',statusF);
      const { data } = await q;
      intents = data||[];
    }
    // Flag intents
    intents = intents.map(function(i) {
      const flags = [];
      if (i.status==='created' && nowMs-new Date(i.created_at).getTime()>FLAG_MISSING_MS) flags.push('missing_hash');
      if (i.status==='hash_submitted' && i.tx_hash_submitted_at &&
          nowMs-new Date(i.tx_hash_submitted_at).getTime()>FLAG_UNCONF_MS) flags.push('awaiting_review');
      return Object.assign({},i,{ flags, ageMs:nowMs-new Date(i.created_at).getTime() });
    });
    const counts = { created:0,hash_submitted:0,credited:0,rejected:0,expired:0 };
    intents.forEach(function(i){ counts[i.status]=(counts[i.status]||0)+1; });
    res.json({ ok:true, intents, counts });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ── SCANNER ENGINE ───────────────────────────────────────────────────────────────────────────
const SCANNER_ENABLED   = process.env.BLOCKCHAIN_SCANNER_ENABLED === 'true';
const AUTO_CREDIT_CRYPTO= process.env.AUTO_CREDIT_CONFIRMED_CRYPTO === 'true';
const AMOUNT_TOLERANCE  = 0.02; // 2% underpay tolerance
const MIN_CONFIRMATIONS = 3;

function _verifyCryptoTx(txHash, network, mockResult) {
  if (!SCANNER_ENABLED) {
    return { txHash, network, status:'scan_error', confirmations:0,
             amountCrypto:null, amountUsdEstimate:null,
             fromAddress:null, toAddress:null,
             errorMessage:'scanner_not_configured' };
  }
  if (mockResult) {
    return Object.assign({ txHash, network, errorMessage:null }, mockResult);
  }
  // Real scanner would call Etherscan/BlockCypher API here
  return { txHash, network, status:'not_found', confirmations:0,
           amountCrypto:null, amountUsdEstimate:null,
           fromAddress:null, toAddress:null, errorMessage:null };
}

function _matchScanToIntent(scanResult, intent) {
  if (!intent) return { matched:false, reason:'no_intent' };
  if (scanResult.status==='scan_error') return { matched:false, reason:'scan_error' };
  if (scanResult.status==='not_found')  return { matched:false, reason:'not_found' };
  const expectedWallet = intent.assigned_wallet_address;
  const actualWallet   = (scanResult.toAddress||'').toLowerCase();
  if (actualWallet && expectedWallet && actualWallet !== expectedWallet.toLowerCase())
    return { matched:false, reason:'wallet_mismatch', expected:expectedWallet, actual:scanResult.toAddress };
  const expectedUsd = parseFloat(intent.expected_usd||0);
  const actualUsd   = parseFloat(scanResult.amountUsdEstimate||0);
  if (expectedUsd>0 && actualUsd>0) {
    const minAcceptable = expectedUsd*(1-AMOUNT_TOLERANCE);
    if (actualUsd<minAcceptable)
      return { matched:false, reason:'amount_short', expectedUsd, actualUsd, minAcceptable };
  }
  return { matched:true,
           matchedIntentId:intent.intent_id, matchedPlayerId:intent.player_id,
           matchedClubId:intent.club_id, scanStatus:scanResult.status,
           confirmations:scanResult.confirmations };
}

// GET /api/admin/crypto/reconciliation
app.get('/api/admin/crypto/reconciliation', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const nowMs = Date.now();
  const clubId = req._clubId || req.query.clubId;
  try {
    // Load intents
    let iq = sb.from('crypto_deposit_intents').select('*').order('created_at',{ ascending:false }).limit(200);
    if (clubId && actor.platformRole !== 'platform_admin') iq = iq.eq('club_id', clubId);
    const { data: intents } = await iq;
    // Load scans
    const { data: scans } = await sb.from('crypto_tx_scans').select('*').order('scanned_at',{ ascending:false }).limit(500);

    const FLAG_MISSING_HASH_MS  = 30 * 60 * 1000;
    const FLAG_NO_SCAN_AFTER_MS = 30 * 60 * 1000;

    function _dayKey(ts) { return ts ? new Date(ts).toISOString().slice(0,10) : 'unknown'; }
    function _scanIdx(ss) {
      var bi = {}, tc = {};
      (ss||[]).forEach(function(s){
        var id = s.matched_intent_id;
        if (id) { if (!bi[id]) bi[id]=[]; bi[id].push(s); }
        var h = s.tx_hash; if (h) tc[h]=(tc[h]||0)+1;
      });
      return { bi, tc };
    }
    var idx = _scanIdx(scans||[]);
    var all = intents||[];

    // Daily summary
    var daysMap = {};
    all.forEach(function(i) {
      var d = _dayKey(i.created_at);
      if (!daysMap[d]) daysMap[d] = { date:d, totalDepositIntents:0, totalHashSubmitted:0,
        totalCreditedDiamonds:0, totalExpectedUsd:0, totalScannedUsd:0, totalConfirmedUsd:0,
        totalRejected:0, missingHashCount:0, pendingReviewCount:0, mismatchCount:0 };
      var r = daysMap[d];
      r.totalDepositIntents++;
      r.totalExpectedUsd += parseFloat(i.expected_usd||0);
      if (i.status==='credited')       r.totalCreditedDiamonds += parseFloat(i.package_amount_diamonds||0);
      if (i.status==='rejected')       r.totalRejected++;
      if (i.status==='pending_review') r.pendingReviewCount++;
      if (i.tx_hash) r.totalHashSubmitted++;
      if (i.status==='created' && nowMs-new Date(i.created_at).getTime()>FLAG_MISSING_HASH_MS) r.missingHashCount++;
      (idx.bi[i.intent_id]||[]).forEach(function(s){
        var u=parseFloat(s.amount_usd_estimate||0);
        r.totalScannedUsd+=u;
        if (s.status==='found_confirmed') r.totalConfirmedUsd+=u;
        if (s.status==='mismatch') r.mismatchCount++;
      });
    });
    var dailySummary = Object.values(daysMap).sort(function(a,b){ return b.date.localeCompare(a.date); });

    // Wallet summary
    var walletMap = {};
    all.forEach(function(i) {
      var w=(i.assigned_wallet_address||'').toLowerCase();
      var k=w+'::'+i.network+'::'+i.crypto_symbol;
      if (!walletMap[k]) walletMap[k]={ walletAddress:i.assigned_wallet_address,
        network:i.network, cryptoSymbol:i.crypto_symbol,
        confirmedUsd:0, creditedDiamonds:0, pendingUsd:0, mismatchCount:0, txCount:0 };
      var rw=walletMap[k];
      if (i.tx_hash) rw.txCount++;
      if (i.status==='credited') rw.creditedDiamonds+=parseFloat(i.package_amount_diamonds||0);
      (idx.bi[i.intent_id]||[]).forEach(function(s){
        var u=parseFloat(s.amount_usd_estimate||0);
        if (s.status==='found_confirmed') rw.confirmedUsd+=u;
        else if (s.status==='found_pending') rw.pendingUsd+=u;
        if (s.status==='mismatch') rw.mismatchCount++;
      });
    });
    var walletSummary = Object.values(walletMap);

    // Flagged rows
    var flagged = [];
    all.forEach(function(i) {
      var flags=[]; var is=(idx.bi[i.intent_id]||[]); var ls=is[is.length-1]||null;
      if (i.status==='created' && nowMs-new Date(i.created_at).getTime()>FLAG_MISSING_HASH_MS) flags.push('missing_hash');
      if (i.status==='hash_submitted' && i.tx_hash_submitted_at) {
        var wms=nowMs-new Date(i.tx_hash_submitted_at).getTime();
        if (wms>FLAG_NO_SCAN_AFTER_MS && is.length===0) flags.push('no_scan_after_hash');
      }
      if (ls && ls.status==='found_confirmed' && i.status!=='credited') flags.push('confirmed_not_credited');
      if (i.status==='credited' && ls && ls.status==='mismatch') flags.push('credited_mismatch');
      if (is.some(function(s){ return s.status==='mismatch'; })) flags.push('wallet_mismatch');
      if (is.some(function(s){ return s.error_message==='amount_short'; })) flags.push('amount_short');
      if (i.tx_hash && (idx.tc[i.tx_hash]||0)>1) flags.push('duplicate_txhash_attempt');
      if (flags.length) flagged.push({ intentId:i.intent_id, playerId:i.player_id,
        clubId:i.club_id, assignedWalletAddress:i.assigned_wallet_address,
        txHash:i.tx_hash||null, status:i.status, flags });
    });

    // Player audit rows
    var playerAuditRows = all.map(function(i) {
      var is=(idx.bi[i.intent_id]||[]); var ls=is[is.length-1]||null;
      var myFlag=flagged.find(function(f){ return f.intentId===i.intent_id; });
      return { playerId:i.player_id, intentId:i.intent_id,
        packageAmountDiamonds:parseFloat(i.package_amount_diamonds||0),
        expectedUsd:parseFloat(i.expected_usd||0),
        assignedWalletAddress:i.assigned_wallet_address,
        txHash:i.tx_hash||null,
        scanStatus:ls?ls.status:null,
        matchedPlayerId:ls?ls.matched_player_id:null,
        creditedDiamonds:i.status==='credited'?parseFloat(i.package_amount_diamonds||0):0,
        status:i.status, flags:myFlag?myFlag.flags:[],
        createdAt:i.created_at, updatedAt:i.updated_at };
    });

    res.json({ ok:true, dailySummary, walletSummary, flaggedRows:flagged, playerAuditRows,
      meta:{ totalIntents:all.length, totalFlagged:flagged.length,
             generatedAt:new Date().toISOString() } });
  } catch(e) {
    console.error('[crypto/recon]', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin/crypto/deposits/scan
app.post('/api/admin/crypto/deposits/scan', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { intentId, txHash, mockResult } = req.body||{};
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    // Load intent
    let intent = null;
    if (intentId) {
      const { data } = await sb.from('crypto_deposit_intents').select('*').eq('intent_id',intentId).limit(1);
      intent = data&&data[0];
    } else if (txHash) {
      const { data } = await sb.from('crypto_deposit_intents').select('*').eq('tx_hash',txHash).limit(1);
      intent = data&&data[0];
    }
    if (!intent) return res.status(404).json({ ok:false, error:'intent_not_found' });
    const hash    = txHash || intent.tx_hash;
    const network = intent.network;
    if (!hash) return res.status(400).json({ ok:false, error:'no_tx_hash_on_intent' });

    // Run scanner
    const scanResult = _verifyCryptoTx(hash, network, mockResult||null);
    const matchResult= _matchScanToIntent(scanResult, intent);

    // Build and persist scan row
    const now    = new Date().toISOString();
    const scanId = 'SCAN_'+hash.slice(0,16)+'_'+Date.now();
    const scanRow = {
      scan_id:scanId, tx_hash:hash, network, crypto_symbol:intent.crypto_symbol,
      status:scanResult.status, confirmations:scanResult.confirmations||0,
      amount_crypto:scanResult.amountCrypto||null,
      amount_usd_estimate:scanResult.amountUsdEstimate||null,
      from_address:scanResult.fromAddress||null,
      to_address:scanResult.toAddress||null,
      matched_intent_id:  matchResult.matched?matchResult.matchedIntentId:null,
      matched_player_id:  matchResult.matched?matchResult.matchedPlayerId:null,
      matched_club_id:    matchResult.matched?matchResult.matchedClubId:null,
      scanned_at:now, raw_json:scanResult,
      error_message:scanResult.errorMessage||null
    };
    await sb.from('crypto_tx_scans').insert(scanRow);

    // Update intent status based on scan
    let newIntentStatus = intent.status;
    if (matchResult.matched && scanResult.status==='found_pending') newIntentStatus='pending_review';
    if (matchResult.matched && scanResult.status==='found_confirmed') newIntentStatus='pending_review';
    if (!matchResult.matched && scanResult.status==='not_found') newIntentStatus=intent.status; // no change
    await sb.from('crypto_deposit_intents')
      .update({ status:newIntentStatus, updated_at:now })
      .eq('intent_id',intent.intent_id);

    // Auto-credit if enabled and confirmed
    let autoCredited = false;
    if (AUTO_CREDIT_CRYPTO && matchResult.matched &&
        scanResult.status==='found_confirmed' &&
        scanResult.confirmations>=MIN_CONFIRMATIONS) {
      const iKey = 'AUTO_CRYPTO_'+intent.intent_id;
      try {
        await _writeLedgerEntry({
          clubId:intent.club_id, playerId:intent.player_id,
          eventType:'BALANCE_ADJUSTMENT', amount:intent.package_amount_diamonds,
          idempotencyKey:iKey, createdBy:'scanner',
          reason:'auto_crypto_credit:'+intent.intent_id
        });
        await sb.from('crypto_deposit_intents').update({
          status:'credited', credited_at:now, credited_by:'scanner', updated_at:now
        }).eq('intent_id',intent.intent_id);
        autoCredited = true;
        console.log('[crypto/scan] auto-credited +'+intent.package_amount_diamonds+'d player='+intent.player_id);
        emitEvent('balance_changed',{ playerId:intent.player_id, diamonds:intent.package_amount_diamonds },
          { clubId:intent.club_id, playerId:intent.player_id }, req.requestId);
      } catch(_e) { console.warn('[crypto/scan] auto-credit error:', _e.message); }
    }

    console.log('[crypto/scan] '+hash.slice(0,20)+'... status='+scanResult.status+
      ' match='+(matchResult.matched?'YES '+matchResult.matchedPlayerId:'NO '+matchResult.reason));
    res.json({ ok:true, scanId, scanStatus:scanResult.status,
      matched:matchResult.matched, matchReason:matchResult.reason||null,
      matchedPlayerId:matchResult.matchedPlayerId||null,
      autoCredited, confirmations:scanResult.confirmations||0,
      intentStatus:newIntentStatus });
  } catch(e) {
    console.error('[crypto/scan] error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});
// ───────────────────────────────────────────────────────────────────────────

// POST /api/admin/crypto/deposits/confirm
app.post('/api/admin/crypto/deposits/confirm', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor||{};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin)
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { intentId } = req.body||{};
  if (!intentId) return res.status(400).json({ ok:false, error:'missing_intentId' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const { data } = await sb.from('crypto_deposit_intents').select('*').eq('intent_id',intentId).limit(1);
    const intent = data&&data[0];
    if (!intent) return res.status(404).json({ ok:false, error:'intent_not_found' });
    if (intent.status==='credited') return res.json({ ok:true, idempotent:true, intentId });
    if (intent.status==='rejected') return res.status(409).json({ ok:false, error:'intent_rejected' });
    if (!['hash_submitted','pending_review','confirmed'].includes(intent.status))
      return res.status(409).json({ ok:false, error:'invalid_status_for_confirm:'+intent.status });
    const iKey = 'CRYPTO_CONF_'+intentId;
    // Write canonical ledger credit (BALANCE_ADJUSTMENT for diamond purchase)
    await _writeLedgerEntry({
      clubId:intent.club_id, playerId:intent.player_id,
      eventType:'BALANCE_ADJUSTMENT', amount:intent.package_amount_diamonds,
      idempotencyKey:iKey, createdBy:actor.actorId||'admin',
      reason:'crypto_deposit_credited:'+intentId,
      metadataJson:{ intentId, cryptoSymbol:intent.crypto_symbol, txHash:intent.tx_hash }
    });
    const now = new Date().toISOString();
    await sb.from('crypto_deposit_intents').update({
      status:'credited', credited_at:now, credited_by:actor.actorId||'admin',
      idempotency_key:iKey, updated_at:now
    }).eq('intent_id',intentId);
    emitEvent('balance_changed',{ playerId:intent.player_id, diamonds:intent.package_amount_diamonds },
      { clubId:intent.club_id, playerId:intent.player_id }, req.requestId);
    _writeAuthAudit('crypto_deposit_credited', actor.actorId, intent.club_id,
      '/admin/crypto/deposits/confirm', { intentId, diamonds:intent.package_amount_diamonds });
    console.log('[crypto/confirm] '+intentId+' +'+intent.package_amount_diamonds+'d player='+intent.player_id);
    res.json({ ok:true, intentId, diamonds:intent.package_amount_diamonds, status:'credited' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/admin/crypto/deposits/reject
app.post('/api/admin/crypto/deposits/reject', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor||{};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin)
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { intentId, reason } = req.body||{};
  if (!intentId||!reason||!reason.trim()) return res.status(400).json({ ok:false, error:'missing_intentId_or_reason' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const { data } = await sb.from('crypto_deposit_intents').select('*').eq('intent_id',intentId).limit(1);
    const intent = data&&data[0];
    if (!intent) return res.status(404).json({ ok:false, error:'intent_not_found' });
    if (intent.status==='credited') return res.status(409).json({ ok:false, error:'already_credited' });
    const now = new Date().toISOString();
    await sb.from('crypto_deposit_intents').update({
      status:'rejected', reject_reason:reason.trim(), updated_at:now
    }).eq('intent_id',intentId);
    emitEvent('balance_changed',{ playerId:intent.player_id, event:'deposit_rejected' },
      { clubId:intent.club_id, playerId:intent.player_id }, req.requestId);
    _writeAuthAudit('crypto_deposit_rejected', actor.actorId, intent.club_id,
      '/admin/crypto/deposits/reject', { intentId, reason:reason.trim() });
    res.json({ ok:true, intentId, status:'rejected' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
// ───────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// PHASE AA: HOST ACTIVE-BETTOR DIAMOND CHARGING
// ════════════════════════════════════════════════════════════════════════════

const HOST_ACTIVE_BETTOR_FEE = 15; // diamonds

function _getWeekStart(nowMs) {
  var d   = new Date(nowMs || Date.now());
  var day = d.getUTCDay();
  var diff= day === 0 ? -6 : 1 - day;
  var mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() + diff);
  mon.setUTCHours(0,0,0,0);
  return mon.toISOString().slice(0,10);
}

async function _processActiveBettorCharge(sb, clubId, playerId, ticketId, nowMs) {
  if (!sb) return { ok:true, charged:false, reason:'supabase_not_configured_dev_bypass' };
  const weekStart = _getWeekStart(nowMs);

  // Already active this week?
  const { data:existing } = await sb.from('weekly_active_bettors')
    .select('player_id').eq('club_id',clubId).eq('player_id',playerId)
    .eq('week_start',weekStart).limit(1);
  if (existing && existing[0]) {
    return { ok:true, charged:false, reason:'already_active_this_week', weekStart };
  }

  // Load host balance
  const { data:balRow } = await sb.from('host_diamond_balances')
    .select('*').eq('club_id',clubId).limit(1);
  const host = balRow && balRow[0];
  // FAIL-CLOSED: missing host balance row blocks new bettors in production
  if (!host) {
    const isDev = process.env.NODE_ENV !== 'production';
    const devBypass = process.env.DEV_AUTH_BYPASS === 'true';
    if (!isDev || !devBypass) {
      return {
        ok:false, error:'host_diamond_balance_missing', httpStatus:402,
        message:'Host diamond balance is not configured. Contact the host to set up their account.'
      };
    }
    console.warn('[WARN] DEV_AUTH_BYPASS: host_diamond_balance_missing for club='+clubId+' — allowing in dev');
    return { ok:true, charged:false, reason:'dev_bypass_no_balance_row', weekStart };
  }

  if (host.balance_diamonds < HOST_ACTIVE_BETTOR_FEE) {
    return {
      ok:false, error:'host_diamond_balance_insufficient', httpStatus:402,
      message:'Host diamond balance is too low to activate another bettor this week. Ask host to refill diamonds.',
      balance:host.balance_diamonds, required:HOST_ACTIVE_BETTOR_FEE
    };
  }

  // Deduct, activate, write ledger
  const ledgerId = 'HAB_'+clubId+'_'+playerId+'_'+weekStart;
  const now = new Date(nowMs||Date.now()).toISOString();

  await sb.from('host_diamond_balances')
    .update({ balance_diamonds: host.balance_diamonds - HOST_ACTIVE_BETTOR_FEE, updated_at:now })
    .eq('club_id', clubId);

  await sb.from('weekly_active_bettors').insert({
    club_id:clubId, player_id:playerId, week_start:weekStart,
    first_ticket_id:ticketId, activated_at:now,
    charged_diamonds:HOST_ACTIVE_BETTOR_FEE, charge_ledger_id:ledgerId
  });

  // Write host ledger entry
  await _writeLedgerEntry({
    clubId, playerId:host.host_actor_id,
    eventType:'HOST_ACTIVE_BETTOR_CHARGE', amount:HOST_ACTIVE_BETTOR_FEE,
    idempotencyKey:ledgerId, createdBy:'system',
    reason:'active_bettor_fee:'+playerId+':'+weekStart,
    metadataJson:{ playerId, weekStart, ticketId }
  }).catch(function(e){ console.warn('[hab] ledger write error:', e.message); });

  // Write host diamond ledger entry for the charge
  await _writeHostDiamondLedger(sb, {
    ledgerId, clubId, hostActorId:host.host_actor_id,
    eventType:'HOST_ACTIVE_BETTOR_CHARGE', amount:HOST_ACTIVE_BETTOR_FEE, direction:'debit',
    balanceBefore:host.balance_diamonds, balanceAfter:host.balance_diamonds-HOST_ACTIVE_BETTOR_FEE,
    createdBy:'system', reason:'active_bettor_fee:'+playerId+':'+weekStart,
    idempotencyKey:ledgerId, metadata:{ playerId, weekStart, ticketId }
  });
  console.log('[host/active-bettor] CHARGED playerId='+playerId+
    ' -'+HOST_ACTIVE_BETTOR_FEE+'d week='+weekStart+' balance='+(host.balance_diamonds-HOST_ACTIVE_BETTOR_FEE));

  return {
    ok:true, charged:true, chargedDiamonds:HOST_ACTIVE_BETTOR_FEE,
    ledgerEvent:'HOST_ACTIVE_BETTOR_CHARGE', weekStart, ledgerId
  };
}

// ── Host diamond ledger writer ──────────────────────────────────────────────────────────────────────────
const VALID_HD_EVENT_TYPES = new Set([
  'HOST_DIAMOND_TOPUP','HOST_ACTIVE_BETTOR_CHARGE',
  'HOST_DIAMOND_ADJUSTMENT','HOST_DIAMOND_REFUND'
]);

async function _writeHostDiamondLedger(sb, params) {
  if (!sb) return;
  const { ledgerId, clubId, hostActorId, eventType, amount, direction,
          balanceBefore, balanceAfter, createdBy, reason, idempotencyKey, metadata } = params;
  try {
    await sb.from('host_diamond_ledger').insert({
      ledger_id:ledgerId, club_id:clubId, host_actor_id:hostActorId,
      event_type:eventType, amount_diamonds:amount, direction,
      balance_before:balanceBefore, balance_after:balanceAfter,
      created_at:new Date().toISOString(), created_by:createdBy||'system',
      reason:reason||null, idempotency_key:idempotencyKey||null,
      metadata_json:metadata||{}
    });
  } catch(e) { console.warn('[hdl] ledger write error:', e.message); }
}

// POST /api/admin/host-diamonds/topup
app.post('/api/admin/host-diamonds/topup', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor||{};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { clubId, hostActorId, amountDiamonds, method, reason, idempotencyKey } = req.body||{};
  const VALID_METHODS = new Set(['admin_credit','crypto','manual','promo','other']);
  if (!clubId||!idempotencyKey)       return res.status(400).json({ ok:false, error:'missing_clubId_or_idempotencyKey' });
  const amt = parseFloat(amountDiamonds);
  if (isNaN(amt)||amt<=0)             return res.status(400).json({ ok:false, error:'invalid_amount' });
  if (!VALID_METHODS.has(method))     return res.status(400).json({ ok:false, error:'invalid_method:'+method });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    // Idempotency check
    const { data:idemRow } = await sb.from('host_diamond_ledger')
      .select('ledger_id').eq('idempotency_key',idempotencyKey).limit(1);
    if (idemRow&&idemRow[0]) return res.json({ ok:true, idempotent:true });

    // Load current balance
    const { data:balRow } = await sb.from('host_diamond_balances')
      .select('*').eq('club_id',clubId).limit(1);
    const host = balRow&&balRow[0];
    const balBefore = host ? parseFloat(host.balance_diamonds) : 0;
    const balAfter  = balBefore + amt;
    const now = new Date().toISOString();
    const ledgerId = idempotencyKey;

    // Upsert balance
    await sb.from('host_diamond_balances').upsert({
      club_id:clubId, host_actor_id:hostActorId||host&&host.host_actor_id||'unknown',
      balance_diamonds:balAfter, updated_at:now
    },{ onConflict:'club_id' });

    // Write ledger entry
    await _writeHostDiamondLedger(sb, {
      ledgerId, clubId, hostActorId:hostActorId||host&&host.host_actor_id||'unknown',
      eventType:'HOST_DIAMOND_TOPUP', amount:amt, direction:'credit',
      balanceBefore:balBefore, balanceAfter:balAfter,
      createdBy:actor.actorId||'admin', reason:reason||null,
      idempotencyKey, metadata:{ method }
    });
    _writeAuthAudit('host_diamond_topup', actor.actorId, clubId,
      '/admin/host-diamonds/topup', { amt, method });
    console.log('[host/topup] +'+amt+'d bal='+balBefore+'->'+balAfter);
    res.json({ ok:true, clubId, balanceBefore:balBefore, balanceAfter:balAfter,
               amountDiamonds:amt, ledgerId });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/admin/host-diamonds/adjust
app.post('/api/admin/host-diamonds/adjust', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor||{};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { clubId, amountDiamonds, direction, reason } = req.body||{};
  if (!clubId||!reason||!reason.trim()) return res.status(400).json({ ok:false, error:'missing_clubId_or_reason' });
  if (!['credit','debit'].includes(direction)) return res.status(400).json({ ok:false, error:'invalid_direction' });
  const amt = parseFloat(amountDiamonds);
  if (isNaN(amt)||amt<=0) return res.status(400).json({ ok:false, error:'invalid_amount' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const { data:balRow } = await sb.from('host_diamond_balances')
      .select('*').eq('club_id',clubId).limit(1);
    const host = balRow&&balRow[0];
    if (!host) return res.status(404).json({ ok:false, error:'host_balance_not_found' });
    const balBefore = parseFloat(host.balance_diamonds);
    const balAfter  = direction==='credit' ? balBefore+amt : balBefore-amt;
    if (balAfter < 0 && actor.platformRole!=='platform_admin')
      return res.status(400).json({ ok:false, error:'would_go_negative', balanceBefore:balBefore, wouldBe:balAfter });
    const now = new Date().toISOString();
    const ledgerId = 'ADJ_'+clubId+'_'+Date.now();
    await sb.from('host_diamond_balances')
      .update({ balance_diamonds:balAfter, updated_at:now }).eq('club_id',clubId);
    await _writeHostDiamondLedger(sb, {
      ledgerId, clubId, hostActorId:host.host_actor_id,
      eventType:'HOST_DIAMOND_ADJUSTMENT', amount:amt, direction,
      balanceBefore:balBefore, balanceAfter:balAfter,
      createdBy:actor.actorId||'admin', reason:reason.trim(),
      idempotencyKey:null, metadata:{}
    });
    _writeAuthAudit('host_diamond_adjust', actor.actorId, clubId,
      '/admin/host-diamonds/adjust', { amt, direction, balBefore, balAfter });
    res.json({ ok:true, balanceBefore:balBefore, balanceAfter:balAfter, direction, ledgerId });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
// ────────────────────────────────────────────────────────────────────────────

// POST /api/admin/host-diamonds/seed
app.post('/api/admin/host-diamonds/seed', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const { clubId, hostActorId, startingBalanceDiamonds, force } = req.body||{};
  if (!clubId||!hostActorId) return res.status(400).json({ ok:false, error:'missing_clubId_or_hostActorId' });
  const bal = parseFloat(startingBalanceDiamonds);
  if (isNaN(bal)||bal<0) return res.status(400).json({ ok:false, error:'invalid_startingBalance' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const { data:existing } = await sb.from('host_diamond_balances').select('*').eq('club_id',clubId).limit(1);
    if (existing&&existing[0]&&!force) {
      return res.status(409).json({ ok:false, error:'balance_row_already_exists',
        current:parseFloat(existing[0].balance_diamonds) });
    }
    const now = new Date().toISOString();
    await sb.from('host_diamond_balances').upsert({
      club_id:clubId, host_actor_id:hostActorId,
      balance_diamonds:bal, updated_at:now
    }, { onConflict:'club_id' });
    _writeAuthAudit('host_balance_seeded', actor.actorId, clubId,
      '/admin/host-diamonds/seed', { hostActorId, bal, force:!!force });
    console.log('[host/seed] hostActorId='+hostActorId+' bal='+bal+' force='+!!force);
    res.json({ ok:true, clubId, hostActorId, balanceDiamonds:bal,
      created:!(existing&&existing[0]), overwritten:!!(existing&&existing[0]) });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
// ────────────────────────────────────────────────────────────────────────────

// GET /api/host/diamond-invoice
app.get('/api/host/diamond-invoice', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.settlement_manager && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const clubId    = req._clubId || req.query.clubId;
  const weekStart = req.query.weekStart || _getWeekStart();
  const sb = getSupabase();
  if (!sb) return res.json({ ok:true, invoiceId:'HDI_'+clubId+'_'+weekStart, clubId, weekStart,
    activeBettorCount:0, totalActiveBettorCharges:0, totalTopups:0, totalAdjustments:0,
    lineItems:[], activeBettors:[], _note:'supabase_not_configured' });
  try {
    var weekEndD = new Date(weekStart+'T00:00:00Z');
    weekEndD.setUTCDate(weekEndD.getUTCDate()+7);
    var weekEnd = weekEndD.toISOString().slice(0,10);
    const { data:bettors } = await sb.from('weekly_active_bettors')
      .select('*').eq('club_id',clubId).eq('week_start',weekStart).order('activated_at',{ ascending:true });
    const { data:ledger }  = await sb.from('host_diamond_ledger')
      .select('*').eq('club_id',clubId)
      .gte('created_at',weekStart+'T00:00:00Z').lt('created_at',weekEnd+'T00:00:00Z')
      .order('created_at',{ ascending:true });
    const { data:balRow }  = await sb.from('host_diamond_balances')
      .select('balance_diamonds').eq('club_id',clubId).limit(1);
    const endBal = balRow&&balRow[0] ? parseFloat(balRow[0].balance_diamonds) : null;
    const ll = ledger||[];
    const bs = bettors||[];
    const totalCharges = ll.filter(function(r){ return r.event_type.includes('CHARGE'); })
      .reduce(function(s,r){ return s+parseFloat(r.amount_diamonds); },0);
    const totalTopups  = ll.filter(function(r){ return r.event_type.includes('TOPUP'); })
      .reduce(function(s,r){ return s+parseFloat(r.amount_diamonds); },0);
    const totalAdj     = ll.filter(function(r){ return r.event_type.includes('ADJUSTMENT'); })
      .reduce(function(s,r){ return s+parseFloat(r.amount_diamonds); },0);
    var lineItems = [];
    if (bs.length) lineItems.push({ description:'Active bettor fee', quantity:bs.length,
      unitPriceDiamonds:HOST_ACTIVE_BETTOR_FEE, totalDiamonds:bs.length*HOST_ACTIVE_BETTOR_FEE });
    if (totalTopups) lineItems.push({ description:'Diamond top-ups', quantity:1,
      unitPriceDiamonds:totalTopups, totalDiamonds:totalTopups });
    if (totalAdj)   lineItems.push({ description:'Adjustments', quantity:1,
      unitPriceDiamonds:totalAdj, totalDiamonds:totalAdj });
    res.json({ ok:true, invoiceId:'HDI_'+clubId+'_'+weekStart, clubId, weekStart, weekEnd,
      feePerActiveBettor:HOST_ACTIVE_BETTOR_FEE, activeBettorCount:bs.length,
      totalActiveBettorCharges:totalCharges, totalTopups, totalAdjustments:totalAdj,
      startingBalance:null, endingBalance:endBal,
      lineItems,
      activeBettors:bs.map(function(r){ return { playerId:r.player_id, firstTicketId:r.first_ticket_id,
        activatedAt:r.activated_at, chargedDiamonds:parseFloat(r.charged_diamonds) }; }),
      generatedAt:new Date().toISOString() });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
// ────────────────────────────────────────────────────────────────────────────

// GET /api/host/diamond-weekly-report
app.get('/api/host/diamond-weekly-report', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.settlement_manager && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const clubId    = req._clubId || req.query.clubId;
  const weekStart = req.query.weekStart || _getWeekStart();
  const sb = getSupabase();
  if (!sb) return res.json({ ok:true, weekStart, totalActiveBettors:0, totalCharges:0,
    totalTopups:0, totalAdjustments:0, activeBettors:[], ledgerRows:[], _note:'supabase_not_configured' });
  try {
    // Week window
    var weekEndD = new Date(weekStart+'T00:00:00Z');
    weekEndD.setUTCDate(weekEndD.getUTCDate()+7);
    var weekEnd = weekEndD.toISOString().slice(0,10);

    // Active bettors for this week
    const { data:bettors } = await sb.from('weekly_active_bettors')
      .select('*').eq('club_id',clubId).eq('week_start',weekStart)
      .order('activated_at',{ ascending:true });

    // Ledger rows for this week
    const { data:ledger } = await sb.from('host_diamond_ledger')
      .select('*').eq('club_id',clubId)
      .gte('created_at',weekStart+'T00:00:00Z')
      .lt('created_at',weekEnd+'T00:00:00Z')
      .order('created_at',{ ascending:true });

    // Current balance
    const { data:balRow } = await sb.from('host_diamond_balances')
      .select('balance_diamonds').eq('club_id',clubId).limit(1);
    const endBal = balRow&&balRow[0] ? parseFloat(balRow[0].balance_diamonds) : null;

    const ll = ledger||[];
    const totalCharges     = ll.filter(function(r){ return r.event_type.includes('CHARGE'); })
      .reduce(function(s,r){ return s+parseFloat(r.amount_diamonds); },0);
    const totalTopups      = ll.filter(function(r){ return r.event_type.includes('TOPUP'); })
      .reduce(function(s,r){ return s+parseFloat(r.amount_diamonds); },0);
    const totalAdjustments = ll.filter(function(r){ return r.event_type.includes('ADJUSTMENT'); })
      .reduce(function(s,r){ return s+parseFloat(r.amount_diamonds); },0);

    res.json({ ok:true, weekStart, weekEnd, feePerActiveBettor:HOST_ACTIVE_BETTOR_FEE,
      endingHostBalance:endBal,
      totalActiveBettors:(bettors||[]).length, totalCharges, totalTopups, totalAdjustments,
      activeBettors:(bettors||[]).map(function(r){
        return { playerId:r.player_id, firstTicketId:r.first_ticket_id,
                 activatedAt:r.activated_at, chargedDiamonds:parseFloat(r.charged_diamonds),
                 chargeLedgerId:r.charge_ledger_id };
      }),
      ledgerRows:ll.map(function(r){
        return { eventType:r.event_type, direction:r.direction,
                 amountDiamonds:parseFloat(r.amount_diamonds),
                 balanceBefore:parseFloat(r.balance_before), balanceAfter:parseFloat(r.balance_after),
                 createdAt:r.created_at, reason:r.reason||null };
      })
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
// ────────────────────────────────────────────────────────────────────────────

// GET /api/host/diamond-usage
app.get('/api/host/diamond-usage', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.settlement_manager && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const clubId = req._clubId || req.query.clubId;
  const sb = getSupabase();
  if (!sb) return res.json({ ok:true, balanceDiamonds:0, activeBettorCount:0,
    feePerActiveBettor:HOST_ACTIVE_BETTOR_FEE, capacityTotal:0, capacityUsed:0,
    capacityRemaining:0, activeBettors:[], _note:'supabase_not_configured' });
  try {
    const weekStart = _getWeekStart();
    const { data:balRow } = await sb.from('host_diamond_balances')
      .select('*').eq('club_id',clubId).limit(1);
    const balance = balRow&&balRow[0] ? parseFloat(balRow[0].balance_diamonds) : 0;
    const { data:wab } = await sb.from('weekly_active_bettors')
      .select('*').eq('club_id',clubId).eq('week_start',weekStart);
    const activeBettorCount = (wab||[]).length;
    const capacityRemaining = Math.floor(balance / HOST_ACTIVE_BETTOR_FEE);
    // Recent ledger
    const { data:recentLedger } = await sb.from('host_diamond_ledger')
      .select('*').eq('club_id',clubId).order('created_at',{ ascending:false }).limit(10);
    const weekIso = weekStart+'T00:00:00.000Z';
    const ledgerAll = recentLedger||[];
    const totalTopupsThisWeek = ledgerAll
      .filter(function(e){ return e.event_type==='HOST_DIAMOND_TOPUP' && e.created_at>=weekIso; })
      .reduce(function(s,e){ return s+parseFloat(e.amount_diamonds); },0);
    const totalChargesThisWeek = ledgerAll
      .filter(function(e){ return e.event_type==='HOST_ACTIVE_BETTOR_CHARGE' && e.created_at>=weekIso; })
      .reduce(function(s,e){ return s+parseFloat(e.amount_diamonds); },0);
    res.json({ ok:true, balanceDiamonds:balance, activeBettorCount,
      feePerActiveBettor:HOST_ACTIVE_BETTOR_FEE,
      capacityTotal: capacityRemaining + activeBettorCount,
      capacityUsed:  activeBettorCount,
      capacityRemaining,
      projectedRemainingActiveBettors: capacityRemaining,
      totalTopupsThisWeek, totalChargesThisWeek,
      recentLedger: ledgerAll,
      activeBettors: (wab||[]).map(function(r){
        return { playerId:r.player_id, weekStart:r.week_start,
                 activatedAt:r.activated_at, chargedDiamonds:r.charged_diamonds };
      })
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
// ────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// PHASE V: FRAUD/ABUSE SIGNALS
// ════════════════════════════════════════════════════════════════════════════

const ALERT_TYPES = new Set([
  'rapid_bet_velocity','repeated_rate_limit','repeated_failed_auth',
  'odds_change_rejections','stale_line_attempts','large_payout_attempt',
  'over_limit_attempt','repeated_cancel_attempts',
  'settlement_overpayment_attempt','manual_override_used'
]);

const ALERT_SEVERITY = {
  rapid_bet_velocity:             { medium:5,  high:10 },
  repeated_rate_limit:            { medium:3,  high:10 },
  repeated_failed_auth:           { medium:3,  high:8  },
  odds_change_rejections:         { medium:3,  high:8  },
  stale_line_attempts:            { medium:3,  high:8  },
  large_payout_attempt:           { medium:1,  high:3  },
  over_limit_attempt:             { medium:2,  high:5  },
  repeated_cancel_attempts:       { medium:4,  high:8  },
  settlement_overpayment_attempt: { medium:1,  high:3  },
  manual_override_used:           { medium:1,  high:3  }
};

const ALERT_COALESCE_MS = 24*60*60*1000; // 24h
const _alertMemStore   = new Map(); // key = clubId|actorId|type

function _alertKey(clubId, actorId, type) { return (clubId||'')+'|'+(actorId||'')+'|'+type; }

function _calcAlertSeverity(type, count) {
  const thr = ALERT_SEVERITY[type];
  if (!thr) return 'low';
  if (count >= thr.high)   return 'high';
  if (count >= thr.medium) return 'medium';
  return 'low';
}

// Fire-and-forget risk alert emission with 24h coalescing
function emitRiskAlert(type, clubId, actorId, metadata) {
  if (!ALERT_TYPES.has(type)) return;
  const nowMs = Date.now();
  const now   = new Date(nowMs).toISOString();
  const key   = _alertKey(clubId, actorId, type);
  const existing = _alertMemStore.get(key);

  let alert;
  if (existing && existing.status==='open' &&
      (nowMs-new Date(existing.first_seen_at).getTime()) < ALERT_COALESCE_MS) {
    existing.count++;
    existing.severity    = _calcAlertSeverity(type, existing.count);
    existing.last_seen_at= now; existing.updated_at=now;
    if (metadata) existing.metadata_json=Object.assign({},existing.metadata_json,metadata);
    alert = existing;
  } else {
    alert = {
      alert_id:     'ALERT_'+type+'_'+(actorId||'anon')+'_'+nowMs,
      club_id:      clubId||null, actor_id:actorId||null, player_id:actorId||null,
      type, severity:_calcAlertSeverity(type,1), status:'open', count:1,
      first_seen_at:now, last_seen_at:now, metadata_json:metadata||{},
      created_at:now, updated_at:now
    };
  }
  _alertMemStore.set(key, alert);

  // Persist fire-and-forget
  try {
    const sb=getSupabase();
    if (sb) sb.from('risk_alerts').upsert(alert,{ onConflict:'alert_id' })
      .then(()=>{}).catch(()=>{});
  } catch(_e){}

  if (alert.severity!=='low') {
    logEvent('warn','risk_alert',{ type, clubId, actorId, count:alert.count, severity:alert.severity });
  }
}

// Admin endpoints
app.get('/api/admin/risk-alerts', (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const clubId   = req._clubId || req.query.clubId;
  const statusF  = req.query.status;
  const limit    = Math.min(parseInt(req.query.limit)||50,200);
  let alerts = [..._alertMemStore.values()]
    .filter(function(a){
      if (actor.platformRole!=='platform_admin' && clubId && a.club_id!==clubId) return false;
      if (statusF && a.status!==statusF) return false;
      return true;
    })
    .sort(function(a,b){ return a.last_seen_at<b.last_seen_at?1:-1; })
    .slice(0,limit);
  const counts = { open:0,acknowledged:0,dismissed:0,high:0,medium:0,low:0 };
  _alertMemStore.forEach(function(a){
    if (!clubId||a.club_id===clubId||actor.platformRole==='platform_admin') {
      counts[a.status]=(counts[a.status]||0)+1;
      if (a.status==='open') counts[a.severity]=(counts[a.severity]||0)+1;
    }
  });
  res.json({ ok:true, alerts, counts });
});

app.post('/api/admin/risk-alerts/ack', (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin)
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { alertId } = req.body||{};
  if (!alertId) return res.status(400).json({ ok:false, error:'missing_alertId' });
  for (const [key,a] of _alertMemStore) {
    if (a.alert_id===alertId) {
      if (a.status!=='open') return res.status(409).json({ ok:false, error:'alert_not_open' });
      a.status='acknowledged'; a.updated_at=new Date().toISOString();
      return res.json({ ok:true, alertId });
    }
  }
  res.status(404).json({ ok:false, error:'alert_not_found' });
});

app.post('/api/admin/risk-alerts/dismiss', (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin)
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { alertId } = req.body||{};
  if (!alertId) return res.status(400).json({ ok:false, error:'missing_alertId' });
  for (const [key,a] of _alertMemStore) {
    if (a.alert_id===alertId) {
      a.status='dismissed'; a.updated_at=new Date().toISOString();
      return res.json({ ok:true, alertId });
    }
  }
  res.status(404).json({ ok:false, error:'alert_not_found' });
});
// ───────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// PHASE R: OBSERVABILITY + HEALTH DASHBOARD
// ════════════════════════════════════════════════════════════════════════════

const _SENSITIVE_LOG_KEYS = new Set(['authorization','x-actor-role','token','password',
                                      'secret','jwt','bearer','SERVICE_ROLE_KEY']);
const _SERVER_START = Date.now();
let   _rpcFailCount = 0;

function _sanitizeLog(data) {
  if (!data||typeof data!=='object') return data;
  const out = {};
  Object.keys(data).forEach(function(k) {
    if (_SENSITIVE_LOG_KEYS.has(k.toLowerCase())) out[k]='[REDACTED]';
    else if (data[k]&&typeof data[k]==='object') out[k]=_sanitizeLog(data[k]);
    else out[k]=data[k];
  });
  return out;
}

function logEvent(level, event, data, requestId) {
  const LEVELS = new Set(['info','warn','error']);
  if (!LEVELS.has(level)) level='info';
  const entry = { ts:new Date().toISOString(), level, event,
    requestId:requestId||null, data:_sanitizeLog(data||{}) };
  if (level==='error') console.error('['+level.toUpperCase()+']', event, JSON.stringify(entry.data));
  else if (level==='warn') console.warn('[WARN]', event, JSON.stringify(entry.data));
  else if (process.env.LOG_VERBOSE) console.log('[INFO]', event, JSON.stringify(entry.data));
  return entry;
}

// Request ID middleware
const _SAFE_REQ_ID_RE = /^[a-zA-Z0-9_\-]{6,64}$/;
function requestIdMiddleware(req, res, next) {
  const incoming = (req.headers['x-request-id']||'').trim();
  req.requestId = _SAFE_REQ_ID_RE.test(incoming)
    ? incoming
    : 'req_'+Date.now().toString(36)+'_'+_crypto.randomBytes(4).toString('hex');
  res.setHeader('x-request-id', req.requestId);
  next();
}
// ───────────────────────────────────────────────────────────────────────────

// ── Supabase mirror client (Phase A — passive write only) ─────────────────────
// Loaded lazily so missing env never crashes startup.
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    _supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    console.log('[supabase] client initialised — mirror writes enabled');
  } catch(e) {
    console.warn('[supabase] client init failed:', e.message);
  }
  return _supabase;
}

// Fire-and-forget mirror: never throws, never blocks.
async function mirrorTicketToSupabase(ticket) {
  const sb = getSupabase();
  if (!sb) return; // env not configured — silent skip
  const ticketId = ticket.id || ('T_' + Date.now());
  try {
    // 1. Insert ticket row
    const sels = Array.isArray(ticket.selections) ? ticket.selections : [];
    const ticketRow = {
      id:                ticketId,
      club_id:           ticket.clubId   || ticket.club_id   || null,
      player_id:         ticket.playerId || ticket.player_id || null,
      player_username:   ticket.playerUsername || null,
      type:              ticket.type || 'Single',
      status:            ticket.status || 'active',
      risk_amount:       parseFloat(ticket.riskAmount)      || 0,
      potential_profit:  parseFloat(ticket.potentialProfit) || 0,
      estimated_payout:  parseFloat(ticket.estimatedPayout) || 0,
      odds:              ticket.odds ? String(ticket.odds) : null,
      placed_at:         ticket.placedAt || new Date().toISOString(),
      raw_local:         ticket, // full object stored for Phase A audit
      mirrored_at:       new Date().toISOString()
    };
    const { error: tErr } = await sb.from('tickets').upsert(ticketRow, { onConflict: 'id' });
    if (tErr) throw new Error('ticket: ' + tErr.message);

    // 2. Insert ticket_legs rows
    if (sels.length) {
      const legRows = sels.map(function(sel, i) {
        return {
          id:                 sel.legId || (ticketId + '_leg' + i),
          ticket_id:          ticketId,
          leg_index:          i,
          provider_name:      sel.providerName      || 'odds-api',
          provider_game_id:   sel.providerGameId    || sel.gameId   || null,
          canonical_game_key: sel.canonicalGameKey  || sel.gameKey  || '',
          sport:              sel.sport || null,
          home_team:          sel.homeTeam   || null,
          away_team:          sel.awayTeam   || null,
          scheduled_start:    sel.scheduledStart || sel.commenceTime || null,
          market:             sel.market || '',
          pick:               sel.pick   || '',
          odds:               typeof sel.odds === 'number' ? sel.odds : null,
          line:               sel.line != null ? parseFloat(sel.line) : null,
          side:               sel.side  || null,
          game_status:        sel.gameStatus || null,
          leg_result:         sel.result || null
        };
      });
      const { error: lErr } = await sb.from('ticket_legs').upsert(legRows, { onConflict: 'id' });
      if (lErr) throw new Error('legs: ' + lErr.message);
    }

    // 3. Audit event
    await sb.from('audit_events').insert({
      event_type: 'ticket_mirrored',
      ticket_id:  ticketId,
      player_id:  ticketRow.player_id,
      club_id:    ticketRow.club_id,
      payload:    { legs: sels.length, type: ticket.type, risk: ticketRow.risk_amount }
    });

    console.log('[supabase mirror] ticketId:', ticketId, 'success: true legs:', sels.length);
  } catch(e) {
    console.warn('[supabase mirror] ticketId:', ticketId, 'success: false error:', e.message);
  }
}

// Mirror a single ledger entry — append-only, idempotency via id (upsert onConflict=id does nothing on duplicate)
async function mirrorLedgerEntry(entry) {
  const sb = getSupabase();
  if (!sb || !entry || !entry.id) return;
  try {
    const row = {
      id:             entry.id,
      club_id:        entry.clubId  || entry.club_id  || null,
      player_id:      entry.playerId || entry.player_id || null,
      ticket_id:      entry.ticketId || entry.ticket_id || null,
      type:           entry.type,
      amount:         parseFloat(entry.amount) || 0,
      balance_before: entry.balanceBefore != null ? parseFloat(entry.balanceBefore) : null,
      balance_after:  entry.balanceAfter  != null ? parseFloat(entry.balanceAfter)  : null,
      reason:         entry.reason || entry.type,
      final_score:    entry.finalScore || entry.final_score || null,
      created_at:     entry.createdAt || new Date().toISOString(),
      created_by:     entry.createdBy || 'system'
    };
    // upsert by id — if id already exists, updates in place (safe: content is immutable)
    // Previously used ignoreDuplicates:true which silently dropped rows when IDs collided
    const { data: upserted, error } = await sb.from('ledger_entries').upsert(row, { onConflict: 'id' }).select('id');
    if (error) throw new Error(error.message);
    console.log('[supabase mirror] ledger id:', entry.id, 'type:', entry.type, 'upserted:', upserted && upserted.length, 'success: true');
  } catch(e) {
    console.warn('[supabase mirror] ledger id:', entry.id, 'success: false error:', e.message);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/events — polling endpoint
app.get('/api/events', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const clubId  = req._clubId || (req.query.clubId);
  const since   = (req.query.since||'').trim();
  const limit   = Math.min(parseInt(req.query.limit)||50, 200);
  const nowTs   = new Date().toISOString();
  const rank    = ROLE_RANK[actor.role]||0;

  // Collect from mem buffer
  const cid = clubId||'__global';
  let events = (_evMem[cid]||[]).concat(
    actor.platformRole==='platform_admin'
      ? Object.values(_evMem).flat().filter(function(e){ return e.club_id!==cid; })
      : []
  );

  // Also try Supabase for events not in mem buffer
  try {
    const sb = getSupabase();
    if (sb && since) {
      let q = sb.from('event_feed').select('*').order('created_at').limit(limit);
      if (clubId && actor.platformRole!=='platform_admin') q=q.eq('club_id',clubId);
      if (since.startsWith('EV_')) q=q.gt('event_id',since);
      else q=q.gt('created_at',since);
      const { data } = await q;
      if (data&&data.length) {
        const existIds = new Set(events.map(function(e){ return e.event_id; }));
        (data||[]).forEach(function(e){ if(!existIds.has(e.event_id)) events.push(e); });
      }
    }
  } catch(_e){}

  // Filter by cursor
  if (since) {
    events = events.filter(function(e){
      return since.startsWith('EV_') ? e.event_id>since : e.created_at>since;
    });
  }

  // Access control
  events = events.filter(function(ev) {
    if (actor.platformRole==='platform_admin') return true;
    if (ev.club_id && ev.club_id!==clubId) return false;
    if (rank >= ROLE_RANK.risk_viewer) return true;
    if (CLUB_WIDE_EV.has(ev.type)) return true;
    return ev.player_id && ev.player_id===actor.actorId;
  });

  // Sort + limit
  events.sort(function(a,b){ return a.created_at<b.created_at?-1:1; });
  events = events.slice(-limit);
  const latestCursor = events.length ? events[events.length-1].event_id : (since||null);
  res.json({ ok:true, events, latestCursor, serverTime:nowTs, count:events.length });
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'pocketbooks-sports-secret-2026';

// Phase Q+R: request ID → CORS → security headers → payload → rate limit
app.use(requestIdMiddleware);
app.use(_hardenedCors);
app.use(express.json({ limit:'100kb' }));
app.use(securityHeadersMiddleware);
app.use(payloadSizeMiddleware);
app.use(rateLimitMiddleware);

// ===== HEALTH + DIAGNOSTICS (Phase R) =====

// GET /api/health — public, safe
app.get('/api/health', async (req, res) => {
  const uptime = Math.round((Date.now()-_SERVER_START)/1000);
  let dbStatus='unknown', dbOk=false;
  try { const sb=getSupabase(); if(sb){await sb.from('tickets').select('id').limit(1);dbStatus='connected';dbOk=true;}
        else dbStatus='not_configured'; } catch(_e){ dbStatus='error'; }
  const cache = typeof LIVE_MARKET_CACHE!=='undefined'?LIVE_MARKET_CACHE:null;
  const oddsStatus = cache&&cache.sourceStatus||'unknown';
  const lastOdds   = cache&&cache.lastSuccessAt||null;
  const _BAKED_SHA = 'bd2c05b'; // settlement-audit-fixes-complete
  const _BUILD_MARKER = 'settlement-audit-fixes-complete'; // Bugs #1/#2/#4/#5/#6/#11 fixed
  res.json({ ok:dbOk, uptime, version:process.env.APP_VERSION||'unknown',
    commit:process.env.COMMIT_SHA||_BAKED_SHA, bakedSHA:_BAKED_SHA,
    buildMarker:_BUILD_MARKER, dbStatus, oddsStatus,
    resultStatus:'unknown', queueStatus:'not_implemented',
    lastOddsSuccessAt:lastOdds, lastResultSuccessAt:null,
    requestId:req.requestId });
});

// GET /api/admin/env-check — full_admin+; reports missing/warning env vars without exposing values
app.get('/api/admin/env-check', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const REQUIRED = [
    'SESSION_SECRET','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY',
    'ALLOWED_ORIGINS','ODDS_API_KEY'
  ];
  const RECOMMENDED = [
    { key:'PLATFORM_ADMIN_ALLOWLIST', reason:'platform_admin escape hatch' },
    { key:'WALLET_ERC20',             reason:'crypto deposit wallet (ERC20)' },
    { key:'WALLET_BTC',               reason:'crypto deposit wallet (BTC)' },
    { key:'ENABLE_WORKER',            reason:'background job worker' },
  ];
  const OPTIONAL = [
    'BLOCKCHAIN_SCANNER_ENABLED','AUTO_CREDIT_CONFIRMED_CRYPTO',
    'APP_VERSION','COMMIT_SHA','LOG_VERBOSE'
  ];
  const missing  = REQUIRED.filter(function(k){ return !process.env[k]; }).map(function(k){ return { key:k, level:'required' }; });
  const warnings = RECOMMENDED.filter(function(v){ return !process.env[v.key]; }).map(function(v){ return { key:v.key, reason:v.reason }; });
  const present  = REQUIRED.filter(function(k){ return !!process.env[k]; })
    .concat(RECOMMENDED.filter(function(v){ return !!process.env[v.key]; }).map(function(v){ return v.key; }))
    .concat(OPTIONAL.filter(function(k){ return !!process.env[k]; }));
  // Never expose values
  res.json({ ok:missing.length===0, missing, warnings,
    presentCount:present.length,
    report: missing.map(function(m){ return 'MISSING(required): '+m.key; })
           .concat(warnings.map(function(w){ return 'WARNING(recommended): '+w.key+' — '+w.reason; })),
    checkedAt:new Date().toISOString() });
});

// ── ADMIN JOB ENDPOINTS ───────────────────────────────────────────────────────────────────────
app.get('/api/admin/jobs', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const limit  = Math.min(parseInt(req.query.limit)||50, 200);
  const status = req.query.status;
  const jobs   = [..._jobMemStore.values()]
    .filter(function(j){ return !status||j.status===status; })
    .sort(function(a,b){ return a.updated_at<b.updated_at?1:-1; })
    .slice(0, limit);
  const counts = { queued:0,running:0,succeeded:0,failed:0,dead:0 };
  _jobMemStore.forEach(function(j){ counts[j.status]=(counts[j.status]||0)+1; });
  res.json({ ok:true, jobs, counts, workerId:WORKER_ID });
});

app.post('/api/admin/jobs/enqueue', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { type, payload, clubId, maxAttempts, runAfter, idempotencyKey } = req.body||{};
  if (!type) return res.status(400).json({ ok:false, error:'missing_type' });
  const r = await enqueueJob(type, payload||{}, { clubId, maxAttempts, runAfter, idempotencyKey });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

app.post('/api/admin/jobs/retry', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { jobId } = req.body||{};
  if (!jobId) return res.status(400).json({ ok:false, error:'missing_jobId' });
  const j = _jobMemStore.get(jobId);
  if (!j) return res.status(404).json({ ok:false, error:'job_not_found' });
  if (j.status!=='dead') return res.status(409).json({ ok:false, error:'job_not_dead' });
  j.status='queued'; j.attempts=0; j.run_after=new Date().toISOString();
  j.last_error=null; j.updated_at=new Date().toISOString();
  try { const sb=getSupabase(); if(sb) await sb.from('jobs')
    .update({status:'queued',attempts:0,run_after:j.run_after,last_error:null,updated_at:j.updated_at})
    .eq('job_id',jobId); } catch(_e){}
  res.json({ ok:true, jobId });
});

app.post('/api/admin/jobs/cancel', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { jobId } = req.body||{};
  const j = _jobMemStore.get(jobId);
  if (!j) return res.status(404).json({ ok:false, error:'job_not_found' });
  if (j.status==='running') return res.status(409).json({ ok:false, error:'cannot_cancel_running' });
  j.status='dead'; j.last_error='cancelled'; j.updated_at=new Date().toISOString();
  res.json({ ok:true, jobId });
});
// ───────────────────────────────────────────────────────────────────────────

// GET /api/admin/diagnostics — full_admin+ or platform_admin
app.get('/api/admin/diagnostics', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const rank = ROLE_RANK[actor.role]||0;
  if (rank < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role', required:'full_admin' });
  const sb = getSupabase();
  const result = { ok:true, generatedAt:new Date().toISOString(), requestId:req.requestId };
  // Rate limit stats snapshot
  result.rateLimitStats = { totalKeys:_rlWindows.size };
  // Market status
  try {
    const cache = typeof LIVE_MARKET_CACHE!=='undefined'?LIVE_MARKET_CACHE:{};
    result.marketStatus = { sourceStatus:cache.sourceStatus, gameCount:cache.gameCount,
      marketCount:cache.marketCount, cacheAgeMs:cache.updatedAt?Date.now()-new Date(cache.updatedAt).getTime():null };
  } catch(_e){ result.marketStatus={}; }
  // Result snapshot count
  result.resultStatus = {};
  if (sb) { try {
    const { count } = await sb.from('result_snapshots').select('*',{count:'exact',head:true});
    result.resultStatus = { snapshotCount:count||0 };
  } catch(_e){} }
  // Audit event counts (last 24h)
  result.auditEventCounts = {};
  if (sb) { try {
    const since = new Date(Date.now()-86400000).toISOString();
    const { data:evts } = await sb.from('audit_events').select('event_type')
      .gte('created_at',since);
    (evts||[]).forEach(function(e){
      result.auditEventCounts[e.event_type]=(result.auditEventCounts[e.event_type]||0)+1;
    });
  } catch(_e){} }
  // Session counts
  result.sessionCounts = { active:0, revoked:0 };
  _sessionMemStore.forEach(function(s){
    if (!s) return;
    if (s.status==='active') result.sessionCounts.active++;
    else if (s.status==='revoked') result.sessionCounts.revoked++;
  });
  // Settlement stats
  result.settlementStats = { openPeriods:0, closedPeriods:0 };
  if (sb) { try {
    const { data:periods } = await sb.from('settlement_periods').select('status');
    (periods||[]).forEach(function(p){
      if (p.status==='open') result.settlementStats.openPeriods++;
      else result.settlementStats.closedPeriods++;
    });
  } catch(_e){} }
  result.rpcFailCount = _rpcFailCount;
  // Job counts
  const jCounts = { queued:0,running:0,succeeded:0,failed:0,dead:0 };
  _jobMemStore.forEach(function(j){ jCounts[j.status]=(jCounts[j.status]||0)+1; });
  result.jobCounts = jCounts;
  res.json(result);
});

// GET /health — legacy shorthand
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ===== ENV CHECK (safe — returns boolean flags only, no secret values) =====
app.get('/api/env-check', (req, res) => {
  res.json({
    serviceName:          'pocketbooks-sports-backend',
    railwayServiceUrl:    'pocketbooks-sports-backend-production.up.railway.app',
    hasSupabaseUrl:       !!process.env.SUPABASE_URL,
    hasSupabaseServiceKey:!!process.env.SUPABASE_SERVICE_ROLE_KEY,
    hasDatabaseUrl:       !!process.env.DATABASE_URL,
    hasOddsApiKey:        !!process.env.ODDS_API_KEY,
    nodeEnv:              process.env.NODE_ENV || 'development',
    timestamp:            new Date().toISOString()
  });
});

// ===== DB (lazy init - won't crash startup) =====
let pool = null;
function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', err => console.error('DB pool error:', err.message));
  }
  return pool;
}

async function query(sql, params) {
  return getPool().query(sql, params);
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      diamonds INTEGER NOT NULL DEFAULT 500,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS clubs (
      id SERIAL PRIMARY KEY,
      host_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      code VARCHAR(20) UNIQUE NOT NULL,
      description VARCHAR(500),
      max_bet DECIMAL(10,2) DEFAULT 500,
      max_parlay DECIMAL(10,2) DEFAULT 1000,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS club_memberships (
      id SERIAL PRIMARY KEY,
      club_id INTEGER REFERENCES clubs(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      host_id INTEGER REFERENCES users(id),
      balance DECIMAL(10,2) DEFAULT 0,
      credit_limit DECIMAL(10,2) DEFAULT 500,
      max_bet DECIMAL(10,2) DEFAULT 100,
      total_bets INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      role VARCHAR(20) DEFAULT 'player',
      status VARCHAR(20) DEFAULT 'pending',
      joined_at TIMESTAMP DEFAULT NOW(),
      approved_at TIMESTAMP,
      UNIQUE(club_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS player_limits (
      id SERIAL PRIMARY KEY,
      club_id INTEGER REFERENCES clubs(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      max_bet DECIMAL(10,2) DEFAULT 100,
      max_daily_risk DECIMAL(10,2) DEFAULT 500,
      max_payout DECIMAL(10,2) DEFAULT 2000,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(club_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS bets (
      id SERIAL PRIMARY KEY,
      host_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
      player_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      game VARCHAR(500) NOT NULL,
      bet_type VARCHAR(50) NOT NULL,
      sport VARCHAR(50) DEFAULT 'MLB',
      risk DECIMAL(10,2) NOT NULL,
      win DECIMAL(10,2) NOT NULL,
      line VARCHAR(100),
      result VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      settled_at TIMESTAMP
    );
  `);
  // Safe column migrations — ADD IF NOT EXISTS so live DB catches up with schema
  const migrations = [
    `ALTER TABLE club_memberships ADD COLUMN IF NOT EXISTS balance DECIMAL(10,2) DEFAULT 0`,
    `ALTER TABLE club_memberships ADD COLUMN IF NOT EXISTS credit_limit DECIMAL(10,2) DEFAULT 500`,
    `ALTER TABLE club_memberships ADD COLUMN IF NOT EXISTS max_bet DECIMAL(10,2) DEFAULT 100`,
    `ALTER TABLE club_memberships ADD COLUMN IF NOT EXISTS total_bets INTEGER DEFAULT 0`,
    `ALTER TABLE club_memberships ADD COLUMN IF NOT EXISTS wins INTEGER DEFAULT 0`,
    `ALTER TABLE club_memberships ADD COLUMN IF NOT EXISTS losses INTEGER DEFAULT 0`,
    `ALTER TABLE club_memberships ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'player'`,
    `ALTER TABLE club_memberships ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`,
    `ALTER TABLE club_memberships ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`,
    `ALTER TABLE clubs ADD COLUMN IF NOT EXISTS max_parlay DECIMAL(10,2) DEFAULT 1000`,
    `ALTER TABLE clubs ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''`,
  ];
  for (const sql of migrations) {
    try { await query(sql); } catch(e) { console.error('[migration] failed:', sql.slice(0,60), e.message); }
  }
  console.log('[db] migrations complete');
}

// CANONICAL MARKET IDENTITY MIGRATION (priority #13)
//
// Adds structured columns to odds_snapshots so the priority-#11 canonical
// lookup + priority-#12 Owls snapshot upsert can persist + retrieve player
// props (and any future structured market type) without overloading the
// legacy `selection_key` string.
//
// SQL also lives in migrations/2026-05-22_canonical_market_identity.sql
// and is duplicated here so the backend self-migrates on Railway boot —
// same pattern as initDB above. Statements are idempotent (ADD COLUMN IF
// NOT EXISTS, CREATE INDEX IF NOT EXISTS) so running it on every boot is
// safe.
//
// After the ALTER, we introspect information_schema.columns to confirm
// the required columns are present and emit:
//   ODDS_SNAPSHOTS_SCHEMA_READY columns=N
//   ODDS_SNAPSHOTS_SCHEMA_MISSING missing=col1,col2,...
//
// Fail-soft: no DATABASE_URL -> log + return; the snapshot upsert's catch
// block already handles the legacy column set.
const CANONICAL_MARKET_IDENTITY_COLUMNS = [
  'canonical_market_key',
  'canonical_selection_key',
  'market_type',
  'provider_game_id',
  'player_name',
  'player_name_normalized',
  'prop_type',
  'prop_type_normalized',
  'prop_side',
  'player_team',
];

async function _migrateOddsSnapshotsSchema() {
  if (!process.env.DATABASE_URL) {
    console.log('ODDS_SNAPSHOTS_SCHEMA_MISSING missing=all reason=no_database_url');
    return { ok:false, reason:'no_database_url' };
  }
  // ----- DDL: idempotent ALTER + CREATE INDEX -----
  const ddl = [
    `ALTER TABLE odds_snapshots
       ADD COLUMN IF NOT EXISTS canonical_market_key     TEXT,
       ADD COLUMN IF NOT EXISTS canonical_selection_key  TEXT,
       ADD COLUMN IF NOT EXISTS market_type              TEXT,
       ADD COLUMN IF NOT EXISTS provider_game_id         TEXT,
       ADD COLUMN IF NOT EXISTS player_name              TEXT,
       ADD COLUMN IF NOT EXISTS player_name_normalized   TEXT,
       ADD COLUMN IF NOT EXISTS prop_type                TEXT,
       ADD COLUMN IF NOT EXISTS prop_type_normalized     TEXT,
       ADD COLUMN IF NOT EXISTS prop_side                TEXT,
       ADD COLUMN IF NOT EXISTS player_team              TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_odds_snapshots_canonical
       ON odds_snapshots (canonical_market_key, canonical_selection_key)`,
  ];
  for (const sql of ddl) {
    try {
      await query(sql);
    } catch (e) {
      // 42P01 = table doesn't exist. Some early dev envs don't have
      // odds_snapshots yet — log and bail out gracefully.
      const msg = (e && e.message) || '';
      if (/relation .*odds_snapshots.* does not exist/i.test(msg) || /42P01/.test(String(e.code||''))) {
        console.log('ODDS_SNAPSHOTS_SCHEMA_MISSING missing=all reason=table_not_found');
        return { ok:false, reason:'table_not_found' };
      }
      console.error('[odds_snapshots migration] failed:', msg);
      return { ok:false, reason:'ddl_error', error:msg };
    }
  }
  // ----- Verify: information_schema.columns -----
  const present = new Set();
  try {
    const r = await query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'odds_snapshots'`
    );
    for (const row of (r.rows || [])) present.add(row.column_name);
  } catch (e) {
    console.error('[odds_snapshots migration] schema introspection failed:', e.message);
    return { ok:false, reason:'introspect_error', error:e.message };
  }
  const missing = CANONICAL_MARKET_IDENTITY_COLUMNS.filter(function(c){ return !present.has(c); });
  if (missing.length > 0) {
    console.log('ODDS_SNAPSHOTS_SCHEMA_MISSING missing=' + missing.join(','));
    return { ok:false, reason:'columns_missing', missing };
  }
  console.log('ODDS_SNAPSHOTS_SCHEMA_READY columns=' + CANONICAL_MARKET_IDENTITY_COLUMNS.length);
  return { ok:true };
}

// ════════════════════════════════════════════════════════════════════════════
// PERMISSION ENGINE
// Roles: owner(5) > full_admin(4) > settlement_manager(3) > risk_viewer(2) > view_only(1)
// ════════════════════════════════════════════════════════════════════════════
const ROLE_LEVELS = { owner:5, full_admin:4, settlement_manager:3, risk_viewer:2, view_only:1 };
const ACTION_MIN_LEVEL = {
  settle_player:3, weekly_rollover:3, approve_cancel:4, deny_cancel:4,
  set_player_limits:4, add_player:4, remove_player:5, manage_staff:5,
  view_host_dashboard:1, view_active_bets:1, view_history:1,
  view_exposure:2, view_settlement_preview:2, view_player_limits:2,
  grade_trigger:4
};

function _canDo(role, action) {
  const rl = ROLE_LEVELS[role];
  const ml = ACTION_MIN_LEVEL[action];
  if (!rl) return { allowed:false, reason:'unknown_role:'+role };
  if (ml===undefined) return { allowed:false, reason:'unknown_action:'+action };
  const allowed = rl >= ml;
  return { allowed, role, action, roleLevel:rl, requiredLevel:ml,
    reason: allowed ? 'permitted' : 'insufficient_role:needs_level_'+ml+'_have_'+rl+'_role_'+role };
}

// requirePermission(action) middleware factory
// Reads X-Staff-Role header (or falls back to default 'owner' for existing JWT auth)
// requirePermission — Phase A stub; replaced by full version in auth block below.
// This placeholder lets existing route declarations compile; the real middleware
// is installed after the auth block initialises.
let requirePermission = function(action, getTargetPlayerId) {
  return function(req, res, next) {
    // Phase A compat: honour x-staff-role as well as x-actor-role
    req._permAction = action;
    next(); // will be replaced post-auth-block
  };
};

// Permission management endpoints
// GET /api/permissions/roles — list all roles and their capabilities
app.get('/api/permissions/roles', function(req, res) {
  res.json({
    ok: true,
    roles: Object.keys(ROLE_LEVELS).map(function(r) {
      var level = ROLE_LEVELS[r];
      return {
        role: r, level,
        canDo: Object.keys(ACTION_MIN_LEVEL).filter(function(a){ return level >= ACTION_MIN_LEVEL[a]; })
      };
    }).sort(function(a,b){ return b.level-a.level; })
  });
});

// POST /api/permissions/check — check a role/action combination
app.post('/api/permissions/check', function(req, res) {
  const { role, action } = req.body || {};
  if (!role || !action) return res.status(400).json({ ok:false, error:'missing role or action' });
  const r = _canDo(role, action);
  res.json({ ok:true, ...r });
});
// ════════════════════════════════════════════════════════════════════════════

// ===== AUTH MIDDLEWARE =====
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    if (user.role !== 'master_admin') return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}

// ===== AUTH =====
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hashed = await bcrypt.hash(password, 10);
    const assignedRole = (process.env.MASTER_ADMIN_EMAIL && email.toLowerCase() === process.env.MASTER_ADMIN_EMAIL.toLowerCase()) ? 'master_admin' : 'user';
    const r = await query(
      'INSERT INTO users (email,password,name,role,diamonds) VALUES ($1,$2,$3,$4,$5) RETURNING id,email,name,role,diamonds',
      [email.toLowerCase(), hashed, name, assignedRole, 500]
    );
    const user = r.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    const user = r.rows[0];
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    if (!await bcrypt.compare(password, user.password)) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name, role: user.role, diamonds: user.diamonds } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const r = await query('SELECT id,email,name,role,diamonds,created_at FROM users WHERE id=$1', [req.user.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== CLUBS =====
function genCode() { return Math.random().toString(36).substring(2,8).toUpperCase(); }

app.post('/api/clubs', auth, async (req, res) => {
  const { name, description, max_bet, max_parlay } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  let code = genCode();
  try {
    const r = await query('INSERT INTO clubs (host_id,name,code,description,max_bet,max_parlay) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, name, code, description||'', max_bet||500, max_parlay||1000]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clubs', auth, async (req, res) => {
  try {
    const r = await query(`SELECT c.*,COUNT(m.id) as member_count FROM clubs c LEFT JOIN club_memberships m ON c.id=m.club_id WHERE c.host_id=$1 GROUP BY c.id ORDER BY c.created_at DESC`, [req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clubs/search/:code', async (req, res) => {
  try {
    const r = await query('SELECT id,name,code,description FROM clubs WHERE code=$1 AND is_active=true', [req.params.code.toUpperCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Club not found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clubs/request', auth, async (req, res) => {
  const { code } = req.body;
  try {
    const club = await query('SELECT * FROM clubs WHERE code=$1 AND is_active=true', [code.toUpperCase()]);
    if (!club.rows.length) return res.status(404).json({ error: 'Club not found' });
    const c = club.rows[0];
    const exists = await query('SELECT id,status FROM club_memberships WHERE club_id=$1 AND player_id=$2', [c.id, req.user.id]);
    if (exists.rows.length) return res.status(400).json({ error: 'Already a member', status: exists.rows[0].status });
    await query('INSERT INTO club_memberships (club_id,player_id,host_id,status,role) VALUES ($1,$2,$3,$4,$5)', [c.id, req.user.id, c.host_id, 'pending', 'player']);
    res.json({ success: true, club: { id: c.id, name: c.name, code: c.code } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clubs/:id/members', auth, async (req, res) => {
  try {
    const r = await query(`SELECT m.*,u.name,u.email,CASE WHEN m.total_bets>0 THEN ROUND((m.wins::float/m.total_bets*100)::numeric,1) ELSE 0 END as win_rate FROM club_memberships m JOIN users u ON m.player_id=u.id WHERE m.club_id=$1 AND m.host_id=$2 ORDER BY m.joined_at DESC`, [req.params.id, req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clubs/:id/requests', auth, async (req, res) => {
  try {
    const r = await query(`SELECT m.*,u.name,u.email FROM club_memberships m JOIN users u ON m.player_id=u.id WHERE m.club_id=$1 AND m.host_id=$2 AND m.status='pending' ORDER BY m.joined_at DESC`, [req.params.id, req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/clubs/:id/requests/:memberId', auth, async (req, res) => {
  const { action } = req.body;
  const status = action === 'approve' ? 'approved' : 'rejected';
  try {
    const r = await query(`UPDATE club_memberships SET status=$1,approved_at=${action==='approve'?'NOW()':'NULL'} WHERE id=$2 AND host_id=$3 RETURNING *`, [status, req.params.memberId, req.user.id]);
    if (action === 'approve' && r.rows[0]) await query('INSERT INTO player_limits (club_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, r.rows[0].player_id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/my-clubs', auth, async (req, res) => {
  try {
    const r = await query(`SELECT c.*,m.balance,m.credit_limit,m.max_bet,m.total_bets,m.wins,m.losses,m.role,m.status,m.id as membership_id FROM club_memberships m JOIN clubs c ON m.club_id=c.id WHERE m.player_id=$1 ORDER BY m.joined_at DESC`, [req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== BETS =====
app.get('/api/bets', auth, async (req, res) => {
  try {
    const r = await query(`SELECT b.*,u.name as player_name FROM bets b LEFT JOIN users u ON b.player_id=u.id WHERE b.host_id=$1 ORDER BY b.created_at DESC LIMIT 50`, [req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bets', auth, async (req, res) => {
  const { player_id, game, bet_type, sport, risk, win, line, result, club_id } = req.body;
  if (!game || !risk) return res.status(400).json({ error: 'Missing fields' });
  try {
    const r = await query('INSERT INTO bets (host_id,club_id,player_id,game,bet_type,sport,risk,win,line,result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [req.user.id, club_id||null, player_id||null, game, bet_type||'Straight', sport||'MLB', risk, win||Math.round(risk*0.909), line||'', result||'pending']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== PLAYERS (legacy) =====
app.get('/api/players', auth, async (req, res) => {
  try {
    const r = await query(`SELECT m.*,u.name,u.email,CASE WHEN m.total_bets>0 THEN ROUND((m.wins::float/m.total_bets*100)::numeric,1) ELSE 0 END as win_rate FROM club_memberships m JOIN users u ON m.player_id=u.id WHERE m.host_id=$1 ORDER BY m.joined_at DESC`, [req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats/weekly', auth, async (req, res) => {
  try {
    const r = await query(`SELECT COUNT(*) as total_bets,COALESCE(SUM(risk),0) as handle,COALESCE(SUM(CASE WHEN result='loss' THEN risk ELSE 0 END),0)-COALESCE(SUM(CASE WHEN result='win' THEN win ELSE 0 END),0) as profit,COUNT(CASE WHEN result='pending' THEN 1 END) as pending FROM bets WHERE host_id=$1 AND created_at>=NOW()-INTERVAL '7 days'`, [req.user.id]);
    const s = r.rows[0];
    const handle = parseFloat(s.handle)||0;
    const profit = parseFloat(s.profit)||0;
    res.json({ ...s, hold_pct: handle>0?((profit/handle)*100).toFixed(1):0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== ODDS (public, no auth) =====
const ODDS_KEY = process.env.ODDS_API_KEY;
const https = require('https');

// ════════════════════════════════════════════════════════════════════════════
// OWLS INSIGHT ODDS PROVIDER (Phase 1)
// ════════════════════════════════════════════════════════════════════════════

const ODDS_PROVIDER      = process.env.ODDS_PROVIDER || 'the_odds_api';
const OWLS_KEY           = process.env.OWLS_INSIGHT_API_KEY || '';
const OWLS_BASE_URL      = (process.env.OWLS_INSIGHT_BASE_URL || 'https://api.owlsinsight.com').replace(/\/$/, '');
console.log('[odds-provider] env ODDS_PROVIDER='+process.env.ODDS_PROVIDER+
  ' resolved='+ODDS_PROVIDER+
  ' hasOwlsKey='+(!!OWLS_KEY)+
  ' hasOwlsBase='+(!!process.env.OWLS_INSIGHT_BASE_URL));
const OWLS_BOOKS         = process.env.OWLS_INSIGHT_BOOKS || 'pinnacle,fanduel,draftkings';
const OWLS_ALTERNATES    = process.env.OWLS_INSIGHT_ALTERNATES === 'true';

// Owls Insight v1 unified-odds supported sport keys. The unified
// /api/v1/{sport}/odds endpoint covers a broader catalog than we previously
// surfaced. Keys here map every alias we accept (Odds-API full keys + our
// short keys) to the canonical Owls path segment. If Owls doesn't actually
// have a feed for a key we list, the poller logs and skips it gracefully —
// the catalog stays exposed via /api/sports so the UI can still render the
// tab dimmed (per spec).
const OWLS_SPORT_MAP = {
  // ── US major leagues ──
  basketball_nba:'nba',                 nba:'nba',
  basketball_wnba:'wnba',               wnba:'wnba',
  americanfootball_nfl:'nfl',           nfl:'nfl',
  icehockey_nhl:'nhl',                  nhl:'nhl',
  baseball_mlb:'mlb',                   mlb:'mlb',
  // ── US college ──
  basketball_ncaab:'ncaab',             ncaab:'ncaab',
  americanfootball_ncaaf:'ncaaf',       ncaaf:'ncaaf',
  baseball_ncaa:'ncaabaseball',         ncaabaseball:'ncaabaseball',  college_baseball:'ncaabaseball',
  // ── Combat sports ──
  mma_mixed_martial_arts:'mma',         mma:'mma',
  boxing_boxing:'boxing',               boxing:'boxing',
  // ── Motorsports ──
  nascar:'nascar',                      nascar_cup:'nascar',
  formula1:'f1',                        f1:'f1',
  // ── Soccer (multi-competition; all roll up to 'soccer' for unified-odds path) ──
  soccer:'soccer',
  soccer_epl:'soccer_epl',              epl:'soccer_epl',           premier_league:'soccer_epl',
  soccer_uefa_champs_league:'soccer_ucl', ucl:'soccer_ucl',         champions_league:'soccer_ucl',
  soccer_usa_mls:'soccer_mls',          mls:'soccer_mls',
  soccer_fifa_world_cup:'soccer_worldcup', worldcup:'soccer_worldcup', world_cup:'soccer_worldcup',
  soccer_uefa_european_championship:'soccer_euros', euros:'soccer_euros',
  soccer_spain_la_liga:'soccer_laliga', laliga:'soccer_laliga',
  soccer_italy_serie_a:'soccer_seriea', serie_a:'soccer_seriea',
  soccer_germany_bundesliga:'soccer_bundesliga', bundesliga:'soccer_bundesliga',
  soccer_france_ligue_one:'soccer_ligue1', ligue1:'soccer_ligue1',
  // ── Other international team sports ──
  cricket:'cricket',
  cricket_ipl:'cricket_ipl',            ipl:'cricket_ipl',
  cricket_international_t20:'cricket_t20', t20:'cricket_t20',
  rugbyunion_six_nations:'rugby',       rugby_union:'rugby',     rugby:'rugby',
  rugbyleague:'rugby_league',           rugby_league:'rugby_league', nrl:'rugby_league',
  aussierules_afl:'afl',                afl:'afl',
  // ── Individual sports ──
  tennis:'tennis',                      atp:'tennis_atp',          wta:'tennis_wta',
  tennis_atp:'tennis_atp',              tennis_wta:'tennis_wta',
  golf_pga_championship:'golf_pga',     pga:'golf_pga',            pga_tour:'golf_pga',
  golf_masters_tournament:'golf_pga',
  golf_us_open:'golf_pga',              golf_the_open_championship:'golf_pga',
  golf:'golf_pga',
  golf_liv:'golf_liv',                  liv:'golf_liv',
  golf_european_tour:'golf_european',
  table_tennis:'table_tennis',          tabletennis:'table_tennis',
  // ── Esports ──
  cs2:'cs2',                            counterstrike:'cs2',     csgo:'cs2',
  valorant:'valorant',
  lol:'lol',                            leagueoflegends:'lol',
  dota2:'dota2',                        dota:'dota2',
  rocketleague:'rocketleague',          rl:'rocketleague'
};

// The exhaustive list of short keys this backend is willing to surface when
// OWLS_ENABLED_SPORTS=all. Derived from OWLS_SPORT_MAP values (deduped).
const OWLS_ALL_SPORTS = (function(){
  var seen = {}, out = [];
  Object.values(OWLS_SPORT_MAP).forEach(function(v){ if (v && !seen[v]) { seen[v]=true; out.push(v); } });
  return out;
})();

// ── Sport enablement ──
// OWLS_ENABLED_SPORTS controls which sports the backend polls + advertises
// in /api/sports. Spec:
//   - "all"                  → every sport in OWLS_ALL_SPORTS
//   - "mlb,nba,tennis,..."  → only those sports
//   - unset                  → legacy OWLS_SAFE_SPORTS (back-compat) or default
const OWLS_SAFE_SPORTS_DEFAULT = ['mlb','nba','nhl','nfl','ncaab','ncaaf'];
function _parseEnabledSportsEnv() {
  var raw = (process.env.OWLS_ENABLED_SPORTS||'').trim().toLowerCase();
  if (raw === 'all') return OWLS_ALL_SPORTS.slice();
  if (raw)           return raw.split(',').map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean);
  // Legacy fallback — keep existing deployments working
  if (process.env.OWLS_SAFE_SPORTS)
    return process.env.OWLS_SAFE_SPORTS.split(',').map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean);
  return OWLS_SAFE_SPORTS_DEFAULT.slice();
}
const OWLS_ENABLED_SPORTS = _parseEnabledSportsEnv();
// Legacy alias — still referenced in a few places downstream
const OWLS_SAFE_SPORTS = OWLS_ENABLED_SPORTS;
// Boot-time catalog log (live/upcoming counts unknown until the live cache
// has its first successful poll — use '?' placeholders so structured log
// parsers don't choke on the missing numerics).
console.log('OWLS_SPORT_CATALOG'
  +' total='+OWLS_ALL_SPORTS.length
  +' enabled='+OWLS_ENABLED_SPORTS.length
  +' live=? upcoming=?'
  +' provider=owls'
  +' enabledList='+JSON.stringify(OWLS_ENABLED_SPORTS));

function _mapToOwlsSport(key) { return OWLS_SPORT_MAP[key] || null; }

function _owlsMarketType(key) {
  var k = (key||'').toLowerCase();
  // Core full-game markets
  if (k==='h2h'||k==='moneyline') return 'moneyline';
  if (k==='spreads'||k==='spread') return 'spread';
  if (k==='totals'||k==='total')   return 'total';
  // Baseball run line is a spread variant
  if (k==='run_line'||k==='runline') return 'spread';
  // Alternate lines map to their base canonical type (downstream can use the `line` field)
  if (k==='alternate_spreads'||k==='alt_spreads'||k==='alternate_spread') return 'spread';
  if (k==='alternate_totals'||k==='alt_totals'||k==='alternate_total')    return 'total';
  // Team totals — distinct canonical so downstream can split per-team
  if (k==='team_totals'||k==='team_total') return 'team_total';
  // First-half markets — keep distinct so they don't pollute full-game lines
  if (k==='first_half_spreads'||k==='first_half_spread'||k==='spreads_h1'||k==='spread_h1') return 'first_half_spread';
  if (k==='first_half_totals' ||k==='first_half_total' ||k==='totals_h1' ||k==='total_h1')  return 'first_half_total';
  if (k==='first_half_moneyline'||k==='first_half_h2h'||k==='h2h_h1'||k==='moneyline_h1')   return 'first_half_moneyline';
  // Player props — if the key starts with player_/batter_/pitcher_/anytime
  // we treat it as a prop and let _owlsPropType() classify the subtype.
  if (_owlsPropType(k)) return 'player_prop';
  return null;
}

// Map a raw Owls market key to a normalized prop subtype label that's
// safe to surface in the UI ("Points", "Receiving Yards", etc.). Returns
// null when the key isn't recognized as a player prop.
//
// We accept a generous alias set because Owls/upstream books are
// inconsistent on the exact key string (player_pass_yds vs pass_yards vs
// passYards). If you see a missing key in production, add it here.
function _owlsPropType(key) {
  var k = String(key||'').toLowerCase().replace(/[\s-]+/g,'_');
  // ----- NBA / WNBA / NCAAB -----
  if (k==='player_points' || k==='points' || k==='player_pts')       return 'Points';
  if (k==='player_rebounds' || k==='rebounds' || k==='player_reb')   return 'Rebounds';
  if (k==='player_assists'  || k==='assists'  || k==='player_ast')   return 'Assists';
  if (k==='player_threes' || k==='threes' || k==='player_3pt'
      || k==='player_three_pointers_made')                           return '3-Pointers Made';
  if (k==='player_steals'  || k==='steals')                          return 'Steals';
  if (k==='player_blocks'  || k==='blocks')                          return 'Blocks';
  if (k==='player_turnovers' || k==='turnovers')                     return 'Turnovers';
  if (k==='player_pra' || k==='player_points_rebounds_assists')      return 'Pts + Reb + Ast';
  if (k==='player_pr'  || k==='player_points_rebounds')              return 'Pts + Reb';
  if (k==='player_pa'  || k==='player_points_assists')               return 'Pts + Ast';
  if (k==='player_ra'  || k==='player_rebounds_assists')             return 'Reb + Ast';
  // ----- NFL / NCAAF -----
  if (k==='player_pass_yds' || k==='player_passing_yards'
      || k==='pass_yards' || k==='passing_yards')                    return 'Passing Yards';
  if (k==='player_pass_tds' || k==='player_passing_tds')             return 'Passing TDs';
  if (k==='player_pass_completions')                                 return 'Pass Completions';
  if (k==='player_pass_attempts')                                    return 'Pass Attempts';
  if (k==='player_pass_interceptions')                               return 'Interceptions Thrown';
  if (k==='player_rush_yds' || k==='player_rushing_yards'
      || k==='rush_yards' || k==='rushing_yards')                    return 'Rushing Yards';
  if (k==='player_rush_attempts')                                    return 'Rushing Attempts';
  if (k==='player_rush_tds')                                         return 'Rushing TDs';
  if (k==='player_receptions' || k==='receptions')                   return 'Receptions';
  if (k==='player_reception_yds' || k==='player_receiving_yards'
      || k==='reception_yards' || k==='receiving_yards')             return 'Receiving Yards';
  if (k==='player_reception_tds')                                    return 'Receiving TDs';
  if (k==='player_anytime_td')                                       return 'Anytime TD';
  if (k==='player_first_td')                                         return 'First TD';
  if (k==='player_last_td')                                          return 'Last TD';
  if (k==='player_kicking_points')                                   return 'Kicking Points';
  if (k==='player_sacks')                                            return 'Sacks';
  if (k==='player_tackles_assists' || k==='player_tackles')          return 'Tackles + Asts';
  // ----- MLB -----
  if (k==='pitcher_strikeouts' || k==='player_strikeouts')           return 'Strikeouts';
  if (k==='pitcher_outs')                                            return 'Pitching Outs';
  if (k==='pitcher_earned_runs')                                     return 'Earned Runs';
  if (k==='pitcher_walks')                                           return 'Walks Allowed';
  if (k==='pitcher_hits_allowed')                                    return 'Hits Allowed';
  if (k==='batter_hits' || k==='player_hits')                        return 'Hits';
  if (k==='batter_total_bases')                                      return 'Total Bases';
  if (k==='batter_home_runs' || k==='player_home_runs')              return 'Home Runs';
  if (k==='batter_rbis' || k==='player_rbis')                        return 'RBIs';
  if (k==='batter_runs_scored' || k==='player_runs_scored')          return 'Runs Scored';
  if (k==='batter_walks' || k==='player_walks')                      return 'Walks';
  if (k==='batter_stolen_bases')                                     return 'Stolen Bases';
  // ----- NHL -----
  if (k==='player_goals'  || k==='goals')                            return 'Goals';
  if (k==='player_shots'  || k==='shots' || k==='shots_on_goal')     return 'Shots on Goal';
  if (k==='player_points_nhl')                                       return 'Points';
  if (k==='goalie_saves'  || k==='player_saves')                     return 'Goalie Saves';
  // ----- Soccer -----
  if (k==='player_shots_on_target')                                  return 'Shots on Target';
  if (k==='player_to_score')                                         return 'Anytime Goalscorer';
  // Catch-all heuristics: anything that starts with player_/batter_/pitcher_/goalie_
  // is treated as a prop even if the specific subtype is unknown. Better
  // to surface than to silently drop.
  if (/^(player|batter|pitcher|goalie)_/.test(k)) {
    // Humanize: "player_some_thing" -> "Some Thing"
    return k.replace(/^(player|batter|pitcher|goalie)_/, '')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, function(c){ return c.toUpperCase(); });
  }
  return null;
}

// Convert decimal odds to American (if needed)
function _toAmericanOdds(price) {
  if (typeof price !== 'number') return price;
  // American odds: integers typically > 100 or < -100
  // Decimal odds: typically 1.xx to 20.xx
  // If the absolute value is < 30 and it's not a whole number near +-100, treat as decimal
  if (Math.abs(price) <= 30 && price > 0) {
    // Likely decimal: convert
    if (price >= 2) return Math.round((price - 1) * 100);
    else            return Math.round(-100 / (price - 1));
  }
  return price; // already American
}

function _normalizeOwlsResponse(owlsData, sportKey) {
  if (!owlsData) return null;
  // Accept success:true OR no success field (some responses omit it)
  if (owlsData.success === false) return null;

  var rawData = owlsData.data;
  if (!rawData) return null;

  // Build flat event list — handle both shapes:
  //   Shape A: { pinnacle:[...], fanduel:[...] }  (per-book object, docs say this)
  //   Shape B: [...] flat array of events
  //   Shape C: { events:[...] }
  var allEvents = []; var seen = {};
  function _addEv(ev) { if (ev && ev.id && !seen[ev.id]) { seen[ev.id]=true; allEvents.push(ev); } }

  if (Array.isArray(rawData)) {
    rawData.forEach(_addEv);
  } else if (rawData.events && Array.isArray(rawData.events)) {
    rawData.events.forEach(_addEv);
  } else if (typeof rawData === 'object') {
    // Per-book or any object — iterate values
    Object.values(rawData).forEach(function(v){
      if (Array.isArray(v)) v.forEach(_addEv);
      else if (v && v.id) _addEv(v); // single event value
    });
  }

  // Also handle top-level events array
  if (!allEvents.length && Array.isArray(owlsData.events)) {
    owlsData.events.forEach(_addEv);
  }

  var games = []; var mkByCK = {}; var mkByPGI = {}; var warnings = [];
  // [owls][summary] diagnostics — temporary instrumentation for market-key coverage audit
  var acceptedKeyCounts = {}; var skippedKeyCounts = {}; var skippedSamples = [];
  var acceptedTotal = 0; var skippedTotal = 0;

  allEvents.forEach(function(ev){
    var evId   = ev.id || ev.event_id || ev.game_id;
    var sport  = ev.sport_key || ev.sport || sportKey || '?';
    var home   = ev.home_team  || ev.home  || ev.homeTeam  || '';
    var away   = ev.away_team  || ev.away  || ev.awayTeam  || '';
    var ct     = ev.commence_time || ev.start_time || ev.game_time || ev.startTime || '';
    var date   = ct ? ct.slice(0,10) : '';
    var ck     = sport+'|'+away+'|'+home+'|'+date;

    // ── Normalize Owls event status into our 3-state model: upcoming | live | final ──
    // Owls can express liveness as ev.status / ev.state / ev.in_play / ev.is_live / ev.completed
    var rawEvStatus = String(ev.status || ev.state || ev.event_status || '').toLowerCase();
    var evCompleted = ev.completed === true || ev.is_complete === true || ev.is_final === true ||
                      /^(final|complete|completed|ended|closed|settled)$/.test(rawEvStatus);
    var evCanceled  = ev.canceled === true || ev.cancelled === true ||
                      /^(canceled|cancelled|abandoned|postponed)$/.test(rawEvStatus);
    var evLive      = ev.in_play === true || ev.is_live === true || ev.live === true ||
                      /^(live|in_play|inprogress|in_progress|started|playing)$/.test(rawEvStatus);
    // Time-based fallback for liveness when provider didn't say
    if (!evCompleted && !evCanceled && !evLive && ct) {
      var ctMsNorm = new Date(ct).getTime();
      if (!isNaN(ctMsNorm) && Date.now() >= ctMsNorm) evLive = true;
    }
    var gameStatus = evCompleted ? 'final' : evCanceled ? 'canceled' : evLive ? 'live' : 'upcoming';

    // ── Capture scoreboard fields when the feed surfaces them. Owls' /odds
    //    payload sometimes embeds game state under ev.score / ev.live / ev.game_state /
    //    ev.period_info. We accept many shapes and fall through to undefined when absent.
    var scoreObj = ev.score || ev.scores || ev.live || ev.game_state || ev.gameState || {};
    var homeScore = ev.home_score!=null ? ev.home_score :
                    ev.homeScore!=null  ? ev.homeScore  :
                    scoreObj.home!=null ? scoreObj.home :
                    scoreObj.home_score!=null ? scoreObj.home_score : null;
    var awayScore = ev.away_score!=null ? ev.away_score :
                    ev.awayScore!=null  ? ev.awayScore  :
                    scoreObj.away!=null ? scoreObj.away :
                    scoreObj.away_score!=null ? scoreObj.away_score : null;
    var period    = ev.period || ev.quarter || scoreObj.period || scoreObj.quarter || null;
    var clock     = ev.clock  || ev.time_remaining || scoreObj.clock || scoreObj.time_remaining || null;
    var inning    = ev.inning || scoreObj.inning || null;
    var inningHalf= ev.inning_half || ev.inningHalf || scoreObj.inning_half || scoreObj.half || null;
    var outs      = ev.outs != null ? ev.outs : (scoreObj.outs!=null ? scoreObj.outs : null);
    var basesOcc  = ev.bases || ev.bases_occupied || scoreObj.bases || scoreObj.bases_occupied || null;
    var possession= ev.possession || scoreObj.possession || null;
    var down      = ev.down || scoreObj.down || null;
    var distance  = ev.distance || ev.yards_to_go || scoreObj.distance || null;

    var gEntry = { id:evId, sport_key:sport, commence_time:ct,
      home_team:home, away_team:away, canonicalKey:ck,
      status:gameStatus, completed:!!evCompleted, canceled:!!evCanceled,
      isLive:!!evLive,
      // Scoreboard (null when the feed doesn't supply it — frontend hides empty fields)
      homeScore: homeScore!=null ? Number(homeScore) : null,
      awayScore: awayScore!=null ? Number(awayScore) : null,
      period, clock, inning, inningHalf, outs, basesOccupied: basesOcc,
      possession, down, distance,
      markets:[] };

    // Bookmakers may be at ev.bookmakers, ev.books, or markets may be directly on ev
    var bookmakerList = ev.bookmakers || ev.books || [];

    // Handle markets directly on event (no bookmaker wrapper)
    if (!bookmakerList.length && (ev.markets||ev.odds)) {
      bookmakerList = [{ key:'owls', title:'Owls', last_update: ct, markets: ev.markets||ev.odds||[] }];
    }

    (bookmakerList).forEach(function(bm){
      var bmKey    = bm.key || bm.id || 'owls';
      var bmTitle  = bm.title || bm.name || bmKey;
      var bmUpdate = bm.last_update || bm.lastUpdate || bm.updated_at || '';

      // Markets may be at bm.markets, bm.odds, or bm itself may have h2h/spreads/totals keys
      var mktList = bm.markets || bm.odds || [];
      if (!mktList.length) {
        // Try extracting h2h/spreads/totals from bm directly
        ['h2h','moneyline','spreads','spread','totals','total'].forEach(function(k){
          if (bm[k]) mktList.push({ key:k, outcomes:bm[k] });
        });
      }

      (mktList).forEach(function(mkt){
        var mktKey = mkt.key || mkt.type || mkt.market_key || mkt.name || '';
        var mktKeyLc = (mktKey||'').toLowerCase() || '(empty)';
        var mt = _owlsMarketType(mktKey);
        if (!mt) {
          skippedTotal++;
          skippedKeyCounts[mktKeyLc] = (skippedKeyCounts[mktKeyLc]||0)+1;
          if (skippedSamples.length < 8 && skippedSamples.indexOf(mktKeyLc) === -1) skippedSamples.push(mktKeyLc);
          return;
        }
        acceptedTotal++;
        acceptedKeyCounts[mktKeyLc] = (acceptedKeyCounts[mktKeyLc]||0)+1;
        // Capture market-level status from Owls (suspended/closed/active/live)
        var rawMktStatus = String(mkt.status || mkt.state || '').toLowerCase();
        var mktSuspended = mkt.suspended === true || mkt.is_suspended === true ||
                           /^(suspended|paused|inactive)$/.test(rawMktStatus);
        var mktClosed    = mkt.closed === true || mkt.is_closed === true ||
                           /^(closed|settled|final)$/.test(rawMktStatus);
        if (mktSuspended || mktClosed) {
          warnings.push((mktClosed?'closed:':'suspended:')+evId+':'+mktKey);
          return;
        }

        var outcomes = mkt.outcomes || mkt.selections || [];
        if (!Array.isArray(outcomes)) {
          // Some APIs return {home:{price,point}, away:{price,point}}
          outcomes = Object.entries(outcomes).map(function(kv){
            return Object.assign({ name:kv[0] }, kv[1]);
          });
        }

        // ----- Prop-only metadata pulled from the market level -----
        // Player name may live at the market level ("player":"LeBron James"),
        // on individual outcomes, or embedded in the outcome name. We collect
        // anything we find at the market scope here so per-outcome code can
        // fall back to it.
        var propSubtype = (mt === 'player_prop') ? _owlsPropType(mktKey) : null;
        var mktPlayer = mkt.player || mkt.player_name || mkt.description ||
                        mkt.participant || mkt.athlete || null;
        var mktTeam   = mkt.team || mkt.team_name || null;

        outcomes.forEach(function(oc){
          var ocName  = oc.name  || oc.team   || oc.label || oc.selection || '';
          var ocPrice = oc.price || oc.odds   || oc.american || oc.line    || 0;
          var ocPoint = oc.point != null ? oc.point
                      : oc.handicap != null ? oc.handicap
                      : oc.spread   != null ? oc.spread   : undefined;

          var americanOdds = _toAmericanOdds(parseFloat(ocPrice)||0);

          var entry = { marketType:mt, sportsbook:bmKey, sportsbookName:bmTitle,
            teamOrSide:ocName, odds:americanOdds, lastUpdate:bmUpdate,
            providerGameId:evId, canonicalKey:ck,
            // Propagate event-level status so downstream gates can decide allow/block
            marketStatus: rawMktStatus || (evLive ? 'active' : 'active'),
            eventStatus:  gameStatus,
            eventCompleted: !!evCompleted,
            eventCanceled:  !!evCanceled,
            eventLive:      !!evLive };
          if (ocPoint != null) entry.line = ocPoint;
          if (mt==='total') entry.overUnder = ocName;

          // ----- Prop-only fields -----
          if (mt === 'player_prop') {
            entry.marketKey = String(mktKey||'').toLowerCase();
            entry.propType  = propSubtype || 'Other';
            // Player name: prefer market-scope, then outcome-scope, then
            // strip the trailing "Over/Under" so a name embedded in the
            // outcome label ("LeBron James Over") still works.
            var ocPlayer = oc.player || oc.player_name || oc.description ||
                           oc.participant || oc.athlete || null;
            var player   = mktPlayer || ocPlayer || ocName
                             .replace(/\s*(over|under)\s*$/i, '')
                             .trim();
            entry.playerName = player || null;
            entry.playerTeam = oc.team || mktTeam || null;
            // Side: "over" / "under" / fallback to outcome name lowercased.
            entry.overUnder = String(ocName||'').toLowerCase().indexOf('under') >= 0
              ? 'under' : 'over';
          }

          // ----- Canonical identity stamp (priority #11 cleanup) -----
          // Every cache outcome carries canonicalMarketKey + canonicalSelectionKey
          // so the snapshot upsert + verifier never have to re-derive identity.
          entry.canonicalMarketKey = _buildCanonicalMarketKey({
            canonicalGameKey: ck,
            marketType:       entry.marketType,
            propType:         entry.propType,
            team:             entry.teamOrSide,
          });
          entry.canonicalSelectionKey = _buildCanonicalSelectionKey({
            marketType: entry.marketType,
            team:       entry.teamOrSide,
            player:     entry.playerName,
            side:       entry.overUnder || entry.teamOrSide,
            line:       entry.line,
          });

          gEntry.markets.push(entry);
        });
      });
    });

    games.push(gEntry);
    if (!mkByCK[ck])    mkByCK[ck]=[];
    gEntry.markets.forEach(function(m){ mkByCK[ck].push(m); });
    if (!mkByPGI[evId]) mkByPGI[evId]=[];
    gEntry.markets.forEach(function(m){ mkByPGI[evId].push(m); });
  });

  var mktCount = Object.values(mkByCK).reduce(function(s,a){ return s+a.length; },0);
  console.log('[owls][norm] sport='+sportKey+' events='+allEvents.length+' games='+games.length+' markets='+mktCount+' warnings='+warnings.length);
  // Temporary diagnostics — audit which Owls market keys are mapped vs skipped
  var uniqueAccepted = Object.keys(acceptedKeyCounts).sort();
  var uniqueSkipped  = Object.keys(skippedKeyCounts).sort();
  console.log('[owls][summary] sport='+sportKey
    +' accepted='+acceptedTotal+' skipped='+skippedTotal
    +' uniqueAccepted='+JSON.stringify(uniqueAccepted)
    +' acceptedCounts='+JSON.stringify(acceptedKeyCounts)
    +' uniqueSkipped='+JSON.stringify(uniqueSkipped)
    +' skippedCounts='+JSON.stringify(skippedKeyCounts)
    +' skippedSamples='+JSON.stringify(skippedSamples));

  return { ok:true, games, marketsByCanonicalKey:mkByCK,
    marketsByProviderGameId:mkByPGI,
    sourceStatus:games.length?'live':'empty', warnings, meta:owlsData.meta||{} };
}

async function fetchOddsFromOwlsInsight(sportKey) {
  if (!OWLS_KEY) {
    console.warn('[owls] OWLS_INSIGHT_API_KEY not set');
    return { ok:false, error:'owls_insight_not_configured' };
  }
  var owlsSport = _mapToOwlsSport(sportKey);
  if (!owlsSport) return { ok:false, error:'unsupported_sport:'+sportKey };
  var url = OWLS_BASE_URL+'/api/v1/'+owlsSport+'/odds?books='+OWLS_BOOKS+'&alternates='+OWLS_ALTERNATES;
  return new Promise(function(resolve){
    var parsed; try { parsed = new URL(url); } catch(_){return resolve({ok:false,error:'invalid_url'});}
    var driver = parsed.protocol==='https:' ? https : require('http');
    var chunks = [];
    var req = driver.request({
      hostname:parsed.hostname, port:parsed.port||(parsed.protocol==='https:'?443:80),
      path:parsed.pathname+parsed.search, method:'GET',
      headers:{ 'Authorization':'Bearer '+OWLS_KEY, 'Accept':'application/json' }
    }, function(res){
      res.on('data',function(c){chunks.push(c);});
      res.on('end',function(){
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode===401||res.statusCode===403)
          return resolve({ok:false,error:'owls_insight_unauthorized',status:res.statusCode});
        if (res.statusCode===429)
          return resolve({ok:false,error:'provider_rate_limited',status:429});
        if (res.statusCode>=500)
          return resolve({ok:false,error:'owls_insight_server_error',status:res.statusCode});
        if (res.statusCode!==200)
          return resolve({ok:false,error:'owls_insight_http_error',status:res.statusCode});
        try {
          var data = JSON.parse(body);
          // ─ Safe debug: log first event shape (no API key logged) ─
          try {
            var _debugBooks = Object.keys(data.data||{});
            var _debugFirstBook = _debugBooks[0];
            var _debugEvArr = _debugFirstBook ? (data.data[_debugFirstBook]||[]) : [];
            var _debugEv  = _debugEvArr[0];
            if (_debugEv) {
              var _debugBm  = (_debugEv.bookmakers||[])[0];
              var _debugMkt = (_debugBm&&_debugBm.markets||[])[0];
              var _debugOc  = (_debugMkt&&_debugMkt.outcomes||[])[0];
              console.log('[owls][debug] sport='+sportKey+
                ' topKeys='+JSON.stringify(Object.keys(data.data||{})).slice(0,60)+
                ' books='+JSON.stringify(_debugBooks).slice(0,60)+
                ' evCount='+_debugEvArr.length+
                ' eventKeys='+JSON.stringify(Object.keys(_debugEv)).slice(0,80)+
                ' bmCount='+((_debugEv.bookmakers||[]).length)+
                ' bmKeys='+JSON.stringify(Object.keys(_debugBm||{})).slice(0,60)+
                ' mktCount='+((_debugBm&&_debugBm.markets||[]).length)+
                ' mkt0='+JSON.stringify({key:_debugMkt&&_debugMkt.key,
                  suspended:_debugMkt&&_debugMkt.suspended,
                  outcomeCount:_debugMkt&&(_debugMkt.outcomes||[]).length}).slice(0,80)+
                ' oc0='+JSON.stringify(Object.keys(_debugOc||{})).slice(0,60));
            } else {
              console.log('[owls][debug] sport='+sportKey+' NO EVENTS in response. topKeys='+JSON.stringify(Object.keys(data||{})));
            }
          } catch(_de) { console.warn('[owls][debug] log error:',_de.message); }
          resolve(_normalizeOwlsResponse(data, sportKey) || {ok:false,error:'normalize_failed'});
        } catch(_e) { resolve({ok:false,error:'json_parse_error',detail:_e.message}); }
      });
    });
    req.setTimeout(10000,function(){req.destroy();resolve({ok:false,error:'timeout'});});
    req.on('error',function(e){resolve({ok:false,error:e.message});});
    req.end();
  });
}
// ────────────────────────────────────────────────────────────────────────────

function fetchOdds(sport) {
  return new Promise((resolve) => {
    if (!ODDS_KEY) { console.error('[ODDS] ODDS_API_KEY is not set — set it in Railway environment variables'); return resolve(null); }
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=us&markets=spreads,totals,h2h&oddsFormat=american&bookmakers=draftkings`;
    const req = https.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          // Odds API returns an error object (not array) on quota/auth errors
          if (parsed && parsed.error_code) {
            console.error('[ODDS] API error:', parsed.error_code, parsed.message);
            resolve({ _error: parsed.error_code, _message: parsed.message });
          } else {
            resolve(parsed);
          }
        } catch(e) { console.error('Odds parse error:', e.message); resolve([]); }
      });
    });
    req.on('error', e => { console.error('Odds fetch error:', e.message); resolve([]); });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
  });
}


// ════════════════════════════════════════════════════════════════════════════
// AUTH + ROLE ENFORCEMENT
// ════════════════════════════════════════════════════════════════════════════

const IS_PRODUCTION     = process.env.NODE_ENV === 'production';
const DEV_AUTH_BYPASS   = process.env.DEV_AUTH_BYPASS === 'true';

const ROLE_RANK = {
  owner:              5,
  full_admin:         4,
  settlement_manager: 3,
  risk_viewer:        2,
  player:             1,
  view_only:          0
};

// -1 = player-self check; >=0 = minimum role rank
const ACTION_MIN_RANK = {
  place_bet:                  -1,
  cancel_bet:                 -1,
  view_player_dashboard:      -1,
  view_host_dashboard:         2,
  view_settlement_history:     2,
  settle_player:               3,
  weekly_rollover:             3,
  run_server_grade:            3,
  force_market_refresh:        4,
  view_audit_log:              2,
  // Legacy aliases from Phase A permissions system
  grade_trigger:               3,  // = run_server_grade
  settle:                      3,  // = settle_player
  rollover:                    3,  // = weekly_rollover
  view_risk:                   2,  // = view_host_dashboard
};

function _getRoleRank(role) { return ROLE_RANK[role] != null ? ROLE_RANK[role] : -99; }

// ── SESSION TOKEN FUNCTIONS (HS256) ────────────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-in-prod';
if (IS_PRODUCTION && SESSION_SECRET === 'dev-insecure-secret-change-in-prod') {
  console.error('[auth] FATAL: SESSION_SECRET not set in production! Set SESSION_SECRET env var.');
}

const _crypto = require('crypto');

function _b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function _b64urlDecode(s) {
  s = s.replace(/-/g,'+').replace(/\//g,'/');
  while (s.length%4) s += '=';
  return Buffer.from(s,'base64');
}

function _signToken(payload, expiresInSec) {
  const header = _b64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const exp    = Math.floor(Date.now()/1000) + (expiresInSec != null ? expiresInSec : 86400); // 24h default
  const body   = _b64url(JSON.stringify(Object.assign({}, payload, { exp, iat:Math.floor(Date.now()/1000) })));
  const sig    = _b64url(_crypto.createHmac('sha256', SESSION_SECRET).update(header+'.'+body).digest());
  return header+'.'+body+'.'+sig;
}

function _verifyToken(token) {
  if (!token || typeof token !== 'string') return { error:'missing_token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { error:'malformed_token' };
  const [header, body, sig] = parts;
  const expected = _b64url(_crypto.createHmac('sha256', SESSION_SECRET).update(header+'.'+body).digest());
  if (expected !== sig) return { error:'invalid_token' };
  let payload;
  try { payload = JSON.parse(_b64urlDecode(body).toString()); } catch(_e) { return { error:'malformed_payload' }; }
  const nowSec = Math.floor(Date.now()/1000);
  if (payload.exp && nowSec >= payload.exp) return { error:'expired_token', expiredAt:payload.exp };
  return { ok:true, payload };
}

// ════════════════════════════════════════════════════════════════════════════
// CLUB MEMBERSHIP ENGINE — authoritative role source
// ════════════════════════════════════════════════════════════════════════════

const _membershipMemCache = new Map(); // key = actorId+'|'+clubId
const MEMBERSHIP_CACHE_TTL_MS = 60 * 1000; // 1 min freshness
const PLATFORM_ADMIN_ALLOWLIST = (process.env.PLATFORM_ADMIN_ALLOWLIST||'').split(',').filter(Boolean);

function _mKey(actorId, clubId) { return actorId+'|'+(clubId||''); }

async function _membershipLoad(actorId, clubId) {
  const cacheKey = _mKey(actorId, clubId);
  const cached   = _membershipMemCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < MEMBERSHIP_CACHE_TTL_MS) return cached.row;
  try {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('club_memberships').select('*')
        .eq('actor_id',actorId).eq('club_id',clubId).limit(1);
      const row = data && data[0] ? data[0] : null;
      _membershipMemCache.set(cacheKey, { row, cachedAt:Date.now() });
      return row;
    }
  } catch(_e) { console.warn('[membership] load error:', _e.message); }
  return null;
}

async function _membershipSave(row, updatedBy) {
  const now = new Date().toISOString();
  row.updated_at = now; if (updatedBy) row.updated_by = updatedBy;
  _membershipMemCache.set(_mKey(row.actor_id||row.actorId, row.club_id||row.clubId),
    { row, cachedAt:Date.now() });
  try {
    const sb = getSupabase();
    if (sb) await sb.from('club_memberships')
      .upsert(row, { onConflict:'actor_id,club_id' });
  } catch(_e) { console.warn('[membership] save error:', _e.message); }
}

function _membershipInvalidate(actorId, clubId) {
  _membershipMemCache.delete(_mKey(actorId, clubId));
}

// Resolve role for token issuance (production: DB wins; dev: fallback allowed)
async function _resolveTokenRole(actorId, clubId, requestedRole) {
  if (!actorId) return { error:'missing_actorId' };
  if (!clubId)  return { error:'missing_clubId' };
  const m = await _membershipLoad(actorId, clubId);
  if (IS_PRODUCTION) {
    if (!m)                     return { error:'membership_not_found' };
    if (m.status !== 'active')  return { error:'membership_inactive', status:m.status };
    // platform_admin only from server allowlist
    if (requestedRole === 'platform_admin' && !PLATFORM_ADMIN_ALLOWLIST.includes(actorId))
      return { error:'cannot_self_issue_elevated_role' };
    return { ok:true, role:m.role, membership:m };
  }
  // Dev: DB wins if available, else use requested or default
  if (m && m.status === 'active') return { ok:true, role:m.role, membership:m };
  const role = ROLE_RANK[requestedRole] != null ? requestedRole : 'player';
  return { ok:true, role, membership:null };
}

// Re-check membership freshness at request time (called from requireActor)
async function _checkMembershipFreshness(actorId, clubId, tokenRole) {
  if (!actorId || !clubId) return { ok:true }; // dev-bypass actors skip
  const m = await _membershipLoad(actorId, clubId);
  if (!m)                     return { ok:false, reason:'membership_not_found' };
  if (m.status !== 'active')  return { ok:false, reason:'membership_inactive', status:m.status };
  const dbRole = m.role;
  if (dbRole !== tokenRole)   return { ok:false, reason:'membership_role_changed',
                                        tokenRole, dbRole };
  return { ok:true };
}

// ── SESSION STORE ───────────────────────────────────────────────────────────────────────
const _sessionMemStore = new Map(); // fallback when Supabase unavailable

function _genJti() {
  return 'jti_'+Date.now()+'_'+_crypto.randomBytes(8).toString('hex');
}

async function _sessionLoad(jti) {
  try {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('sessions').select('*').eq('jti',jti).limit(1);
      if (data && data[0]) { _sessionMemStore.set(jti, data[0]); return data[0]; }
    }
  } catch(_e) {}
  return _sessionMemStore.get(jti) || null;
}

async function _sessionSave(row) {
  _sessionMemStore.set(row.jti, row);
  try {
    const sb = getSupabase();
    if (sb) await sb.from('sessions').upsert(row, { onConflict:'jti' });
  } catch(_e) {}
}

async function _sessionRevokeByActor(actorId, clubId, reason) {
  // Revoke in memory
  let count = 0;
  _sessionMemStore.forEach(function(row) {
    if (row && row.actor_id === actorId && row.club_id === (clubId||'') && row.status === 'active') {
      row.status = 'revoked'; row.revoked_at = new Date().toISOString();
      row.revoke_reason = reason||'role_changed'; count++;
    }
  });
  try {
    const sb = getSupabase();
    if (sb) await sb.from('sessions')
      .update({ status:'revoked', revoked_at:new Date().toISOString(), revoke_reason:reason||'role_changed' })
      .eq('actor_id',actorId).eq('club_id',clubId||'').eq('status','active');
  } catch(_e) {}
  return count;
}

// Issue a signed session token + persist session row
async function issueSessionToken(actorId, role, clubId, expiresInSec, platformRole) {
  const jti = _genJti();
  const now = new Date().toISOString();
  const expMs = (expiresInSec||86400)*1000;
  const payload = { sub:actorId, actorId, role, clubId:clubId||'', jti };
  if (platformRole) payload.platformRole = platformRole;
  const token = _signToken(payload, expiresInSec);
  const row = {
    jti, actor_id:actorId, club_id:clubId||'', role,
    platform_role: platformRole||null,
    status:'active', issued_at:now,
    expires_at: new Date(Date.now()+expMs).toISOString(),
    revoked_at:null, revoke_reason:null, last_seen_at:now
  };
  await _sessionSave(row);
  console.log('[session] issued jti='+jti+' role='+role);
  _writeAuthAudit('session_created', actorId, clubId, '/auth/token',
    { jti, role, expiresIn:expiresInSec||86400 });
  return { token, jti };
}

// ── REQUIRE ACTOR (Phase F — session-verified) ────────────────────────────────────────
function requireActor(req) {
  const authHeader = (req.headers['authorization'] || '').trim();
  const bypassAllowed = !IS_PRODUCTION || DEV_AUTH_BYPASS;
  const reqClub = (req.headers['x-club-id']||'').trim() ||
                  (req.body && req.body.clubId) || (req.query && req.query.clubId) || '';

  // 1. Bearer token
  if (authHeader.startsWith('Bearer ')) {
    const token  = authHeader.slice(7);
    const result = _verifyToken(token);
    if (!result.ok) {
      // ── Legacy JWT fallback: token signed with JWT_SECRET (login tokens) ──
      // If SESSION_SECRET-based verify fails, try JWT_SECRET-based verify.
      // Login tokens from /api/auth/login use jwt.sign with JWT_SECRET.
      try {
        const _jwtLib = require('jsonwebtoken');
        const _decoded = _jwtLib.verify(token, JWT_SECRET);
        console.log('[auth] JWT_SECRET_FALLBACK_DECODED id='+(_decoded&&_decoded.id||'?')
          + ' sub='+(_decoded&&_decoded.sub||'none')
          + ' actorId='+(_decoded&&_decoded.actorId||'none')
          + ' jti='+(_decoded&&_decoded.jti||'none')
          + ' clubId='+(_decoded&&_decoded.clubId||'none')
          + ' isLegacy='+!!(_decoded && _decoded.id && !_decoded.sub && !_decoded.actorId && !_decoded.jti));
        // Only treat as legacy if it has id/email but no sub/actorId/jti/clubId
        if (_decoded && _decoded.id && !_decoded.sub && !_decoded.actorId && !_decoded.jti) {
          const _legacyActorId = String(_decoded.id);
          console.log('[auth] legacy_login_token actor='+_legacyActorId+' — tagging for membership lookup (JWT_SECRET verified)');
          return {
            actorId: _legacyActorId,
            role: 'view_only',
            clubId: '',
            platformRole: null,
            jti: null, isDevBypass: false, fromToken: true,
            legacyToken: true,
            reqClub: reqClub
          };
        }
      } catch(_jwtErr) {
        // JWT_SECRET verify threw (key mismatch / rotation). Last resort: decode
        // WITHOUT signature verification. If payload looks like a legacy login token
        // {id,email,role}, tag it for DB membership lookup (the real auth gate).
        console.log('[auth] JWT_SECRET_FALLBACK_FAILED jwtSecretPresent='+(!!JWT_SECRET)
          +' name='+(_jwtErr&&_jwtErr.name||'?')+' msg='+(_jwtErr&&_jwtErr.message||'?'));
        try {
          const _rawDecoded = require('jsonwebtoken').decode(token);
          if (_rawDecoded && _rawDecoded.id && !_rawDecoded.sub && !_rawDecoded.actorId && !_rawDecoded.jti) {
            const _legacyActorId = String(_rawDecoded.id);
            console.log('[auth] JWT_DECODE_UNVERIFIED_LEGACY actor='+_legacyActorId
              +' — signature unverifiable, identity gated via DB membership');
            return {
              actorId: _legacyActorId, role: 'view_only', clubId: '',
              platformRole: null, jti: null, isDevBypass: false, fromToken: true,
              legacyToken: true, reqClub: reqClub
            };
          }
        } catch(_decodeErr) { /* not even a decodable JWT — fall through */ }
      }
      const evType = result.error;
      console.log('[auth] '+evType+' from '+req.path+' — returning 401 not 403');
      _writeAuthAudit(evType, null, reqClub, req.path);
      return { error:result.error, status:401, auditEvent:evType };
    }
    const p       = result.payload;
    const role    = ROLE_RANK[p.role] != null ? p.role : 'view_only';
    const club    = p.clubId || '';
    const platRole = p.platformRole || null;
    const jti     = p.jti || null;

    // Phase F: production requires jti + session store check
    // Exception: legacy login tokens (jwt.sign format: {id, email, role}, no sub/actorId/jti)
    // are tagged for async membership verification instead of hard-rejected.
    if (IS_PRODUCTION && !jti) {
      const _isLegacyLoginToken = !p.sub && !p.actorId && !p.clubId && (p.id || p.email);
      if (_isLegacyLoginToken) {
        const _legacyActorId = String(p.id || p.email || '');
        console.log('[auth] legacy_login_token actor='+_legacyActorId+' — tagging for membership lookup (no jti)');
        return {
          actorId: _legacyActorId,
          role: 'view_only',
          clubId: '',
          platformRole: null,
          jti: null, isDevBypass: false, fromToken: true,
          legacyToken: true,
          reqClub: reqClub
        };
      }
      console.log('[auth] legacy_token_missing_jti from '+req.path);
      _writeAuthAudit('legacy_token_missing_jti', p.sub||p.actorId, club, req.path);
      return { error:'legacy_token_missing_jti', status:401, auditEvent:'legacy_token_missing_jti' };
    }

    // Attach session check as async side-effect — resolve synchronously from mem cache
    if (jti) {
      const memSession = _sessionMemStore.get(jti);
      if (memSession === undefined) {
        // Not in mem cache yet — trigger async load, fail-open for now (will be checked on next request)
        _sessionLoad(jti).catch(()=>{});
      } else if (memSession === null) {
        _writeAuthAudit('session_not_found', p.sub, club, req.path, { jti });
        return { error:'session_not_found', status:401, auditEvent:'session_not_found' };
      } else {
        if (memSession.status === 'revoked') {
          _writeAuthAudit('session_revoked', p.sub, club, req.path, { jti, reason:memSession.revoke_reason });
          return { error:'session_revoked', status:401, auditEvent:'session_revoked',
                   revokeReason:memSession.revoke_reason };
        }
        if (memSession.status === 'expired') {
          return { error:'expired_token', status:401, auditEvent:'session_expired' };
        }
        // Claim consistency
        if (memSession.role !== role || memSession.club_id !== club) {
          _writeAuthAudit('session_claim_mismatch', p.sub, club, req.path, { jti, storedRole:memSession.role });
          return { error:'session_claim_mismatch', status:401, auditEvent:'session_claim_mismatch' };
        }
        // Update lastSeenAt (fire-and-forget)
        memSession.last_seen_at = new Date().toISOString();
        _sessionSave(memSession).catch(()=>{});
      }
    }

    // Phase G: membership freshness check (async, mem-cache backed, fire-and-forget on miss)
    if (jti && IS_PRODUCTION) {
      const mCheck = _membershipMemCache.get(_mKey(p.sub||p.actorId, club));
      if (mCheck && mCheck.row) {
        const m = mCheck.row;
        if (m.status !== 'active') {
          _writeAuthAudit('membership_inactive', p.sub, club, req.path, { status:m.status, jti });
          return { error:'membership_inactive', status:401, auditEvent:'membership_inactive' };
        }
        if (m.role !== role) {
          // Role changed in DB — revoke session and reject
          _sessionRevokeByActor(p.sub||p.actorId, club, 'role_changed').catch(()=>{});
          _writeAuthAudit('membership_role_changed', p.sub, club, req.path,
            { tokenRole:role, dbRole:m.role, jti });
          return { error:'membership_role_changed', status:401, auditEvent:'membership_role_changed' };
        }
      } else {
        // Trigger async load for next request
        _membershipLoad(p.sub||p.actorId, club).catch(()=>{});
      }
    }



    console.log('[auth] ok actor='+p.sub+' role='+role+' club='+club+(jti?' jti='+jti:''));
    return { actorId:p.sub||p.actorId, role, clubId:club, platformRole:platRole,
             jti, isDevBypass:false, fromToken:true };
  }

  // 2. Dev bypass
  if (bypassAllowed) {
    const bypassClub = reqClub || 'dev-club';
    console.log('[auth] DEV BYPASS actor=dev-owner role=owner club='+bypassClub);
    return { actorId:'dev-owner', role:'owner', clubId:bypassClub,
             platformRole:'platform_admin', isDevBypass:true };
  }

  // 3. No token in production
  console.log('[auth] unauthenticated request to '+req.path);
  _writeAuthAudit('unauthenticated', null, reqClub, req.path);
  return { error:'unauthenticated', status:401, auditEvent:'unauthenticated' };
}

function _writeAuthAudit(eventType, actorId, clubId, endpoint, extra) {
  try {
    const sb = getSupabase();
    if (sb) sb.from('audit_events').insert({
      event_type: eventType, player_id: actorId||null, club_id: clubId||null,
      payload: Object.assign({ endpoint, eventType }, extra||{})
    }).then(()=>{}).catch(()=>{});
  } catch(_e){}
}

// ── CLUB SCOPE ENFORCEMENT ────────────────────────────────────────────────────────────────────
function _checkClubScope(actor, requestedClubId) {
  if (actor.error) return { ok:false, reason:actor.error, auditEvent:actor.error };
  if (!requestedClubId) return { ok:true }; // no club in request — DB filter applies
  if (actor.platformRole === 'platform_admin') return { ok:true, crossClub:true };
  if (actor.isDevBypass) return { ok:true };
  // Membership-verified legacy tokens: clubId was DB-confirmed at auth time
  if (actor.membershipVerified) return { ok:true };
  // Only reject if token has a NON-EMPTY clubId that differs from requested.
  // Empty clubId = legacy login token (no club claim) — let membership lookup decide.
  if (actor.clubId && actor.clubId !== requestedClubId) {
    console.log('[auth] CLUB_SCOPE_MISMATCH_RETURN requestedClub='+requestedClubId
      +' membershipVerified='+(actor.membershipVerified||false));
    return {
      ok:false, reason:'club_scope_mismatch', status:403,
      auditEvent:'club_scope_mismatch',
      actorClubId:actor.clubId, requestedClubId
    };
  }
  return { ok:true };
}

// Derive canonical clubId for DB queries — never trust body/query in production
function _deriveClubId(actor, req) {
  if (!actor || actor.error) return null;
  const bodyClub  = req.body  && req.body.clubId;
  const queryClub = req.query && req.query.clubId;
  // platform_admin and dev bypass may use body/query
  if (actor.platformRole === 'platform_admin') return bodyClub || queryClub || actor.clubId;
  if (actor.isDevBypass) return bodyClub || queryClub || actor.clubId;
  // Production: trust token clubId; also trust reqClub for membership-verified legacy tokens
  if (actor.membershipVerified) return actor.clubId || null;
  return actor.clubId || null;
}

// Extend requirePermission to enforce club scope
// _safeClubId: get canonical clubId for a request (req._clubId set by scope middleware, or body/query in dev)

// ── Club ID normalization guard ───────────────────────────────────────────────
// Modern Supabase-backed routes require canonical UUID/text club IDs.
// Numeric-only club IDs (e.g. "1", "42") are legacy PostgreSQL integer PKs
// from the old /api/clubs system and must not reach Supabase RPC/query paths.
// Apply this middleware BEFORE requirePermissionScoped on protected routes.
//
// Accepts: UUIDs, slug-style text, any string containing non-numeric chars
// Rejects: strings that are purely numeric ("1", "42", "100")
// Bypass:  dev bypass actors; also skipped when clubId is absent (other guards handle that)
const _NUMERIC_CLUB_ID_RE = /^\d+$/;

function requireCanonicalClubId(req, res, next) {
  const clubId = (req.body && req.body.clubId)
    || (req.query && req.query.clubId)
    || (req.headers['x-club-id'] || '').trim()
    || '';
  // If no clubId present, let downstream guards handle missing-clubId
  if (!clubId) return next();
  // Dev bypass: allow numeric IDs only in non-production environments
  // NOTE: DEV_AUTH_BYPASS does NOT bypass the club-ID format check —
  // it only bypasses auth token verification. Club ID normalization
  // is a data-integrity constraint, not an auth constraint.
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) return next();
  // Reject purely numeric club IDs on production Supabase routes
  if (_NUMERIC_CLUB_ID_RE.test(clubId)) {
    console.log('[club-id] NUMERIC_CLUB_ID_REJECTED path='+req.path);
    return res.status(400).json({
      ok: false,
      error: 'legacy_club_id_not_supported',
      clubId,
      hint: 'This route requires a UUID club ID. Numeric club IDs ('+clubId+') are legacy and not supported on this endpoint. Obtain a canonical club UUID via GET /api/clubs or the lobby.'
    });
  }
  next();
}

// ════════════════════════════════════════════════════════════════════════════
// CANONICAL LEDGER ENGINE
// ════════════════════════════════════════════════════════════════════════════

const LEDGER_EVENT_TYPES = new Set([
  'BET_PLACED','BET_CANCELED_REFUND','BET_GRADED_WIN','BET_GRADED_LOSS',
  'BET_GRADED_PUSH','SETTLEMENT_APPLIED','WEEKLY_ROLLOVER','BALANCE_ADJUSTMENT'
]);
const LEDGER_DEBIT_EVENTS  = new Set(['BET_PLACED','SETTLEMENT_APPLIED']);
const LEDGER_CREDIT_EVENTS = new Set(['BET_CANCELED_REFUND','BET_GRADED_WIN','BET_GRADED_PUSH','BALANCE_ADJUSTMENT']);

function _ledgerDirection(eventType) {
  if (LEDGER_DEBIT_EVENTS.has(eventType))  return 'debit';
  if (LEDGER_CREDIT_EVENTS.has(eventType)) return 'credit';
  return 'neutral';
}

function _ledgerId(eventType) {
  return 'LE_'+eventType.slice(0,4)+'_'+Date.now()+'_'+_crypto.randomBytes(4).toString('hex');
}

// Derive ledger balance from rows
function _deriveLedgerBalance(startingLimit, rows) {
  let bal = parseFloat(startingLimit)||0;
  (rows||[]).forEach(function(r) {
    const amt = parseFloat(r.amount||r.amount_cents/100||0);
    if (r.direction==='credit') bal+=amt;
    else if (r.direction==='debit') bal-=amt;
  });
  return Math.round(bal*100)/100;
}

// Write a ledger entry to Supabase
async function _writeLedgerEntry(params) {
  const { clubId, playerId, ticketId, settlementId, eventType, amount,
          balanceBefore, balanceAfter, idempotencyKey, createdBy, reason, metadataJson } = params;
  if (!LEDGER_EVENT_TYPES.has(eventType)) throw new Error('invalid_eventType:'+eventType);
  const amt = parseFloat(amount);
  if (isNaN(amt)||amt<0) throw new Error('invalid_amount:'+amount);
  const dir = _ledgerDirection(eventType);
  const ledgerId = _ledgerId(eventType);
  const row = {
    ledger_id:ledgerId, club_id:clubId||'', player_id:playerId||'',
    ticket_id:ticketId||null, settlement_id:settlementId||null,
    event_type:eventType, amount:amt, currency:'diamonds', direction:dir,
    balance_before:balanceBefore!=null?Math.round(balanceBefore*100)/100:null,
    balance_after:balanceAfter!=null?Math.round(balanceAfter*100)/100:null,
    idempotency_key:idempotencyKey||null,
    created_at:new Date().toISOString(), created_by:createdBy||'system',
    reason:reason||eventType, metadata_json:metadataJson||null
  };
  try {
    const sb = getSupabase();
    if (sb) {
      const { error } = await sb.from('ledger').insert(row);
      if (error) {
        // Unique constraint = idempotent duplicate
        if (error.code === '23505') return { ok:true, idempotent:true, ledgerId };
        throw error;
      }
    }
  } catch(e) {
    if (e.code==='23505') return { ok:true, idempotent:true, ledgerId };
    throw e;
  }
  console.log('[ledger] '+eventType+' player='+playerId+' amt='+amt+
    (ticketId?' ticket='+ticketId:'')+(idempotencyKey?' idem='+idempotencyKey:''));
  return { ok:true, ledgerId, row };
}

// Fetch player ledger rows from Supabase
async function _fetchPlayerLedger(clubId, playerId) {
  try {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('ledger').select('*')
        .eq('club_id',clubId).eq('player_id',playerId).order('created_at');
      return data || [];
    }
  } catch(_e) {}
  return [];
}

// Derive available balance from ledger + active tickets
async function _deriveAvailableBalance(clubId, playerId, startingLimit) {
  const rows = await _fetchPlayerLedger(clubId, playerId);
  let activeTix = [];
  try {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('tickets').select('risk_amount')
        .eq('player_id',playerId).in('status',['active','open']);
      activeTix = data||[];
    }
  } catch(_e){}
  const ledgerBal = _deriveLedgerBalance(startingLimit, rows);
  const openRisk  = activeTix.reduce(function(s,t){ return s+parseFloat(t.risk_amount||0); }, 0);
  const available = Math.round((ledgerBal-openRisk)*100)/100;
  return { ledgerBal, openRisk, available, rows };
}

// ════════════════════════════════════════════════════════════════════════════
// ODDS SNAPSHOT ENGINE (Phase K)
// ════════════════════════════════════════════════════════════════════════════

const SNAPSHOT_TTL_MS  = 5 * 60 * 1000;  // 5 min
const SNAPSHOT_TOLERANCE = 3;             // ±3 American odds points

function _snapKey(cKey, market, selection) {
  return cKey+'|'+(market||'').toLowerCase()+'|'+(selection||'').toLowerCase();
}

// ═════════════════════════════════════════════════════════════════════════
// MARKET IDENTITY PRIMITIVES (canonical cleanup pass — see priority #11)
// ═════════════════════════════════════════════════════════════════════════
//
// Goal: replace string-overloaded market/selection identity with explicit
// structured keys. Frontend payloads keep working (compat shim below) but
// internally we use canonicalMarketKey + canonicalSelectionKey for snapshot
// lookup, grading, and SGP conflict detection.
//
// Vocabulary (every cache entry + every persisted snapshot stamps one):
//
//   moneyline             — full-game H2H
//   spread                — full-game point spread
//   total                 — full-game over/under
//   player_prop           — single-player line (points, yards, etc.)
//   team_total            — per-team over/under
//   period_moneyline      — half/quarter/inning H2H
//   period_spread         — half/quarter/inning spread
//   period_total          — half/quarter/inning total
//
// Existing string keys ("first_half_spread", etc.) map onto this list via
// _coerceMarketType() so old callers and old DB rows keep working.
const MARKET_TYPES = Object.freeze({
  MONEYLINE:        'moneyline',
  SPREAD:           'spread',
  TOTAL:            'total',
  PLAYER_PROP:      'player_prop',
  TEAM_TOTAL:       'team_total',
  PERIOD_MONEYLINE: 'period_moneyline',
  PERIOD_SPREAD:    'period_spread',
  PERIOD_TOTAL:     'period_total',
});

// Map any legacy / alternate market label onto a MARKET_TYPES value. Returns
// null for unknown inputs so callers can decide whether to skip or fall
// through to the raw string (back-compat).
function _coerceMarketType(raw) {
  if (!raw) return null;
  const k = String(raw).toLowerCase().trim();
  if (k === 'moneyline' || k === 'h2h')           return MARKET_TYPES.MONEYLINE;
  if (k === 'spread'    || k === 'spreads'
   || k === 'run_line'  || k === 'runline'
   || k === 'alt_spread' || k === 'alternate_spread' || k === 'alternate_spreads') return MARKET_TYPES.SPREAD;
  if (k === 'total'     || k === 'totals'
   || k === 'alt_total' || k === 'alternate_total' || k === 'alternate_totals') return MARKET_TYPES.TOTAL;
  if (k === 'player_prop' || k === 'prop')         return MARKET_TYPES.PLAYER_PROP;
  if (k === 'team_total'  || k === 'team_totals')  return MARKET_TYPES.TEAM_TOTAL;
  if (k === 'first_half_moneyline' || k === 'h2h_h1' || k === 'moneyline_h1') return MARKET_TYPES.PERIOD_MONEYLINE;
  if (k === 'first_half_spread'    || k === 'spreads_h1' || k === 'spread_h1') return MARKET_TYPES.PERIOD_SPREAD;
  if (k === 'first_half_total'     || k === 'totals_h1'  || k === 'total_h1')  return MARKET_TYPES.PERIOD_TOTAL;
  // Heuristic: anything starting with 'period_' or 'quarter_' or 'inning_'
  // collapses to the period_* variant.
  if (/^(period|quarter|inning|half|h1|h2|q1|q2|q3|q4)_total$/.test(k))     return MARKET_TYPES.PERIOD_TOTAL;
  if (/^(period|quarter|inning|half|h1|h2|q1|q2|q3|q4)_spread$/.test(k))    return MARKET_TYPES.PERIOD_SPREAD;
  if (/^(period|quarter|inning|half|h1|h2|q1|q2|q3|q4)_moneyline$/.test(k)) return MARKET_TYPES.PERIOD_MONEYLINE;
  return null;
}

// Normalize a human player name to a stable identifier.
//   "Jalen Brunson"        -> "jalen_brunson"
//   "Shai Gilgeous-Alex."  -> "shai_gilgeous_alex"
//   "O'Connor, Jamal"      -> "o_connor_jamal"
function _normalizePlayerName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/['’\.]/g, '')           // drop apostrophes, periods
    .replace(/[^a-z0-9]+/g, '_')      // any other run -> single underscore
    .replace(/^_+|_+$/g, '');         // trim leading/trailing underscores
}

// Normalize a propType display label into a stable identifier.
//   "Receiving Yards"  -> "receiving_yards"
//   "3-Pointers Made"  -> "3_pointers_made"
//   "Pts + Reb + Ast"  -> "pts_reb_ast"
function _normalizePropType(label) {
  if (!label) return '';
  return String(label)
    .toLowerCase()
    .replace(/\+/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Build a canonical market identity tuple for any in-cache / on-snapshot
// market entry. Returns { canonicalMarketKey, canonicalSelectionKey }.
//
// canonicalMarketKey shape:
//   game-level    : `${gameKey}|${marketType}`
//   player_prop   : `${gameKey}|player_prop|${propType}`
//   team_total    : `${gameKey}|team_total|${teamSlug}`
//   period_*      : `${gameKey}|${marketType}|${periodLabel}`
//
// canonicalSelectionKey shape:
//   moneyline     : team slug
//   spread        : `${teamSlug}:${line}`
//   total         : `${over|under}:${line}`
//   player_prop   : `${playerNorm}:${over|under}:${line}`
//   team_total    : `${over|under}:${line}`
//   period_*      : same as their full-game cousins
//
// All inputs are tolerated as either canonical or display values — helpers
// re-normalize so callers don't have to think about case.
function _buildCanonicalMarketKey(input) {
  if (!input) return null;
  const gameKey = input.canonicalGameKey || input.gameKey || input.cKey;
  if (!gameKey) return null;
  const mt = _coerceMarketType(input.marketType || input.market);
  if (!mt) return null;
  if (mt === MARKET_TYPES.PLAYER_PROP) {
    const propType = _normalizePropType(input.propType || '');
    return `${gameKey}|${mt}|${propType || 'unknown'}`;
  }
  if (mt === MARKET_TYPES.TEAM_TOTAL) {
    const team = _normalizePlayerName(input.team || input.teamOrSide || '');
    return `${gameKey}|${mt}|${team || 'unknown'}`;
  }
  if (mt === MARKET_TYPES.PERIOD_MONEYLINE ||
      mt === MARKET_TYPES.PERIOD_SPREAD ||
      mt === MARKET_TYPES.PERIOD_TOTAL) {
    const period = _normalizePropType(input.period || input.periodLabel || 'h1');
    return `${gameKey}|${mt}|${period}`;
  }
  return `${gameKey}|${mt}`;
}

function _buildCanonicalSelectionKey(input) {
  if (!input) return null;
  const mt = _coerceMarketType(input.marketType || input.market);
  if (!mt) return null;
  const side = String(input.side || input.overUnder || input.teamOrSide || '').toLowerCase();
  const line = (input.line != null && Number.isFinite(parseFloat(input.line)))
                  ? parseFloat(input.line) : null;
  if (mt === MARKET_TYPES.MONEYLINE || mt === MARKET_TYPES.PERIOD_MONEYLINE) {
    return _normalizePlayerName(input.team || input.teamOrSide || input.selection || '');
  }
  if (mt === MARKET_TYPES.SPREAD || mt === MARKET_TYPES.PERIOD_SPREAD) {
    const team = _normalizePlayerName(input.team || input.teamOrSide || '');
    if (line == null || !team) return null;
    return `${team}:${line}`;
  }
  if (mt === MARKET_TYPES.TOTAL || mt === MARKET_TYPES.PERIOD_TOTAL ||
      mt === MARKET_TYPES.TEAM_TOTAL) {
    const ou = side.indexOf('under') >= 0 ? 'under' : 'over';
    if (line == null) return null;
    return `${ou}:${line}`;
  }
  if (mt === MARKET_TYPES.PLAYER_PROP) {
    const player = _normalizePlayerName(input.player || input.playerName || '');
    if (!player || line == null) return null;
    const ou = side.indexOf('under') >= 0 ? 'under' : 'over';
    return `${player}:${ou}:${line}`;
  }
  return null;
}

// Normalize a legacy frontend leg payload into canonical identity. We do
// NOT mutate the caller's object — we return a fresh structured identity
// they can attach. Logs PROP_IDENTITY_NORMALIZED when we successfully coerce
// a legacy prop shape (market='total' + isPlayerProp=true) into player_prop.
//
// Returns:
//   {
//     marketType,                  // MARKET_TYPES.*
//     canonicalMarketKey,
//     canonicalSelectionKey,
//     legacy: { market, pick, line, isPlayerProp },
//     warnings: […]
//   }
function _normalizeLegIdentity(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const warnings = [];
  const gameKey = leg.canonicalGameKey || leg.gameKey || leg.cKey || '';
  if (!gameKey) return null;

  let marketType = _coerceMarketType(leg.market);
  let playerName = leg.player || leg.playerName || leg.player_name || null;
  let propType   = leg.propType || leg.prop_type || null;
  let side       = leg.side || leg.overUnder || null;
  const lineRaw  = leg.line != null ? leg.line : leg.point;
  const line     = (lineRaw != null && Number.isFinite(parseFloat(lineRaw))) ? parseFloat(lineRaw) : null;

  // ----- Legacy prop shape: market='total' + isPlayerProp=true -----
  // Frontend (priority #10) sends prop legs as market='total' with the
  // flag below + a free-text pick like "Jalen Brunson Over 25.5 Points".
  // Sniff it, parse out the structured identity, and upgrade.
  if (leg.isPlayerProp || marketType === MARKET_TYPES.PLAYER_PROP) {
    marketType = MARKET_TYPES.PLAYER_PROP;
    const pick = String(leg.selectionLabel || leg.pick || '');
    if (!playerName || !propType || !side) {
      const parsed = _parseLegacyPropPick(pick);
      playerName = playerName || parsed.playerName;
      propType   = propType   || parsed.propType;
      side       = side       || parsed.side;
      // Line is rarely missing from the leg, but fall back to the parsed value.
      if (line == null && parsed.line != null) {
        // eslint-disable-next-line no-console
        console.log(`PROP_IDENTITY_NORMALIZED gameKey=${gameKey} reason=parsed_line_from_label`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`PROP_IDENTITY_NORMALIZED gameKey=${gameKey} player=${_normalizePlayerName(playerName||'')} propType=${_normalizePropType(propType||'')} side=${(side||'').toLowerCase()} line=${line!=null?line:'?'} source=${leg.isPlayerProp ? 'legacy_total_flag' : 'native'}`);
    if (!playerName) warnings.push('player_name_missing');
    if (!propType)   warnings.push('prop_type_missing');
    if (!side)       warnings.push('side_missing');
    if (line == null) warnings.push('line_missing');
  }

  const canonicalMarketKey = _buildCanonicalMarketKey({
    canonicalGameKey: gameKey,
    marketType,
    propType,
    // For team_total, the team identifier may live in pick.
    team: leg.team || leg.teamOrSide || (marketType === MARKET_TYPES.TEAM_TOTAL ? leg.pick : null),
    period: leg.period || leg.periodLabel,
  });
  // Selection identity sources:
  //   moneyline  : pick is the team
  //   spread     : pick is the team, leg.line carries the line
  //   total      : pick is the side ("Over"/"Under")
  //   team_total : pick is the side
  //   player_prop: player + side resolved above
  const isTeamMarket =
    marketType === MARKET_TYPES.MONEYLINE ||
    marketType === MARKET_TYPES.SPREAD    ||
    marketType === MARKET_TYPES.PERIOD_MONEYLINE ||
    marketType === MARKET_TYPES.PERIOD_SPREAD;
  const isSideMarket =
    marketType === MARKET_TYPES.TOTAL      ||
    marketType === MARKET_TYPES.TEAM_TOTAL ||
    marketType === MARKET_TYPES.PERIOD_TOTAL;
  const canonicalSelectionKey = _buildCanonicalSelectionKey({
    marketType,
    team:   leg.team || leg.teamOrSide || (isTeamMarket ? leg.pick : null),
    player: playerName,
    side:   side || (isSideMarket ? leg.pick : null),
    line,
  });

  return {
    marketType,
    canonicalMarketKey,
    canonicalSelectionKey,
    playerName, propType, side, line, gameKey,
    legacy: {
      market: leg.market || null,
      pick:   leg.pick || leg.selectionLabel || null,
      line:   leg.line != null ? leg.line : null,
      isPlayerProp: !!leg.isPlayerProp,
    },
    warnings,
  };
}

// Parse a legacy prop pick string back into structured fields. Best-effort;
// the frontend's PropsTab builds the label as
//   `${playerName} ${Over|Under} ${line} ${propType}`
// so we anchor on the Over/Under token.
function _parseLegacyPropPick(label) {
  const out = { playerName:null, propType:null, side:null, line:null };
  if (!label) return out;
  const m = String(label).match(/^(.+?)\s+(over|under)\s+([0-9.]+)\s*(.*)$/i);
  if (!m) {
    // Fallback: just split off trailing Over/Under and digits.
    const m2 = String(label).match(/^(.+?)\s+(over|under)\s*$/i);
    if (m2) {
      out.playerName = m2[1].trim();
      out.side       = m2[2].toLowerCase();
    } else {
      out.playerName = label.trim();
    }
    return out;
  }
  out.playerName = m[1].trim();
  out.side       = m[2].toLowerCase();
  out.line       = parseFloat(m[3]);
  out.propType   = (m[4] || '').trim() || null;
  return out;
}


// Build snapshot rows from LIVE_MARKET_CACHE and upsert into Supabase
// Build one snapshot row from a single (entry, outcome) pair.
//
// Supports two cache shapes:
//   1. Odds-API: entry = { cKey, gameId, sport, market, bookmaker,
//        outcomes:[{name, price, point}, ...], commenceTime, ...status }
//      — the legacy shape produced by _buildCacheFromGames.
//   2. Owls:    entry = { canonicalKey, providerGameId, marketType,
//        teamOrSide, odds, line?, overUnder?, propType?, playerName?,
//        canonicalMarketKey, canonicalSelectionKey, eventStatus, ... }
//      — flat per-outcome shape produced by _normalizeOwlsResponse.
//
// `outcome` is the Odds-API outcome object on path #1; `null` on path #2
// (the entry itself IS the outcome).
function _buildSnapshotRow(entry, outcome, opts) {
  const now = opts.now;
  const exp = opts.exp;
  const provider = opts.provider;

  // ----- Resolve the canonical identity tuple -----
  // Owls entries already carry canonicalMarketKey/canonicalSelectionKey;
  // Odds-API entries don't, so we compute them per outcome on the fly.
  const isOwlsShape = !outcome;
  const marketTypeRaw = isOwlsShape ? entry.marketType : entry.market;
  const marketTypeCoerced = _coerceMarketType(marketTypeRaw) || marketTypeRaw;

  const cKey = entry.cKey || entry.canonicalKey || null;
  if (!cKey) return null;

  let canonicalMarketKey, canonicalSelectionKey;
  if (isOwlsShape) {
    canonicalMarketKey    = entry.canonicalMarketKey || _buildCanonicalMarketKey({
      canonicalGameKey: cKey,
      marketType:       entry.marketType,
      propType:         entry.propType,
      team:             entry.teamOrSide,
    });
    canonicalSelectionKey = entry.canonicalSelectionKey || _buildCanonicalSelectionKey({
      marketType: entry.marketType,
      team:       entry.teamOrSide,
      player:     entry.playerName,
      side:       entry.overUnder || entry.teamOrSide,
      line:       entry.line,
    });
  } else {
    canonicalMarketKey    = _buildCanonicalMarketKey({
      canonicalGameKey: cKey,
      marketType:       entry.market,
      team:             outcome.name,
    });
    canonicalSelectionKey = _buildCanonicalSelectionKey({
      marketType: entry.market,
      team:       outcome.name,
      side:       outcome.name,
      line:       outcome.point,
    });
  }

  // ----- Selection key for the LEGACY column (kept for grading/back-compat) -----
  let legacySelectionKey, legacyMarketKey, oddsAmerican, line;
  if (isOwlsShape) {
    // For Owls props, the legacy selection_key carries the player+side+line
    // so old grading paths that haven't been migrated yet can still locate
    // the row by string match.
    if (entry.marketType === 'player_prop' && entry.playerName) {
      const side = (entry.overUnder || '').toLowerCase();
      const ln   = entry.line != null ? entry.line : '';
      legacySelectionKey = `${entry.playerName} ${side} ${ln}`.trim().toLowerCase();
    } else {
      legacySelectionKey = String(entry.teamOrSide || '').toLowerCase();
    }
    legacyMarketKey = String(entry.marketType || '').toLowerCase();
    oddsAmerican    = Math.round(entry.odds || 0);
    line            = entry.line != null ? entry.line : null;
  } else {
    legacySelectionKey = String(outcome.name || '').toLowerCase();
    legacyMarketKey    = String(entry.market || '').toLowerCase();
    oddsAmerican       = Math.round(outcome.price || 0);
    line               = outcome.point != null ? outcome.point : null;
  }

  const oddsDecimal = oddsAmerican > 0
    ? Math.round((oddsAmerican / 100 + 1) * 10000) / 10000
    : Math.round((100 / Math.abs(oddsAmerican || 1) + 1) * 10000) / 10000;

  const row = {
    snapshot_id:              cKey + '|' + legacyMarketKey + '|' + legacySelectionKey + '|' + Date.now(),
    sport:                    entry.sport || 'unknown',
    event_id:                 entry.gameId || entry.providerGameId || null,
    canonical_game_key:       cKey,
    market_key:               legacyMarketKey,
    selection_key:            legacySelectionKey,
    // Canonical identity columns (priority #11). Stripped by the catch
    // below if the DB hasn't been migrated yet.
    canonical_market_key:     canonicalMarketKey,
    canonical_selection_key:  canonicalSelectionKey,
    market_type:              marketTypeCoerced,
    odds_american:            oddsAmerican,
    odds_decimal:             oddsDecimal,
    point_line:               line,
    // Provider tag for analytics + the per-leg verifier preference order.
    source:                   provider || entry.sportsbook || entry.bookmaker || 'odds-api',
    provider_game_id:         entry.providerGameId || entry.gameId || null,
    fetched_at:               now,
    expires_at:               exp,
    commence_time:            entry.commenceTime || null,
    suspended:                entry.suspended || false,
    event_status:             entry.gameStatus  || entry.eventStatus  || null,
    market_status:            entry.marketStatus || null,
    event_completed:          !!(entry.eventCompleted),
    event_canceled:           !!(entry.eventCanceled),
    event_live:               !!(entry.eventLive),
  };

  // ----- Player-prop identity fields when applicable -----
  if (marketTypeCoerced === 'player_prop' && isOwlsShape) {
    row.player_name           = entry.playerName || null;
    row.player_name_normalized= entry.playerName ? _normalizePlayerName(entry.playerName) : null;
    row.prop_type             = entry.propType || null;
    row.prop_type_normalized  = entry.propType ? _normalizePropType(entry.propType) : null;
    row.prop_side             = (entry.overUnder || '').toLowerCase() || null;
    row.player_team           = entry.playerTeam || null;
  }
  return row;
}

// Module-scope flag so we introspect odds_snapshots' actual column set
// exactly once per process. Diagnoses schema-drift PGRST204 failures (the
// table has different columns than the code writes) without spamming logs.
let _loggedSnapshotSchema = false;
async function _logSnapshotSchemaOnce(sb, sampleRow) {
  if (_loggedSnapshotSchema || !sb) return;
  _loggedSnapshotSchema = true;
  try {
    // Lightweight HEAD-style probe: select 0 rows but force PostgREST to
    // resolve the schema. The returned `error` object (if any) will name
    // the first missing column it sees, which is the fastest path to a
    // pinpoint diagnosis.
    const { error } = await sb.from('odds_snapshots').select('snapshot_id').limit(0);
    const sampleCols = sampleRow ? Object.keys(sampleRow).sort().join(',') : '(no sample)';
    if (error) {
      console.warn('ODDS_SNAPSHOTS_SCHEMA_PROBE_ERR'+
        ' code='+(error.code||'?')+
        ' message='+JSON.stringify((error.message||'').slice(0,200))+
        ' details='+JSON.stringify((error.details||'').slice(0,200))+
        ' hint='+JSON.stringify((error.hint||'').slice(0,200))+
        ' writeColumns='+sampleCols);
    } else {
      console.log('ODDS_SNAPSHOTS_SCHEMA_PROBE_OK writeColumns='+sampleCols);
    }
  } catch(e) {
    console.warn('ODDS_SNAPSHOTS_SCHEMA_PROBE_THREW msg='+(e&&e.message||e));
  }
}

// Verbose error formatter for Supabase JS PostgREST errors. Surfaces the
// fields the catch blocks were previously dropping: code, details, hint,
// plus a bounded preview of the failing row's column set. Hardened so the
// next schema-drift event surfaces in 30 seconds instead of a week.
function _fmtSnapshotErr(label, e, rows) {
  const code    = (e && (e.code||e.statusCode))     || '?';
  const msg     = (e && e.message) || String(e || '');
  const details = (e && e.details) || '';
  const hint    = (e && e.hint)    || '';
  const sample  = (rows && rows[0]) ? rows[0] : null;
  const cols    = sample ? Object.keys(sample).sort().join(',') : '(no rows)';
  const samplePreview = sample
    ? JSON.stringify(sample).slice(0, 360)
    : '';
  return label+
    ' code='+code+
    ' msg='+JSON.stringify(msg.slice(0,300))+
    ' details='+JSON.stringify(String(details).slice(0,200))+
    ' hint='+JSON.stringify(String(hint).slice(0,200))+
    ' rowCount='+(rows?rows.length:0)+
    ' columns='+cols+
    ' sample='+samplePreview;
}

async function _upsertOddsSnapshots() {
  const sb  = getSupabase();
  const now = new Date().toISOString();
  const exp = new Date(Date.now()+SNAPSHOT_TTL_MS).toISOString();
  const cache = LIVE_MARKET_CACHE;
  if (!sb) {
    console.log('ODDS_SNAPSHOT_UPSERT_EMPTY provider='+(ODDS_PROVIDER||'unknown')+' reason=no_supabase');
    return;
  }
  if (!cache.gameCount) {
    console.log('ODDS_SNAPSHOT_UPSERT_EMPTY provider='+(ODDS_PROVIDER||'unknown')+' reason=no_games_in_cache');
    return;
  }

  const provider = ODDS_PROVIDER === 'owls_insight' ? 'owls_insight' : 'odds-api';
  const rows = [];

  // Diagnostic counters — single SNAPSHOT_ITERATION_BEGIN/END pair plus a
  // bounded sample of per-entry SEEN/PREPARED/SKIPPED lines so we get a
  // verifiable trace without flooding Railway (1438 markets / 15s poll =
  // ~5,700 lines/min if uncapped).
  const cacheKeys = Object.keys(cache.marketsByCanonicalKey);
  let seenEntries = 0;
  let loggedSeen = 0, loggedPrepared = 0, loggedSkipped = 0;
  const TRACE_CAP = 8;
  const skipReasons = {};
  const sampleSkips = [];
  function bumpSkip(reason, sampleKey, sampleShape) {
    skipReasons[reason] = (skipReasons[reason] || 0) + 1;
    if (sampleSkips.length < 3) {
      sampleSkips.push({ reason, key: sampleKey, shape: sampleShape });
    }
  }
  console.log('SNAPSHOT_ITERATION_BEGIN provider='+provider+' keys='+cacheKeys.length+' cacheMarketCount='+cache.marketCount);

  // Normalize each value into an iterable list of per-outcome entries so we
  // can handle three shapes uniformly:
  //   1. Odds-API:       { outcomes: [...] }              — one entry, has outcomes
  //   2. Owls overlay:   [ entry, entry, ... ]            — an ARRAY of per-outcome entries
  //   3. Single Owls:    { marketType, teamOrSide, ... }  — one bare entry (defensive)
  //
  // The previous iteration assumed every value was shape #1 OR shape #3.
  // The Owls overlay introduced shape #2 (arrays of entries) which silently
  // produced zero rows because arrays have neither `.outcomes` nor
  // `.marketType`. Flattening here covers all three.
  for (const ck of cacheKeys) {
    const value = cache.marketsByCanonicalKey[ck];
    if (!value) { bumpSkip('null_value', ck, typeof value); continue; }

    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      seenEntries++;
      if (!entry || typeof entry !== 'object') {
        bumpSkip('not_object', ck, typeof entry);
        continue;
      }
      if (loggedSeen < TRACE_CAP) {
        console.log('SNAPSHOT_MARKET_SEEN ck='+ck+' marketType='+(entry.marketType||entry.market||'?')+' hasOutcomes='+Array.isArray(entry.outcomes));
        loggedSeen++;
      }

      // Odds-API shape: entry has an outcomes[] array.
      if (Array.isArray(entry.outcomes) && entry.outcomes.length > 0) {
        for (const outcome of entry.outcomes) {
          const row = _buildSnapshotRow(entry, outcome, { now, exp, provider });
          if (row) {
            rows.push(row);
            if (loggedPrepared < TRACE_CAP) {
              console.log('SNAPSHOT_ROW_PREPARED ck='+ck+' market='+row.market_key+' selection='+row.selection_key);
              loggedPrepared++;
            }
          } else {
            bumpSkip('row_null_oddsapi', ck, JSON.stringify({ outcome: outcome && outcome.name }));
            if (loggedSkipped < TRACE_CAP) {
              console.log('SNAPSHOT_ROW_SKIPPED ck='+ck+' reason=row_null_oddsapi outcome='+(outcome && outcome.name));
              loggedSkipped++;
            }
          }
        }
        continue;
      }

      // Owls shape: entry is a single per-outcome row from the normalizer.
      if (entry.marketType) {
        const row = _buildSnapshotRow(entry, null, { now, exp, provider });
        if (row) {
          rows.push(row);
          if (loggedPrepared < TRACE_CAP) {
            console.log('SNAPSHOT_ROW_PREPARED ck='+ck+' market='+row.market_key+' selection='+row.selection_key);
            loggedPrepared++;
          }
        } else {
          bumpSkip('row_null_owls', ck, JSON.stringify({ mt: entry.marketType, side: entry.teamOrSide }));
          if (loggedSkipped < TRACE_CAP) {
            console.log('SNAPSHOT_ROW_SKIPPED ck='+ck+' reason=row_null_owls marketType='+entry.marketType+' side='+entry.teamOrSide);
            loggedSkipped++;
          }
        }
        continue;
      }

      // Neither shape matched — log enough context to diagnose without
      // dumping the full object on every poll.
      bumpSkip('unknown_shape', ck, Object.keys(entry).slice(0,8).join(','));
    }
  }

  if (!rows.length) {
    console.log('ODDS_SNAPSHOT_UPSERT_EMPTY provider='+provider+
      ' reason=no_rows_after_iteration cacheMarketCount='+cache.marketCount+
      ' seenEntries='+seenEntries+
      ' skipReasons='+JSON.stringify(skipReasons)+
      ' sampleSkips='+JSON.stringify(sampleSkips));
    return;
  }

  console.log('ODDS_SNAPSHOT_UPSERT provider='+provider+' rows='+rows.length+
    ' seenEntries='+seenEntries+
    ' skipReasons='+JSON.stringify(skipReasons));
  // One-shot schema introspection. Logs what columns the code is trying
  // to write so a schema mismatch is visible in 30 seconds, not a week.
  await _logSnapshotSchemaOnce(sb, rows[0]);
  try {
    const { error: upsertErr } = await sb.from('odds_snapshots').upsert(rows,
      { onConflict:'canonical_game_key,market_key,selection_key' });
    if (upsertErr) throw upsertErr;
    console.log('[snapshot] upserted '+rows.length+' odds snapshots');
  } catch(e) {
    // If the DB hasn't been migrated with the new canonical columns the
    // upsert above fails with `column "canonical_market_key" does not exist`
    // (PG code 42703). Retry once with the legacy projection so the system
    // keeps working until the migration runs.
    const msg = (e && e.message) || '';
    const code = (e && (e.code||e.statusCode)) || '?';
    // Surface the full error envelope BEFORE any retry decisions so we see
    // what the DB actually returned even when the strip-fallback path runs.
    console.warn(_fmtSnapshotErr('SNAPSHOT_UPSERT_ERR primary', e, rows));
    // Drop any column the migration hasn't applied yet. We strip the
    // priority-#11 canonical columns AND the priority-#12 player-prop +
    // provider columns in one pass so a single retry covers either state.
    if (/canonical_market_key|canonical_selection_key|market_type|player_name|prop_type|prop_side|player_team|provider_game_id/.test(msg)) {
      console.warn('[snapshot] upsert: optional columns missing on DB, falling back to legacy projection (run the migration to enable structured identity)');
      const legacyRows = rows.map(function(r) {
        const copy = Object.assign({}, r);
        delete copy.canonical_market_key;
        delete copy.canonical_selection_key;
        delete copy.market_type;
        delete copy.player_name;
        delete copy.player_name_normalized;
        delete copy.prop_type;
        delete copy.prop_type_normalized;
        delete copy.prop_side;
        delete copy.player_team;
        delete copy.provider_game_id;
        return copy;
      });
      try {
        const { error: legacyErr } = await sb.from('odds_snapshots').upsert(legacyRows,
          { onConflict:'canonical_game_key,market_key,selection_key' });
        if (legacyErr) throw legacyErr;
        console.log('[snapshot] upserted '+legacyRows.length+' odds snapshots (legacy projection)');
        return;
      } catch(e2) {
        console.warn(_fmtSnapshotErr('SNAPSHOT_UPSERT_ERR legacy', e2, legacyRows));
        return;
      }
    }
    // Non-canonical error path (e.g. PGRST204 schema cache, 23505 unique
    // violation, 42P10 conflict-target mismatch). Already logged above via
    // _fmtSnapshotErr; nothing else to retry without code change.
    void code;
  }
}

// Phase L: fail-closed odds verification
// Production: any error → odds_service_unavailable (never use client odds)
// Dev+bypass: warn and fall back to client odds
async function _verifyLegOddsSnapshot(sb, leg, nowMs, oddsChangePolicy) {
  nowMs = nowMs||Date.now();
  const cKey   = leg.canonicalGameKey||'';
  const market = (leg.market||'moneyline').toLowerCase();
  const pick   = (leg.pick||'').toLowerCase();
  const bypassOk = !IS_PRODUCTION || DEV_AUTH_BYPASS;
  let snap = null;

  // ----- Canonical identity (priority #11) -----
  // Normalize the incoming leg into structured identity. For props this
  // sniffs the legacy {market:'total', isPlayerProp:true} shape and upgrades
  // it to {marketType:'player_prop', canonicalMarketKey, canonicalSelectionKey}.
  const ident = _normalizeLegIdentity(leg) || {};
  const cmk = ident.canonicalMarketKey || null;
  const csk = ident.canonicalSelectionKey || null;

  // Tier 1: canonical lookup. Skipped when we can't build a structured key
  // (e.g. legacy leg with too little data) — we'll fall back to legacy below.
  if (cmk && csk) {
    try {
      const { data, error } = await sb.from('odds_snapshots').select('*')
        .eq('canonical_market_key',cmk)
        .eq('canonical_selection_key',csk)
        .limit(1);
      if (error) throw error;
      if (data && data[0]) {
        snap = data[0];
        if (ident.marketType === MARKET_TYPES.PLAYER_PROP) {
          // eslint-disable-next-line no-console
          console.log(`PROP_SNAPSHOT_MATCH gameKey=${ident.gameKey} player=${_normalizePlayerName(ident.playerName||'')} propType=${_normalizePropType(ident.propType||'')} side=${(ident.side||'').toLowerCase()} line=${ident.line!=null?ident.line:'?'} via=canonical`);
        } else {
          // Non-prop canonical match — same shape as the prop log so Railway
          // grep + downstream tooling can index a single SNAPSHOT_MATCH stem.
          // eslint-disable-next-line no-console
          console.log(`SNAPSHOT_MATCH via=canonical marketType=${ident.marketType||'?'} canonicalMarketKey=${cmk} canonicalSelectionKey=${csk}`);
        }
      }
    } catch(dbErr) {
      // 42703 = column not found. Old DB, no canonical columns. Silent
      // fallback to legacy lookup below.
      const msg = (dbErr && dbErr.message) || '';
      if (!/canonical_market_key|canonical_selection_key/.test(msg)) {
        console.warn('[snapshot] canonical lookup error:', msg);
      }
    }
  }

  // Tier 2: legacy lookup by (canonical_game_key, market_key, selection_key).
  // This is the original code path — keeps existing snapshots discoverable
  // until the canonical columns are populated everywhere.
  if (!snap) {
    try {
      const { data, error } = await sb.from('odds_snapshots').select('*')
        .eq('canonical_game_key',cKey).eq('market_key',market).eq('selection_key',pick)
        .limit(1);
      if (error) throw error;
      snap = data&&data[0]||null;
      if (snap) {
        if (ident.marketType === MARKET_TYPES.PLAYER_PROP) {
          // eslint-disable-next-line no-console
          console.log(`PROP_SNAPSHOT_MATCH gameKey=${ident.gameKey} player=${_normalizePlayerName(ident.playerName||'')} propType=${_normalizePropType(ident.propType||'')} side=${(ident.side||'').toLowerCase()} line=${ident.line!=null?ident.line:'?'} via=legacy`);
        } else {
          // Non-prop legacy match — echoes the legacy column trio the
          // verifier used (canonical_game_key + market_key + selection_key).
          // eslint-disable-next-line no-console
          console.log(`SNAPSHOT_MATCH via=legacy marketType=${ident.marketType||'?'} marketKey=${market} selectionKey=${pick}`);
        }
      }
    } catch(dbErr) {
      console.warn('[snapshot] DB error:', dbErr.message, 'leg='+leg.pick);
      if (bypassOk) {
        console.warn('[snapshot] DEV FALLBACK — using client odds (production would reject)');
        return { ok:true, devFallback:true, warn:'snapshot_db_error',
                 acceptedOddsAmerican:parseInt(leg.odds,10)||0,
                 acceptedOddsDecimal:null };
      }
      return { ok:false, code:'odds_service_unavailable', reason:'db_error', leg:leg.pick };
    }
  }

  // Snapshot not found via either tier
  if (!snap) {
    if (ident.marketType === MARKET_TYPES.PLAYER_PROP) {
      // eslint-disable-next-line no-console
      console.log(`PROP_SNAPSHOT_MISS gameKey=${ident.gameKey} player=${_normalizePlayerName(ident.playerName||'')} propType=${_normalizePropType(ident.propType||'')} side=${(ident.side||'').toLowerCase()} line=${ident.line!=null?ident.line:'?'} cmk=${cmk||'-'} csk=${csk||'-'}`);
    }
    if (bypassOk) {
      console.warn('[snapshot] MISSING — DEV FALLBACK for', leg.pick);
      return { ok:true, devFallback:true, warn:'odds_snapshot_missing',
               acceptedOddsAmerican:parseInt(leg.odds,10)||0, acceptedOddsDecimal:null };
    }
    return { ok:false, code:'odds_service_unavailable', reason:'snapshot_missing', leg:leg.pick };
  }

  // Market state classification
  const state = _classifyMarket(snap, nowMs);
  if (state === 'stale') {
    if (bypassOk) {
      console.warn('[snapshot] STALE — DEV FALLBACK for', leg.pick);
      return { ok:true, devFallback:true, warn:'odds_stale',
               acceptedOddsAmerican:snap.odds_american, acceptedOddsDecimal:parseFloat(snap.odds_decimal) };
    }
    const ageMs = nowMs - new Date(snap.fetched_at).getTime();
    return { ok:false, code:'odds_stale', leg:leg.pick, ageMs };
  }
  // Hard blocks — game is over or market is unavailable. Live is allowed.
  if (state === 'final')
    return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'game_final' };
  if (state === 'canceled')
    return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'game_canceled' };
  if (state === 'suspended')
    return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'suspended' };
  // 'active' and 'live' both allow placement — fall through to odds drift check below.

  // Odds drift check
  const submittedOdds = parseInt(leg.odds,10);
  const serverOdds    = snap.odds_american;
  const drift         = !isNaN(submittedOdds) ? Math.abs(submittedOdds-serverOdds) : 0;
  if (!isNaN(submittedOdds) && drift > SNAPSHOT_TOLERANCE) {
    const policy = oddsChangePolicy||'reject';
    if (policy==='accept_any_with_confirm') { /* allow with changed flag */ }
    else if (policy==='accept_better') {
      if (serverOdds <= submittedOdds)
        return { ok:false, code:'odds_changed', leg:leg.pick, submittedOdds, serverOdds, drift };
    } else {
      return { ok:false, code:'odds_changed', leg:leg.pick, submittedOdds, serverOdds, drift };
    }
  }

  return {
    ok:true,
    snapshotId:           snap.snapshot_id,
    acceptedOddsAmerican: serverOdds,
    acceptedOddsDecimal:  parseFloat(snap.odds_decimal),
    acceptedPointLine:    snap.point_line!=null?parseFloat(snap.point_line):null,
    commenceTime:         snap.commence_time
  };
}

// Classify a snapshot into a market state.
//   active        → placement allowed (covers pregame AND live)
//   live          → placement allowed (informational subtype of active)
//   suspended     → BLOCK (provider paused the market)
//   final         → BLOCK (game completed/settled)
//   canceled      → BLOCK (game canceled/postponed/abandoned)
//   stale         → BLOCK (snapshot too old to trust)
function _classifyMarket(snap, nowMs) {
  nowMs = nowMs||Date.now();
  if (!snap) return 'suspended';
  const ageMs = nowMs - new Date(snap.fetched_at||snap.fetchedAt).getTime();
  if (ageMs > SNAPSHOT_TTL_MS) return 'stale';
  // Hard blocks first — final/canceled/suspended come from provider, not from the clock.
  const evStatus = String(snap.event_status||snap.eventStatus||snap.gameStatus||'').toLowerCase();
  const mkStatus = String(snap.market_status||snap.marketStatus||'').toLowerCase();
  if (snap.eventCompleted === true || evStatus === 'final' || evStatus === 'completed' ||
      mkStatus === 'final' || mkStatus === 'closed' || mkStatus === 'settled')
    return 'final';
  if (snap.eventCanceled === true || evStatus === 'canceled' || evStatus === 'cancelled' ||
      evStatus === 'postponed' || evStatus === 'abandoned')
    return 'canceled';
  if (snap.suspended === true || mkStatus === 'suspended' || mkStatus === 'paused')
    return 'suspended';
  // Live and pregame both allow placement.
  if (snap.eventLive === true || evStatus === 'live' || evStatus === 'in_play' || evStatus === 'in_progress')
    return 'live';
  const ct = snap.commence_time||snap.commenceTime;
  if (ct) { const ms=new Date(ct).getTime(); if(!isNaN(ms)&&nowMs>=ms) return 'live'; }
  return 'active';
}

// Recalculate payout server-side from snapshots (Phase L: fail-closed)
async function _recalcPayoutFromSnapshots(sb, stake, legs, nowMs, oddsChangePolicy) {
  let product = 1;
  const enrichedLegs = [];
  for (let i=0; i<legs.length; i++) {
    const vr = await _verifyLegOddsSnapshot(sb, legs[i], nowMs, oddsChangePolicy);
    // vr is never null now (fail-closed returns error objects)
    if (!vr.ok) return Object.assign(vr, { legIndex:i });
    // Dev fallback: log clearly, product uses submitted odds
    const usedDecimal = vr.acceptedOddsDecimal ||
      (vr.acceptedOddsAmerican > 0
        ? vr.acceptedOddsAmerican/100+1
        : 100/Math.abs(vr.acceptedOddsAmerican||110)+1);
    product *= usedDecimal;
    enrichedLegs.push(Object.assign({}, legs[i], {
      accepted_odds_american: vr.acceptedOddsAmerican,
      accepted_odds_decimal:  vr.acceptedOddsDecimal,
      accepted_point_line:    vr.acceptedPointLine||null,
      odds_snapshot_id:       vr.snapshotId||null,
      accepted_at:            new Date(nowMs).toISOString(),
      dev_fallback:           vr.devFallback||false
    }));
  }
  const payout = Math.round(stake*product*100)/100;
  const profit = Math.round((payout-stake)*100)/100;
  return { ok:true, payout, profit, legs:enrichedLegs };
}

// Wire snapshot upsert into live cache poll
const _origPoll = pollLiveOddsLoop;
const pollLiveOddsLoopWithSnapshots = async function() {
  await _origPoll();
  _upsertOddsSnapshots().catch(()=>{});
};
// Re-register poller with snapshot write.
// Live betting (DK-style) wants 15s refresh so price/score updates feel
// real-time. Allow env override via LIVE_ODDS_POLL_MS for ops tuning.
const LIVE_CACHE_POLL_INTERVAL_MS = parseInt(process.env.LIVE_ODDS_POLL_MS,10) || 15 * 1000;
const CACHE_POLL_INTERVAL = LIVE_CACHE_POLL_INTERVAL_MS; // backwards-compat alias
if (ODDS_KEY || (ODDS_PROVIDER === 'owls_insight' && OWLS_KEY))
  setInterval(pollLiveOddsLoopWithSnapshots, LIVE_CACHE_POLL_INTERVAL_MS);

// ───────────────────────────────────────────────────────────────────────────

// ── RISK LIMITS ENGINE ───────────────────────────────────────────────────────────────────────
const RISK_CODE_STATUS = {
  player_suspended:         403,
  stake_below_min:          422,
  stake_above_max:          422,
  payout_above_max:         422,
  parlays_disabled:         422,
  teasers_disabled:         422,
  round_robins_disabled:    422,
  too_many_parlay_legs:     422,
  sport_blocked:            422,
  sport_not_allowed:        422,
  market_blocked:           422,
  live_betting_disabled:    422,
  player_open_risk_exceeded:422,
  club_open_risk_exceeded:  422,
  event_risk_exceeded:      422,
  market_risk_exceeded:     422
};

// JS-side risk check (runs before RPC, using cached limits + live exposure query)
async function _checkRiskLimitsJs(sb, clubId, playerId, params) {
  const { stake, potentialPayout, betType, legs } = params;
  const nowMs = Date.now();
  let pl = {}, cs = {};
  try {
    const { data:plData } = await sb.from('player_limits').select('*')
      .eq('club_id',clubId).eq('player_id',playerId).limit(1);
    if (plData&&plData[0]) pl = plData[0];
  } catch(_e){}
  try {
    const { data:csData } = await sb.from('club_risk_settings').select('*')
      .eq('club_id',clubId).limit(1);
    if (csData&&csData[0]) cs = csData[0];
  } catch(_e){}

  const s   = parseFloat(stake)||0;
  const pay = parseFloat(potentialPayout)||0;
  const type= (betType||'').toLowerCase();
  const legsArr = legs||[];

  // Player suspended
  if (pl.suspended_until && nowMs < new Date(pl.suspended_until).getTime())
    return { ok:false, code:'player_suspended', suspendedUntil:pl.suspended_until };

  // Stake bounds
  if (cs.min_stake && s < parseFloat(cs.min_stake))
    return { ok:false, code:'stake_below_min', min:cs.min_stake, stake:s };
  if (cs.max_stake && s > parseFloat(cs.max_stake))
    return { ok:false, code:'stake_above_max', max:cs.max_stake, stake:s, source:'club_settings' };
  if (pl.max_single_bet && s > parseFloat(pl.max_single_bet))
    return { ok:false, code:'stake_above_max', max:pl.max_single_bet, stake:s, source:'player_limit' };

  // Payout cap
  const maxPayout = Math.min(
    parseFloat(cs.max_payout)||999999,
    parseFloat(pl.max_payout)||999999
  );
  if (pay > maxPayout)
    return { ok:false, code:'payout_above_max', max:maxPayout, payout:pay };

  // Bet type gates
  if ((type==='parlay'||type==='roundrobin') && cs.allow_parlays===false)
    return { ok:false, code:'parlays_disabled' };
  if (type==='teaser' && cs.allow_teasers===false)
    return { ok:false, code:'teasers_disabled' };
  if (type==='roundrobin' && cs.allow_round_robins===false)
    return { ok:false, code:'round_robins_disabled' };
  if ((type==='parlay'||type==='roundrobin') && cs.max_parlay_legs && legsArr.length > cs.max_parlay_legs)
    return { ok:false, code:'too_many_parlay_legs', max:cs.max_parlay_legs, legs:legsArr.length };

  // Per-leg sport/market/live checks
  for (let i=0; i<legsArr.length; i++) {
    const leg = legsArr[i];
    const sport  = (leg.sport||'').toLowerCase();
    const market = (leg.market||'moneyline').toLowerCase();
    if (cs.blocked_sports && cs.blocked_sports.includes(sport))
      return { ok:false, code:'sport_blocked', sport, legIndex:i, source:'club_settings' };
    if (pl.blocked_sports && pl.blocked_sports.includes(sport))
      return { ok:false, code:'sport_blocked', sport, legIndex:i, source:'player_limit' };
    if (cs.blocked_markets && cs.blocked_markets.includes(market))
      return { ok:false, code:'market_blocked', market, legIndex:i, source:'club_settings' };
    if (pl.blocked_markets && pl.blocked_markets.includes(market))
      return { ok:false, code:'market_blocked', market, legIndex:i, source:'player_limit' };
    if (pl.allowed_sports && !pl.allowed_sports.includes(sport))
      return { ok:false, code:'sport_not_allowed', sport, legIndex:i };
    if (cs.allow_live_betting===false && leg.isLive)
      return { ok:false, code:'live_betting_disabled', legIndex:i };
  }

  // Player open risk
  if (pl.max_open_risk) {
    try {
      const { data } = await sb.from('tickets').select('risk_amount')
        .eq('club_id',clubId).eq('player_id',playerId).in('status',['active','open']);
      const cur = (data||[]).reduce(function(acc,t){ return acc+parseFloat(t.risk_amount||0); },0);
      if (cur + s > parseFloat(pl.max_open_risk))
        return { ok:false, code:'player_open_risk_exceeded',
                 max:pl.max_open_risk, current:cur, stake:s };
    } catch(_e){}
  }

  return { ok:true };
}
// ───────────────────────────────────────────────────────────────────────────

// Call a Postgres money RPC (place_bet_tx, cancel_bet_tx, etc.)
async function _callMoneyRpc(rpcName, params) {
  const sb = getSupabase();
  if (!sb) throw new Error('supabase_not_configured');
  const { data, error } = await sb.rpc(rpcName, params);
  if (error) {
    _rpcFailCount++;
    if (error.code==='23505') return { ok:false, error:'duplicate_ledger_entry' };
    if (error.message&&error.message.includes('insufficient_balance'))
      return { ok:false, error:'insufficient_balance' };
    if (error.message&&error.message.includes('invalid_transition'))
      return { ok:false, error:'invalid_transition', detail:error.message };
    logEvent('error','rpc_failure',{ rpcName, code:error.code, msg:error.message });
    throw error;
  }
  return data || { ok:false, error:'rpc_no_response' };
}

// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY ENGINE
// ════════════════════════════════════════════════════════════════════════════

const KEY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// In-memory fallback when Supabase is unavailable
const _idemMemStore = new Map();

function _sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(_sortKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc,k) => { acc[k]=_sortKeys(obj[k]); return acc; }, {});
  }
  return obj;
}

function _hashRequest(endpoint, actorId, clubId, body) {
  const canonical = JSON.stringify({ endpoint, actorId, clubId:clubId||'', body:_sortKeys(body||{}) });
  return require('crypto').createHash('sha256').update(canonical).digest('hex').slice(0,32);
}

// Load an idempotency record (DB first, memory fallback)
async function _idemLoad(key) {
  try {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('idempotency_keys').select('*').eq('idempotency_key',key).limit(1);
      if (data && data[0]) return data[0];
    }
  } catch(_e) {}
  return _idemMemStore.get(key) || null;
}

// Save an idempotency record
async function _idemSave(row) {
  try {
    const sb = getSupabase();
    if (sb) await sb.from('idempotency_keys').upsert(row, { onConflict:'idempotency_key' });
  } catch(_e) {}
  _idemMemStore.set(row.idempotency_key, row); // always update memory
}

// Core: check and reserve (or replay)
async function _idemCheck(key, endpoint, actorId, clubId, body) {
  if (!key) return { action:'execute', warn:'no_idempotency_key' };
  const reqHash = _hashRequest(endpoint, actorId, clubId, body);
  const nowMs   = Date.now();
  const existing = await _idemLoad(key);

  if (!existing) {
    // Reserve as pending
    const row = {
      idempotency_key:key, actor_id:actorId, club_id:clubId||'', endpoint,
      request_hash:reqHash, status:'pending',
      response_status:null, response_body:null,
      created_at:new Date(nowMs).toISOString(),
      completed_at:null,
      expires_at:new Date(nowMs+KEY_TTL_MS).toISOString()
    };
    await _idemSave(row);
    return { action:'execute', row };
  }

  // Expired?
  if (existing.expires_at && nowMs > new Date(existing.expires_at).getTime()) {
    console.log('[idem] key expired, re-executing:', key);
    return { action:'execute', warn:'key_expired_reused' };
  }

  // Actor/club/hash conflicts
  if (existing.actor_id !== actorId)
    return { action:'conflict', reason:'actor_mismatch', status:409 };
  if (existing.club_id !== (clubId||''))
    return { action:'conflict', reason:'club_mismatch', status:409 };
  if (existing.request_hash !== reqHash)
    return { action:'conflict', reason:'body_mismatch', status:409 };

  if (existing.status === 'pending')
    return { action:'in_progress', status:409, existingRow:existing };

  // Completed or failed — replay
  console.log('[idem] replaying key='+key+' status='+existing.status+
    ' responseStatus='+existing.response_status);
  return { action:'replay', existingRow:existing };
}

// Mark completed after execution
async function _idemComplete(key, responseStatus, responseBody) {
  const existing = await _idemLoad(key);
  if (!existing) return;
  const row = Object.assign({}, existing, {
    status: (responseStatus >= 200 && responseStatus < 300) ? 'completed' : 'failed',
    response_status: responseStatus,
    response_body: responseBody,
    completed_at: new Date().toISOString()
  });
  await _idemSave(row);
}

// Express middleware factory: enforce idempotency for money endpoints
function requireIdempotency(opts) {
  return async function(req, res, next) {
    const key = (req.headers['idempotency-key'] || '').trim() ||
                (req.body && req.body.idempotencyKey) || null;
    if (!key && opts && opts.required) {
      return res.status(400).json({ ok:false, error:'missing_idempotency_key',
        hint:'Include Idempotency-Key header or idempotencyKey in body' });
    }
    if (!key) return next(); // optional endpoints skip

    const actor  = req._actor || {};
    const clubId = req._clubId || '';
    const result = await _idemCheck(key, req.path, actor.actorId||'anon', clubId, req.body);

    if (result.action === 'replay') {
      const stored = result.existingRow;
      console.log('[idem] REPLAY key='+key+' endpoint='+req.path);
      return res.status(stored.response_status||200).json(stored.response_body);
    }
    if (result.action === 'conflict') {
      console.log('[idem] CONFLICT key='+key+' reason='+result.reason);
      return res.status(409).json({ ok:false, error:'idempotency_conflict', reason:result.reason });
    }
    if (result.action === 'in_progress') {
      return res.status(409).json({ ok:false, error:'request_in_progress',
        hint:'Identical request is being processed. Retry after 2s.' });
    }

    // Store key for completion after handler
    req._idemKey = key;
    // Monkey-patch res.json to auto-complete idempotency after response
    const _origJson = res.json.bind(res);
    res.json = function(body) {
      _idemComplete(key, res.statusCode||200, body).catch(()=>{});
      return _origJson(body);
    };
    next();
  };
}

// Supabase migration DDL for idempotency_keys table (for reference/docs)
const IDEMPOTENCY_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key  TEXT PRIMARY KEY,
  actor_id         TEXT NOT NULL,
  club_id          TEXT NOT NULL DEFAULT '',
  endpoint         TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  response_status  INTEGER,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at ON idempotency_keys(expires_at);
`;

// ════════════════════════════════════════════════════════════════════════════

function _safeClubId(req) {
  if (req._clubId !== undefined) return req._clubId;
  return (req.body && req.body.clubId) || (req.query && req.query.clubId) || null;
}

function requirePermissionScoped(action, getTargetPlayerId) {
  return async function(req, res, next) {
    let actor = requireActor(req);
    // ── Entry trace: log raw actor immediately after requireActor ─────────────
    console.log('[auth] RPS_ENTRY action='+action
      + ' actor.error='       + (actor.error       || 'none')
      + ' actor.actorId='     + (actor.actorId      || '?')
      + ' actor.clubId="'     + (actor.clubId        || '') + '"'
      + ' actor.legacyToken=' + (actor.legacyToken   || false)
      + ' actor.isDevBypass=' + (actor.isDevBypass   || false)
      + ' actor.fromToken='   + (actor.fromToken     || false)
      + ' reqClub_header='    + (req.headers['x-club-id']||'(none)')
      + ' body.clubId='       + ((req.body && req.body.clubId)||'(none)'));

    // ── Legacy token async membership resolution ──────────────────────────────
    // Tokens from /api/auth/login carry {id,email,role:'user'} with no clubId.
    // requireActor is sync so it tags these as legacyToken=true.
    // We resolve membership here where we can safely await.
    // Gate: legacy token tagged, OR any actor with empty clubId + a requested club
    // (covers: IS_PRODUCTION=true + jti check blocked tag, or other auth paths)
    if (!actor.error && (actor.legacyToken || (!actor.clubId && !actor.isDevBypass))) {
      const _reqClub = actor.reqClub || (req.body && req.body.clubId) || (req.query && req.query.clubId) || (req.headers['x-club-id']||'').trim() || '';
      const _legacyId = actor.actorId;
      console.log('[auth] LEGACY_MEMBERSHIP_LOOKUP actor='+_legacyId+' reqClub='+_reqClub+' action='+action);
      let _legacyMem = null;
      if (_reqClub) {
        try {
          const _sb = getSupabase();
          if (_sb) {
            // club_memberships schema: actor_id text, club_id text, role text, status text
            // Query: match club_id exactly, then find by actor_id (string AND numeric forms)
            const _numId = parseInt(_legacyId, 10);
            // Try string actor_id first (most common)
            let _md = null;
            const _r1 = await _sb.from('club_memberships')
              .select('actor_id,club_id,role,status')
              .eq('club_id', _reqClub)
              .eq('actor_id', _legacyId)
              .limit(1);
            if (_r1.data && _r1.data[0]) {
              _md = _r1.data[0];
            } else if (!isNaN(_numId)) {
              // Try numeric form
              const _r2 = await _sb.from('club_memberships')
                .select('actor_id,club_id,role,status')
                .eq('club_id', _reqClub)
                .eq('actor_id', String(_numId))
                .limit(1);
              _md = _r2.data && _r2.data[0] ? _r2.data[0] : null;
            }
            console.log('[auth] MEMBERSHIP_QUERY found='+(!!_md)+(_md?' status='+_md.status+' role='+_md.role:''));
            _legacyMem = _md || null;
          }
        } catch(_me) { console.warn('[auth] legacy membership lookup error:', _me.message); }
      }
      if (!_reqClub || !_legacyMem) {
        const _reason = !_reqClub ? 'missing_clubId' : 'membership_not_found';
        console.log('[auth] LEGACY_MEMBERSHIP_REJECT actor='+_legacyId+' reqClub='+(_reqClub||'(none)')+' reason='+_reason);
        _writeAuthAudit(_reason, _legacyId, _reqClub, req.path);
        return res.status(403).json({ ok:false, error:_reason,
          hint:'token has no clubId claim; '+(_reqClub?'no approved membership found in club':'no clubId in request') });
      }
      if (_legacyMem.status !== 'active' && _legacyMem.status !== 'approved') {
        console.log('[auth] LEGACY_MEMBERSHIP_REJECT actor='+_legacyId+' status='+_legacyMem.status);
        _writeAuthAudit('membership_inactive', _legacyId, _reqClub, req.path, { status:_legacyMem.status });
        return res.status(403).json({ ok:false, error:'membership_inactive', membershipStatus:_legacyMem.status });
      }
      const _LEGACY_ROLE_MAP = { host:'full_admin', admin:'full_admin', cohost:'settlement_manager', staff:'risk_viewer' };
      const _rawRole = _legacyMem.role || 'player';
      const _mapped  = _LEGACY_ROLE_MAP[_rawRole] || _rawRole;
      const _dbRole  = ROLE_RANK[_mapped] != null ? _mapped : 'player';
      console.log('[auth] LEGACY_MEMBERSHIP_OK actor='+_legacyId+' reqClub='+_reqClub+' dbRole='+_dbRole+' status='+_legacyMem.status);
      actor = Object.assign({}, actor, { role:_dbRole, clubId:String(_reqClub), membershipVerified:true });
      req._legacyMembership = _legacyMem;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Club scope: derive from token; check against body/query value (must match)
    const requestedClubId = (req.body && req.body.clubId) || (req.query && req.query.clubId) || null;
    console.log('BACKEND_CLUB_SCOPE_CHECK'
      + ' request.clubId='  + (requestedClubId   || '(none)')
      + ' actor.clubId='    + (actor && actor.clubId    || '(none)')
      + ' actor.actorId='   + (actor && actor.actorId   || '?')
      + ' path='            + req.path);
    const scope = _checkClubScope(actor, requestedClubId);
    if (!scope.ok) {
      console.log('[auth] CLUB_SCOPE_MISMATCH requestedClub='+(requestedClubId||'?')+' action='+action);
      console.log('BACKEND_CLUB_SCOPE'
        + ' request.clubId='   + (requestedClubId   || '(none)')
        + ' actor.role='       + (actor.role         || '?')
        + ' path='             + req.path
        + ' mismatch=YES');
      _writeAuthAudit('club_scope_mismatch', actor.actorId, actor.clubId, req.path,
        { requestedClubId, action, role:actor.role });
      // ── DIAGNOSTIC v4: full actor state at the moment of 403 ──────────────
      console.error('[auth] CSM_RETURN_v4'
        + ' buildMarker=legacy-auth-fix-v4-jwt-fallback'
        + ' actor.error='          + (actor.error         || 'none')
        + ' actor.actorId='        + (actor.actorId        || '?')
        + ' actor.clubId="'        + (actor.clubId         || '') + '"'
        + ' actor.legacyToken='    + (actor.legacyToken    || false)
        + ' actor.membershipVerified=' + (actor.membershipVerified || false)
        + ' actor.isDevBypass='    + (actor.isDevBypass    || false)
        + ' actor.fromToken='      + (actor.fromToken      || false)
        + ' actor.role='           + (actor.role           || '?')
        + ' requestedClubId='      + (requestedClubId      || '(none)')
        + ' action='               + action
        + ' path='                 + req.path
        + ' authHeader_prefix='    + ((req.headers['authorization']||'').slice(0,20))
        + ' x-club-id='            + (req.headers['x-club-id']||'(none)')
        + ' body.clubId='          + ((req.body && req.body.clubId) || '(none)'));
      return res.status(403).json({ ok:false, error:'club_scope_mismatch',
        actorClubId:actor.clubId, requestedClubId, action,
        hint:'token_club_must_match_payload_clubId' });
    }
    // Permission check (role)
    const targetId = typeof getTargetPlayerId === 'function'
      ? getTargetPlayerId(req) : (req.body && req.body.playerId) || (req.query && req.query.playerId);
    const perm = _checkPermission(actor, action, targetId);
    if (!perm.allowed) {
      console.log('[auth] DENIED role='+(actor.role||'?')+
        ' action='+action+' reason='+perm.reason);
      _writeAuthAudit('permission_denied', actor.actorId, actor.clubId, req.path,
        { action, role:actor.role, reason:perm.reason, required:perm.required, requestedClubId });
      return res.status(perm.status||403).json({ ok:false, error:'permission_denied',
        reason:perm.reason, required:perm.required, actual:perm.actual });
    }
    // Stamp canonical clubId onto req for handler use
    req._actor  = actor;
    req._clubId = _deriveClubId(actor, req);
    if (actor.isDevBypass) console.log('[auth] DEV BYPASS passthrough action='+action);
    // Audit sensitive grants
    const SENSITIVE = new Set(['settle_player','weekly_rollover','run_server_grade',
                                'grade_trigger','force_market_refresh']);
    if (SENSITIVE.has(action) && !actor.isDevBypass) {
      _writeAuthAudit('permission_granted', actor.actorId, actor.clubId, req.path,
        { action, role:actor.role, fromToken:!!actor.fromToken, requestedClubId });
    }
    next();
  };
}

// Check permission for action; targetPlayerId for player-self actions
function _checkPermission(actor, action, targetPlayerId) {
  if (actor.error) return { allowed:false, reason:actor.error, status:actor.status||401 };
  const minRank = ACTION_MIN_RANK[action];
  if (minRank == null) return { allowed:false, reason:'unknown_action:'+action };
  const rank = _getRoleRank(actor.role);
  if (minRank === -1) {
    const isSelf       = targetPlayerId && String(actor.actorId) === String(targetPlayerId);
    // owner/host can place bets as themselves (same club) — playerCapable = rank >= owner
    const isPrivileged = rank >= ROLE_RANK.full_admin;
    const isPlayerCapable = rank >= ROLE_RANK.owner; // owner can place test bets
    if (!isSelf && !isPrivileged && !isPlayerCapable) {
      return { allowed:false, reason:'not_own_account', status:403 };
    }
    return { allowed:true };
  }
  if (rank < minRank) {
    return {
      allowed:false, reason:'insufficient_role', status:403,
      required: Object.keys(ROLE_RANK).find(r => ROLE_RANK[r] === minRank),
      actual: actor.role
    };
  }
  return { allowed:true };
}

// Express middleware factory: enforces permission, writes audit on deny.
// Reassigns the placeholder declared above.
requirePermission = function(action, getTargetPlayerId) {
  return async function(req, res, next) {
    const actor = requireActor(req);
    const targetId = typeof getTargetPlayerId === 'function'
      ? getTargetPlayerId(req) : (req.body && req.body.playerId) || (req.query && req.query.playerId);
    const perm = _checkPermission(actor, action, targetId);
    if (!perm.allowed) {
      console.log('[auth] DENIED role='+(actor.role||'?')+' action='+action+' reason='+perm.reason);
      // Write audit event (fire-and-forget)
      try {
        const sb = getSupabase();
        if (sb) sb.from('audit_events').insert({
          event_type:'permission_denied',
          player_id: actor.actorId||null, club_id: actor.clubId||null,
          payload:{ actorId:actor.actorId, role:actor.role, action, endpoint:req.path,
                    reason:perm.reason, required:perm.required }
        }).then(()=>{}).catch(()=>{});
      } catch(_e){}
      return res.status(perm.status||403).json({
        ok:false, error:'permission_denied',
        reason:perm.reason, required:perm.required, actual:perm.actual
      });
    }
    req._actor = actor;
    if (actor.isDevBypass) console.log('[auth] DEV BYPASS passthrough action='+action);
    // Audit granted access for sensitive mutations
    const SENSITIVE = new Set(['settle_player','weekly_rollover','run_server_grade','grade_trigger','force_market_refresh']);
    if (SENSITIVE.has(action) && !actor.isDevBypass) {
      try {
        const sb = getSupabase();
        if (sb) sb.from('audit_events').insert({
          event_type:'permission_granted',
          player_id: actor.actorId||null, club_id: actor.clubId||null,
          payload:{ actorId:actor.actorId, role:actor.role, action, endpoint:req.path, fromToken:!!actor.fromToken }
        }).then(()=>{}).catch(()=>{});
      } catch(_e){}
    }
    next();
  };
}

// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// LIVE MARKET CACHE ENGINE
// Single source of truth for all odds data on this server instance.
// Atomic replace only — never partially mutated.
// ════════════════════════════════════════════════════════════════════════════

const ODDS_TOLERANCE_PTS  = 3;
const CACHE_STALE_THRESHOLD = 5 * 60 * 1000; // 5min stale threshold
// Sports the live-odds poller actually fetches. Owls polls use these keys;
// the Odds API legacy path also accepts them. When ODDS_PROVIDER=owls_insight,
// we expand to every sport listed in OWLS_SAFE_SPORTS (mapped to the canonical
// Odds-API-style key for downstream consistency).
const _CACHE_SPORTS_BASE = ['baseball_mlb','basketball_nba','americanfootball_nfl','icehockey_nhl'];
const _CACHE_SPORT_KEY_BY_SHORT = {
  // US major
  mlb:'baseball_mlb', nba:'basketball_nba', wnba:'basketball_wnba',
  nfl:'americanfootball_nfl', nhl:'icehockey_nhl',
  // US college
  ncaab:'basketball_ncaab', ncaaf:'americanfootball_ncaaf', ncaabaseball:'baseball_ncaa',
  // Combat
  mma:'mma_mixed_martial_arts', boxing:'boxing_boxing',
  // Motorsports
  nascar:'nascar', f1:'formula1',
  // Soccer competitions — all share the unified-odds 'soccer' provider path
  soccer:'soccer',
  soccer_epl:'soccer_epl', soccer_ucl:'soccer_uefa_champs_league',
  soccer_mls:'soccer_usa_mls', soccer_worldcup:'soccer_fifa_world_cup',
  soccer_euros:'soccer_uefa_european_championship',
  soccer_laliga:'soccer_spain_la_liga', soccer_seriea:'soccer_italy_serie_a',
  soccer_bundesliga:'soccer_germany_bundesliga', soccer_ligue1:'soccer_france_ligue_one',
  // Other international team
  cricket:'cricket', cricket_ipl:'cricket_ipl', cricket_t20:'cricket_international_t20',
  rugby:'rugbyunion_six_nations', rugby_league:'rugbyleague', afl:'aussierules_afl',
  // Individual
  tennis:'tennis', tennis_atp:'tennis_atp', tennis_wta:'tennis_wta',
  golf_pga:'golf_pga_championship', golf_liv:'golf_liv', golf_european:'golf_european_tour',
  table_tennis:'table_tennis',
  // Esports
  cs2:'cs2', valorant:'valorant', lol:'lol', dota2:'dota2', rocketleague:'rocketleague'
};
const CACHE_SPORTS = (ODDS_PROVIDER === 'owls_insight')
  ? OWLS_SAFE_SPORTS.map(function(s){ return _CACHE_SPORT_KEY_BY_SHORT[s] || s; })
  : _CACHE_SPORTS_BASE;

function _sportPrefix(sportKey) {
  const k = (sportKey||'').toLowerCase();
  if (k.startsWith('baseball'))             return 'MLB';
  if (k.startsWith('basketball_nba'))       return 'NBA';
  if (k.startsWith('americanfootball_nfl')) return 'NFL';
  if (k.startsWith('icehockey'))            return 'NHL';
  if (k.startsWith('soccer'))               return 'SOCCER';
  return k.split('_')[0].toUpperCase();
}
function _normalizeMarketKey(key) {
  return key === 'h2h' ? 'moneyline' : key === 'spreads' ? 'spread' : key === 'totals' ? 'total' : key;
}
function _buildCKeyFromGame(game) {
  const sport    = _sportPrefix(game.sport_key);
  const awayTeam = (game.away_team||'').toLowerCase().replace(/\s+/g,'-');
  const homeTeam = (game.home_team||'').toLowerCase().replace(/\s+/g,'-');
  const dateStr  = (game.commence_time||'').slice(0,10);
  return sport+'|'+awayTeam+'|'+homeTeam+'|'+dateStr;
}

function _makeEmptyCache() {
  return {
    updatedAt:null, lastSuccessAt:null, games:[], marketsByCanonicalKey:{},
    marketsByProviderGameId:{}, gameCount:0, marketCount:0,
    fetchDurationMs:null, sourceStatus:'empty', warnings:[]
  };
}

// Derive 3-state game status from a normalized game record (Odds API or Owls flat).
function _deriveGameStatus(game) {
  if (!game) return 'upcoming';
  // Explicit status wins
  var s = String(game.status || game.state || game.event_status || '').toLowerCase();
  if (game.completed === true || /^(final|complete|completed|ended|closed|settled)$/.test(s)) return 'final';
  if (game.canceled === true || game.cancelled === true ||
      /^(canceled|cancelled|abandoned|postponed)$/.test(s)) return 'canceled';
  if (game.isLive === true || game.is_live === true || game.in_play === true ||
      /^(live|in_play|inprogress|in_progress|started|playing)$/.test(s)) return 'live';
  // Time fallback: commence_time in the past with no completion signal => live
  var ct = game.commence_time || game.commenceTime;
  if (ct) {
    var ms = new Date(ct).getTime();
    if (!isNaN(ms) && Date.now() >= ms) return 'live';
  }
  return 'upcoming';
}

function _buildCacheFromGames(gamesArr, prevCache, fetchDurationMs) {
  const now = new Date().toISOString();
  if (!Array.isArray(gamesArr) || !gamesArr.length) {
    return Object.assign({}, prevCache || _makeEmptyCache(), {
      sourceStatus: prevCache && prevCache.lastSuccessAt ? 'stale_preserved' : 'empty',
      warnings:['fetch_returned_empty']
    });
  }
  const byKey = {}, byId = {};
  let marketCount = 0;
  for (const game of gamesArr) {
    const cKey   = _buildCKeyFromGame(game);
    const gameId = game.id;
    // Compute and stamp game.status so the Live tab can filter on it
    const gameStatus = _deriveGameStatus(game);
    game.status     = gameStatus;
    game.isLive     = gameStatus === 'live';
    game.isFinal    = gameStatus === 'final';
    game.isCanceled = gameStatus === 'canceled';
    for (const bookmaker of (game.bookmakers||[])) {
      for (const market of (bookmaker.markets||[])) {
        const mLabel   = _normalizeMarketKey(market.key);
        const mapKeyC  = cKey + '|' + mLabel;
        const mapKeyI  = gameId + '|' + mLabel;
        // Owls/legacy may flag market-level suspended/closed
        const mktSuspended = market.suspended === true || market.is_suspended === true;
        const mktClosed    = market.closed === true || market.is_closed === true ||
                             gameStatus === 'final' || gameStatus === 'canceled';
        const entry = {
          cKey, gameId, sport:game.sport_key, market:mLabel,
          bookmaker:bookmaker.key, outcomes:market.outcomes||[],
          commenceTime:game.commence_time,
          suspended:!!mktSuspended,
          closed:!!mktClosed,
          // Game/event status fields so placement gates can allow live, block final
          gameStatus:gameStatus,
          eventCompleted:gameStatus==='final',
          eventCanceled:gameStatus==='canceled',
          eventLive:gameStatus==='live',
          marketStatus: mktSuspended ? 'suspended' : mktClosed ? 'closed' : (gameStatus==='live' ? 'active' : 'active'),
          state:'open', updatedAt:now
        };
        if (!byKey[mapKeyC]) { byKey[mapKeyC]=entry; marketCount++; }
        if (!byId[mapKeyI])  { byId[mapKeyI]=entry; }
      }
    }
  }
  return {
    updatedAt:now, lastSuccessAt:now, games:gamesArr,
    marketsByCanonicalKey:byKey, marketsByProviderGameId:byId,
    gameCount:gamesArr.length, marketCount, fetchDurationMs:fetchDurationMs||0,
    sourceStatus:'healthy', warnings:[]
  };
}

// Single shared cache instance — replaced atomically
let LIVE_MARKET_CACHE = _makeEmptyCache();

// Normalize a cache market entry to a placement-relevant state.
// Live games are 'open' — we want bets on them. Only block on real market
// problems: suspended, final, canceled, or stale cache.
function _normalizeMarketState(entry, nowMs) {
  nowMs = nowMs || Date.now();
  if (!entry) return { state:'suspended', reason:'not_found' };
  if (entry.eventCompleted === true || entry.gameStatus === 'final')
    return { state:'closed', reason:'game_final' };
  if (entry.eventCanceled === true || entry.gameStatus === 'canceled')
    return { state:'closed', reason:'game_canceled' };
  if (entry.suspended) return { state:'suspended', reason:'provider_suspended' };
  if (entry.closed)    return { state:'closed',    reason:'market_closed' };
  if (entry.updatedAt) {
    const age = nowMs - new Date(entry.updatedAt).getTime();
    if (age > CACHE_STALE_THRESHOLD) return { state:'stale', reason:'cache_stale', ageMs:age };
  }
  // Pregame and live both → open
  return { state:'open', reason:'ok' };
}

function _getSuspendedMarkets(cache, nowMs) {
  nowMs = nowMs || Date.now();
  return Object.entries(cache.marketsByCanonicalKey)
    .map(function([key, entry]) {
      const ms = _normalizeMarketState(entry, nowMs);
      return ms.state !== 'open' ? { key, state:ms.state, reason:ms.reason, cKey:entry.cKey } : null;
    }).filter(Boolean);
}

// Poll live odds and atomically replace cache
async function pollLiveOddsLoop() {
  // Provider switch: Owls Insight vs The Odds API
  console.log('[odds-provider] selected='+ODDS_PROVIDER+' hasOwlsKey='+(!!OWLS_KEY)+' hasOddsKey='+(!!ODDS_KEY));
  if (ODDS_PROVIDER === 'owls_insight') {
    if (!OWLS_KEY) { console.warn('[live cache] OWLS_INSIGHT_API_KEY not set — skipping poll'); return; }
    const start = Date.now();
    const allGames = [];
    // Per-sport normalized results so we can also harvest the
    // marketsByCanonicalKey + marketsByProviderGameId that the normalizer
    // already built. Previously _buildCacheFromGames was called on Owls
    // games but its bookmaker-iterating loop produces an empty market map
    // for Owls' flat shape — so the snapshot upsert silently wrote zero
    // rows. Now we keep the normalizer's maps and overlay them onto the
    // freshly-built cache after the fact.
    const owlsResults = [];
    try {
      await Promise.all(CACHE_SPORTS.map(async function(sport) {
        const result = await fetchOddsFromOwlsInsight(sport);
        if (result && result.ok && Array.isArray(result.games)) {
          owlsResults.push(result);
          result.games.forEach(function(g){ allGames.push(g); });
        } else if (result && !result.ok) {
          console.warn('[owls] fetch error sport='+sport+': '+(result.error||'unknown'));
        }
      }));
      const fetchDurationMs = Date.now()-start;
      const newCache = _buildCacheFromGames(allGames, LIVE_MARKET_CACHE, fetchDurationMs);

      // ── Owls overlay: replace the empty bookmaker-derived market maps
      //    with the normalizer's flat per-outcome maps. _upsertOddsSnapshots
      //    detects this shape via the lack of `outcomes[]` on each entry.
      const overlayByCK = {};
      const overlayByPGI = {};
      let overlayMarketCount = 0;
      for (const r of owlsResults) {
        const byCK = r.marketsByCanonicalKey || {};
        const byPGI = r.marketsByProviderGameId || {};
        for (const ck of Object.keys(byCK)) {
          const list = byCK[ck] || [];
          if (!overlayByCK[ck]) overlayByCK[ck] = [];
          for (const e of list) overlayByCK[ck].push(e);
          overlayMarketCount += list.length;
        }
        for (const pgi of Object.keys(byPGI)) {
          const list = byPGI[pgi] || [];
          if (!overlayByPGI[pgi]) overlayByPGI[pgi] = [];
          for (const e of list) overlayByPGI[pgi].push(e);
        }
      }

      // Enrich each Owls entry with the game-level fields _upsertOddsSnapshots
      // wants but the normalizer didn't stamp (commenceTime, sport_key). We
      // index games-by-id so the per-outcome enrichment is O(N) overall.
      //
      // CRITICAL: e.cKey is always set from the overlay map key, even when
      // the game lookup misses. Previously this was gated on `if (g)`, which
      // meant any provider_game_id ↔ normalizer-id mismatch caused
      // _buildSnapshotRow() to return null on every outcome (cKey gate at
      // line ~3640) — silently producing zero rows. The map key `ck` IS the
      // canonical key by definition; using it as a fallback is safe.
      const gameById = {};
      let cKeyFallbackHits = 0;
      for (const g of allGames) if (g && g.id) gameById[g.id] = g;
      for (const ck of Object.keys(overlayByCK)) {
        for (const e of overlayByCK[ck]) {
          // Always-on: canonical key from the map key. Source of truth.
          if (!e.cKey) e.cKey = ck;
          const g = e.providerGameId ? gameById[e.providerGameId] : null;
          if (g) {
            if (!e.commenceTime) e.commenceTime = g.commence_time || null;
            if (!e.sport)        e.sport        = g.sport_key     || null;
            if (!e.gameId)       e.gameId       = g.id            || null;
          } else if (e.providerGameId) {
            cKeyFallbackHits++;
          }
        }
      }
      if (cKeyFallbackHits > 0) {
        console.log('OWLS_ENRICH_CKEY_FALLBACK count='+cKeyFallbackHits+
          ' reason=providerGameId_not_in_gameById (cKey still set from map key)');
      }

      // Overlay the maps onto the new cache. We keep newCache.games (the
      // raw normalized game list — used by the projection layer and the
      // Live tab) but the marketsByCanonicalKey + marketsByProviderGameId
      // come from the normalizer.
      newCache.marketsByCanonicalKey   = overlayByCK;
      newCache.marketsByProviderGameId = overlayByPGI;
      newCache.marketCount             = overlayMarketCount;

      // eslint-disable-next-line no-console
      console.log(`OWLS_CACHE_SNAPSHOTS_READY games=${newCache.gameCount} markets=${overlayMarketCount}`);

      // The previous Owls path skipped the cache replace when sourceStatus
      // wasn't 'healthy'. We preserve that behavior — but a healthy Owls
      // run with 0 overlay markets is still better than wiping the old map,
      // so we only swap when we actually got data.
      if (newCache.sourceStatus==='healthy') {
        LIVE_MARKET_CACHE = newCache;
        console.log('[owls] cache updated games='+newCache.gameCount+' markets='+overlayMarketCount+' fetch='+fetchDurationMs+'ms');
      } else {
        console.warn('[owls] fetch returned empty — preserving previous cache');
      }
    } catch(e) { console.error('[owls] poll error:', e.message); }
    return;
  }
  // Default: The Odds API
  if (!ODDS_KEY) { console.log('[live cache] ODDS_API_KEY not set — skipping poll'); return; }
  const start = Date.now();
  const allGames = [];
  try {
    await Promise.all(CACHE_SPORTS.map(async function(sport) {
      const games = await fetchOdds(sport);
      if (Array.isArray(games)) allGames.push(...games);
    }));
    const fetchDurationMs = Date.now() - start;
    const newCache = _buildCacheFromGames(allGames, LIVE_MARKET_CACHE, fetchDurationMs);
    if (newCache.sourceStatus === 'healthy') {
      LIVE_MARKET_CACHE = newCache; // atomic replace
      console.log('[live cache] updated games='+newCache.gameCount+' markets='+newCache.marketCount+' fetch='+fetchDurationMs+'ms');
    } else {
      console.warn('[live cache] fetch returned empty — preserving previous cache ('+LIVE_MARKET_CACHE.gameCount+' games)');
    }
  } catch(e) {
    console.error('[live cache] poll error — preserving previous cache:', e.message);
  }
}

// Start poller on boot
if (ODDS_KEY || (ODDS_PROVIDER === 'owls_insight' && OWLS_KEY)) {
  pollLiveOddsLoopWithSnapshots(); // immediate — also fires _upsertOddsSnapshots on first tick
}

// ── ODDS VALIDATION HELPERS ───────────────────────────────────────────────────────────────────────────
// (kept for bets/place validation — now uses LIVE_MARKET_CACHE instead of per-request fetch)
// ODDS_TOLERANCE_PTS is declared above in the cache engine block

// Build a flat lookup map: "canonicalGameKey|market" -> { outcomes, suspended, closed }
// from a raw Odds API response array.
function buildLiveMarketMap(gamesArr, marketType) {
  const map = {};
  if (!Array.isArray(gamesArr)) return map;
  for (const game of gamesArr) {
    const homeTeam = (game.home_team||'').toLowerCase().replace(/\s+/g,'-');
    const awayTeam = (game.away_team||'').toLowerCase().replace(/\s+/g,'-');
    const sport    = (game.sport_key||'').split('_')[0];
    const dateStr  = game.commence_time ? game.commence_time.slice(0,10) : '';
    const cKey     = sport.toUpperCase()+'|'+awayTeam+'|'+homeTeam+'|'+dateStr;
    // Also index by provider game id for fast lookup
    const gameId   = game.id;

    for (const bookmaker of (game.bookmakers||[])) {
      for (const market of (bookmaker.markets||[])) {
        const mLabel = market.key; // 'h2h' | 'spreads' | 'totals'
        const normalized = mLabel === 'h2h' ? 'moneyline' : mLabel === 'spreads' ? 'spread' : mLabel === 'totals' ? 'total' : mLabel;
        const mapKey = cKey + '|' + normalized;
        if (!map[mapKey]) {
          map[mapKey] = {
            cKey, gameId, market: normalized,
            suspended: false, closed: false,
            outcomes: market.outcomes || []
          };
        }
        // Also index by providerGameId for P1 match
        const idKey = gameId + '|' + normalized;
        if (!map[idKey]) map[idKey] = map[mapKey];
      }
    }
  }
  return map;
}

// Validate one leg vs live market map. Returns { ok, code, ... }
// Live betting is supported: do NOT block solely because commenceTime is in the past.
// Only block when the market or game is actually unavailable (suspended/final/canceled).
function validateLegOdds(leg, liveMap, nowMs) {
  nowMs = nowMs || Date.now();
  // Find live market: try providerGameId first (P1), then cKey (P2)
  const mLabel = (leg.market||'moneyline').toLowerCase().replace('run line','spread').replace('puck line','spread');
  const liveMarket =
    (leg.providerGameId && liveMap[leg.providerGameId+'|'+mLabel]) ||
    (leg.canonicalGameKey && liveMap[leg.canonicalGameKey+'|'+mLabel]);

  if (!liveMarket) return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'not_found' };
  if (liveMarket.eventCompleted || liveMarket.gameStatus === 'final')
    return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'game_final' };
  if (liveMarket.eventCanceled || liveMarket.gameStatus === 'canceled')
    return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'game_canceled' };
  if (liveMarket.suspended) return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'suspended' };
  if (liveMarket.closed)    return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'closed' };

  // Match outcome by pick name (case-insensitive)
  const outcome = (liveMarket.outcomes||[]).find(o =>
    o.name && leg.pick && o.name.toLowerCase() === leg.pick.toLowerCase()
  );
  if (!outcome) return { ok:false, code:'market_closed', leg:leg.pick, reason:'outcome_not_found' };

  // Drift check (American points)
  const drift = Math.abs(outcome.price - parseInt(leg.odds,10));
  if (drift > ODDS_TOLERANCE_PTS) {
    return { ok:false, code:'odds_changed', leg:leg.pick,
             oldOdds: parseInt(leg.odds,10), newOdds: outcome.price, drift };
  }
  return { ok:true, liveOdds: outcome.price, leg: leg.pick };
}

// Validate all legs — now uses dual maps (canonical + providerGameId)
function validateAllLegsOdds(legs, byCanonical, byProvider, nowMs) {
  // Support legacy single-map call (byProvider omitted)
  if (typeof byProvider === 'number') { nowMs = byProvider; byProvider = {}; }
  byCanonical = byCanonical || {};
  byProvider  = byProvider  || {};
  nowMs = nowMs || Date.now();
  for (let i=0; i<legs.length; i++) {
    const leg = legs[i];
    const mLabel = (leg.market||'moneyline').toLowerCase().replace('run line','spread').replace('puck line','spread');
    const merged = Object.assign({}, byCanonical, byProvider); // providerGameId keys override on collision
    const r = validateLegOdds(leg, merged, nowMs);
    if (!r.ok) return Object.assign(r, { legIndex:i });
  }
  return { ok:true };
}

// Build updated odds snapshot from LIVE_MARKET_CACHE
function buildAcceptedOddsSnapshotFromCache(legs, cache) {
  const now = new Date().toISOString();
  return legs.map(function(leg) {
    const mLabel = (leg.market||'moneyline').toLowerCase().replace('run line','spread').replace('puck line','spread');
    const entry =
      (leg.providerGameId && cache.marketsByProviderGameId[leg.providerGameId+'|'+mLabel]) ||
      (leg.canonicalGameKey && cache.marketsByCanonicalKey[leg.canonicalGameKey+'|'+mLabel]);
    const outcome = entry && (entry.outcomes||[]).find(o =>
      o.name && o.name.toLowerCase() === (leg.pick||'').toLowerCase());
    return Object.assign({}, leg, { odds: outcome ? outcome.price : leg.odds, oddsAcceptedAt: now });
  });
}

// Legacy: flat-map snapshot (kept for grading paths)
function buildAcceptedOddsSnapshot(legs, liveMap) {
  const now = new Date().toISOString();
  return legs.map(function(leg) {
    const mLabel = (leg.market||'moneyline').toLowerCase().replace('run line','spread').replace('puck line','spread');
    const liveMarket = (leg.providerGameId && liveMap[leg.providerGameId+'|'+mLabel]) ||
                       (leg.canonicalGameKey && liveMap[leg.canonicalGameKey+'|'+mLabel]);
    const outcome = liveMarket && (liveMarket.outcomes||[]).find(o =>
      o.name && o.name.toLowerCase() === (leg.pick||'').toLowerCase());
    return Object.assign({}, leg, { odds: outcome ? outcome.price : leg.odds, oddsAcceptedAt: now });
  });
}
// ───────────────────────────────────────────────────────────────────────────

// Debug: confirm env vars are set (no values exposed)
app.get('/api/env-check', (req, res) => {
  res.json({
    ODDS_API_KEY: !!process.env.ODDS_API_KEY,
    DATABASE_URL: !!process.env.DATABASE_URL,
    JWT_SECRET: !!process.env.JWT_SECRET
  });
});

// Scores endpoint — returns completed games with final scores
// ── Supabase mirror endpoints (Phase A) ────────────────────────────────────────
// POST /api/mirror/ticket — fire-and-forget from client after localStorage write
app.post('/api/mirror/ticket', async (req, res) => {
  const { ticket, ledgerEntry } = req.body.ticket ? req.body : { ticket: req.body, ledgerEntry: null };
  const t = ticket || req.body;
  const browserStatus = String((t&&t.status)||'').toLowerCase();
  if (!BROWSER_TICKET_MIRROR_WRITES_ENABLED)
    return res.json(_mirrorNoopPayload('browser_ticket_mirror_writes_disabled',
      { endpoint:'/api/mirror/ticket' }));
  if (!GRADING_SETTLEMENT_ENABLED && _BROWSER_TERMINAL_STATUSES.has(browserStatus))
    return res.json(_mirrorNoopPayload('browser_terminal_status_mirror_blocked',
      { endpoint:'/api/mirror/ticket', status:browserStatus }));
  res.json({ queued: true }); // respond immediately
  if (!t || !t.id) return;
  mirrorTicketToSupabase(t).catch(function(e){ console.warn('[mirror/ticket] error:', e.message); });
  // Also mirror ledger entry if provided in same call
  if (ledgerEntry && ledgerEntry.id) {
    if (!BROWSER_LEDGER_MIRROR_WRITES_ENABLED) return;
    mirrorLedgerEntry(ledgerEntry).catch(function(e){ console.warn('[mirror/ledger] error:', e.message); });
  }
});

// POST /api/mirror/ledger — mirror a single ledger entry (append-only, idempotent)
app.post('/api/mirror/ledger', async (req, res) => {
  if (!BROWSER_LEDGER_MIRROR_WRITES_ENABLED)
    return res.json(_mirrorNoopPayload('browser_ledger_mirror_writes_disabled',
      { endpoint:'/api/mirror/ledger' }));
  res.json({ queued: true }); // respond immediately
  const entry = req.body;
  if (!entry || !entry.id) return;
  mirrorLedgerEntry(entry).catch(function(e){ console.warn('[mirror/ledger] error:', e.message); });
});

// POST /api/mirror/ledger-bulk — mirror array of ledger entries in one batch (for replay)
app.post('/api/mirror/ledger-bulk', async (req, res) => {
  if (!BROWSER_LEDGER_MIRROR_WRITES_ENABLED)
    return res.json(_mirrorNoopPayload('browser_ledger_mirror_writes_disabled',
      { endpoint:'/api/mirror/ledger-bulk' }));
  const sb = getSupabase();
  if (!sb) return res.json({ ok: false, reason: 'supabase_not_configured', inserted: 0 });
  const entries = Array.isArray(req.body) ? req.body : (req.body.entries || []);
  if (!entries.length) return res.json({ ok: true, inserted: 0 });
  res.json({ queued: true, count: entries.length });
  // Process async after response
  (async function() {
    const rows = entries.filter(function(e){ return e && e.id; }).map(function(e) {
      return {
        id:             e.id,
        club_id:        e.clubId   || e.club_id   || null,
        player_id:      e.playerId || e.player_id || null,
        ticket_id:      e.ticketId || e.ticket_id || null,
        type:           e.type     || 'bet_placed',
        amount:         parseFloat(e.amount) || 0,
        balance_before: e.balanceBefore != null ? parseFloat(e.balanceBefore) : null,
        balance_after:  e.balanceAfter  != null ? parseFloat(e.balanceAfter)  : null,
        reason:         e.reason   || e.type     || 'replay',
        final_score:    e.finalScore || e.final_score || null,
        created_at:     e.createdAt  || new Date().toISOString(),
        created_by:     e.createdBy  || 'replay'
      };
    });
    try {
      const { data, error } = await sb.from('ledger_entries').upsert(rows, { onConflict: 'id' }).select('id');
      if (error) throw error;
      console.log('[supabase mirror] ledger-bulk upserted:', data && data.length, 'of', rows.length);
    } catch(e) {
      console.warn('[supabase mirror] ledger-bulk error:', e.message);
    }
  })();
});

// POST /api/mirror/ledger-debug — synchronous insert, returns actual Supabase error for diagnosis
app.post('/api/mirror/ledger-debug', async (req, res) => {
  if (!BROWSER_LEDGER_MIRROR_WRITES_ENABLED)
    return res.json({ ok:true, disabled:true, containment:true });
  const sb = getSupabase();
  if (!sb) return res.json({ ok: false, reason: 'supabase_not_configured' });
  const entry = req.body;
  if (!entry || !entry.id) return res.json({ ok: false, reason: 'missing_id' });
  try {
    const row = {
      id:             entry.id,
      club_id:        entry.clubId   || entry.club_id   || null,
      player_id:      entry.playerId || entry.player_id || null,
      ticket_id:      entry.ticketId || entry.ticket_id || null,
      type:           entry.type     || 'bet_placed',
      amount:         parseFloat(entry.amount) || 0,
      balance_before: entry.balanceBefore != null ? parseFloat(entry.balanceBefore) : null,
      balance_after:  entry.balanceAfter  != null ? parseFloat(entry.balanceAfter)  : null,
      reason:         entry.reason   || entry.type || 'debug',
      final_score:    entry.finalScore || null,
      created_at:     entry.createdAt || new Date().toISOString(),
      created_by:     'debug'
    };
    // Try insert first (no ignoreDuplicates) to surface real constraint errors
    const { data, error } = await sb.from('ledger_entries').insert(row).select();
    if (error) {
      return res.json({ ok: false, supabaseError: error.message, code: error.code, hint: error.hint, details: error.details, row });
    }
    res.json({ ok: true, inserted: data });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/mirror/tickets-with-legs — tickets + legs in one call for DB primary read
app.get('/api/mirror/tickets-with-legs', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ enabled: false, tickets: [], legs: [], reason: 'not configured' });
  try {
    const { playerId, clubId, limit: limitQ } = req.query;
    const limit = Math.min(parseInt(limitQ)||200, 500);
    let tq = sb.from('tickets')
      .select('id,type,status,risk_amount,potential_profit,estimated_payout,odds,placed_at,graded_at,grading_source,grading_snapshot,player_id,club_id')
      .order('placed_at', { ascending: false }).limit(limit);
    if (playerId) tq = tq.eq('player_id', playerId);
    if (clubId)   tq = tq.eq('club_id', clubId);
    const { data: tickets, error: tErr } = await tq;
    if (tErr) throw tErr;
    // Fetch legs for these ticket IDs
    const ticketIds = (tickets||[]).map(function(t){ return t.id; });
    let legs = [];
    if (ticketIds.length) {
      const { data: legData, error: lErr } = await sb.from('ticket_legs')
        .select('id,ticket_id,leg_index,pick,market,odds,line,sport,home_team,away_team,canonical_game_key,scheduled_start,provider_game_id,game_status,leg_result')
        .in('ticket_id', ticketIds);
      if (lErr) throw lErr;
      legs = legData || [];
    }
    res.json({ enabled: true, tickets: tickets || [], legs });
  } catch(e) {
    res.status(500).json({ enabled: true, tickets: [], legs: [], error: e.message });
  }
});

// GET /api/mirror/tickets — read tickets from Supabase for a player/club (shadow read)
// Used by client runReadShadowAudit() — compare-only, never replaces localStorage.
app.get('/api/mirror/tickets', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ enabled: false, reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured', tickets: [] });
  try {
    const { playerId, clubId, limit: limitQ } = req.query;
    const limit = Math.min(parseInt(limitQ)||200, 500);
    let query = sb.from('tickets')
      .select('id, status, type, risk_amount, potential_profit, placed_at, graded_at, mirrored_at')
      .order('placed_at', { ascending: false })
      .limit(limit);
    if (playerId) query = query.eq('player_id', playerId);
    if (clubId)   query = query.eq('club_id', clubId);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ enabled: true, tickets: data || [], count: count });
  } catch(e) {
    res.status(500).json({ enabled: true, tickets: [], error: e.message });
  }
});

// GET /api/mirror/audit — ticket mirror status
app.get('/api/mirror/audit', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ enabled: false, reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured' });
  try {
    const limit = Math.min(parseInt(req.query.limit)||20, 100);
    const { data, error, count } = await sb
      .from('tickets')
      .select('id, type, status, risk_amount, placed_at, mirrored_at', { count: 'exact' })
      .order('mirrored_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ enabled: true, total_mirrored: count, recent: data || [] });
  } catch(e) { res.status(500).json({ enabled: true, error: e.message }); }
});

// GET /api/mirror/audit/legs — ticket_legs mirror status
app.get('/api/mirror/audit/legs', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ enabled: false, reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured' });
  try {
    const limit = Math.min(parseInt(req.query.limit)||50, 200);
    const { data, error, count } = await sb
      .from('ticket_legs')
      .select('id, ticket_id, leg_index, canonical_game_key, market, pick, odds', { count: 'exact' })
      .order('ticket_id', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ enabled: true, total_mirrored: count, recent: data || [] });
  } catch(e) { res.status(500).json({ enabled: true, error: e.message }); }
});

// GET /api/mirror/audit/ledger — ledger_entries mirror status
app.get('/api/mirror/audit/ledger', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ enabled: false, reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured' });
  try {
    const limit = Math.min(parseInt(req.query.limit)||50, 200);
    const { data, error, count } = await sb
      .from('ledger_entries')
      .select('id, ticket_id, type, amount, balance_before, balance_after, reason, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ enabled: true, total_mirrored: count, recent: data || [] });
  } catch(e) { res.status(500).json({ enabled: true, error: e.message }); }
});
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/scores/:sport', async (req, res) => {
  const sportMap = { nfl:'americanfootball_nfl', nba:'basketball_nba', mlb:'baseball_mlb', nhl:'icehockey_nhl', soccer:'soccer_usa_mls', ufl:'americanfootball_ufl' };
  const sport = sportMap[req.params.sport] || req.params.sport;
  const daysFrom = req.query.daysFrom || '3';
  if (!ODDS_KEY) return res.status(503).json({ error: 'ODDS_API_KEY not configured' });
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/scores/?apiKey=${ODDS_KEY}&daysFrom=${daysFrom}`;
  const req2 = require('https').get(url, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      try {
        const parsed = JSON.parse(d);
        if (parsed && parsed.error_code) return res.status(402).json({ error: parsed.message, error_code: parsed.error_code });
        // Return only completed games with scores
        const completed = (Array.isArray(parsed) ? parsed : []).filter(g => g.completed && g.scores && g.scores.length >= 2);
        res.json(completed.map(g => ({
          id: g.id, sport: g.sport_title, home: g.home_team, away: g.away_team,
          commence_time: g.commence_time, completed: g.completed,
          home_score: parseInt((g.scores.find(s => s.name === g.home_team)||{}).score||0),
          away_score: parseInt((g.scores.find(s => s.name === g.away_team)||{}).score||0),
          last_update: g.last_update
        })));
      } catch(e) { res.status(500).json({ error: 'Parse error' }); }
    });
  });
  req2.on('error', e => res.status(502).json({ error: e.message }));
  req2.setTimeout(8000, () => { req2.destroy(); res.status(504).json({ error: 'Timeout' }); });
});

// ── Helpers: project the in-memory cache into the flat player-friendly shape ──
// When ODDS_PROVIDER=owls_insight, the live poller stores Owls games in
// LIVE_MARKET_CACHE.games. Each game carries a flat `markets[]` array of
// { marketType, sportsbook, teamOrSide, odds, line } entries — NOT the
// bookmakers->markets nesting the legacy Odds API path produces. This helper
// folds the flat market array back into the moneyline/spreads/totals triplet
// the frontend already consumes, preferring Pinnacle when present and falling
// back to the first sportsbook seen for any side we haven't filled yet.
function _isMatchingSport(gameSportKey, requestedShort, requestedFull) {
  if (!gameSportKey) return false;
  var g = String(gameSportKey).toLowerCase();
  if (requestedFull && g === String(requestedFull).toLowerCase()) return true;
  if (requestedShort && g === String(requestedShort).toLowerCase()) return true;
  // Tolerate "baseball_mlb" vs "mlb" mismatch and sport-title casing.
  if (requestedShort && g.indexOf('_'+String(requestedShort).toLowerCase()) >= 0) return true;
  if (requestedShort && g.indexOf(String(requestedShort).toLowerCase()) === 0) return true;
  return false;
}

function _projectOwlsGameToFlat(g, sportLabel) {
  if (!g || typeof g !== 'object') return null;
  var moneyline = [];
  var spreads   = [];
  var totals    = [];
  // Props: one row per (player, propType, line). Each row carries both
  // over+under odds when the feed supplies them; missing side stays null.
  // Keyed by `propType|player|line` so a Pinnacle entry can overwrite a
  // weaker book via the same _pick() rule.
  var propsByKey = {};   // key -> { propType, playerName, team, line, overOdds, underOdds, marketKey, providerGameId }
  // De-dupe per (marketType, side) preferring Pinnacle; "side" is teamOrSide.
  var seen = {}; // key -> sportsbook chosen
  function _pick(key, sportsbook) {
    var cur = seen[key];
    if (!cur) { seen[key] = sportsbook || 'unknown'; return true; }
    // Upgrade if we get Pinnacle later (best-line proxy for our MVP)
    if (sportsbook === 'pinnacle' && cur !== 'pinnacle') { seen[key] = 'pinnacle'; return true; }
    return false;
  }
  var mkts = Array.isArray(g.markets) ? g.markets : [];
  for (var i = 0; i < mkts.length; i++) {
    var m = mkts[i]; if (!m) continue;
    var mt = m.marketType; var side = m.teamOrSide; var price = m.odds;
    if (typeof price !== 'number' || !side) continue;
    var key = mt + '|' + side;
    if (mt === 'moneyline') {
      if (_pick(key, m.sportsbook)) {
        var existing = moneyline.findIndex(function(x){ return x.team === side; });
        var row = { team: side, odds: price };
        if (existing >= 0) moneyline[existing] = row; else moneyline.push(row);
      }
    } else if (mt === 'spread') {
      if (typeof m.line !== 'number') continue;
      if (_pick(key, m.sportsbook)) {
        var ex = spreads.findIndex(function(x){ return x.team === side; });
        var rr = { team: side, line: m.line, odds: price };
        if (ex >= 0) spreads[ex] = rr; else spreads.push(rr);
      }
    } else if (mt === 'total') {
      if (typeof m.line !== 'number') continue;
      // Owls Over/Under outcomes share a line; key by name only.
      if (_pick(key, m.sportsbook)) {
        var et = totals.findIndex(function(x){ return x.name === side; });
        var rt = { name: side, line: m.line, odds: price };
        if (et >= 0) totals[et] = rt; else totals.push(rt);
      }
    } else if (mt === 'player_prop') {
      // Only surface props that have a player name AND a numeric line.
      // Anytime-TD / first-TD-style yes-no markets without a line are
      // intentionally skipped for the MVP — the UI is line-based today.
      if (!m.playerName || typeof m.line !== 'number') continue;
      var propKey = (m.propType||'Other') + '|' +
                    String(m.playerName).toLowerCase() + '|' + m.line;
      var pickKey = 'prop|' + propKey + '|' + (m.overUnder||'?');
      if (!_pick(pickKey, m.sportsbook)) continue;
      var p = propsByKey[propKey];
      if (!p) {
        p = {
          propType:       m.propType || 'Other',
          playerName:     m.playerName,
          team:           m.playerTeam || null,
          line:           m.line,
          overOdds:       null,
          underOdds:      null,
          marketKey:      m.marketKey || null,
          providerGameId: m.providerGameId || null,
        };
        propsByKey[propKey] = p;
      }
      if (m.overUnder === 'under') p.underOdds = price;
      else                          p.overOdds  = price;
    }
    // team_total / first_half_* intentionally not surfaced in the MVP
    // moneyline/spread/total triplet — they're still in LIVE_MARKET_CACHE
    // for downstream consumers when we're ready.
  }
  // Materialize props array sorted by propType, then player.
  var props = Object.values(propsByKey);
  props.sort(function(a, b) {
    if (a.propType !== b.propType) return a.propType < b.propType ? -1 : 1;
    return (a.playerName||'').localeCompare(b.playerName||'');
  });
  // Surface game status (upcoming/live/final/canceled) so the frontend
  // can filter the Live tab and decide whether to show a betting CTA.
  var status = g.status || _deriveGameStatus(g);
  var sportShort = String(sportLabel || g.sport_key || '').toLowerCase();
  var gameStateText = _formatGameStateText(sportShort, {
    status, period:g.period, clock:g.clock,
    inning:g.inning, inningHalf:g.inningHalf, outs:g.outs,
    down:g.down, distance:g.distance
  });
  return {
    id:    g.id || g.providerGameId || ((g.away_team||'')+'@'+(g.home_team||'')+'@'+(g.commence_time||'')),
    sport: sportLabel || g.sport_key || '',
    home:  g.home_team || '',
    away:  g.away_team || '',
    time:  g.commence_time || null,
    status: status,                   // 'upcoming' | 'live' | 'final' | 'canceled'
    isLive: status === 'live',
    isFinal: status === 'final',
    isCanceled: status === 'canceled',
    // Scoreboard — null fields when feed doesn't surface them
    homeScore: g.homeScore != null ? g.homeScore : null,
    awayScore: g.awayScore != null ? g.awayScore : null,
    period:    g.period    || null,
    clock:     g.clock     || null,
    inning:    g.inning    || null,
    inningHalf:g.inningHalf|| null,
    outs:      g.outs      != null ? g.outs : null,
    basesOccupied: g.basesOccupied || null,
    possession:g.possession|| null,
    down:      g.down      || null,
    distance:  g.distance  != null ? g.distance : null,
    gameStateText: gameStateText,
    moneyline: moneyline,
    spreads:   spreads,
    totals:    totals,
    // Player props — array of { propType, playerName, team, line, overOdds,
    // underOdds, marketKey, providerGameId }. Empty when the feed doesn't
    // provide props for this game.
    props:     props
  };
}

// Format a sport-aware human game-state string for the live scoreboard.
// MLB:  "▲ 2nd 2 Outs"
// NBA:  "Q3 4:21"
// NFL:  "3rd & 7 • Q2 12:14"
// NHL/Soccer/Default: "Q2 12:14" or just the clock
function _formatGameStateText(sportShort, s) {
  if (!s) return '';
  if (s.status === 'final')    return 'Final';
  if (s.status === 'canceled') return 'Canceled';
  if (s.status !== 'live')     return '';
  var sp = String(sportShort||'').toLowerCase();
  if (sp.indexOf('mlb') >= 0 || sp.indexOf('baseball') >= 0) {
    var arrow = '';
    var half = String(s.inningHalf||'').toLowerCase();
    if (half === 'top'    || half === 't') arrow = '▲';
    if (half === 'bottom' || half === 'b') arrow = '▼';
    var inn  = s.inning ? _ordinal(s.inning) : null;
    var outs = s.outs != null ? s.outs + ' Out' + (s.outs===1?'':'s') : null;
    return [arrow, inn, outs].filter(Boolean).join(' ');
  }
  if (sp.indexOf('nfl') >= 0 || sp.indexOf('football') >= 0 || sp.indexOf('ncaaf') >= 0 || sp.indexOf('ufl') >= 0) {
    var dd = (s.down && s.distance != null) ? _ordinal(s.down)+' & '+s.distance : null;
    var qclk = s.period ? 'Q'+s.period+(s.clock?' '+s.clock:'') : (s.clock||'');
    return [dd, qclk].filter(Boolean).join(' • ');
  }
  if (sp.indexOf('nba') >= 0 || sp.indexOf('basketball') >= 0 || sp.indexOf('ncaab') >= 0) {
    var q = s.period ? 'Q'+s.period : '';
    return (q + (s.clock?' '+s.clock:'')).trim();
  }
  if (sp.indexOf('nhl') >= 0 || sp.indexOf('hockey') >= 0) {
    var pp = s.period ? 'P'+s.period : '';
    return (pp + (s.clock?' '+s.clock:'')).trim();
  }
  if (sp.indexOf('soccer') >= 0) {
    return (s.clock ? s.clock+"'" : '');
  }
  return [s.period?'Q'+s.period:'', s.clock||''].filter(Boolean).join(' ').trim();
}
function _ordinal(n) {
  n = parseInt(n,10); if (!n) return '';
  var s = ['th','st','nd','rd'], v = n%100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}

// Sort: live first (by clock proximity), then upcoming (by commence_time asc),
// then final/canceled at the bottom. Matches DK-style home-screen ordering.
function _compareGamesForBoard(a, b) {
  function rank(g) {
    if (g && g.status === 'live')     return 0;
    if (g && g.status === 'upcoming') return 1;
    if (g && g.status === 'final')    return 2;
    if (g && g.status === 'canceled') return 3;
    return 1;
  }
  var ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  // Within same bucket, sort by commence_time ascending (oldest first for live = late game later)
  var ta = a && a.time ? new Date(a.time).getTime() : Infinity;
  var tb = b && b.time ? new Date(b.time).getTime() : Infinity;
  return ta - tb;
}

// Project ALL Owls cache games matching a sport key into the flat shape.
function _owlsCacheFlatGamesForSport(requestedSport, sportLabel) {
  var cache = (typeof LIVE_MARKET_CACHE !== 'undefined') ? LIVE_MARKET_CACHE : null;
  if (!cache || !Array.isArray(cache.games) || !cache.games.length) return [];
  var short = String(requestedSport||'').toLowerCase();
  var full  = _CACHE_SPORT_KEY_BY_SHORT[short] || short;
  var out = [];
  for (var i = 0; i < cache.games.length; i++) {
    var g = cache.games[i];
    if (!_isMatchingSport(g.sport_key, short, full)) continue;
    var flat = _projectOwlsGameToFlat(g, sportLabel || short.toUpperCase());
    if (flat && flat.home && flat.away) out.push(flat);
  }
  return out;
}

app.get('/api/odds/:sport', async (req, res) => {
  const sportMap = { nfl:'americanfootball_nfl', nba:'basketball_nba', mlb:'baseball_mlb', nhl:'icehockey_nhl', soccer:'soccer_usa_mls', ufl:'americanfootball_ufl' };
  const sportShort = String(req.params.sport||'').toLowerCase();
  const sport = sportMap[sportShort] || sportShort;
  // ── Owls Insight path: serve from the in-memory cache the poller fills.
  if (ODDS_PROVIDER === 'owls_insight') {
    const flat = _owlsCacheFlatGamesForSport(sportShort, sportShort.toUpperCase());
    const cache = (typeof LIVE_MARKET_CACHE !== 'undefined') ? LIVE_MARKET_CACHE : null;
    res.setHeader('X-Provider',      'owls_insight');
    res.setHeader('X-Source-Status', (cache && cache.sourceStatus) || 'unknown');
    res.setHeader('X-Games-Count',   String(flat.length));
    if (cache && cache.updatedAt) {
      res.setHeader('X-Cache-Age',   String(Math.max(0, Math.round((Date.now() - new Date(cache.updatedAt).getTime()) / 1000))));
    }
    // Sort live games first, then upcoming by commence_time, then final at the bottom.
    flat.sort(_compareGamesForBoard);
    console.log('[odds] source=owls-cache sport='+sportShort+' games='+flat.length+
      ' live='+flat.filter(function(g){return g.status==='live';}).length+
      ' sourceStatus='+(cache&&cache.sourceStatus||'unknown'));
    // Empty is a valid, non-error response — the frontend renders "No games available right now."
    return res.json(flat.slice(0, 50));
  }
  // ── Legacy Odds API path (untouched) ────────────────────────────────────
  console.log('[odds] source=backend-proxy sport='+req.params.sport+' key_fingerprint='+(ODDS_KEY?ODDS_KEY.slice(0,4)+'...'+ODDS_KEY.slice(-4):'MISSING'));
  try {
    const games = await fetchOdds(sport);
    if (games === null) { return res.status(503).json({ error: 'ODDS_API_KEY not configured on server.' }); }
    if (games && games._error) { return res.status(402).json({ error: games._message, error_code: games._error }); }
    const formatted = (Array.isArray(games) ? games : []).slice(0,20).map(g => {
      const status = _deriveGameStatus(g);
      return {
        id: g.id, sport: g.sport_title||req.params.sport.toUpperCase(),
        home: g.home_team, away: g.away_team, time: g.commence_time,
        status, isLive: status==='live', isFinal: status==='final', isCanceled: status==='canceled',
        // Odds API /odds doesn't include live scores — hydrate from /scores cache when present
        homeScore: null, awayScore: null, period:null, clock:null, inning:null,
        outs:null, basesOccupied:null, possession:null, gameStateText: status==='final'?'Final':'',
        spreads: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='spreads')?.outcomes||[]).map(o=>({team:o.name,line:o.point,odds:o.price})),
        totals: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='totals')?.outcomes||[]).map(o=>({name:o.name,line:o.point,odds:o.price})),
        moneyline: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='h2h')?.outcomes||[]).map(o=>({team:o.name,odds:o.price})),
        // Legacy Odds API path doesn't currently surface props; the Owls
        // path is the source of player props. Empty array keeps the UI
        // contract uniform.
        props: []
      };
    });
    formatted.sort(_compareGamesForBoard);
    res.json(formatted);
  } catch(e) { console.error('Odds endpoint error:', e.message); res.json([]); }
});

// ── Sport catalog metadata ──────────────────────────────────────────────────
// Every sport/competition the backend is willing to advertise. sortOrder is
// the DK-style static fallback ordering; /api/sports re-sorts at request
// time by (live first → upcoming → popular US → alphabetical). icon = emoji
// fallback for clients without bundled SVGs. logoUrl points at a local asset
// path the frontend can resolve from its public/ tree (or null = use icon).
// sportGroup is the All Sports-screen category.
const SPORT_META = {
  // ── US major (1–10) ──
  mlb:               { label:'MLB',              sportGroup:'us-major',      icon:'⚾',   logoUrl:'/sports/logos/mlb.svg',           sortOrder: 1 },
  nba:               { label:'NBA',              sportGroup:'us-major',      icon:'🏀',   logoUrl:'/sports/logos/nba.svg',           sortOrder: 2 },
  nfl:               { label:'NFL',              sportGroup:'us-major',      icon:'🏈',   logoUrl:'/sports/logos/nfl.svg',           sortOrder: 3 },
  nhl:               { label:'NHL',              sportGroup:'us-major',      icon:'🏒',   logoUrl:'/sports/logos/nhl.svg',           sortOrder: 4 },
  wnba:              { label:'WNBA',             sportGroup:'us-major',      icon:'🏀',   logoUrl:'/sports/logos/wnba.svg',          sortOrder: 5 },
  // ── US college (11–20) ──
  ncaab:             { label:'NCAAB',            sportGroup:'us-college',    icon:'🏀',   logoUrl:'/sports/logos/ncaa.svg',          sortOrder:11 },
  ncaaf:             { label:'NCAAF',            sportGroup:'us-college',    icon:'🏈',   logoUrl:'/sports/logos/ncaa.svg',          sortOrder:12 },
  ncaabaseball:      { label:'College Baseball', sportGroup:'us-college',    icon:'⚾',   logoUrl:'/sports/logos/ncaa.svg',          sortOrder:13 },
  // ── Combat (21–30) ──
  mma:               { label:'MMA',              sportGroup:'combat',        icon:'🥊',   logoUrl:'/sports/logos/ufc.svg',           sortOrder:21 },
  boxing:            { label:'Boxing',           sportGroup:'combat',        icon:'🥊',   logoUrl:'/sports/logos/boxing.svg',        sortOrder:22 },
  // ── Motorsports (31–40) ──
  nascar:            { label:'NASCAR',           sportGroup:'motorsports',   icon:'🏁',   logoUrl:'/sports/logos/nascar.svg',        sortOrder:31 },
  f1:                { label:'Formula 1',        sportGroup:'motorsports',   icon:'🏎',   logoUrl:'/sports/logos/f1.svg',            sortOrder:32 },
  // ── Soccer competitions (41–60) ──
  soccer:            { label:'Soccer',           sportGroup:'soccer',        icon:'⚽',   logoUrl:null,                              sortOrder:41 },
  soccer_worldcup:   { label:'World Cup',        sportGroup:'soccer',        icon:'🏆',   logoUrl:'/sports/logos/worldcup.svg',      sortOrder:42 },
  soccer_euros:      { label:'Euros',            sportGroup:'soccer',        icon:'⚽',   logoUrl:'/sports/logos/uefa-euro.svg',     sortOrder:43 },
  soccer_ucl:        { label:'Champions League', sportGroup:'soccer',        icon:'🏆',   logoUrl:'/sports/logos/ucl.svg',           sortOrder:44 },
  soccer_epl:        { label:'Premier League',   sportGroup:'soccer',        icon:'⚽',   logoUrl:'/sports/logos/epl.svg',           sortOrder:45 },
  soccer_laliga:     { label:'La Liga',          sportGroup:'soccer',        icon:'⚽',   logoUrl:'/sports/logos/laliga.svg',        sortOrder:46 },
  soccer_seriea:     { label:'Serie A',          sportGroup:'soccer',        icon:'⚽',   logoUrl:'/sports/logos/seriea.svg',        sortOrder:47 },
  soccer_bundesliga: { label:'Bundesliga',       sportGroup:'soccer',        icon:'⚽',   logoUrl:'/sports/logos/bundesliga.svg',    sortOrder:48 },
  soccer_ligue1:     { label:'Ligue 1',          sportGroup:'soccer',        icon:'⚽',   logoUrl:'/sports/logos/ligue1.svg',        sortOrder:49 },
  soccer_mls:        { label:'MLS',              sportGroup:'soccer',        icon:'⚽',   logoUrl:'/sports/logos/mls.svg',           sortOrder:50 },
  // ── Other international team (61–70) ──
  cricket:           { label:'Cricket',          sportGroup:'international', icon:'🏏',   logoUrl:'/sports/logos/cricket.svg',       sortOrder:61 },
  cricket_ipl:       { label:'IPL',              sportGroup:'international', icon:'🏏',   logoUrl:'/sports/logos/ipl.svg',           sortOrder:62 },
  cricket_t20:       { label:'T20 Intl',         sportGroup:'international', icon:'🏏',   logoUrl:'/sports/logos/cricket.svg',       sortOrder:63 },
  rugby:             { label:'Rugby Union',      sportGroup:'international', icon:'🏉',   logoUrl:'/sports/logos/rugby.svg',         sortOrder:64 },
  rugby_league:      { label:'Rugby League',     sportGroup:'international', icon:'🏉',   logoUrl:'/sports/logos/rugby.svg',         sortOrder:65 },
  afl:               { label:'AFL',              sportGroup:'international', icon:'🏉',   logoUrl:'/sports/logos/afl.svg',           sortOrder:66 },
  // ── Individual (71–80) ──
  tennis:            { label:'Tennis',           sportGroup:'individual',    icon:'🎾',   logoUrl:null,                              sortOrder:71 },
  tennis_atp:        { label:'ATP',              sportGroup:'individual',    icon:'🎾',   logoUrl:'/sports/logos/atp.svg',           sortOrder:72 },
  tennis_wta:        { label:'WTA',              sportGroup:'individual',    icon:'🎾',   logoUrl:'/sports/logos/wta.svg',           sortOrder:73 },
  golf_pga:          { label:'PGA Tour',         sportGroup:'individual',    icon:'⛳',   logoUrl:'/sports/logos/pga.svg',           sortOrder:74 },
  golf_liv:          { label:'LIV Golf',         sportGroup:'individual',    icon:'⛳',   logoUrl:'/sports/logos/liv.svg',           sortOrder:75 },
  golf_european:     { label:'DP World Tour',    sportGroup:'individual',    icon:'⛳',   logoUrl:'/sports/logos/european-tour.svg', sortOrder:76 },
  table_tennis:      { label:'Table Tennis',     sportGroup:'individual',    icon:'🏓',   logoUrl:null,                              sortOrder:77 },
  // ── Esports (81–90) ──
  cs2:               { label:'CS2',              sportGroup:'esports',       icon:'🎮',   logoUrl:'/sports/logos/cs2.svg',           sortOrder:81 },
  valorant:          { label:'Valorant',         sportGroup:'esports',       icon:'🎮',   logoUrl:'/sports/logos/valorant.svg',      sortOrder:82 },
  lol:               { label:'LoL',              sportGroup:'esports',       icon:'🎮',   logoUrl:'/sports/logos/lol.svg',           sortOrder:83 },
  dota2:             { label:'Dota 2',           sportGroup:'esports',       icon:'🎮',   logoUrl:'/sports/logos/dota2.svg',         sortOrder:84 },
  rocketleague:      { label:'Rocket League',    sportGroup:'esports',       icon:'🚗',   logoUrl:'/sports/logos/rocketleague.svg',  sortOrder:85 }
};

// "Popular US sports" set used by the DK-style live→upcoming→popular sort.
const _POPULAR_US_SPORTS = { mlb:1, nba:1, nfl:1, nhl:1, wnba:1, ncaab:1, ncaaf:1, mma:1, boxing:1, nascar:1, golf_pga:1 };

// ── GET /api/sports ─────────────────────────────────────────────────────────
// Returns the full sport catalog the backend is willing to advertise. The
// frontend uses this to build sport tabs dynamically and the All Sports
// screen. Per the sport-tabs spec:
//   - OWLS_ENABLED_SPORTS=all       → every sport in OWLS_ALL_SPORTS appears
//   - OWLS_ENABLED_SPORTS=<list>    → only those sports appear (enabled=true)
//   - Sports with no current games still appear (frontend dims them) unless
//     they are not enabled by config
// Per-sport fields (matches spec exactly, plus a few extras for compat):
//   { key, label, owlsKey, enabled, hasGames, liveGameCount,
//     upcomingGameCount, icon, sortOrder, group, markets, games,
//     finalGameCount, sourceStatus }
app.get('/api/sports', (req, res) => {
  const cache    = (typeof LIVE_MARKET_CACHE !== 'undefined') ? LIVE_MARKET_CACHE : null;
  const provider = ODDS_PROVIDER || 'unknown';
  const nowMs    = Date.now();

  // Per-sport counts pulled from cache (live, upcoming, final, total markets)
  const counts = {};
  if (cache && Array.isArray(cache.games)) {
    for (let i = 0; i < cache.games.length; i++) {
      const g = cache.games[i];
      let short = null;
      const sk = String(g.sport_key||'').toLowerCase();
      for (const k in _CACHE_SPORT_KEY_BY_SHORT) {
        if (_CACHE_SPORT_KEY_BY_SHORT[k] === sk || k === sk) { short = k; break; }
      }
      if (!short) continue;
      const c = counts[short] || (counts[short] = { games:0, markets:0, live:0, upcoming:0, final:0 });
      c.games++;
      const status = g.status || _deriveGameStatus(g);
      if (status === 'live')          c.live++;
      else if (status === 'upcoming') c.upcoming++;
      else if (status === 'final')    c.final++;
      if (Array.isArray(g.markets) && g.markets.length) {
        c.markets += g.markets.length;
      } else if (Array.isArray(g.bookmakers)) {
        for (const bm of g.bookmakers) {
          for (const m of (bm.markets||[])) c.markets += (m.outcomes||[]).length;
        }
      }
    }
  }

  // Catalog = enabled sports ∪ sports with cache hits. Enabled sports always
  // appear (so the UI can dim empties); cache hits for a non-enabled sport
  // still surface so a manually-flipped flag works without code changes.
  const enabledSet = {};
  for (const s of OWLS_ENABLED_SPORTS) enabledSet[s] = true;
  const allKeys = {};
  for (const k in enabledSet) allKeys[k] = true;
  for (const k in counts)     allKeys[k] = true;

  const sports = Object.keys(allKeys).map(function(key){
    const meta = SPORT_META[key] || {
      label: key.toUpperCase().replace(/_/g,' '),
      sportGroup: 'other',
      icon: '🏆',
      logoUrl: null,
      sortOrder: 99
    };
    const c    = counts[key] || { games:0, markets:0, live:0, upcoming:0, final:0 };
    const owlsKey = OWLS_SPORT_MAP[key] || OWLS_SPORT_MAP[_CACHE_SPORT_KEY_BY_SHORT[key]||''] || null;
    return {
      key:               key,
      label:             meta.label,
      owlsKey:           owlsKey,
      sportGroup:        meta.sportGroup || meta.group || 'other',
      icon:              meta.icon || null,
      logoUrl:           meta.logoUrl || null,
      enabled:           !!enabledSet[key],
      hasGames:          c.games > 0,
      liveGameCount:     c.live,
      upcomingGameCount: c.upcoming,
      totalGameCount:    c.games,
      sortOrder:         meta.sortOrder != null ? meta.sortOrder : 99,
      // ─ Back-compat shims (older clients reading group/games/markets) ─
      group:             meta.sportGroup || meta.group || 'other',
      games:             c.games,
      markets:           c.markets,
      finalGameCount:    c.final,
      sourceStatus:      c.games > 0 ? (cache && cache.sourceStatus) || 'unknown'
                                     : (enabledSet[key] ? 'empty' : 'inactive')
    };
  });

  // DK-style smart ordering:
  //   1) sports with LIVE games first (by liveGameCount desc)
  //   2) then sports with UPCOMING games (by upcomingGameCount desc)
  //   3) then popular US sports (alphabetical within tier)
  //   4) then everything else alphabetical
  // Tie-breaker inside each tier: static sortOrder, then label.
  sports.sort(function(a, b){
    function tier(s){
      if (s.liveGameCount > 0)           return 0;
      if (s.upcomingGameCount > 0)       return 1;
      if (_POPULAR_US_SPORTS[s.key])     return 2;
      return 3;
    }
    const ta = tier(a), tb = tier(b);
    if (ta !== tb) return ta - tb;
    // Within "live" tier, more live games first
    if (ta === 0 && a.liveGameCount !== b.liveGameCount)
      return b.liveGameCount - a.liveGameCount;
    // Within "upcoming" tier, more upcoming games first
    if (ta === 1 && a.upcomingGameCount !== b.upcomingGameCount)
      return b.upcomingGameCount - a.upcomingGameCount;
    // "Popular" + "other" tiers: static sortOrder then label
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });

  // Telemetry: visible = enabled+hasGames, dimmed = enabled+!hasGames,
  // hidden = !enabled (came in only because cache had something).
  let visible = 0, dimmed = 0, hidden = 0, totalLive = 0, totalUpcoming = 0;
  for (const s of sports) {
    totalLive     += s.liveGameCount;
    totalUpcoming += s.upcomingGameCount;
    if (!s.enabled)      hidden++;
    else if (s.hasGames) visible++;
    else                 dimmed++;
  }
  console.log('OWLS_SPORT_CATALOG'
    +' total='+sports.length
    +' enabled='+OWLS_ENABLED_SPORTS.length
    +' live='+totalLive
    +' upcoming='+totalUpcoming);
  console.log('SPORT_ICON_RENDER visible='+visible+' dimmed='+dimmed+' hidden='+hidden);

  res.setHeader('Cache-Control', 'public, max-age=15');
  res.json({
    provider:     provider,
    updatedAt:    cache && cache.updatedAt || null,
    sourceStatus: cache && cache.sourceStatus || 'unknown',
    enabledCount: OWLS_ENABLED_SPORTS.length,
    catalogCount: OWLS_ALL_SPORTS.length,
    totalLive:    totalLive,
    totalUpcoming:totalUpcoming,
    sports:       sports
  });
});

app.get('/api/odds', async (req, res) => {
  const sports = ['baseball_mlb','basketball_nba','icehockey_nhl','americanfootball_ufl'];
  try {
    const results = await Promise.all(sports.map(s => fetchOdds(s).catch(()=>[])));
    const all = results.flat().slice(0,30).map(g => ({
      id: g.id, sport: g.sport_title||'',
      home: g.home_team, away: g.away_team, time: g.commence_time,
      spreads: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='spreads')?.outcomes||[]).map(o=>({team:o.name,line:o.point,odds:o.price})),
      totals: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='totals')?.outcomes||[]).map(o=>({name:o.name,line:o.point,odds:o.price})),
      moneyline: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='h2h')?.outcomes||[]).map(o=>({team:o.name,odds:o.price}))
    }));
    res.json(all);
  } catch(e) { res.json([]); }
});

// ===== ADMIN =====
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [u,c,b,m,h,sh] = await Promise.all([
      query('SELECT COUNT(*) as total FROM users'),
      query('SELECT COUNT(*) as total FROM clubs'),
      query("SELECT COUNT(*) as total,COALESCE(SUM(risk),0) as handle,COALESCE(SUM(CASE WHEN result='loss' THEN risk ELSE 0 END),0) as collected,COALESCE(SUM(CASE WHEN result='win' THEN win ELSE 0 END),0) as paid_out FROM bets"),
      query("SELECT COUNT(CASE WHEN status='approved' THEN 1 END) as approved,COUNT(CASE WHEN status='pending' THEN 1 END) as pending FROM club_memberships"),
      query('SELECT COUNT(DISTINCT host_id) as total FROM clubs'),
      query(`SELECT u.name,u.email,m.wins,m.total_bets,c.name as club_name,CASE WHEN m.total_bets>0 THEN ROUND((m.wins::float/m.total_bets*100)::numeric,1) ELSE 0 END as win_rate FROM club_memberships m JOIN users u ON m.player_id=u.id JOIN clubs c ON m.club_id=c.id WHERE m.total_bets>=5 ORDER BY win_rate DESC LIMIT 20`)
    ]);
    const bets = b.rows[0];
    const profit = parseFloat(bets.collected)-parseFloat(bets.paid_out);
    res.json({ users:parseInt(u.rows[0].total), clubs:parseInt(c.rows[0].total), active_hosts:parseInt(h.rows[0].total), active_members:parseInt(m.rows[0].approved), pending_requests:parseInt(m.rows[0].pending), total_bets:parseInt(bets.total), handle:parseFloat(bets.handle).toFixed(2), profit:profit.toFixed(2), sharp_players:sh.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const r = await query('SELECT id,email,name,role,diamonds,created_at FROM users ORDER BY created_at DESC LIMIT 100');
    res.json({ users: r.rows, total: r.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id', adminAuth, async (req, res) => {
  const { role, diamonds } = req.body;
  try {
    const r = await query('UPDATE users SET role=COALESCE($1,role),diamonds=COALESCE($2,diamonds) WHERE id=$3 RETURNING id,name,email,role,diamonds', [role, diamonds, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/clubs', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT c.*,u.name as host_name,u.email as host_email,COUNT(DISTINCT m.id) as member_count,COUNT(DISTINCT b.id) as bet_count,COALESCE(SUM(b.risk),0) as handle FROM clubs c JOIN users u ON c.host_id=u.id LEFT JOIN club_memberships m ON c.id=m.club_id AND m.status='approved' LEFT JOIN bets b ON b.club_id=c.id GROUP BY c.id,u.name,u.email ORDER BY c.created_at DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/payments', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT c.id as club_id,c.name as club_name,c.code,u.name as host_name,u.email as host_email,COUNT(m.id) as active_players,COUNT(m.id)*10 as weekly_fee_owed FROM clubs c JOIN users u ON c.host_id=u.id LEFT JOIN club_memberships m ON c.id=m.club_id AND m.status='approved' GROUP BY c.id,u.name,u.email ORDER BY weekly_fee_owed DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/bets', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT b.*,u.name as player_name,c.name as club_name FROM bets b LEFT JOIN users u ON b.player_id=u.id LEFT JOIN clubs c ON b.club_id=c.id ORDER BY b.created_at DESC LIMIT 100`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== PLAYER LIMITS =====
app.get('/api/clubs/:id/limits/:userId', auth, async (req, res) => {
  try {
    const r = await query('SELECT * FROM player_limits WHERE club_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
    res.json(r.rows[0]||{});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clubs/:id/limits/:userId', auth, async (req, res) => {
  const { max_bet, max_daily_risk, max_payout } = req.body;
  try {
    const r = await query(`INSERT INTO player_limits (club_id,user_id,max_bet,max_daily_risk,max_payout,updated_at) VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (club_id,user_id) DO UPDATE SET max_bet=$3,max_daily_risk=$4,max_payout=$5,updated_at=NOW() RETURNING *`,
      [req.params.id, req.params.userId, max_bet||100, max_daily_risk||500, max_payout||2000]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== START =====
console.log('Starting Pocketbooks Sports Backend...');
console.log('PORT:', process.env.PORT);
console.log('DATABASE_URL set:', !!process.env.DATABASE_URL);
const _k = process.env.ODDS_API_KEY || '';
console.log('ODDS_API_KEY set:', !!_k, '| fingerprint:', _k ? _k.slice(0,4)+'...'+_k.slice(-4) : 'MISSING');

// ════════════════════════════════════════════════════════════════════════════
// SERVER GRADING ENGINE (Phase C)
// ════════════════════════════════════════════════════════════════════════════
// RESULT SNAPSHOT ENGINE (Phase M)
// ════════════════════════════════════════════════════════════════════════════

// Upsert result snapshots from Odds API scores response
async function _upsertResultSnapshots(scoresData, sport) {
  const sb = getSupabase();
  if (!sb || !Array.isArray(scoresData)) return;
  const now = new Date().toISOString();
  const rows = scoresData.map(function(game) {
    const sport_key = game.sport_key||sport||'unknown';
    const sp = sport_key.split('_')[0].toUpperCase()==='BASEBALL'?'MLB'
      :sport_key.split('_')[0].toUpperCase()==='BASKETBALL'?'NBA'
      :sport_key.toUpperCase().split('_')[0];
    const away = (game.away_team||'').toLowerCase().replace(/\s+/g,'-');
    const home = (game.home_team||'').toLowerCase().replace(/\s+/g,'-');
    const date = (game.commence_time||'').slice(0,10);
    const cKey = sp+'|'+away+'|'+home+'|'+date;
    // Derive winner from scores
    const scores = game.scores||[];
    let homeScore=null, awayScore=null, winner=null;
    if (scores.length===2) {
      const h=scores.find(function(s){ return s.name===game.home_team; });
      const a=scores.find(function(s){ return s.name===game.away_team; });
      if(h&&a) {
        homeScore=parseInt(h.score,10)||0; awayScore=parseInt(a.score,10)||0;
        if (game.completed) {
          winner = homeScore>awayScore?'home':awayScore>homeScore?'away':'tie';
        }
      }
    }
    const status = game.completed?'final':game.scores?'live':'scheduled';
    return {
      result_snapshot_id: 'RS_'+sport+'_'+game.id,
      sport: sp, event_id:game.id, canonical_game_key:cKey,
      home_team:game.home_team, away_team:game.away_team,
      commence_time:game.commence_time, status,
      home_score:homeScore, away_score:awayScore, winner,
      final_at:game.completed?now:null,
      source:'odds-api', fetched_at:now
    };
  });
  if (!rows.length) return;
  try {
    await sb.from('result_snapshots').upsert(rows, { onConflict:'canonical_game_key' });
    console.log('[results] upserted '+rows.length+' result snapshots for '+sport);
  } catch(e) { console.warn('[results] upsert error:', e.message); }
}

// Derive leg outcome from result snapshot
function _deriveLegOutcome(leg, result) {
  if (!result) return { outcome:'error', reason:'result_missing' };
  if (result.status !== 'final') return { outcome:'pending', reason:'result_not_final', status:result.status };
  const market   = (leg.market||'moneyline').toLowerCase().replace('run line','spread').replace('puck line','spread');
  const pick     = (leg.pick||'').toLowerCase();
  const homeTeam = (result.home_team||'').toLowerCase();
  const awayTeam = (result.away_team||'').toLowerCase();
  const homeScore= parseInt(result.home_score,10)||0;
  const awayScore= parseInt(result.away_score,10)||0;

  if (market==='moneyline'||market==='h2h') {
    if (homeScore===awayScore) return { outcome:'push', reason:'tie' };
    const pickedHome = pick.includes(homeTeam);
    const pickedAway = pick.includes(awayTeam);
    if (result.winner==='home'&&pickedHome) return { outcome:'won' };
    if (result.winner==='away'&&pickedAway) return { outcome:'won' };
    return { outcome:'lost' };
  }
  if (market==='spread'||market==='run line') {
    const line = parseFloat(leg.accepted_point_line||leg.line||0);
    const pickedHome = pick.includes(homeTeam);
    const margin = homeScore-awayScore;
    const adjusted = pickedHome ? margin+line : awayScore-homeScore+line;
    if (Math.abs(adjusted)<0.001) return { outcome:'push' };
    return adjusted>0 ? { outcome:'won' } : { outcome:'lost' };
  }
  if (market==='total'||market==='totals') {
    const total = homeScore+awayScore;
    const line  = parseFloat(leg.accepted_point_line||leg.line||0);
    const pickOver = pick.includes('over');
    if (Math.abs(total-line)<0.001) return { outcome:'push' };
    return (pickOver?total>line:total<line) ? { outcome:'won' } : { outcome:'lost' };
  }
  return { outcome:'error', reason:'unsupported_market:'+market };
}

// Derive combined ticket outcome from all legs
function _deriveTicketOutcome(ticket, legs, resultsByKey) {
  const type = (ticket.type||'single').toLowerCase();
  if (!legs.length) return { outcome:'error', reason:'no_legs' };
  const legOutcomes = legs.map(function(leg) {
    const result = resultsByKey[leg.canonical_game_key||'']||null;
    return Object.assign({ leg:leg.pick }, _deriveLegOutcome(leg, result));
  });
  const pending = legOutcomes.find(function(l){ return l.outcome==='pending'||l.outcome==='error'; });
  if (pending) return { outcome:pending.outcome, reason:pending.reason, leg:pending.leg };
  if (type==='single'||type==='straight') return legOutcomes[0];
  // Parlay
  const anyLost = legOutcomes.find(function(l){ return l.outcome==='lost'; });
  if (anyLost) return { outcome:'lost' };
  const anyPush = legOutcomes.find(function(l){ return l.outcome==='push'; });
  if (anyPush) return { outcome:'push' };
  return legOutcomes.every(function(l){ return l.outcome==='won'; }) ? { outcome:'won' } : { outcome:'lost' };
}
// ───────────────────────────────────────────────────────────────────────────

// POST /api/grade/run — authoritative server-side grading
// Reads tickets from Supabase, fetches scores, grades, writes ledger + audit.
// ════════════════════════════════════════════════════════════════════════════

const FINAL_STATUSES_SG = new Set(['final','f','completed','complete','closed',
  'cancelled','canceled','postponed','suspended','forfeit','f/ot','f/so']);

function _sgIsGameFinal(s) { return s ? FINAL_STATUSES_SG.has(String(s).toLowerCase().trim()) : false; }

function _sgNorm(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/\s+/g,' ').trim().replace(/^the\s+/,'');
}

function _sgSameDateUTC(msA, msB) {
  if (!msA || !msB) return true;
  var a = new Date(msA), b = new Date(msB);
  return a.getUTCFullYear()===b.getUTCFullYear()&&a.getUTCMonth()===b.getUTCMonth()&&a.getUTCDate()===b.getUTCDate();
}

function _sgAmToDecimal(o) {
  var n = parseInt(String(o||0).replace('+',''));
  if (!n || isNaN(n)) return 1;
  return n > 0 ? n/100+1 : 100/Math.abs(n)+1;
}

function _sgFindGame(leg, games) {
  var selMs  = leg.scheduled_start ? new Date(leg.scheduled_start).getTime() : 0;
  var provId = leg.provider_game_id || null;
  var cKey   = leg.canonical_game_key || null;
  var selH   = _sgNorm(leg.home_team), selA = _sgNorm(leg.away_team);

  if (provId) {
    var p1 = games.find(function(g){ return g.id===provId || String(g.id)===String(provId); });
    if (p1) return { game:p1, method:'provider_game_id' };
  }
  if (cKey) {
    var sport = (leg.sport||'mlb').toUpperCase();
    var p2 = games.filter(function(g){
      var ga=_sgNorm(g.away||''), gh=_sgNorm(g.home||'');
      var gMs = g._commenceMs||0;
      var gDate = gMs ? new Date(gMs).toISOString().slice(0,10) : '';
      var gKey = sport+'|'+ga.replace(/\s+/g,'-')+'|'+gh.replace(/\s+/g,'-')+'|'+gDate;
      return gKey === cKey;
    });
    if (p2.length===1) return { game:p2[0], method:'canonical_game_key' };
    if (p2.length>1)  return { game:null, reason:'ambiguous_match_refused', method:'canonical_game_key', candidates:p2.length };
  }
  if (selH && selA) {
    var p3 = games.filter(function(g){
      var gh=_sgNorm(g.home||''), ga=_sgNorm(g.away||'');
      var teams=(gh===selH&&ga===selA)||(gh===selA&&ga===selH);
      if (!teams) return false;
      return selMs>0&&g._commenceMs>0 ? _sgSameDateUTC(selMs,g._commenceMs) : true;
    });
    if (p3.length===1) return { game:p3[0], method:'teams_date' };
    if (p3.length>1)  return { game:null, reason:'ambiguous_match_refused', method:'teams_date', candidates:p3.length };
    return { game:null, reason:'no_candidate', method:'teams_date', candidates:0 };
  }
  return { game:null, reason:'no_match_found', method:'none', candidates:0 };
}

function _sgGradeLeg(leg, game) {
  var pick   = _sgNorm(leg.pick||'');
  var market = (leg.market||'').toLowerCase();
  var hs=game.home_score||game.homeScore, as=game.away_score||game.awayScore;
  var home=_sgNorm(game.home||''), away=_sgNorm(game.away||'');
  if (market.includes('moneyline')||market.includes('to win')) {
    var winner=hs>as?home:as>hs?away:null;
    if (!winner) return 'push';
    return (pick.includes(winner)||pick.includes(winner.split(' ').pop()))?'won':'lost';
  }
  if (market.includes('run line')||market.includes('spread')) {
    var m=pick.match(/([+-]?\d+\.?\d*)/);
    if (!m) return null;
    var spread=parseFloat(m[1]);
    var isH=pick.includes(home)||pick.includes(home.split(' ').pop());
    var margin=isH?(hs-as):(as-hs); var adj=margin+spread;
    return adj>0?'won':adj<0?'lost':'push';
  }
  if (market.includes('total')||market.includes('over')||market.includes('under')) {
    var m2=pick.match(/(\d+\.?\d*)/);
    if (!m2) return null;
    var line=parseFloat(m2[1]); var total=hs+as;
    var isOver=pick.includes('over')||/^o\s/.test(pick);
    if (total===line) return 'push';
    return (isOver?total>line:total<line)?'won':'lost';
  }
  return null;
}

async function _sgFetchCompletedGames(daysBack) {
  daysBack = daysBack || 3;
  const oddsKey = process.env.ODDS_API_KEY;
  if (!oddsKey) return [];
  return new Promise(function(resolve) {
    const https = require('https');
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/scores/?apiKey=${oddsKey}&daysFrom=${daysBack}`;
    const req = https.get(url, function(r) {
      let d = '';
      r.on('data', function(c){ d+=c; });
      r.on('end', function(){
        try {
          const parsed = JSON.parse(d);
          if (!Array.isArray(parsed)) { resolve([]); return; }
          const completed = parsed.filter(function(g){ return g.completed&&g.scores&&g.scores.length>=2; });
          const games = completed.map(function(g) {
            const hs = parseInt((g.scores.find(function(s){ return s.name===g.home_team; })||{}).score||0);
            const as = parseInt((g.scores.find(function(s){ return s.name===g.away_team; })||{}).score||0);
            const cMs = g.commence_time ? new Date(g.commence_time).getTime() : 0;
            return { id:g.id, home:g.home_team, away:g.away_team,
              home_score:hs, away_score:as, status:'Final', completed:true,
              _commenceMs:cMs };
          });
          resolve(games);
        } catch(e) { resolve([]); }
      });
    });
    req.on('error', function(){ resolve([]); });
    req.setTimeout(8000, function(){ req.destroy(); resolve([]); });
  });
}

// POST /api/grade/manual — admin manual grade override
app.post('/api/grade/manual', requireCanonicalClubId, requirePermissionScoped('run_server_grade'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor||{};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin)
    return res.status(403).json({ ok:false, error:'insufficient_role', required:'full_admin' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const { ticketId, result, reason, overrideCode, clubId } = req.body||{};
  if (!ticketId||!result||!reason||!overrideCode)
    return res.status(400).json({ ok:false, error:'missing_required_field' });
  if (!['won','lost','push'].includes(result))
    return res.status(400).json({ ok:false, error:'invalid_result:'+result });
  if (!GRADING_SETTLEMENT_ENABLED || !MANUAL_GRADE_SETTLEMENT_ENABLED)
    return res.status(503).json({ ok:false, error:'grading_settlement_disabled',
      reason:GRADING_DISABLED_REASON, containment:_gradingContainmentStatus() });
  try {
    const { data:tData } = await sb.from('tickets')
      .select('id,status,player_id,club_id,risk_amount,potential_profit').eq('id',ticketId).limit(1);
    const ticket = tData&&tData[0];
    if (!ticket) return res.status(404).json({ ok:false, error:'ticket_not_found' });
    if (['won','lost','push','canceled','voided'].includes(ticket.status))
      return res.status(409).json({ ok:false, error:'already_graded', status:ticket.status });
    const profit = parseFloat(ticket.potential_profit)||0;
    const iKey   = 'MANUAL_'+result+'_'+ticketId;
    const gradeResult = await _callMoneyRpc('grade_ticket_tx', {
      p_ticket_id:ticket.id, p_club_id:ticket.club_id||clubId||'',
      p_player_id:ticket.player_id, p_grade_result:result, p_profit:profit,
      p_idempotency_key:iKey, p_created_by:actor.actorId||'admin'
    });
    if (!gradeResult.ok && !gradeResult.idempotent)
      return res.status(400).json({ ok:false, error:gradeResult.error||'grade_failed' });
    await sb.from('grade_overrides').insert({
      ticket_id:ticketId, player_id:ticket.player_id, club_id:ticket.club_id||clubId,
      result, override_code:overrideCode, reason,
      created_by:actor.actorId||'admin', actor_role:actor.role
    });
    await sb.from('audit_events').insert({
      event_type:'manual_grade_override', ticket_id:ticketId,
      player_id:ticket.player_id, club_id:ticket.club_id||clubId,
      payload:{ result, reason, overrideCode, createdBy:actor.actorId, actorRole:actor.role }
    });
    emitRiskAlert('manual_override_used', clubId||ticket.club_id, actor.actorId,
      { ticketId, result, overrideCode });
    console.log('[grade/manual] ticketId='+ticketId+' result='+result+' code='+overrideCode);
    res.json({ ok:true, ticketId, result, overrideCode, balanceAfter:gradeResult.balance_after });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/grade/run', requireCanonicalClubId, requirePermissionScoped('grade_trigger'), requireIdempotency({required:false}), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });

  const { daysBack=3, playerId, clubId } = req.body||{};
  const nowMs = Date.now();
  const gradedAt = new Date().toISOString();

  try {
    // 1. Load active tickets from Supabase
    let tq = sb.from('tickets')
      .select('id,type,status,risk_amount,potential_profit,estimated_payout,graded_at,player_id,club_id')
      .in('status',['active','open']);
    if (playerId) tq = tq.eq('player_id', playerId);
    if (clubId)   tq = tq.eq('club_id',   clubId);
    const { data: tickets, error: tErr } = await tq;
    if (tErr) throw tErr;
    if (!tickets || !tickets.length) return res.json({ ok:true, checked:0, graded:0, skipped:0, errors:[], results:[] });

    // Load legs for these tickets
    const ticketIds = tickets.map(function(t){ return t.id; });
    const { data: allLegs, error: lErr } = await sb.from('ticket_legs')
      .select('id,ticket_id,leg_index,pick,market,odds,line,sport,home_team,away_team,canonical_game_key,scheduled_start,provider_game_id,game_status,leg_result')
      .in('ticket_id', ticketIds);
    if (lErr) throw lErr;

    // 2. Phase M: fetch result snapshots from DB (server-trusted results only)
    const uniqueKeys = [...new Set((allLegs||[]).map(function(l){ return l.canonical_game_key||''; }).filter(Boolean))];
    let resultsByKey = {};
    if (uniqueKeys.length) {
      try {
        const { data: snapRows } = await sb.from('result_snapshots').select('*')
          .in('canonical_game_key', uniqueKeys);
        (snapRows||[]).forEach(function(r){ resultsByKey[r.canonical_game_key]=r; });
        // Also try to refresh from Odds API scores
        const sports = [...new Set((allLegs||[]).map(function(l){ return (l.sport||'baseball_mlb').toLowerCase(); }))];
        for (const sport of sports) {
          try {
            const url = `https://api.the-odds-api.com/v4/sports/${sport}/scores/?apiKey=${ODDS_KEY}&daysFrom=${daysBack}`;
            const scoresData = await new Promise(function(resolve) {
              const https = require('https');
              const req = https.get(url, function(res) {
                let d=''; res.on('data',function(c){d+=c;}); res.on('end',function(){try{resolve(JSON.parse(d));}catch(_e){resolve([]);}});
              }); req.on('error',function(){ resolve([]); }); req.setTimeout(8000,function(){ req.destroy(); resolve([]); });
            });
            if (Array.isArray(scoresData)) {
              await _upsertResultSnapshots(scoresData, sport);
              // Re-load updated snapshots
              scoresData.forEach(function(g){
                if (!g.completed) return;
                const sp=g.sport_key.includes('baseball')?'MLB':g.sport_key.split('_')[0].toUpperCase();
                const away=(g.away_team||'').toLowerCase().replace(/\s+/g,'-');
                const home=(g.home_team||'').toLowerCase().replace(/\s+/g,'-');
                const date=(g.commence_time||'').slice(0,10);
                const cKey=sp+'|'+away+'|'+home+'|'+date;
                const scores=g.scores||[];
                const h=scores.find(function(s){return s.name===g.home_team;});
                const a=scores.find(function(s){return s.name===g.away_team;});
                if(h&&a){
                  resultsByKey[cKey]={ status:'final', home_team:g.home_team, away_team:g.away_team,
                    home_score:parseInt(h.score,10)||0, away_score:parseInt(a.score,10)||0,
                    winner:parseInt(h.score,10)>parseInt(a.score,10)?'home':parseInt(a.score,10)>parseInt(h.score,10)?'away':'tie' };
                }
              });
            }
          } catch(_e) { console.warn('[grade/run] score fetch for '+sport+':', _e.message); }
        }
      } catch(_e) { console.warn('[grade/run] result load error:', _e.message); }
    }

    console.log('[server grade] tickets='+tickets.length+' resultKeys='+Object.keys(resultsByKey).length);
    const results = [];
    let graded = 0, skipped = 0;
    const errors = [];

    for (const ticket of tickets) {
      const ticketLegs = (allLegs||[]).filter(function(l){ return l.ticket_id===ticket.id; })
        .sort(function(a,b){ return (a.leg_index||0)-(b.leg_index||0); });
      const row = { ticketId:ticket.id, statusBefore:ticket.status, statusAfter:null,
        result:null, source:'result_snapshot', payoutDelta:0, ledgerEntryId:null,
        auditEventId:null, reason:null };

      try {
        if (ticket.graded_at) { row.reason='already_graded'; skipped++; results.push(row); continue; }

        // Phase M: derive outcome from server result snapshots only
        const outcome = _deriveTicketOutcome(ticket, ticketLegs, resultsByKey);
        if (outcome.outcome==='error') { row.reason=outcome.reason||'result_conflict'; skipped++; results.push(row); continue; }
        if (outcome.outcome==='pending') { row.reason=outcome.reason||'result_not_final'; skipped++; results.push(row); continue; }
        const combined = outcome.outcome; // 'won'|'lost'|'push'

        const risk   = parseFloat(ticket.risk_amount)||0;
        const profit = parseFloat(ticket.potential_profit)||0;
        const payout = combined==='won'?Math.round((risk+profit)*100)/100:combined==='push'?risk:0;
        const delta  = combined==='won'?profit:combined==='push'?0:-risk;

        if (!GRADING_SETTLEMENT_ENABLED) {
          if (!GRADE_RUN_DRY_RUN_ENABLED)
            throw new Error('grading_settlement_disabled:'+GRADING_DISABLED_REASON);
          row.statusAfter=ticket.status; row.result=combined; row.payoutDelta=delta;
          row.dryRun=true; row.settlementDisabled=true; row.reason='dry_run:'+GRADING_DISABLED_REASON;
          row.wouldPayout=payout; row.wouldCanonicalLedgerId='LE_GR_'+ticket.id+'_'+combined;
          skipped++;
          results.push(row);
          continue;
        }

        // Phase I+M: call grade_ticket_tx RPC
        const iKey = 'SG_'+combined+'_'+ticket.id;
        const gradeResult = await _callMoneyRpc('grade_ticket_tx', {
          p_ticket_id:ticket.id, p_club_id:ticket.club_id||'', p_player_id:ticket.player_id,
          p_grade_result:combined, p_profit:profit,
          p_idempotency_key:iKey, p_created_by:'server-grade-api'
        });
        if (!gradeResult.ok && !gradeResult.idempotent)
          throw new Error('grade_rpc_rejected:'+gradeResult.error);

        console.log('[grade/run] canonical settlement ok ticketId='+ticket.id+
          ' result='+combined+' ledgerEntryId='+(gradeResult.ledger_entry_id||iKey));

        const { data: auditData } = await sb.from('audit_events').insert({
          event_type:'ticket_graded_server',
          ticket_id:ticket.id, player_id:ticket.player_id, club_id:ticket.club_id,
          payload:{ result:combined, source:'result_snapshot', legCount:ticketLegs.length,
                    payout, delta, rpcOk:gradeResult.ok, balanceAfter:gradeResult.balance_after }
        }).select('id');

        row.statusAfter=combined; row.result=combined; row.payoutDelta=delta;
        row.ledgerEntryId=gradeResult.ledger_entry_id||iKey;
        row.canonicalLedgerId=gradeResult.ledger_entry_id||iKey;
        row.auditEventId=auditData&&auditData[0]?auditData[0].id:null;
        row.balanceAfter=gradeResult.balance_after;
        graded++;
        console.log('[server grade] graded ticketId='+ticket.id+' result='+combined+' source=result_snapshot');

      } catch(ticketErr) {
        row.reason='error:'+ticketErr.message;
        errors.push({ ticketId:ticket.id, error:ticketErr.message });
        console.error('[server grade] error on ticket', ticket.id, ticketErr.message);
      }
      results.push(row);
    }

    res.json({ ok:true,
      mode:GRADING_SETTLEMENT_ENABLED?'settlement':'dry_run',
      settlementDisabled:!GRADING_SETTLEMENT_ENABLED,
      containment:_gradingContainmentStatus(),
      checked:tickets.length, graded, skipped, errors, results });
  } catch(e) {
    console.error('[server grade] fatal:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── HOST DASHBOARD DB READ (Phase C Step 2) ────────────────────────────────────────────────────────
// ══ CLUB MEMBERSHIP MANAGEMENT ENDPOINTS ═══════════════════════════════════════════════════════════════════════

// Helper: assert actor is owner/full_admin in the scoped club
function _requireMemberAdmin(actor) {
  if (actor.error) return actor;
  const rank = ROLE_RANK[actor.role] != null ? ROLE_RANK[actor.role] : -99;
  if (rank < ROLE_RANK.full_admin) return { error:'insufficient_role', required:'full_admin', status:403 };
  return null;
}

// GET /api/club/members
app.get('/api/club/members', requirePermissionScoped('view_settlement_history'), async (req, res) => {
  if (req._clubId) req.query = Object.assign({}, req.query, { clubId: req._clubId });
  const { clubId } = req.query;
  if (!clubId) return res.status(400).json({ ok:false, error:'missing_clubId' });
  try {
    const sb = getSupabase();
    let members = [];
    if (sb) {
      const { data } = await sb.from('club_memberships').select('*').eq('club_id',clubId).order('joined_at');
      members = data || [];
    }
    res.json({ ok:true, members, clubId });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/club/members/invite
app.post('/api/club/members/invite', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor || {};
  const deny  = _requireMemberAdmin(actor);
  if (deny) return res.status(deny.status||403).json({ ok:false, error:deny.error });
  const { clubId, targetActorId, role } = req.body || {};
  if (!targetActorId) return res.status(400).json({ ok:false, error:'missing_targetActorId' });
  const inviteRole = ROLE_RANK[role] != null ? role : 'player';
  const now = new Date().toISOString();
  const row = { actor_id:targetActorId, club_id:clubId, role:inviteRole, status:'pending',
                joined_at:now, updated_at:now, updated_by:actor.actorId||'system' };
  try {
    const sb = getSupabase();
    if (sb) await sb.from('club_memberships').upsert(row, { onConflict:'actor_id,club_id' });
    _membershipInvalidate(targetActorId, clubId);
    _writeAuthAudit('member_invited', actor.actorId, clubId, '/club/members/invite',
      { targetActorId, role:inviteRole });
    res.json({ ok:true, targetActorId, role:inviteRole, status:'pending' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/club/members/approve
app.post('/api/club/members/approve', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor || {};
  const deny  = _requireMemberAdmin(actor);
  if (deny) return res.status(deny.status||403).json({ ok:false, error:deny.error });
  const { clubId, targetActorId } = req.body || {};
  if (!targetActorId) return res.status(400).json({ ok:false, error:'missing_targetActorId' });
  try {
    const sb = getSupabase();
    if (sb) await sb.from('club_memberships')
      .update({ status:'active', updated_at:new Date().toISOString(), updated_by:actor.actorId })
      .eq('actor_id',targetActorId).eq('club_id',clubId).eq('status','pending');
    _membershipInvalidate(targetActorId, clubId);
    _writeAuthAudit('member_approved', actor.actorId, clubId, '/club/members/approve', { targetActorId });
    res.json({ ok:true, targetActorId, status:'active' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/club/members/update-role
app.post('/api/club/members/update-role', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor || {};
  const deny  = _requireMemberAdmin(actor);
  if (deny) return res.status(deny.status||403).json({ ok:false, error:deny.error });
  const { clubId, targetActorId, newRole } = req.body || {};
  if (!targetActorId || !newRole) return res.status(400).json({ ok:false, error:'missing_fields' });
  if (!ROLE_RANK.hasOwnProperty(newRole)) return res.status(400).json({ ok:false, error:'invalid_role:'+newRole });
  try {
    const sb = getSupabase();
    let oldRole = null;
    if (sb) {
      const { data } = await sb.from('club_memberships').select('role').eq('actor_id',targetActorId).eq('club_id',clubId).limit(1);
      if (data && data[0]) oldRole = data[0].role;
      await sb.from('club_memberships')
        .update({ role:newRole, updated_at:new Date().toISOString(), updated_by:actor.actorId })
        .eq('actor_id',targetActorId).eq('club_id',clubId);
    }
    _membershipInvalidate(targetActorId, clubId);
    // Revoke sessions so next token fetch gets new role
    await _sessionRevokeByActor(targetActorId, clubId, 'role_changed');
    _writeAuthAudit('member_role_updated', actor.actorId, clubId, '/club/members/update-role',
      { targetActorId, oldRole, newRole });
    res.json({ ok:true, targetActorId, oldRole, newRole });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/club/members/suspend
app.post('/api/club/members/suspend', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor || {};
  const deny  = _requireMemberAdmin(actor);
  if (deny) return res.status(deny.status||403).json({ ok:false, error:deny.error });
  const { clubId, targetActorId, reason } = req.body || {};
  if (!targetActorId) return res.status(400).json({ ok:false, error:'missing_targetActorId' });
  try {
    const sb = getSupabase();
    if (sb) await sb.from('club_memberships')
      .update({ status:'suspended', updated_at:new Date().toISOString(), updated_by:actor.actorId })
      .eq('actor_id',targetActorId).eq('club_id',clubId);
    _membershipInvalidate(targetActorId, clubId);
    await _sessionRevokeByActor(targetActorId, clubId, 'suspended');
    _writeAuthAudit('member_suspended', actor.actorId, clubId, '/club/members/suspend',
      { targetActorId, reason });
    res.json({ ok:true, targetActorId, status:'suspended' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/club/members/remove
app.post('/api/club/members/remove', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor || {};
  const deny  = _requireMemberAdmin(actor);
  if (deny) return res.status(deny.status||403).json({ ok:false, error:deny.error });
  const { clubId, targetActorId } = req.body || {};
  if (!targetActorId) return res.status(400).json({ ok:false, error:'missing_targetActorId' });
  try {
    const sb = getSupabase();
    if (sb) await sb.from('club_memberships')
      .update({ status:'removed', updated_at:new Date().toISOString(), updated_by:actor.actorId })
      .eq('actor_id',targetActorId).eq('club_id',clubId);
    _membershipInvalidate(targetActorId, clubId);
    await _sessionRevokeByActor(targetActorId, clubId, 'removed');
    _writeAuthAudit('member_removed', actor.actorId, clubId, '/club/members/remove', { targetActorId });
    res.json({ ok:true, targetActorId, status:'removed' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
// ───────────────────────────────────────────────────────────────────────────

// ══ SESSION TOKEN ISSUANCE ═══════════════════════════════════════════════════════════════════════════
// POST /api/auth/token — issue a signed session token (role from DB in production)
app.post('/api/auth/token', requireCanonicalClubId, async (req, res) => {
  const { actorId, clubId, role: requestedRole } = req.body || {};
  if (!actorId) return res.status(400).json({ ok:false, error:'missing_actorId' });
  if (!clubId)  return res.status(400).json({ ok:false, error:'missing_clubId'  });
  // Phase G: DB is source of truth for role
  const resolved = await _resolveTokenRole(actorId, clubId, requestedRole);
  if (!resolved.ok) {
    console.log('[auth/token] denied reason='+resolved.error);
    _writeAuthAudit(resolved.error, actorId, clubId, '/auth/token', { requestedRole });
    return res.status(403).json({ ok:false, error:resolved.error, status:resolved.status });
  }
  const finalRole   = resolved.role;
  const platRole    = PLATFORM_ADMIN_ALLOWLIST.includes(actorId) ? 'platform_admin' : null;
  const { token, jti } = await issueSessionToken(actorId, finalRole, clubId, 86400, platRole);
  console.log('[auth/token] issued role='+finalRole+(platRole?' [platform_admin]':''));
  res.json({ ok:true, token, jti, actorId, role:finalRole, clubId, expiresIn:86400 });
});

// POST /api/auth/refresh — rotate token (revoke old jti, issue new)
app.post('/api/auth/refresh', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if (!actor.jti)  return res.status(400).json({ ok:false, error:'no_jti_to_rotate' });
  // Revoke old session
  const oldRow = _sessionMemStore.get(actor.jti);
  if (oldRow) {
    oldRow.status='revoked'; oldRow.revoked_at=new Date().toISOString();
    oldRow.revoke_reason='rotated';
    await _sessionSave(oldRow);
  }
  // Issue new session
  const { token:newToken, jti:newJti } = await issueSessionToken(
    actor.actorId, actor.role, actor.clubId, 86400, actor.platformRole);
  _writeAuthAudit('session_refreshed', actor.actorId, actor.clubId, '/auth/refresh',
    { oldJti:actor.jti, newJti });
  console.log('[session] rotated oldJti='+actor.jti+' newJti='+newJti);
  res.json({ ok:true, token:newToken, jti:newJti, expiresIn:86400 });
});

// POST /api/auth/logout — revoke current token
app.post('/api/auth/logout', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if (actor.jti) {
    const row = _sessionMemStore.get(actor.jti);
    if (row) {
      row.status='revoked'; row.revoked_at=new Date().toISOString();
      row.revoke_reason='logout';
      await _sessionSave(row);
    }
    _writeAuthAudit('session_revoked', actor.actorId, actor.clubId, '/auth/logout',
      { jti:actor.jti, reason:'logout' });
    console.log('[session] logout jti='+actor.jti);
  }
  res.json({ ok:true, loggedOut:true });
});

// POST /api/auth/revoke-session — admin revoke (owner/full_admin/platform_admin)
app.post('/api/auth/revoke-session', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const rank = ROLE_RANK[actor.role] != null ? ROLE_RANK[actor.role] : -99;
  if (rank < ROLE_RANK.full_admin && actor.platformRole !== 'platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { targetActorId, targetClubId, reason, jti: targetJti } = req.body || {};
  if (targetJti) {
    // Revoke specific session
    const row = await _sessionLoad(targetJti);
    if (!row) return res.status(404).json({ ok:false, error:'session_not_found' });
    row.status='revoked'; row.revoked_at=new Date().toISOString();
    row.revoke_reason=reason||'admin_revoke';
    await _sessionSave(row);
    _writeAuthAudit('session_revoked', actor.actorId, actor.clubId, '/auth/revoke-session',
      { targetJti, reason:reason||'admin_revoke', byActor:actor.actorId });
    return res.json({ ok:true, revokedJti:targetJti });
  }
  if (targetActorId) {
    const count = await _sessionRevokeByActor(targetActorId, targetClubId||'', reason||'admin_revoke');
    _writeAuthAudit('session_revoked', actor.actorId, actor.clubId, '/auth/revoke-session',
      { targetActorId, targetClubId, revokedCount:count, byActor:actor.actorId });
    return res.json({ ok:true, revokedCount:count });
  }
  res.status(400).json({ ok:false, error:'missing targetActorId or jti' });
});

// GET /api/auth/verify — verify token + session, return actor info
app.get('/api/auth/verify', (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  res.json({ ok:true, actorId:actor.actorId, role:actor.role, clubId:actor.clubId,
             jti:actor.jti, isDevBypass:actor.isDevBypass, fromToken:actor.fromToken||false });
});
// ───────────────────────────────────────────────────────────────────────────

// ══ LIVE MARKETS API ═══════════════════════════════════════════════════════════════════════════
app.get('/api/markets/live', (req, res) => {
  const nowMs = Date.now();
  const cache = LIVE_MARKET_CACHE;
  const cacheAgeMs = cache.updatedAt ? nowMs - new Date(cache.updatedAt).getTime() : null;
  const sport = req.query.sport;
  const since = req.query.since ? new Date(req.query.since).getTime() : null;
  const minimal = req.query.minimal === 'true';

  // Collect suspended/closed markets
  const suspendedMarkets = _getSuspendedMarkets(cache, nowMs);

  // Filter games by sport if requested
  let games = cache.games;
  if (sport) games = games.filter(g => g.sport_key && g.sport_key.toLowerCase().includes(sport.toLowerCase()));

  // Filter by since timestamp
  if (since) games = games.filter(g => g.commence_time && new Date(g.commence_time).getTime() >= since);

  // Build warnings
  const warnings = [];
  if (cacheAgeMs !== null && cacheAgeMs > CACHE_STALE_THRESHOLD) warnings.push('cache_stale');
  if (cache.sourceStatus === 'stale_preserved') warnings.push('using_preserved_cache');
  if (cache.gameCount === 0) warnings.push('cache_empty');

  res.json({
    updatedAt:  cache.updatedAt,
    cacheAgeMs, fetchDurationMs: cache.fetchDurationMs,
    source: 'server_cache', sourceStatus: cache.sourceStatus,
    gameCount: cache.gameCount, marketCount: cache.marketCount,
    games: minimal ? [] : games,
    suspendedMarkets,
    warnings,
    lastSuccessAt: cache.lastSuccessAt
  });
});

// GET /api/markets/live-count — lightweight payload for the bottom-nav "Live" badge.
// Returns the number of in-progress games across all sports, plus a per-sport breakdown.
// Designed to be polled by the frontend on the same cadence as the odds refresh.
app.get('/api/markets/live-count', (req, res) => {
  const cache = LIVE_MARKET_CACHE;
  const games = (cache && Array.isArray(cache.games)) ? cache.games : [];
  const nowMs = Date.now();
  const bySport = {};
  let total = 0;
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    const status = g.status || _deriveGameStatus(g);
    if (status !== 'live') continue;
    total++;
    // Map full sport key (e.g. "baseball_mlb") back to the short key ("mlb") for the UI
    let short = String(g.sport_key||'').toLowerCase();
    for (const k in _CACHE_SPORT_KEY_BY_SHORT) {
      if (_CACHE_SPORT_KEY_BY_SHORT[k] === short || k === short) { short = k; break; }
    }
    bySport[short] = (bySport[short]||0) + 1;
  }
  res.setHeader('Cache-Control', 'public, max-age=10');
  res.json({
    ok: true,
    total: total,
    bySport: bySport,
    updatedAt: (cache && cache.updatedAt) || null,
    cacheAgeMs: (cache && cache.updatedAt) ? (nowMs - new Date(cache.updatedAt).getTime()) : null
  });
});

// GET /api/odds/live — cross-sport live games feed for the DK-style Live tab.
// Returns ONLY status==='live' games, projected to the flat board shape (with
// scoreboard fields where the feed supplies them) and pre-sorted by sport then time.
// Optional ?sport=mlb,nba narrows the set; default = all sports.
app.get('/api/odds/live', (req, res) => {
  const cache = LIVE_MARKET_CACHE;
  const games = (cache && Array.isArray(cache.games)) ? cache.games : [];
  const sportFilter = String(req.query.sport||'').toLowerCase().split(',').filter(Boolean);
  const out = [];
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    const status = g.status || _deriveGameStatus(g);
    if (status !== 'live') continue;
    // Resolve short sport key for projection + filter
    let short = String(g.sport_key||'').toLowerCase();
    for (const k in _CACHE_SPORT_KEY_BY_SHORT) {
      if (_CACHE_SPORT_KEY_BY_SHORT[k] === short || k === short) { short = k; break; }
    }
    if (sportFilter.length && sportFilter.indexOf(short) < 0) continue;
    const flat = _projectOwlsGameToFlat(g, short.toUpperCase());
    if (flat && flat.home && flat.away) {
      flat.sportKey = short;
      out.push(flat);
    }
  }
  // Sort: by sport then by commence_time asc (most-progressed games first)
  out.sort(function(a,b){
    if (a.sportKey !== b.sportKey) return a.sportKey < b.sportKey ? -1 : 1;
    const ta = a.time ? new Date(a.time).getTime() : Infinity;
    const tb = b.time ? new Date(b.time).getTime() : Infinity;
    return ta - tb;
  });
  res.setHeader('Cache-Control', 'public, max-age=5');
  res.setHeader('X-Live-Count', String(out.length));
  res.json({
    ok: true,
    total: out.length,
    games: out,
    updatedAt: (cache && cache.updatedAt) || null,
    refreshIntervalMs: LIVE_CACHE_POLL_INTERVAL_MS
  });
});

// GET /api/markets/health — cache health widget for host dashboard
app.get('/api/markets/health', (req, res) => {
  const nowMs = Date.now();
  const cache = LIVE_MARKET_CACHE;
  const cacheAgeMs = cache.updatedAt ? nowMs - new Date(cache.updatedAt).getTime() : null;
  const suspendedCount = _getSuspendedMarkets(cache, nowMs).length;
  res.json({
    status: cache.sourceStatus,
    gameCount: cache.gameCount, marketCount: cache.marketCount,
    suspendedMarkets: suspendedCount,
    cacheAgeMs, fetchDurationMs: cache.fetchDurationMs,
    lastSuccessAt: cache.lastSuccessAt, updatedAt: cache.updatedAt,
    healthy: cache.sourceStatus === 'healthy' && (cacheAgeMs === null || cacheAgeMs < CACHE_STALE_THRESHOLD)
  });
});

// GET /api/markets/status — live market health for frontend banner
app.get('/api/markets/status', async (req, res) => {
  const nowMs = Date.now();
  const cache = LIVE_MARKET_CACHE;
  const cacheAgeMs = cache.updatedAt ? nowMs - new Date(cache.updatedAt).getTime() : null;
  // Count markets by state from cache (fast, no DB hit)
  let active=0, live=0, suspended=0, stale=0, finalCount=0, canceled=0;
  Object.values(cache.marketsByCanonicalKey).forEach(function(entry) {
    const state = _classifyMarket({
      fetched_at: entry.updatedAt,
      suspended: entry.suspended,
      commence_time: entry.commenceTime,
      event_status: entry.gameStatus,
      market_status: entry.marketStatus,
      eventCompleted: entry.eventCompleted,
      eventCanceled: entry.eventCanceled,
      eventLive: entry.eventLive
    }, nowMs);
    if (state==='active')        active++;
    else if (state==='live')      { live++; active++; } // live counts as placeable
    else if (state==='suspended') suspended++;
    else if (state==='stale')     stale++;
    else if (state==='final')     finalCount++;
    else if (state==='canceled')  canceled++;
  });
  const warnings = [];
  if (stale > 0)         warnings.push('stale_markets:'+stale);
  if (suspended > 0)     warnings.push('suspended_markets:'+suspended);
  if (cache.gameCount===0) warnings.push('no_markets_loaded');
  if (cacheAgeMs && cacheAgeMs > SNAPSHOT_TTL_MS) warnings.push('cache_stale');
  const serviceOk = IS_PRODUCTION
    ? (cache.gameCount > 0 && (!cacheAgeMs || cacheAgeMs < SNAPSHOT_TTL_MS))
    : true; // dev: always ok
  res.json({
    ok:true, serviceOk,
    sourceStatus:cache.sourceStatus, lastSuccessAt:cache.lastSuccessAt,
    cacheAgeMs, gameCount:cache.gameCount, marketCount:cache.marketCount,
    activeMarketCount:active,
    liveMarketCount:live,
    suspendedMarketCount:suspended,
    staleMarketCount:stale,
    finalMarketCount:finalCount,
    canceledMarketCount:canceled,
    warnings
  });
});

// POST /api/markets/refresh — force cache refresh (dev/admin)
app.post('/api/markets/refresh', requirePermissionScoped('force_market_refresh'), requireIdempotency({required:false}), async (req, res) => {
  try {
    await pollLiveOddsLoop();
    const cache = LIVE_MARKET_CACHE;
    console.log('[live cache] forced refresh: games='+cache.gameCount+' markets='+cache.marketCount);
    res.json({ ok:true, gameCount:cache.gameCount, marketCount:cache.marketCount,
               updatedAt:cache.updatedAt, sourceStatus:cache.sourceStatus });
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});
// ───────────────────────────────────────────────────────────────────────────

// GET /api/host/dashboard?clubId=...
app.get('/api/host/dashboard', requireCanonicalClubId, requirePermissionScoped('view_host_dashboard'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, source:'supabase_not_configured', stats:null });
  if (req._clubId) req.query = Object.assign({}, req.query, { clubId: req._clubId });
  const { clubId, playerId } = req.query;
  try {
    // Load tickets
    let tq = sb.from('tickets')
      .select('id,status,type,risk_amount,potential_profit,estimated_payout,player_id,placed_at,graded_at');
    if (clubId)   tq = tq.eq('club_id',   clubId);
    if (playerId) tq = tq.eq('player_id', playerId);
    const { data: tickets, error: tErr } = await tq;
    if (tErr) throw tErr;

    // Load recent ledger entries
    let lq = sb.from('ledger_entries')
      .select('id,ticket_id,player_id,type,amount,balance_before,balance_after,reason,created_at')
      .order('created_at', { ascending:false }).limit(200);
    if (clubId)   lq = lq.eq('club_id',   clubId);
    if (playerId) lq = lq.eq('player_id', playerId);
    const { data: ledger, error: lErr } = await lq;
    if (lErr) throw lErr;

    // Derive stats from tickets only (source of truth)
    var handle=0, activeRisk=0, hostAtRisk=0, settledGain=0, settledLoss=0;
    var activeBetCount=0, gradedCount=0, canceledCount=0;
    const active=[], graded=[];

    (tickets||[]).forEach(function(t) {
      var s      = (t.status||'').toLowerCase();
      var risk   = parseFloat(t.risk_amount)||0;
      var profit = parseFloat(t.potential_profit)||0;
      if (s==='canceled'||s==='voided'||s==='deleted') { canceledCount++; return; }
      if (s==='active'||s==='open') {
        handle+=risk; activeRisk+=risk; hostAtRisk+=profit; activeBetCount++; active.push(t);
      } else if (s==='won') {
        handle+=risk; settledLoss+=profit; gradedCount++; graded.push(t);
      } else if (s==='lost') {
        handle+=risk; settledGain+=risk; gradedCount++; graded.push(t);
      } else if (s==='push'||s==='pushed') {
        handle+=risk; gradedCount++; graded.push(t);
      }
    });

    function rnd(v) { return Math.round((isNaN(v)?0:v)*100)/100; }
    const settledHandle = handle - activeRisk;
    const profit        = rnd(settledGain - settledLoss);
    const holdPct       = settledHandle>0 ? rnd(profit/settledHandle*100) : null;

    const stats = {
      handle:         rnd(handle),
      activeRisk:     rnd(activeRisk),
      hostAtRisk:     rnd(hostAtRisk),
      settledGain:    rnd(settledGain),
      settledLoss:    rnd(settledLoss),
      profit:         profit,
      holdPct:        holdPct,
      activeBetCount: activeBetCount,
      gradedCount:    gradedCount,
      canceledCount:  canceledCount
    };

    // Warnings
    const warnings = [];
    if (isNaN(stats.handle))     warnings.push('handle_NaN');
    if (stats.activeRisk < 0)   warnings.push('activeRisk_negative');
    if (stats.activeBetCount !== active.length) warnings.push('activeBetCount_mismatch');

    res.json({
      ok: true, source: 'db', clubId: clubId||null,
      players:        [], // reserved for Phase C Step 3
      activeTickets:  active,
      gradedTickets:  graded,
      ledgerEntries:  ledger||[],
      stats,
      warnings
    });
  } catch(e) {
    console.error('[host/dashboard] error:', e.message);
    res.status(500).json({ ok:false, source:'db_error', error:e.message, stats:null });
  }
});
// ────────────────────────────────────────────────────────────────────────────

// GET /api/host/settlements-preview?clubId= — read-only settlement preview from DB
app.get('/api/host/settlements-preview', requireCanonicalClubId, requirePermissionScoped('view_settlement_history'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, source:'supabase_not_configured', players:[], totals:{playersOwe:0,hostOwes:0,net:0} });
  if (req._clubId) req.query = Object.assign({}, req.query, { clubId: req._clubId });
  const { clubId } = req.query;
  try {
    // Load all tickets for this club
    let tq = sb.from('tickets')
      .select('id,status,risk_amount,potential_profit,player_id,player_username,placed_at,type');
    if (clubId) tq = tq.eq('club_id', clubId);
    const { data: tickets, error: tErr } = await tq;
    if (tErr) throw tErr;

    // Load balance_start from player_limits (modern UUID-club source) (BUG4_FIXED_player_limits_balance_start)
    // Legacy path used club_members (PostgreSQL int-PK table) which has no rows
    // for UUID-club players created through the new Supabase system.
    // player_limits is the canonical source used by close-week, reconciliation, and Bug #2.
    var memberMap = {};
    try {
      let plq = sb.from('player_limits').select('player_id,balance_start');
      if (clubId) plq = plq.eq('club_id', clubId);
      const { data: plRows } = await plq;
      (plRows||[]).forEach(function(r) {
        if (r.player_id != null) memberMap[String(r.player_id)] = { balance_start: parseFloat(r.balance_start)||1000 };
      });
    } catch(_e) { console.warn('[settlements-preview] player_limits fetch error:', _e.message); }

    // Derive per-player settlement from tickets
    var byPlayer = {};
    function getOrCreate(pid, username) {
      if (!byPlayer[pid]) {
        var meta = memberMap[pid] || {};
        byPlayer[pid] = {
          playerId:     pid,
          username:     username || pid,
          balance:      parseFloat(meta.balance_start || 1000),
          openRisk:     0,
          settledNet:   0,
          owesHost:     0,
          hostOwes:     0,
          lastTicketAt: null
        };
      }
      return byPlayer[pid];
    }

    function rnd(v){ return Math.round((isNaN(v)?0:v)*100)/100; }

    (tickets||[]).forEach(function(t) {
      var pid  = t.player_id || 'unknown';
      var s    = (t.status||'').toLowerCase();
      var risk = parseFloat(t.risk_amount)||0;
      var prof = parseFloat(t.potential_profit)||0;
      var p    = getOrCreate(pid, t.player_username);
      var pMs  = t.placed_at ? new Date(t.placed_at).getTime() : 0;
      if (pMs && (!p.lastTicketAt || pMs > new Date(p.lastTicketAt).getTime())) p.lastTicketAt = t.placed_at;
      if (s==='canceled'||s==='voided'||s==='deleted'||s==='push'||s==='pushed') return;
      if (s==='active'||s==='open')  { p.openRisk   += risk; }
      else if (s==='won')             { p.settledNet += prof; }
      else if (s==='lost')            { p.settledNet -= risk; }
    });

    Object.values(byPlayer).forEach(function(p) {
      p.settledNet = rnd(p.settledNet);
      p.openRisk   = rnd(p.openRisk);
      if (p.settledNet < 0) { p.owesHost = rnd(Math.abs(p.settledNet)); p.hostOwes = 0; }
      else                  { p.hostOwes = rnd(p.settledNet); p.owesHost = 0; }
    });

    var players = Object.values(byPlayer).sort(function(a,b){ return (b.owesHost+b.hostOwes)-(a.owesHost+a.hostOwes); });
    var playersOweTot = players.reduce(function(s,p){ return s+p.owesHost; },0);
    var hostOwesTot   = players.reduce(function(s,p){ return s+p.hostOwes; },0);

    res.json({
      ok: true, source:'db', clubId: clubId||null,
      players,
      totals: {
        playersOwe: rnd(playersOweTot),
        hostOwes:   rnd(hostOwesTot),
        net:        rnd(playersOweTot - hostOwesTot)
      }
    });
  } catch(e) {
    console.error('[settlements-preview] error:', e.message);
    res.status(500).json({ ok:false, source:'db_error', error:e.message, players:[], totals:{playersOwe:0,hostOwes:0,net:0} });
  }
});

// POST /api/host/settle-player — execute settlement, write ledger + audit
app.post('/api/host/settle-player', requireCanonicalClubId, requirePermissionScoped('settle_player'), requireIdempotency({required:true}), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const { clubId, playerId, amount, direction, settlementWeek, note, idempotencyKey } = req.body || {};

  // Validate inputs
  const VALID_DIR = new Set(['player_paid_host','host_paid_player']);
  const errors = [];
  if (!clubId)         errors.push('missing_clubId');
  if (!playerId)       errors.push('missing_playerId');
  if (!idempotencyKey) errors.push('missing_idempotencyKey');
  if (!VALID_DIR.has(direction)) errors.push('invalid_direction:'+direction);
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) errors.push('invalid_amount');
  if (errors.length) return res.status(400).json({ ok:false, errors });

  try {
    // 1. Recalculate preview server-side
    let tq = sb.from('tickets')
      .select('id,status,risk_amount,potential_profit,player_id')
      .eq('club_id', clubId).eq('player_id', playerId);
    const { data: tickets, error: tErr } = await tq;
    if (tErr) throw tErr;

    var owesHost=0, hostOwes=0;
    (tickets||[]).forEach(function(t){
      var s=t.status.toLowerCase(), r=parseFloat(t.risk_amount)||0, p=parseFloat(t.potential_profit)||0;
      if (s==='canceled'||s==='voided'||s==='push'||s==='pushed'||s==='active'||s==='open') return;
      if (s==='lost') owesHost += r;
      if (s==='won')  hostOwes += p;
    });
    // Net
    var net = hostOwes - owesHost; // positive = host owes player
    if (net > 0) { hostOwes=net; owesHost=0; } else { owesHost=-net; hostOwes=0; }

    // Direction / overpay validation — with prior payment deduction (BUG56_FIXED_prior_payments_subtracted)
    // Subtract confirmed prior payments to derive remaining payable (Bugs #5/#6 fix).
    var priorPaid = 0;
    try {
      const { data: _priorRows } = await sb.from('settlement_payments')
        .select('amount')
        .eq('club_id', clubId).eq('player_id', playerId)
        .eq('direction', direction).eq('status', 'confirmed');
      priorPaid = (_priorRows||[]).reduce(function(s,r){ return s+parseFloat(r.amount||0); }, 0);
      priorPaid = Math.round(priorPaid * 100) / 100;
    } catch(_prErr) { console.warn('[settle-player] prior payments fetch error:', _prErr.message); }

    if (direction==='player_paid_host' && owesHost<=0)
      return res.status(400).json({ ok:false, error:'player_does_not_owe_host', owesHost, hostOwes });
    if (direction==='host_paid_player' && hostOwes<=0)
      return res.status(400).json({ ok:false, error:'host_does_not_owe_player', owesHost, hostOwes });
    var grossAmt = direction==='player_paid_host' ? owesHost : hostOwes;
    var maxAmt   = Math.round(Math.max(0, grossAmt - priorPaid) * 100) / 100;
    if (amt > maxAmt + 0.01)
      return res.status(400).json({ ok:false, error:'overpay_blocked', amount:amt,
        maxAmount:maxAmt, grossOwed:grossAmt, priorPaid, remaining:maxAmt });

    // 2. Phase I: settle_player_tx RPC (atomic canonical ledger)
    const rpcDir = direction==='host_paid_player' ? 'host_owes_player' : 'player_owes_host';
    const settlementId = idempotencyKey; // use idempotencyKey as settlementId for deduplication
    const settleResult = await _callMoneyRpc('settle_player_tx', {
      p_settlement_id:   settlementId,
      p_club_id:         clubId,
      p_player_id:       playerId,
      p_amount:          amt,
      p_direction:       rpcDir,
      p_idempotency_key: idempotencyKey,
      p_created_by:      (req._actor&&req._actor.actorId)||'host'
    });
    if (!settleResult.ok && !settleResult.idempotent)
      return res.status(400).json({ ok:false, error:settleResult.error||'settlement_failed' });

    // Register in settlement_payments so payment-confirm sees it as already done (R1_FIXED_double_settlement_guard)
    // This prevents payment-confirm from writing a second SETTLEMENT_APPLIED for the same debt.
    if (!settleResult.idempotent) {
      const _payId = 'SETTLE_DIRECT_'+idempotencyKey;
      sb.from('settlement_payments').upsert({
        payment_id: _payId, period_id: 'DIRECT', revision: 0,
        club_id: clubId, player_id: playerId, direction, amount: amt,
        method: 'direct', status: 'confirmed', note: note||null,
        created_at: new Date().toISOString(), created_by: (req._actor&&req._actor.actorId)||'host',
        confirmed_at: new Date().toISOString(), confirmed_by: (req._actor&&req._actor.actorId)||'host',
        ledger_written: true, ledger_settlement_id: idempotencyKey
      }, { onConflict: 'payment_id' }).then(()=>{}, function(e){ console.warn('[settle-player] payment_row write error:', e.message); });
    }

    // Legacy ledger_entries mirror (fire-and-forget)
    var executedAt = new Date().toISOString();
    sb.from('ledger_entries').upsert({
      id:idempotencyKey, club_id:clubId, player_id:playerId,
      type:'settlement', amount:Math.round((rpcDir==='host_owes_player'?amt:-amt)*100)/100,
      reason:direction+(note?': '+note:''), created_at:executedAt, created_by:'host',
      settlement_week:settlementWeek||null
    }, { onConflict:'id' }).then(()=>{},()=>{});

    // 3. Audit event
    await sb.from('audit_events').insert({
      event_type: 'settlement_executed',
      club_id: clubId, player_id: playerId,
      payload: { direction, amount:amt, maxAmount:maxAmt, settlementWeek, idempotencyKey,
                 note:note||null, balanceAfter:settleResult.balance_after }
    });

    // 4. Return updated preview
    const { data: updatedPreview } = await sb.from('tickets')
      .select('id,status,risk_amount,potential_profit,player_id,placed_at')
      .eq('club_id', clubId);
    var byPid = {};
    (updatedPreview||[]).forEach(function(t){
      var pid=t.player_id; if(!byPid[pid]) byPid[pid]={owesHost:0,hostOwes:0,openRisk:0};
      var s=t.status.toLowerCase(),r=parseFloat(t.risk_amount)||0,p=parseFloat(t.potential_profit)||0;
      if (s==='canceled'||s==='voided'||s==='pushed'||s==='push') return;
      if (s==='active'||s==='open')  byPid[pid].openRisk+=r;
      else if (s==='lost')           byPid[pid].owesHost+=r;
      else if (s==='won')            byPid[pid].hostOwes+=p;
    });
    var rnd=function(v){return Math.round((isNaN(v)?0:v)*100)/100;};
    Object.values(byPid).forEach(function(p){
      var net=p.hostOwes-p.owesHost;
      if(net>0){p.hostOwes=rnd(net);p.owesHost=0;}else{p.owesHost=rnd(-net);p.hostOwes=0;}
      p.openRisk=rnd(p.openRisk);
    });

    console.log('[settle-player] success idempotencyKey='+idempotencyKey+' direction='+direction+' amount='+amt);
    res.json({
      ok: true, executed: true,
      ledgerEntryId: idempotencyKey,
      direction, amount: amt, settlementWeek,
      previewAfter: byPid
    });
  } catch(e) {
    console.error('[settle-player] error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── WEEKLY ROLLOVER ENGINE (Phase C Step 5) ────────────────────────────────────────────────────

function _getISOWeek(date) {
  var d = new Date(date || Date.now()); d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 3 - (d.getDay()+6)%7);
  var w1 = new Date(d.getFullYear(), 0, 4);
  return d.getFullYear() + '-W' + String(1 + Math.round(
    ((d.getTime() - w1.getTime()) / 86400000 - 3 + (w1.getDay()+6)%7) / 7
  )).padStart(2,'0');
}

// POST /api/host/weekly-rollover
app.post('/api/host/weekly-rollover', requirePermissionScoped('weekly_rollover'), requireIdempotency({required:true}), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const { clubId, rolloverWeek, performedBy } = req.body || {};

  if (!clubId) return res.status(400).json({ ok:false, errors:['missing_clubId'] });
  const week = rolloverWeek || _getISOWeek();
  if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ ok:false, errors:['invalid_rolloverWeek_format'] });

  try {
    // 1. Duplicate check
    const { data: existing } = await sb.from('weekly_rollovers')
      .select('id').eq('club_id', clubId).eq('rollover_week', week).limit(1);
    if (existing && existing.length > 0)
      return res.status(409).json({ ok:false, error:'rollover_already_executed_for_week:'+week });

    // 2. Load current tickets for settlement preview
    const { data: tickets } = await sb.from('tickets')
      .select('id,status,risk_amount,potential_profit,player_id,player_username,placed_at')
      .eq('club_id', clubId);

    // 2b. Load player starting balances for rollover RPC (BUG2_FIXED_player_limits_balMap)
    // Without this, p_starting_balance is hardcoded to 1000 for ALL players.
    var balMap = {};
    try {
      const { data: _plRows } = await sb.from('player_limits').select('player_id,balance_start')
        .eq('club_id', clubId);
      (_plRows||[]).forEach(function(r) {
        if (r.player_id != null && r.balance_start != null)
          balMap[String(r.player_id)] = parseFloat(r.balance_start);
      });
    } catch(_balErr) { console.warn('[weekly-rollover] player_limits fetch error:', _balErr.message); }

    // 3. Derive per-player snapshot
    var byPlayer = {};
    function goc(pid, uname) {
      if (!byPlayer[pid]) byPlayer[pid] = { playerId:pid, username:uname||pid,
        owesHost:0, hostOwes:0, openRisk:0, settledNet:0, activeBetCount:0 };
      return byPlayer[pid];
    }
    var rnd = function(v){ return Math.round((isNaN(v)?0:v)*100)/100; };
    (tickets||[]).forEach(function(t) {
      var s=t.status.toLowerCase(), r=parseFloat(t.risk_amount)||0, p=parseFloat(t.potential_profit)||0;
      var pl = goc(t.player_id, t.player_username);
      if (s==='canceled'||s==='voided'||s==='push'||s==='pushed') return;
      if (s==='active'||s==='open')  { pl.openRisk+=r; pl.activeBetCount++; }
      else if (s==='lost')            { pl.settledNet-=r; }
      else if (s==='won')             { pl.settledNet+=p; }
    });
    Object.values(byPlayer).forEach(function(pl) {
      var net=pl.settledNet;
      if (net<0) { pl.owesHost=rnd(-net); pl.hostOwes=0; }
      else        { pl.hostOwes=rnd(net);  pl.owesHost=0; }
      pl.openRisk=rnd(pl.openRisk); pl.settledNet=rnd(pl.settledNet);
    });
    // 3b. Subtract confirmed prior payments from snapshot (BUG56_FIXED_prior_payments_subtracted)
    // Without this, weekly rollover snapshots show gross owed even when player
    // already paid part of it — leading to double-collection.
    try {
      const _playerIds = Object.keys(byPlayer);
      if (_playerIds.length) {
        const { data: _pmtRows } = await sb.from('settlement_payments')
          .select('player_id,direction,amount')
          .eq('club_id', clubId).eq('status', 'confirmed')
          .in('player_id', _playerIds);
        (_pmtRows||[]).forEach(function(r) {
          var pl = byPlayer[r.player_id];
          if (!pl) return;
          var a = parseFloat(r.amount)||0;
          if (r.direction === 'player_paid_host') {
            // Player paid host: reduces how much player still owes
            pl.owesHost = Math.max(0, Math.round((pl.owesHost - a)*100)/100);
          } else if (r.direction === 'host_paid_player') {
            // Host paid player: reduces how much host still owes
            pl.hostOwes = Math.max(0, Math.round((pl.hostOwes - a)*100)/100);
          }
        });
        // Re-clamp: payments can't make a value go negative (should not happen, but guard it)
        Object.values(byPlayer).forEach(function(pl) {
          pl.owesHost = Math.max(0, rnd(pl.owesHost));
          pl.hostOwes = Math.max(0, rnd(pl.hostOwes));
        });
      }
    } catch(_pmtErr) { console.warn('[weekly-rollover] prior payments fetch error:', _pmtErr.message); }

    var players = Object.values(byPlayer);
    var playersOweTot = players.reduce(function(s,p){ return s+p.owesHost; },0);
    var hostOwesTot   = players.reduce(function(s,p){ return s+p.hostOwes; },0);
    var totals = { playersOwe:rnd(playersOweTot), hostOwes:rnd(hostOwesTot), net:rnd(playersOweTot-hostOwesTot) };
    var performedAt = new Date().toISOString();

    // 4. Write weekly_rollovers row (UNIQUE constraint prevents duplicates)
    const { error: rrErr } = await sb.from('weekly_rollovers').insert({
      club_id: clubId, rollover_week: week,
      performed_at: performedAt, performed_by: performedBy||'host',
      totals_snapshot: JSON.stringify(totals), players_count: players.length
    });
    if (rrErr) throw rrErr;

    // 5. Write per-player snapshots + Phase I canonical ledger WEEKLY_ROLLOVER entries
    if (players.length) {
      const snapRows = players.map(function(p) { return {
        rollover_week: week, club_id: clubId, player_id: p.playerId, username: p.username,
        owes_host: p.owesHost, host_owes: p.hostOwes, open_risk: p.openRisk,
        settled_net: p.settledNet, active_ticket_count: p.activeBetCount,
        snapshotted_at: performedAt
      }; });
      const { error: snapErr } = await sb.from('weekly_player_snapshots').insert(snapRows);
      if (snapErr) throw snapErr;

      // Write one WEEKLY_ROLLOVER ledger event per player (via RPC — idempotent per player+week)
      await Promise.all(players.map(async function(p) {
        try {
          await _callMoneyRpc('weekly_rollover_tx', {
            p_rollover_id:      'WR_'+clubId+'_'+week+'_'+p.playerId,
            p_club_id:          clubId,
            p_player_id:        p.playerId,
            p_week_start:       week,
            p_starting_balance: balMap[String(p.playerId)] || 1000, // actual starting balance (Bug #2 fix)
            p_created_by:       performedBy||'host'
          });
        } catch(_e) { /* non-fatal: snapshot already exists */ }
      }));
    }

    // 6. Audit event
    await sb.from('audit_events').insert({
      event_type: 'weekly_rollover_executed', club_id: clubId,
      payload: { rolloverWeek:week, playersCount:players.length, totals, performedBy:performedBy||'host' }
    });

    console.log('[weekly-rollover] week='+week+' players='+players.length);
    res.json({
      ok: true, rolloverWeek: week, playersSnapshotted: players.length,
      totals, nextWeekInitialized: true, performedAt
    });
  } catch(e) {
    console.error('[weekly-rollover] error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// GET /api/host/rollover-history?clubId=
app.get('/api/host/rollover-history', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, history:[] });
  const { clubId, limit:limitQ } = req.query;
  try {
    const limit = Math.min(parseInt(limitQ)||12, 52);
    let q = sb.from('weekly_rollovers')
      .select('id,club_id,rollover_week,performed_at,totals_snapshot,players_count')
      .order('rollover_week', { ascending:false }).limit(limit);
    if (clubId) q = q.eq('club_id', clubId);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok:true, history: data||[] });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/host/week-snapshot?clubId=&week=
app.get('/api/host/week-snapshot', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, players:[] });
  const { clubId, week } = req.query;
  try {
    let q = sb.from('weekly_player_snapshots')
      .select('*').order('owes_host', { ascending:false });
    if (clubId) q = q.eq('club_id', clubId);
    if (week)   q = q.eq('rollover_week', week);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok:true, week:week||'all', players:data||[] });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
// ────────────────────────────────────────────────────────────────────────────

// ── DB-AUTHORITATIVE BET PLACEMENT (Phase C) ───────────────────────────────────────────────────
// POST /api/bets/place
app.post('/api/bets/place', requireCanonicalClubId, requirePermissionScoped('place_bet'), requireIdempotency({required:true}), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const _bodyRaw = req.body || {};
  // If no playerId in body, use the token's actorId (owner/host placing own test bet)
  const _actor = requireActor(req);
  const _resolvedPlayerId = _bodyRaw.playerId || (_actor && _actor.actorId) || null;
  const { clubId, betType, stake, legs, payout, potentialProfit,
          idempotencyKey, playerUsername } = _bodyRaw;
  const playerId = _resolvedPlayerId;
  if (_actor && !_bodyRaw.playerId && _actor.actorId) {
    console.log('TOKEN_SCOPE role='+(_actor.role||'?')+' playerCapable=true (resolved from token)');
  }
  const rnd = function(v){ return Math.round((isNaN(v)?0:v)*100)/100; };
  const now = new Date().toISOString();

  // Validate required fields
  const VALID_TYPES = new Set(['Single','Parlay','RoundRobin','Teaser']);
  const errors = [];
  if (!playerId)          errors.push('missing_playerId');
  if (!idempotencyKey)    errors.push('missing_idempotencyKey');
  if (!VALID_TYPES.has(betType)) errors.push('invalid_betType:'+betType);
  const stakeAmt = parseFloat(stake);
  if (isNaN(stakeAmt)||stakeAmt<=0) errors.push('invalid_stake');
  let legsArr = Array.isArray(legs) ? legs : [];
  if (!legsArr.length) errors.push('no_legs');
  legsArr.forEach(function(leg,i) {
    if (!leg.pick) errors.push('leg'+i+'_missing_pick');
    if (!leg.market) errors.push('leg'+i+'_missing_market');
    if (!leg.canonicalGameKey) errors.push('leg'+i+'_missing_canonicalGameKey');
    if (typeof leg.odds !== 'number') errors.push('leg'+i+'_invalid_odds');
    if (!leg.scheduledStart) errors.push('leg'+i+'_missing_scheduledStart');
  });
  if (errors.length) return res.status(400).json({ ok:false, errors });

  try {
    // Idempotency is handled entirely by requireIdempotency middleware above.
    // The middleware checks idempotency_keys, marks requests pending/completed,
    // and replays stored responses — no second preflight check needed here.
    // The RPC's DB unique constraint on p_idempotency_key is the final atomic guard.

    // 2. Derive DB balance for player — MUST filter by club_id (Bug #1 fix)
    // Without the club filter, losses/open risk from OTHER clubs reduce this
    // player's available balance here, which is incorrect.
    const { data: playerTix } = await sb.from('tickets')
      .select('status,risk_amount,potential_profit')
      .eq('player_id', playerId)
      .eq('club_id', clubId);
    var startBal = 1000;
    try {
      // Use player_limits scoped by club_id — modern UUID-club source (CLUBMEMBERS_CLEANUP_player_limits_scope)
      // club_members is legacy PostgreSQL; has no rows for UUID-club players and no club_id filter
      const { data:mem } = await sb.from('player_limits').select('balance_start')
        .eq('club_id',clubId).eq('player_id',playerId).limit(1);
      if (mem&&mem[0]) startBal = parseFloat(mem[0].balance_start)||1000;
    } catch(_e) {}
    var openRisk=0, settledGains=0, settledLosses=0;
    (playerTix||[]).forEach(function(t){
      var s=t.status.toLowerCase(), r=parseFloat(t.risk_amount)||0, p=parseFloat(t.potential_profit)||0;
      if (s==='canceled'||s==='voided'||s==='push'||s==='pushed') return;
      if (s==='active'||s==='open') openRisk+=r;
      else if (s==='won')  settledGains+=p;
      else if (s==='lost') settledLosses+=r;
    });
    var available = rnd(startBal - openRisk - settledLosses + settledGains);
    if (stakeAmt > available + 0.005)
      return res.status(400).json({ ok:false, error:'insufficient_balance', available, stake:stakeAmt });

    // 2b. Risk limits check (JS-side; Postgres RPC also enforces, this gives early rejection)
    try {
      const riskCheck = await _checkRiskLimitsJs(sb, clubId, playerId, {
        stake: stakeAmt, potentialPayout: parseFloat(payout)||0,
        betType, legs: legsArr
      });
      if (!riskCheck.ok) {
        const httpStatus = RISK_CODE_STATUS[riskCheck.code] || 422;
        console.log('[bets/place] risk limit rejected:', riskCheck.code, 'actor='+playerId);
        // Emit risk alert based on rejection code
        var _raType = {
          payout_above_max:'large_payout_attempt', player_open_risk_exceeded:'over_limit_attempt',
          club_open_risk_exceeded:'over_limit_attempt', event_risk_exceeded:'over_limit_attempt',
          market_risk_exceeded:'over_limit_attempt', stake_above_max:'over_limit_attempt'
        }[riskCheck.code];
        if (_raType) emitRiskAlert(_raType, clubId, playerId,
          { code:riskCheck.code, stake:stakeAmt, payout:parseFloat(payout)||0 });
        return res.status(httpStatus).json({ ok:false, code:riskCheck.code, ...riskCheck });
      }
    } catch(riskErr) {
      console.warn('[bets/place] risk check error (fail-open):', riskErr.message);
    }

    // 2c. Phase AA: active-bettor charge check
    const _habResult = await _processActiveBettorCharge(sb, clubId, playerId, null, Date.now());
    if (!_habResult.ok) {
      if (_habResult.httpStatus === 402) {
        return res.status(402).json({ ok:false, error:_habResult.error,
          message:_habResult.message, balance:_habResult.balance, required:_habResult.required });
      }
      // Other unexpected errors: fail-closed (log + block)
      console.error('[bets/place] active-bettor charge unexpected error:', _habResult.error);
      return res.status(503).json({ ok:false, error:'active_bettor_charge_failed',
        detail:_habResult.error });
    }

    // 3. Phase K: snapshot-based odds verification + server payout recalculation
    const nowMs = Date.now();
    // Load club oddsChangePolicy
    let oddsChangePolicy = 'reject';
    try {
      const { data:csData } = await sb.from('club_risk_settings').select('odds_change_policy')
        .eq('club_id',clubId).limit(1);
      if (csData&&csData[0]) oddsChangePolicy = csData[0].odds_change_policy||'reject';
    } catch(_e){}

    let serverPayout = null;
    let serverProfit = null;

    // Snapshot validation is unconditional — oddsAccepted is a UI-only signal
    // and must never bypass server authority over payout calculation.
    // A client sending { oddsAccepted: true, payout: 9999 } gets no special treatment.
    const payoutResult = await _recalcPayoutFromSnapshots(sb, stakeAmt, legsArr, nowMs, oddsChangePolicy);
    if (payoutResult && !payoutResult.ok) {
      const httpStatus = payoutResult.code==='odds_service_unavailable'?503
        : (payoutResult.code==='odds_changed'
          ||payoutResult.code==='market_unavailable'
          ||payoutResult.code==='market_closed'
          ||payoutResult.code==='odds_stale')?409 : 422;
      console.log('[bets/place] snapshot validation failed:', payoutResult.code,
        payoutResult.reason||'-', payoutResult.leg, '('+httpStatus+')');
      // Surface a clean user-facing message for Live tab placement.
      // Only fire when the market is actually suspended or the game is final/canceled.
      if (!payoutResult.userMessage) {
        if (payoutResult.code === 'market_unavailable') {
          payoutResult.userMessage =
            payoutResult.reason === 'game_final'    ? 'Market unavailable: game is final.' :
            payoutResult.reason === 'game_canceled' ? 'Market unavailable: game canceled.' :
            payoutResult.reason === 'suspended'     ? 'Market unavailable: temporarily suspended.' :
                                                      'Market unavailable.';
        } else if (payoutResult.code === 'odds_changed') {
          payoutResult.userMessage = 'Odds changed — please review and confirm.';
        } else if (payoutResult.code === 'odds_stale') {
          payoutResult.userMessage = 'Odds refreshing — please try again.';
        } else if (payoutResult.code === 'odds_service_unavailable') {
          payoutResult.userMessage = 'Odds service unavailable — please try again shortly.';
        }
      }
      // Emit risk alert for snapshot rejection
      var _snapRaType = { odds_changed:'odds_change_rejections',
        odds_stale:'stale_line_attempts',
        market_unavailable:'stale_line_attempts',
        market_closed:'stale_line_attempts',
        odds_service_unavailable:null }[payoutResult.code];
      if (_snapRaType) emitRiskAlert(_snapRaType, clubId, playerId,
        { code:payoutResult.code, reason:payoutResult.reason, leg:payoutResult.leg });
      const _updatedLegs = (payoutResult.code === 'odds_changed' && payoutResult.legs)
        ? payoutResult.legs.map(function(l){ return { pick:l.pick, odds:l.liveOdds||l.odds, market:l.market, gameId:l.gameId }; })
        : undefined;
      return res.status(httpStatus).json(Object.assign({ ok:false }, payoutResult,
        _updatedLegs ? { updatedLegs: _updatedLegs } : {}));
    }
    if (payoutResult && payoutResult.ok) {
      // Server payout is always authoritative — client payout value is ignored.
      legsArr = payoutResult.legs;
      serverPayout = payoutResult.payout;
      serverProfit = rnd(serverPayout - stakeAmt);
      const anyFallback = legsArr.some(function(l){ return l.dev_fallback; });
      console.log('[bets/place] server payout recalculated:', payoutResult.payout,
        '(client submitted:', parseFloat(payout)||0, anyFallback?'[DEV FALLBACK]':'');
    }

    // 3b. Conflict check: active legs on same game+market
    //     Bypass paths (testing / staging):
    //       - env BETS_BYPASS_CONFLICT=1            → globally disabled
    //       - req.body._bypassConflict === true     → per-request (must be
    //                                                  explicitly allowed by
    //                                                  BETS_ALLOW_BYPASS_FLAG)
    //     Bypass attempts are always logged so we can't accidentally ship
    //     prod with this on.
    const _conflictGloballyOff = process.env.BETS_BYPASS_CONFLICT === '1';
    const _conflictPerReqAllowed = process.env.BETS_ALLOW_BYPASS_FLAG === '1'
                                && req.body && req.body._bypassConflict === true;
    const _conflictBypass = _conflictGloballyOff || _conflictPerReqAllowed;
    if (_conflictBypass) {
      console.warn('[bets/place] CONFLICT CHECK BYPASSED',
        { playerId, clubId, via: _conflictGloballyOff ? 'env' : 'request',
          ticketCount: legsArr.length });
    }
    if (!_conflictBypass) {
      const { data: activeTix } = await sb.from('tickets').select('id')
        .eq('player_id', playerId).in('status',['active','open']);
      if (activeTix && activeTix.length) {
        const activeTicketIds = activeTix.map(function(t){ return t.id; });
        const { data: activeLegs } = await sb.from('ticket_legs')
          .select('canonical_game_key,market').in('ticket_id', activeTicketIds);
        const activeLegsArr = activeLegs || [];
        for (var i=0; i<legsArr.length; i++) {
          var newToken = legsArr[i].canonicalGameKey + '|' + (legsArr[i].market||'').toLowerCase();
          for (var j=0; j<activeLegsArr.length; j++) {
            var exToken = activeLegsArr[j].canonical_game_key + '|' + (activeLegsArr[j].market||'').toLowerCase();
            if (newToken === exToken) return res.status(409).json({ ok:false, error:'conflict_active_bet:'+legsArr[i].canonicalGameKey });
          }
        }
      }
    }

    // 4. Generate ticket ID
    const ticketId = 'T_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);

    // 5. Build ticket_legs rows in memory (Phase K accepted-odds snapshot +
    //    priority #11 canonical identity fields). NOTE: we no longer insert
    //    here — the parent `tickets` row must exist first to satisfy the
    //    ticket_legs.ticket_id FK. Actual insert happens in step 6b below.
    const legRows = legsArr.map(function(leg,i) {
      // Build canonical identity for this leg. Same helper that the
      // snapshot verifier uses, so the persisted ticket leg carries the
      // exact identity tuple grading + SGP will need later.
      var ident = _normalizeLegIdentity(leg) || {};
      return {
        id: leg.legId || (ticketId+'_leg'+i), ticket_id: ticketId, leg_index: i,
        provider_name: leg.providerName||'odds-api', provider_game_id: leg.providerGameId||null,
        canonical_game_key: leg.canonicalGameKey, sport: leg.sport||null,
        home_team: leg.homeTeam||null, away_team: leg.awayTeam||null,
        scheduled_start: leg.scheduledStart||leg.commenceTime||null,
        market: leg.market, pick: leg.pick,
        odds: leg.accepted_odds_american || leg.odds,
        line: leg.accepted_point_line!=null ? leg.accepted_point_line : (leg.line!=null?parseFloat(leg.line):null),
        side: leg.side||null,
        // Phase K snapshot fields
        accepted_odds_american: leg.accepted_odds_american||null,
        accepted_odds_decimal:  leg.accepted_odds_decimal||null,
        accepted_point_line:    leg.accepted_point_line||null,
        odds_snapshot_id:       leg.odds_snapshot_id||null,
        accepted_at:            leg.accepted_at||null,
        // Canonical identity (priority #11). Optional columns — DB without
        // them gets stripped automatically by the catch below.
        market_type:              ident.marketType || _coerceMarketType(leg.market) || leg.market,
        canonical_market_key:     ident.canonicalMarketKey || null,
        canonical_selection_key:  ident.canonicalSelectionKey || null,
        player_name_normalized:   ident.playerName ? _normalizePlayerName(ident.playerName) : null,
        prop_type_normalized:     ident.propType ? _normalizePropType(ident.propType) : null,
        prop_side:                ident.marketType === MARKET_TYPES.PLAYER_PROP ? (ident.side || null) : null
      };
    });

    // 6. Phase I+J: call place_bet_tx RPC FIRST (atomic ticket + canonical
    //    ledger + risk limits). Ticket parent row must exist before legs
    //    are inserted, otherwise ticket_legs_ticket_id_fkey rejects.
    const rpcResult = await _callMoneyRpc('place_bet_tx', {
      p_ticket_id:        ticketId,
      p_club_id:          clubId||'',
      p_player_id:        playerId,
      p_player_username:  playerUsername||null,
      p_bet_type:         betType,
      p_stake:            rnd(stakeAmt),
      p_potential_profit: serverProfit != null ? serverProfit : rnd(parseFloat(potentialProfit)||0),
      p_estimated_payout: serverPayout != null ? rnd(serverPayout) : rnd(parseFloat(payout)||0),
      p_idempotency_key:  idempotencyKey,
      p_created_by:       playerId,
      // Phase J risk limit params
      p_leg_count:        legsArr.length,
      p_sports:           legsArr.map(function(l){ return (l.sport||'').toLowerCase(); }),
      p_markets:          legsArr.map(function(l){ return (l.market||'moneyline').toLowerCase(); }),
      p_canonical_keys:   legsArr.map(function(l){ return l.canonicalGameKey||''; }),
      p_is_live:          legsArr.some(function(l){ return !!l.isLive; })
    });
    if (!rpcResult.ok && !rpcResult.idempotent) {
      // RPC rejected — nothing inserted yet (legs come after). No cleanup needed.
      // Risk limit rejection from Postgres
      if (rpcResult.code && RISK_CODE_STATUS[rpcResult.code]) {
        return res.status(RISK_CODE_STATUS[rpcResult.code]).json(
          Object.assign({ ok:false }, rpcResult));
      }
      if (rpcResult.error==='insufficient_balance')
        return res.status(400).json({ ok:false, error:'insufficient_balance',
          available:rpcResult.available, stake:stakeAmt });
      return res.status(400).json({ ok:false, error:rpcResult.error||'placement_failed' });
    }

    // 6b. Insert ticket_legs AFTER the parent ticket exists so the
    //     ticket_legs_ticket_id_fkey FK is satisfied. On failure here we must
    //     compensate by voiding the just-created ticket — otherwise we leave
    //     an orphan ticket with no legs (and a real balance reservation).
    try {
      try {
        const r = await sb.from('ticket_legs').insert(legRows);
        if (r.error) throw r.error;
      } catch(e1) {
        const msg = (e1 && e1.message) || '';
        // Strip columns the DB doesn't know about yet (pre-migration) and retry
        const _missingCanonical  = /market_type|canonical_market_key|canonical_selection_key|player_name_normalized|prop_type_normalized|prop_side/.test(msg);
        const _missingPhaseK     = /accepted_at|accepted_odds_american|accepted_odds_decimal|accepted_point_line|odds_snapshot_id/.test(msg);
        if (_missingCanonical || _missingPhaseK) {
          const _stripped = _missingCanonical ? 'canonical' : '';
          const _strippedK = _missingPhaseK ? 'phaseK' : '';
          console.warn('[ticket_legs] insert: missing columns on DB ('+[_stripped,_strippedK].filter(Boolean).join('+')
            +'), falling back — run migration 021 in Supabase');
          const legacyRows = legRows.map(function(r) {
            const copy = Object.assign({}, r);
            // Strip canonical identity columns
            delete copy.market_type;
            delete copy.canonical_market_key;
            delete copy.canonical_selection_key;
            delete copy.player_name_normalized;
            delete copy.prop_type_normalized;
            delete copy.prop_side;
            // Strip Phase K columns if also missing
            if (_missingPhaseK) {
              delete copy.accepted_odds_american;
              delete copy.accepted_odds_decimal;
              delete copy.accepted_point_line;
              delete copy.odds_snapshot_id;
              delete copy.accepted_at;
            }
            return copy;
          });
          const r2 = await sb.from('ticket_legs').insert(legacyRows);
          if (r2.error) throw r2.error;
        } else {
          throw e1;
        }
      }
    } catch(legErr) {
      // Compensation: cancel the just-created parent ticket so we don't
      // strand the player's balance reservation. Use cancel_bet_tx (the
      // same atomic primitive /api/bets/cancel uses) with a derived
      // idempotency key so it cannot collide with the placement key.
      console.error('[bets/place] ticket_legs insert failed AFTER RPC ok — compensating:', legErr.message, 'ticketId='+ticketId);
      try {
        const cancelResult = await _callMoneyRpc('cancel_bet_tx', {
          p_ticket_id:       ticketId,
          p_club_id:         clubId||'',
          p_player_id:       playerId,
          p_idempotency_key: idempotencyKey+':compensate',
          p_reason:          'ticket_legs_insert_failed',
          p_created_by:      playerId
        });
        if (!cancelResult || (!cancelResult.ok && !cancelResult.idempotent)) {
          console.error('[bets/place] CRITICAL: cancel_bet_tx compensation failed for orphan ticketId='+ticketId, cancelResult);
        }
      } catch(cancelErr) {
        console.error('[bets/place] CRITICAL: cancel_bet_tx compensation threw for orphan ticketId='+ticketId, cancelErr.message);
      }
      return res.status(500).json({ ok:false, error:'ticket_legs_insert_failed',
        detail: legErr.message, ticketId });
    }

    // 7. Legacy ledger_entries mirror (Phase A compat — fire-and-forget)
    // NOTE: Supabase v2 query builders are thenables but not real Promises
    // until awaited or .then()'d — calling .catch() directly throws
    // "upsert(...).catch is not a function". Use .then(noop, noop) instead.
    sb.from('ledger_entries').upsert({
      id: idempotencyKey, club_id: clubId||null, player_id: playerId,
      ticket_id: ticketId, type: 'bet_placed',
      amount: rnd(-stakeAmt), reason: 'bet_placed:'+betType,
      created_at: now, created_by: playerId
    }, { onConflict:'id' }).then(()=>{},()=>{});

    // 8. Audit event — fire-and-forget after RPC commit.
    // Must NOT throw: a failed audit write must never fail the placement or
    // cause the idempotency key to be marked 'failed', which would let a
    // retry re-execute the RPC and double-debit the player.
    try {
      await sb.from('audit_events').insert({
        event_type: 'ticket_placed', player_id: playerId, club_id: clubId||null, ticket_id: ticketId,
        payload: { betType, stake:stakeAmt, legs:legsArr.length, payout: parseFloat(payout)||0,
                   txResult: rpcResult }
      });
    } catch(_auditErr) {
      console.warn('[bets/place] audit_events write failed (non-fatal):', _auditErr.message,
        'ticketId='+ticketId);
    }

    const ticketRow = { id:ticketId, club_id:clubId, player_id:playerId, type:betType,
      status:'active', risk_amount:rnd(stakeAmt), placed_at:now };
    console.log('[bets/place] RPC ok ticketId='+ticketId+' stake='+stakeAmt+' balanceAfter='+(rpcResult.balance_after||'?'));
    emitEvent('ticket_placed',{ ticketId, stake:stakeAmt, betType, balanceAfter:rpcResult.balance_after },
      { clubId, actorId:playerId, playerId }, req.requestId);
    emitEvent('balance_changed',{ playerId, balanceAfter:rpcResult.balance_after },
      { clubId, playerId }, req.requestId);
    // Velocity signal: track rapid bet placement
    emitRiskAlert('rapid_bet_velocity', clubId, playerId, { ticketId, stake:stakeAmt });
    res.json({ ok:true, ticketId, ticket:ticketRow, legs:legRows,
               ledgerEntryId:idempotencyKey, balanceAfter:rpcResult.balance_after });
  } catch(e) {
    console.error('[bets/place] error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});
// ───────────────────────────────────────────────────────────────────────═

// POST /api/bets/cancel — DB-authoritative ticket cancellation
app.post('/api/bets/cancel', requireCanonicalClubId, requirePermissionScoped('cancel_bet'), requireIdempotency({required:true}), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const { clubId, playerId, ticketId, idempotencyKey, reason } = req.body || {};
  const now = new Date().toISOString();
  const errors = [];
  if (!ticketId)       errors.push('missing_ticketId');
  if (!playerId)       errors.push('missing_playerId');
  if (!idempotencyKey) errors.push('missing_idempotencyKey');
  if (errors.length) return res.status(400).json({ ok:false, errors });

  try {
    // 1. Idempotency: if already canceled with this key, return success
    const { data: existLedger } = await sb.from('ledger_entries')
      .select('id,ticket_id').eq('id', idempotencyKey).limit(1);
    if (existLedger && existLedger[0])
      return res.json({ ok:true, idempotent:true, ticketId, ledgerEntryId:idempotencyKey });

    // 2. Load ticket + legs
    const { data: tickets, error: tErr } = await sb.from('tickets')
      .select('id,status,risk_amount,player_id,club_id').eq('id', ticketId).limit(1);
    if (tErr) throw tErr;
    const ticket = tickets && tickets[0];
    if (!ticket) return res.status(404).json({ ok:false, error:'ticket_not_found' });
    const _cancelActor = req._actor || {};
    const _cancelActorRank = ROLE_RANK[_cancelActor.role] != null ? ROLE_RANK[_cancelActor.role] : -99;
    const _isPrivilegedCancel = _cancelActorRank >= ROLE_RANK.full_admin || _cancelActor.platformRole === 'platform_admin';
    // Privileged actors (full_admin+) can cancel any ticket in the club; players must own the ticket
    if (!_isPrivilegedCancel && ticket.player_id !== playerId) {
      return res.status(403).json({ ok:false, error:'not_owner',
        hint:'player can only cancel own tickets; host/admin can cancel any' });
    }
    // Use ticket's actual player_id for ledger operations (body.playerId may differ when host cancels for player)
    const _effectivePlayerId = ticket.player_id || playerId;
    if (clubId && ticket.club_id && ticket.club_id !== clubId) return res.status(403).json({ ok:false, error:'wrong_club' });
    const s = ticket.status.toLowerCase();
    if (s === 'canceled' || s === 'voided') return res.json({ ok:true, idempotent:true, ticketId, message:'already_canceled' });
    if (s !== 'active' && s !== 'open') return res.status(400).json({ ok:false, error:'cannot_cancel_settled:status='+s });

    // 3. Game started check via ticket_legs
    const { data: legs } = await sb.from('ticket_legs').select('scheduled_start').eq('ticket_id', ticketId);
    const nowMs = Date.now();
    for (const leg of (legs||[])) {
      if (!leg.scheduled_start) continue;
      const ctMs = new Date(leg.scheduled_start).getTime();
      if (!isNaN(ctMs) && nowMs >= ctMs)
        return res.status(400).json({ ok:false, error:'game_already_started:'+leg.scheduled_start });
    }

    // 4. Phase I: call cancel_bet_tx RPC (atomic ticket status + canonical ledger)
    const riskAmt = parseFloat(ticket.risk_amount)||0;
    const cancelResult = await _callMoneyRpc('cancel_bet_tx', {
      p_ticket_id:       ticketId,
      p_club_id:         clubId||ticket.club_id||'',
      p_player_id:       _effectivePlayerId,
      p_idempotency_key: idempotencyKey,
      p_reason:          reason||'player_request',
      p_created_by:      _cancelActor.actorId || _effectivePlayerId
    });
    if (!cancelResult.ok && !cancelResult.idempotent) {
      const code = cancelResult.error||'cancel_failed';
      const status = code.includes('invalid_transition') ? 400
                   : code.includes('not_owner') ? 403 : 400;
      return res.status(status).json({ ok:false, error:code });
    }

    // 5. Legacy ledger_entries mirror (fire-and-forget)
    sb.from('ledger_entries').upsert({
      id: idempotencyKey, club_id: clubId||null, player_id: _effectivePlayerId,
      ticket_id: ticketId, type: 'bet_canceled', amount: riskAmt,
      reason: 'cancel:'+(reason||'player_request'), created_at: now, created_by: _cancelActor.actorId||_effectivePlayerId
    }, { onConflict:'id' }).then(()=>{},()=>{});

    // 6. Audit event
    await sb.from('audit_events').insert({
      event_type: 'ticket_canceled', player_id: _effectivePlayerId, club_id: clubId||null, ticket_id: ticketId,
      payload: { reason:reason||'player_request', refundAmount:riskAmt,
                 canceledBy:_cancelActor.actorId||_effectivePlayerId,
                 idempotencyKey, txResult:cancelResult }
    });

    const refundAmt = cancelResult.refund || riskAmt;
    console.log('[bets/cancel] RPC ok ticketId='+ticketId+' refund=$'+refundAmt+' player='+_effectivePlayerId);
    emitEvent('ticket_canceled',{ ticketId, refundAmount:refundAmt, balanceAfter:cancelResult.balance_after },
      { clubId, actorId:_cancelActor.actorId||_effectivePlayerId, playerId:_effectivePlayerId }, req.requestId);
    emitEvent('balance_changed',{ playerId:_effectivePlayerId, balanceAfter:cancelResult.balance_after },
      { clubId, playerId:_effectivePlayerId }, req.requestId);
    res.json({ ok:true, ticketId, status:'canceled', refundAmount:refundAmt,
               ledgerEntryId:idempotencyKey, balanceAfter:cancelResult.balance_after,
               canceledBy:_cancelActor.actorId||_effectivePlayerId });
  } catch(e) {
    console.error('[bets/cancel] error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// GET /api/player/dashboard?clubId=&playerId= — DB-derived player dashboard
app.get('/api/player/dashboard', requireCanonicalClubId, requirePermissionScoped('view_player_dashboard'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, source:'supabase_not_configured', balance:null });
  if (req._clubId) req.query = Object.assign({}, req.query, { clubId: req._clubId });
  const { clubId, playerId } = req.query;
  if (!playerId) return res.status(400).json({ ok:false, error:'missing_playerId' });
  const rnd = function(v){ return Math.round((isNaN(v)?0:v)*100)/100; };
  try {
    // Tickets for this player
    let tq = sb.from('tickets').select(
      'id,status,type,risk_amount,potential_profit,estimated_payout,placed_at,graded_at,grading_source,odds'
    ).eq('player_id', playerId);
    if (clubId) tq = tq.eq('club_id', clubId);
    tq = tq.order('placed_at', { ascending:false });
    const { data: tickets, error: tErr } = await tq;
    if (tErr) throw tErr;

    // Starting balance from player_limits scoped by club_id (CLUBMEMBERS_CLEANUP_player_limits_scope)
    // club_members is legacy PostgreSQL; has no rows for UUID-club players and no club_id filter
    var startingBalance = 1000;
    try {
      const { data: mem } = await sb.from('player_limits')
        .select('balance_start').eq('club_id', clubId).eq('player_id', playerId)
        .limit(1);
      if (mem && mem[0] && mem[0].balance_start) startingBalance = parseFloat(mem[0].balance_start)||1000;
    } catch(_e) {}

    // Derive balance
    var openRisk=0, settledGains=0, settledLosses=0;
    var active=[], settled=[], canceled=[];
    var warnings = [];
    (tickets||[]).forEach(function(t) {
      var s=t.status.toLowerCase(), r=parseFloat(t.risk_amount)||0, p=parseFloat(t.potential_profit)||0;
      if (isNaN(r)||r<0) { warnings.push('invalid_risk:'+t.id); r=0; }
      if (s==='canceled'||s==='voided'||s==='deleted') { canceled.push(t); return; }
      if (s==='active'||s==='open')   { openRisk+=r; active.push(t); }
      else if (s==='won')             { settledGains+=p; settled.push(t); }
      else if (s==='lost')            { settledLosses+=r; settled.push(t); }
      else if (s==='push'||s==='pushed') { settled.push(t); } // push: no net change
    });
    var available = rnd(startingBalance - openRisk - settledLosses + settledGains);
    if (available<0) warnings.push('available_negative:'+available);

    // Weekly stats
    var now = new Date();
    now.setHours(0,0,0,0); now.setDate(now.getDate()+3-(now.getDay()+6)%7);
    var w1 = new Date(now.getFullYear(),0,4);
    var isoWeek = now.getFullYear()+'-W'+String(1+Math.round(((now.getTime()-w1.getTime())/86400000-3+(w1.getDay()+6)%7)/7)).padStart(2,'0');
    var wStart = new Date(); wStart.setHours(0,0,0,0); wStart.setDate(wStart.getDate()-(wStart.getDay()+6)%7);
    var wStartMs = wStart.getTime(), wEndMs = wStartMs+7*86400000;
    var wNet=0, wRisk=0, wCount=0;
    (tickets||[]).forEach(function(t){
      var ts=new Date(t.placed_at||0).getTime();
      if (ts<wStartMs||ts>=wEndMs) return;
      wCount++;
      var s=t.status.toLowerCase(), r=parseFloat(t.risk_amount)||0, p=parseFloat(t.potential_profit)||0;
      if (s==='active'||s==='open') wRisk+=r;
      else if (s==='won')  wNet+=p;
      else if (s==='lost') wNet-=r;
    });

    res.json({
      ok: true, source:'db', clubId:clubId||null, playerId,
      balance: {
        startingBalance: rnd(startingBalance),
        availableBalance: available,
        openRisk: rnd(openRisk),
        settledGains: rnd(settledGains),
        settledLosses: rnd(settledLosses),
        pendingPayouts: rnd(openRisk),
        refunds: 0  // push handled via openRisk exclusion
      },
      tickets: {
        active,
        settled,
        canceled,
        totalCount: (tickets||[]).length
      },
      weekly: {
        currentWeek: isoWeek,
        settledNet: rnd(wNet),
        openRisk: rnd(wRisk),
        ticketCount: wCount
      },
      warnings
    });
  } catch(e) {
    console.error('[player/dashboard] error:', e.message);
    res.status(500).json({ ok:false, source:'db_error', error:e.message, balance:null });
  }
});

// ══ RISK SETTINGS ENDPOINTS (Phase J) ═══════════════════════════════════════════════════════════════════════

app.get('/api/club/risk-settings', requirePermissionScoped('view_host_dashboard'), async (req, res) => {
  if (req._clubId) req.query = Object.assign({}, req.query, { clubId: req._clubId });
  const { clubId } = req.query;
  const sb = getSupabase();
  if (!sb||!clubId) return res.status(400).json({ ok:false, error:'missing_clubId' });
  try {
    const { data } = await sb.from('club_risk_settings').select('*').eq('club_id',clubId).limit(1);
    res.json({ ok:true, settings: data&&data[0] || null, clubId });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/club/risk-settings', requirePermissionScoped('view_host_dashboard'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor||{};
  if (ROLE_RANK[actor.role]<ROLE_RANK.full_admin)
    return res.status(403).json({ ok:false, error:'insufficient_role', required:'full_admin' });
  const { clubId, ...settings } = req.body||{};
  const sb = getSupabase();
  if (!sb||!clubId) return res.status(400).json({ ok:false, error:'missing_clubId' });
  try {
    const row = Object.assign({ club_id:clubId, updated_at:new Date().toISOString() }, settings);
    await sb.from('club_risk_settings').upsert(row, { onConflict:'club_id' });
    _writeAuthAudit('risk_settings_updated', actor.actorId, clubId, '/club/risk-settings',
      { updatedBy:actor.actorId, fields:Object.keys(settings) });
    res.json({ ok:true, clubId, settings:row });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/club/player-limits', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor||{};
  if (ROLE_RANK[actor.role]<ROLE_RANK.full_admin)
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const { clubId, playerId, ...limits } = req.body||{};
  if (!clubId||!playerId) return res.status(400).json({ ok:false, error:'missing fields' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const row = Object.assign({ club_id:clubId, player_id:playerId }, limits);
    await sb.from('player_limits').upsert(row, { onConflict:'club_id,player_id' });
    _writeAuthAudit('player_limits_updated', actor.actorId, clubId, '/club/player-limits',
      { playerId, fields:Object.keys(limits) });
    res.json({ ok:true, clubId, playerId, limits:row });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/api/club/exposure', requirePermissionScoped('view_host_dashboard'), async (req, res) => {
  if (req._clubId) req.query = Object.assign({}, req.query, { clubId: req._clubId });
  const { clubId, playerId } = req.query;
  const sb = getSupabase();
  if (!sb||!clubId) return res.status(400).json({ ok:false, error:'missing_clubId' });
  try {
    let q = sb.from('risk_exposure').select('*').eq('club_id',clubId);
    if (playerId) q = q.eq('player_id',playerId);
    const { data } = await q;
    const summary = (data||[]).reduce(function(acc,row) {
      acc.totalOpenRisk    = (acc.totalOpenRisk||0)    + parseFloat(row.open_risk||0);
      acc.totalPotentialPayout = (acc.totalPotentialPayout||0) + parseFloat(row.potential_payout||0);
      return acc;
    }, {});
    res.json({ ok:true, clubId, rows:data||[], summary });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
// ───────────────────────────────────────────────────────────────────────────

// ══ SETTLEMENT PERIODS + CLOSEOUT (Phase N) ═══════════════════════════════════════════════════════════════════════

// ── PAYMENT HELPERS ───────────────────────────────────────────────────────────────────────
async function _calcTotalPaid(sb, periodId, playerId, direction) {
  const { data } = await sb.from('settlement_payments').select('amount')
    .eq('period_id',periodId).eq('player_id',playerId)
    .eq('direction',direction).eq('status','confirmed');
  return Math.round((data||[]).reduce(function(s,r){ return s+parseFloat(r.amount||0); },0)*100)/100;
}
const VALID_PAY_METHODS    = new Set(['cash','zelle','venmo','cashapp','crypto','other']);
const VALID_PAY_DIRECTIONS = new Set(['player_paid_host','host_paid_player']);
// ───────────────────────────────────────────────────────────────────────────

// GET /api/host/settlements/periods
app.get('/api/host/settlements/periods', requirePermissionScoped('view_settlement_history'), async (req, res) => {
  if (req._clubId) req.query = Object.assign({}, req.query, { clubId: req._clubId });
  const { clubId } = req.query;
  const sb = getSupabase();
  if (!sb||!clubId) return res.status(400).json({ ok:false, error:'missing_clubId' });
  try {
    const { data } = await sb.from('settlement_periods').select('*')
      .eq('club_id',clubId).order('week_start',{ ascending:false }).limit(52);
    res.json({ ok:true, periods:data||[], clubId });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/host/settlements/:periodId/snapshots
app.get('/api/host/settlements/:periodId/snapshots', requirePermissionScoped('view_settlement_history'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const { periodId } = req.params;
  const revision = req.query.revision != null ? parseInt(req.query.revision,10) : null;
  try {
    let q = sb.from('settlement_snapshots').select('*').eq('period_id',periodId);
    if (revision != null) q = q.eq('revision',revision);
    else {
      // Get latest revision
      const { data:maxRev } = await sb.from('settlement_snapshots')
        .select('revision').eq('period_id',periodId).order('revision',{ascending:false}).limit(1);
      if (maxRev&&maxRev[0]) q = q.eq('revision',maxRev[0].revision);
    }
    const { data } = await q.order('player_id');
    res.json({ ok:true, periodId, snapshots:data||[] });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/host/settlements/payment
app.post('/api/host/settlements/payment', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor||{};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.settlement_manager)
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const { periodId, clubId, playerId, direction, amount, method, note, adminOverride } = req.body||{};
  if (!periodId||!clubId||!playerId) return res.status(400).json({ ok:false, error:'missing_required_field' });
  if (!VALID_PAY_DIRECTIONS.has(direction)) return res.status(400).json({ ok:false, error:'invalid_direction' });
  if (!VALID_PAY_METHODS.has(method||'cash')) return res.status(400).json({ ok:false, error:'invalid_method' });
  const amt = parseFloat(amount);
  if (isNaN(amt)||amt<=0) return res.status(400).json({ ok:false, error:'invalid_amount' });
  try {
    // Period must be closed or reopened
    const { data:pData } = await sb.from('settlement_periods').select('status,revision')
      .eq('period_id',periodId).limit(1);
    const period = pData&&pData[0];
    if (!period||period.status==='open')
      return res.status(409).json({ ok:false, code:'period_not_closed' });
    // Snapshot for overpayment check
    const { data:snapData } = await sb.from('settlement_snapshots').select('amount_owed_by_player,amount_owed_to_player')
      .eq('period_id',periodId).eq('player_id',playerId).order('revision',{ascending:false}).limit(1);
    const snap = snapData&&snapData[0]||{ amount_owed_by_player:0, amount_owed_to_player:0 };
    const owedKey = direction==='player_paid_host'?'amount_owed_by_player':'amount_owed_to_player';
    const amountOwed = parseFloat(snap[owedKey]||0);
    const alreadyPaid = await _calcTotalPaid(sb, periodId, playerId, direction);
    const remaining  = Math.round((amountOwed-alreadyPaid)*100)/100;
    if (amt > remaining+0.005 && !adminOverride) {
      emitRiskAlert('settlement_overpayment_attempt', clubId, actor.actorId,
        { attempted:amt, remaining, amountOwed });
      return res.status(409).json({ ok:false, code:'overpayment_blocked',
        amountOwed, alreadyPaid, remaining, attempted:amt });
    }
    if (amt > remaining+0.005 && adminOverride && (ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin)
      return res.status(403).json({ ok:false, code:'insufficient_role_for_override', required:'full_admin' });
    // Create payment row
    const paymentId = 'PAY_'+clubId+'_'+playerId+'_'+Date.now();
    const now = new Date().toISOString();
    const { error:pErr } = await sb.from('settlement_payments').insert({
      payment_id:paymentId, period_id:periodId, revision:period.revision||0,
      club_id:clubId, player_id:playerId, direction, amount:amt,
      method:method||'cash', status:'pending', note:note||null,
      created_at:now, created_by:actor.actorId||'host'
    });
    if (pErr) throw pErr;
    _writeAuthAudit('payment_recorded', actor.actorId, clubId, '/settlements/payment',
      { paymentId, direction, amount:amt, method:method||'cash' });
    console.log('[settlement/payment] '+paymentId+' '+direction+' $'+amt+' pending');
    res.json({ ok:true, paymentId, status:'pending', direction, amount:amt });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/host/settlements/payment-confirm
app.post('/api/host/settlements/payment-confirm', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor||{};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.settlement_manager)
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const { paymentId } = req.body||{};
  if (!paymentId) return res.status(400).json({ ok:false, error:'missing_paymentId' });
  try {
    const { data:pData } = await sb.from('settlement_payments').select('*').eq('payment_id',paymentId).limit(1);
    const pay = pData&&pData[0];
    if (!pay) return res.status(404).json({ ok:false, error:'payment_not_found' });
    if (pay.status==='confirmed') return res.json({ ok:true, idempotent:true, paymentId });
    if (pay.status==='voided')    return res.status(409).json({ ok:false, error:'payment_voided' });
    const iKey = 'CONFIRM_PAY_'+paymentId;
    // Guard: check canonical ledger for existing SETTLEMENT_APPLIED (R1_FIXED_double_settlement_guard)
    // Prevents double-write if settle-player already executed the RPC for this debt.
    // Check by settlement_id (settle_player_tx uses idempotencyKey as settlement_id in ledger)
    // OR by idempotency_key = CONFIRM_PAY_<paymentId> (own prior write).
    var _existingSettlement = null;
    try {
      // Check if a ledger row already exists with our own iKey (pure idempotency replay)
      var _ownRow = await sb.from('ledger').select('ledger_id,settlement_id')
        .eq('club_id',pay.club_id).eq('player_id',pay.player_id)
        .eq('event_type','SETTLEMENT_APPLIED').eq('idempotency_key',iKey).limit(1);
      if (_ownRow.data && _ownRow.data[0]) _existingSettlement = _ownRow.data[0];
      // Also check if a DIRECT settlement row exists for same player+direction+amount
      // (settle-player path stores ledger_settlement_id for cross-reference)
      if (!_existingSettlement) {
        var _directPay = await sb.from('settlement_payments').select('payment_id,ledger_settlement_id')
          .eq('club_id',pay.club_id).eq('player_id',pay.player_id)
          .eq('direction',pay.direction).eq('status','confirmed').eq('method','direct')
          .eq('amount',pay.amount).limit(1);
        if (_directPay.data && _directPay.data[0] && _directPay.data[0].ledger_settlement_id) {
          // settle-player already wrote the ledger entry; this confirm is a no-ledger idempotent
          console.log('[settlement/confirm] DOUBLE_SETTLEMENT_GUARD paymentId='+paymentId
            +' — direct settlement already exists ledger_id='+_directPay.data[0].ledger_settlement_id
            +' — skipping second SETTLEMENT_APPLIED write');
          await sb.from('settlement_payments').update({
            status:'confirmed', confirmed_at:new Date().toISOString(),
            confirmed_by:(actor&&actor.actorId)||'host', ledger_written:false,
            note:(pay.note?pay.note+' ':'')+'[no-ledger: covered by direct settlement]'
          }).eq('payment_id',paymentId);
          return res.json({ ok:true, paymentId, ledgerId:null, doubleSettlementPrevented:true });
        }
      }
    } catch(_gsErr) { console.warn('[settlement/confirm] guard query error:', _gsErr.message); }
    if (_existingSettlement) {
      // Own prior write found — idempotent replay, update payment status if needed
      if (pay.status !== 'confirmed') {
        await sb.from('settlement_payments').update({
          status:'confirmed', confirmed_at:new Date().toISOString(),
          confirmed_by:(actor&&actor.actorId)||'host', ledger_written:true
        }).eq('payment_id',paymentId);
      }
      return res.json({ ok:true, paymentId, idempotent:true, ledgerId:_existingSettlement.ledger_id });
    }
    // Write canonical ledger
    const dir = pay.direction==='player_paid_host'?'debit':'credit';
    await _writeLedgerEntry({
      clubId:pay.club_id, playerId:pay.player_id, settlementId:paymentId,
      eventType:'SETTLEMENT_APPLIED', amount:parseFloat(pay.amount),
      idempotencyKey:iKey, createdBy:actor.actorId||'host',
      reason:'payment_confirmed:'+pay.direction
    });
    const now = new Date().toISOString();
    await sb.from('settlement_payments').update({
      status:'confirmed', confirmed_at:now, confirmed_by:actor.actorId||'host', ledger_written:true
    }).eq('payment_id',paymentId);
    _writeAuthAudit('payment_confirmed', actor.actorId, pay.club_id, '/settlements/payment-confirm',
      { paymentId, amount:pay.amount, direction:pay.direction });
    console.log('[settlement/confirm] '+paymentId+' confirmed $'+pay.amount+' '+dir);
    emitEvent('payment_confirmed',{ paymentId, amount:pay.amount, direction:pay.direction },
      { clubId:pay.club_id, playerId:pay.player_id, actorId:actor.actorId }, req.requestId);
    res.json({ ok:true, paymentId, ledgerId:'LE_PAY_'+paymentId });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/host/settlements/payment-void
app.post('/api/host/settlements/payment-void', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor||{};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin)
    return res.status(403).json({ ok:false, error:'insufficient_role', required:'full_admin' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const { paymentId, voidReason } = req.body||{};
  if (!paymentId) return res.status(400).json({ ok:false, error:'missing_paymentId' });
  try {
    const { data:pData } = await sb.from('settlement_payments').select('*').eq('payment_id',paymentId).limit(1);
    const pay = pData&&pData[0];
    if (!pay) return res.status(404).json({ ok:false, error:'payment_not_found' });
    if (pay.status==='voided') return res.json({ ok:true, idempotent:true, paymentId });
    let reversalLedgerId = null;
    // If already ledger-applied, write reversal
    if (pay.ledger_written) {
      const revDir = pay.direction==='player_paid_host'?'credit':'debit';
      const rKey = 'VOID_PAY_'+paymentId;
      await _writeLedgerEntry({
        clubId:pay.club_id, playerId:pay.player_id, settlementId:paymentId,
        eventType:'BALANCE_ADJUSTMENT', amount:parseFloat(pay.amount),
        idempotencyKey:rKey, createdBy:actor.actorId||'host',
        reason:'void_reversal:'+paymentId, metadataJson:{ voidedPaymentId:paymentId }
      });
      reversalLedgerId = 'LE_REV_'+paymentId;
    }
    const now = new Date().toISOString();
    await sb.from('settlement_payments').update({
      status:'voided', voided_at:now, voided_by:actor.actorId||'host',
      void_reason:voidReason||null
    }).eq('payment_id',paymentId);
    _writeAuthAudit('payment_voided', actor.actorId, pay.club_id, '/settlements/payment-void',
      { paymentId, amount:pay.amount, reversalLedgerId, voidReason });
    console.log('[settlement/void] '+paymentId+(reversalLedgerId?' reversal='+reversalLedgerId:''));
    emitEvent('payment_voided',{ paymentId, reversalLedgerId, amount:pay.amount },
      { clubId:pay.club_id, playerId:pay.player_id, actorId:actor.actorId }, req.requestId);
    res.json({ ok:true, paymentId, reversalLedgerId });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/host/settlements/:periodId/payments
app.get('/api/host/settlements/:periodId/payments', requirePermissionScoped('view_settlement_history'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const { periodId } = req.params;
  const actor = req._actor||{};
  try {
    // Load snapshots (latest revision)
    const { data:revData } = await sb.from('settlement_snapshots').select('revision')
      .eq('period_id',periodId).order('revision',{ascending:false}).limit(1);
    const latestRev = revData&&revData[0]?revData[0].revision:0;
    const { data:snaps } = await sb.from('settlement_snapshots').select('*')
      .eq('period_id',periodId).eq('revision',latestRev);
    const { data:payments } = await sb.from('settlement_payments').select('*')
      .eq('period_id',periodId).order('created_at');
    // Build per-player balance view
    const byPlayer = {};
    (snaps||[]).forEach(function(s) {
      const paidBy = (payments||[]).filter(function(p){ return p.player_id===s.player_id&&p.status==='confirmed'&&p.direction==='player_paid_host'; })
                       .reduce(function(acc,p){ return acc+parseFloat(p.amount||0); },0);
      const paidTo = (payments||[]).filter(function(p){ return p.player_id===s.player_id&&p.status==='confirmed'&&p.direction==='host_paid_player'; })
                       .reduce(function(acc,p){ return acc+parseFloat(p.amount||0); },0);
      const owedBy = parseFloat(s.amount_owed_by_player||0);
      const owedTo = parseFloat(s.amount_owed_to_player||0);
      const remBy  = Math.round((owedBy-paidBy)*100)/100;
      const remTo  = Math.round((owedTo-paidTo)*100)/100;
      const status = owedBy>0?(paidBy<=0?'unpaid':paidBy<owedBy-0.005?'partial':paidBy>owedBy+0.005?'overpaid':'paid')
                   : owedTo>0?(paidTo<=0?'unpaid':paidTo<owedTo-0.005?'partial':paidTo>owedTo+0.005?'overpaid':'paid')
                   : 'even';
      byPlayer[s.player_id] = {
        playerId:s.player_id, owedByPlayer:owedBy, owedToPlayer:owedTo,
        paidByPlayer:Math.round(paidBy*100)/100, paidToPlayer:Math.round(paidTo*100)/100,
        remainingByPlayer:remBy, remainingToPlayer:remTo,
        status, paymentHistory:(payments||[]).filter(function(p){ return p.player_id===s.player_id; })
      };
    });
    res.json({ ok:true, periodId, playerBalances:Object.values(byPlayer) });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/host/settlements/close-week
app.post('/api/host/settlements/close-week', requireCanonicalClubId, requirePermissionScoped('settlement_manager'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor   = req._actor||{};
  const actorRank = ROLE_RANK[actor.role]||0;
  const { clubId, weekStart, forceClose } = req.body||{};
  if (!clubId||!weekStart) return res.status(400).json({ ok:false, error:'missing_clubId_or_weekStart' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const now = new Date().toISOString();
  try {
    // Ensure period exists
    const periodId = 'SP_'+clubId+'_'+weekStart;
    await sb.from('settlement_periods').upsert({
      period_id:periodId, club_id:clubId, week_start:weekStart,
      week_end: new Date(new Date(weekStart).getTime()+6*86400000).toISOString().slice(0,10),
      status:'open'
    }, { onConflict:'club_id,week_start', ignoreDuplicates:true });

    // Load period
    const { data:pData } = await sb.from('settlement_periods').select('*')
      .eq('period_id',periodId).limit(1);
    const period = pData&&pData[0];
    if (!period) return res.status(404).json({ ok:false, error:'period_not_found' });
    if (period.status==='closed')
      return res.status(409).json({ ok:false, code:'period_already_closed', periodId });

    // Check open tickets
    const { data:openTix } = await sb.from('tickets').select('id,player_id')
      .eq('club_id',clubId).in('status',['active','open']);
    const openCount = (openTix||[]).length;
    if (openCount>0 && !forceClose)
      return res.status(409).json({ ok:false, code:'open_tickets_exist', openCount,
        hint:'Set forceClose:true with full_admin+ to override' });
    if (openCount>0 && forceClose && actorRank < ROLE_RANK.full_admin)
      return res.status(403).json({ ok:false, code:'insufficient_role_for_force_close', required:'full_admin' });

    // Compute player snapshots from canonical ledger
    const { data:members } = await sb.from('club_memberships')
      .select('actor_id').eq('club_id',clubId).eq('status','active');
    const { data:limits } = await sb.from('player_limits')
      .select('player_id,balance_start').eq('club_id',clubId);
    const balMap = {}; (limits||[]).forEach(function(l){ balMap[l.player_id]=parseFloat(l.balance_start)||1000; });
    const { data:allTix } = await sb.from('tickets')
      .select('player_id,status,risk_amount,potential_profit').eq('club_id',clubId);
    const nextRevision = (period.revision||0) + 1;
    const snapRows = [];
    for (const m of (members||[])) {
      const pid = m.actor_id;
      const starting = balMap[pid]||1000;
      const { data:lRows } = await sb.from('ledger').select('amount,direction')
        .eq('club_id',clubId).eq('player_id',pid);
      const ptix = (allTix||[]).filter(function(t){ return t.player_id===pid; });
      let cred=0,deb=0,openRisk=0,gains=0,losses=0,openCt=0,closedCt=0;
      (lRows||[]).forEach(function(r){
        if(r.direction==='credit') cred+=parseFloat(r.amount||0);
        else if(r.direction==='debit') deb+=parseFloat(r.amount||0);
      });
      ptix.forEach(function(t){
        var s=t.status.toLowerCase(), r=parseFloat(t.risk_amount||0), p=parseFloat(t.potential_profit||0);
        if(s==='active'||s==='open'){openRisk+=r;openCt++;}
        else closedCt++;
        if(s==='won') gains+=p;
        if(s==='lost') losses+=r;
      });
      const ledBal  = Math.round((starting+cred-deb)*100)/100;
      const netRes  = Math.round((gains-losses)*100)/100;
      const finBal  = Math.round((ledBal-Math.round(openRisk*100)/100)*100)/100;
      snapRows.push({
        period_id:periodId, revision:nextRevision, club_id:clubId, player_id:pid,
        starting_limit:starting,
        ledger_credits:Math.round(cred*100)/100,
        ledger_debits:Math.round(deb*100)/100,
        ledger_balance:ledBal,
        open_risk:Math.round(openRisk*100)/100,
        net_result:netRes,
        final_balance:finBal,
        amount_owed_by_player:netRes<0?Math.round(Math.abs(netRes)*100)/100:0,
        amount_owed_to_player:netRes>0?Math.round(netRes*100)/100:0,
        ticket_count:ptix.length,
        closed_ticket_count:closedCt,
        open_ticket_count:openCt
      });
    }

    if (snapRows.length) {
      const { error:sErr } = await sb.from('settlement_snapshots').insert(snapRows);
      if (sErr) throw sErr;
    }

    // Update period status
    const { error:pErr } = await sb.from('settlement_periods')
      .update({ status:'closed', closed_at:now, closed_by:actor.actorId||'host',
                revision:nextRevision })
      .eq('period_id',periodId);
    if (pErr) throw pErr;

    // Audit event
    await sb.from('audit_events').insert({
      event_type:'settlement_period_closed', club_id:clubId,
      payload:{ periodId, weekStart, closedBy:actor.actorId, forceClose:!!forceClose,
                playerCount:snapRows.length, revision:nextRevision }
    });

    emitEvent('settlement_closed',{ periodId, weekStart, revision:nextRevision, playerCount:snapRows.length },
      { clubId }, req.requestId);
    console.log('[close-week] periodId='+periodId+' players='+snapRows.length+' rev='+nextRevision);
    res.json({ ok:true, periodId, weekStart, revision:nextRevision,
               playerCount:snapRows.length, forceClose:!!forceClose });
  } catch(e) {
    console.error('[close-week] error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// POST /api/host/settlements/reopen-week
app.post('/api/host/settlements/reopen-week', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor||{};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin)
    return res.status(403).json({ ok:false, error:'insufficient_role', required:'full_admin' });
  const { clubId, weekStart, reason } = req.body||{};
  if (!clubId||!weekStart) return res.status(400).json({ ok:false, error:'missing_fields' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const periodId = 'SP_'+clubId+'_'+weekStart;
  const now = new Date().toISOString();
  try {
    const { data:pData } = await sb.from('settlement_periods').select('*')
      .eq('period_id',periodId).limit(1);
    const period = pData&&pData[0];
    if (!period) return res.status(404).json({ ok:false, error:'period_not_found' });
    if (period.status!=='closed'&&period.status!=='reopened')
      return res.status(409).json({ ok:false, code:'period_not_closed', status:period.status });
    await sb.from('settlement_periods')
      .update({ status:'reopened', reopened_at:now, reopened_by:actor.actorId||'host',
                reason:reason||null })
      .eq('period_id',periodId);
    await sb.from('audit_events').insert({
      event_type:'settlement_period_reopened', club_id:clubId,
      payload:{ periodId, weekStart, reopenedBy:actor.actorId, reason:reason||null }
    });
    console.log('[reopen-week] periodId='+periodId);
    res.json({ ok:true, periodId, weekStart, status:'reopened' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
// ───────────────────────────────────────────────────────────────────────────

// GET /api/host/reconciliation — Phase H atomic ledger balance reconciliation
app.get('/api/host/reconciliation', requireCanonicalClubId, requirePermissionScoped('view_settlement_history'), async (req, res) => {
  if (req._clubId) req.query = Object.assign({}, req.query, { clubId: req._clubId });
  const { clubId } = req.query;
  const sb = getSupabase();
  if (!sb || !clubId) return res.json({ ok:false, error:'missing_clubId_or_supabase' });
  try {
    // Load all club players
    const { data: members } = await sb.from('club_memberships')
      .select('actor_id,role').eq('club_id',clubId).eq('status','active');
    const { data: limits }  = await sb.from('player_limits')
      .select('player_id,balance_start').eq('club_id',clubId);
    const balanceMap = {};
    (limits||[]).forEach(function(l){ balanceMap[l.player_id]=parseFloat(l.balance_start)||1000; });

    const players = [];
    for (const m of (members||[])) {
      const pid = m.actor_id;
      const startingLimit = balanceMap[pid]||1000;
      // Ledger-derived balance
      const { data: ledgerRows } = await sb.from('ledger').select('amount,direction')
        .eq('club_id',clubId).eq('player_id',pid);
      const { data: activeTix } = await sb.from('tickets').select('risk_amount,status,potential_profit')
        .eq('club_id',clubId).eq('player_id',pid);
      const allTix = activeTix||[];
      const ledgerBal = _deriveLedgerBalance(startingLimit, ledgerRows||[]);
      const openRisk  = allTix.filter(function(t){ return t.status==='active'||t.status==='open'; })
                              .reduce(function(s,t){ return s+parseFloat(t.risk_amount||0); },0);
      const ledgerAvail = Math.round((ledgerBal-openRisk)*100)/100;
      // Ticket-derived (old)
      let gains=0, losses=0;
      allTix.forEach(function(t){
        if(t.status==='won') gains+=parseFloat(t.potential_profit||0);
        if(t.status==='lost') losses+=parseFloat(t.risk_amount||0);
      });
      const ticketAvail = Math.round((startingLimit-openRisk-losses+gains)*100)/100;
      const mismatch = Math.abs(ledgerAvail-ticketAvail)>0.01;
      const lastRow = (ledgerRows||[]).slice(-1)[0];
      players.push({ playerId:pid, role:m.role, startingLimit, ledgerBal, ledgerAvail,
                     ticketAvail, openRisk, mismatch,
                     lastLedgerId:lastRow&&lastRow.ledger_id||null });
    }
    const mismatches = players.filter(function(p){ return p.mismatch; });
    res.json({ ok:true, clubId, players, mismatchCount:mismatches.length,
               healthy:mismatches.length===0 });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/host/settlement-reconciliation — read-only balance proof
app.get('/api/host/settlement-reconciliation', requireCanonicalClubId, requirePermissionScoped('view_settlement_history'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, status:'supabase_not_configured' });
  if (req._clubId) req.query = Object.assign({}, req.query, { clubId: req._clubId });
  const { clubId } = req.query;
  const rnd = function(v){ return Math.round((isNaN(v)?0:v)*100)/100; };
  try {
    // 1. Tickets
    let tq = sb.from('tickets').select('id,status,risk_amount,potential_profit');
    if (clubId) tq = tq.eq('club_id', clubId);
    const { data: tickets } = await tq;
    var activeRisk=0, settledGain=0, settledLoss=0;
    (tickets||[]).forEach(function(t){
      var s=t.status.toLowerCase(), r=parseFloat(t.risk_amount)||0, p=parseFloat(t.potential_profit)||0;
      if (s==='canceled'||s==='voided'||s==='push'||s==='pushed') return;
      if (s==='active'||s==='open')  activeRisk  +=r;
      else if (s==='lost')           settledGain +=r;
      else if (s==='won')            settledLoss +=p;
    });
    var ticketTotals = { activeRisk:rnd(activeRisk), settledGain:rnd(settledGain),
      settledLoss:rnd(settledLoss), profit:rnd(settledGain-settledLoss) };

    // 2. Ledger
    let lq = sb.from('ledger_entries').select('id,type,amount');
    if (clubId) lq = lq.eq('club_id', clubId);
    const { data: ledger } = await lq;
    var lTotals = { bet_placed:0,bet_won:0,bet_lost:0,bet_push:0,bet_canceled:0,settlement:0,other:0 };
    (ledger||[]).forEach(function(e){
      var a=parseFloat(e.amount)||0;
      if (lTotals[e.type]!==undefined) lTotals[e.type]+=a; else lTotals.other+=a;
    });
    var ledgerNet = rnd(Object.values(lTotals).reduce(function(s,v){return s+v;},0));
    var ledgerTotals = Object.assign({net:ledgerNet},
      Object.fromEntries(Object.entries(lTotals).map(function(kv){return [kv[0],rnd(kv[1])];})));

    // 3. Settlement preview
    var byPlayer={}, oweTot=0, hostTot=0;
    (tickets||[]).forEach(function(t){
      var pid=t.player_id||'unknown', s=t.status.toLowerCase(),
          r=parseFloat(t.risk_amount)||0, p=parseFloat(t.potential_profit)||0;
      if (!byPlayer[pid]) byPlayer[pid]={net:0};
      if (s==='canceled'||s==='voided'||s==='push'||s==='pushed') return;
      if (s==='lost') byPlayer[pid].net-=r;
      if (s==='won')  byPlayer[pid].net+=p;
    });
    Object.values(byPlayer).forEach(function(p){
      if (p.net<0) oweTot+=Math.abs(p.net); else hostTot+=p.net;
    });
    var previewTotals = { playersOwe:rnd(oweTot), hostOwes:rnd(hostTot), net:rnd(oweTot-hostTot) };

    // 4. Latest rollover
    var latestRollover = null;
    try {
      let rq = sb.from('weekly_rollovers').select('rollover_week,totals_snapshot,performed_at')
        .order('rollover_week',{ascending:false}).limit(1);
      if (clubId) rq = rq.eq('club_id',clubId);
      const { data:rr } = await rq;
      if (rr&&rr[0]) { var rt={}; try{rt=JSON.parse(rr[0].totals_snapshot||'{}');}catch(_e){}
        latestRollover = { rolloverWeek:rr[0].rollover_week, performedAt:rr[0].performed_at, ...rt }; }
    } catch(_e){}

    // 5. Legacy mismatches (kept for backward compat)
    var mismatches = [];
    var pNet = previewTotals.net;
    if (Math.abs(ticketTotals.profit - pNet) > 0.02)
      mismatches.push({ category:'ticket_vs_preview', delta:rnd(ticketTotals.profit-pNet),
        detail:'ticketProfit='+ticketTotals.profit+' previewNet='+pNet });
    if (latestRollover) {
      var snapCalcNet = rnd((latestRollover.playersOwe||0)-(latestRollover.hostOwes||0));
      if (Math.abs(snapCalcNet-(latestRollover.net||0)) > 0.02)
        mismatches.push({ category:'snapshot_internal', delta:rnd(snapCalcNet-(latestRollover.net||0)),
          detail:'calcNet='+snapCalcNet+' snapshotNet='+latestRollover.net });
    }

    // 5b. TRUE cross-source check: ticket-derived net vs canonical ledger net (BUG11_FIXED_ledger_vs_ticket_xcheck)
    // Previous code compared ticket scan vs ticket scan (different aggregations of the same data)
    // which would always show "balanced" even when ledger_entries diverged from tickets.
    // Now we build per-player nets from BOTH sources and flag any divergence.
    var ledgerXCheck = [];
    try {
      // 5b-i. Ticket-derived per-player settled net (won - lost, no canceled/voided/push/active/open)
      var ticketNetByPlayer = {};
      var ticketIdsByPlayer = {};
      (tickets||[]).forEach(function(t) {
        var s = (t.status||'').toLowerCase();
        if (s==='canceled'||s==='voided'||s==='push'||s==='pushed'||s==='active'||s==='open') return;
        var pid = t.player_id||'unknown';
        if (!ticketNetByPlayer[pid]) { ticketNetByPlayer[pid]=0; ticketIdsByPlayer[pid]=[]; }
        if (s==='won')  ticketNetByPlayer[pid] += parseFloat(t.potential_profit)||0;
        if (s==='lost') ticketNetByPlayer[pid] -= parseFloat(t.risk_amount)||0;
        ticketIdsByPlayer[pid].push(t.id||'?');
      });

      // 5b-ii. Canonical ledger net per player
      // Use the 'ledger' table (canonical — credit/debit rows) not 'ledger_entries' (mirror).
      // settlement-relevant event types: BET_GRADED_WIN (credit), BET_GRADED_LOSS (neutral by
      // convention — loss risk was already debited at placement), SETTLEMENT_APPLIED.
      // Simpler cross-check: sum credits - debits for settlement event types per player.
      var ledgerNetByPlayer = {};
      var ledgerIdsByPlayer = {};
      var SETTLEMENT_CREDIT_EVENTS = new Set(['BET_GRADED_WIN','BET_GRADED_PUSH','BET_CANCELED_REFUND','SETTLEMENT_APPLIED']);
      var SETTLEMENT_DEBIT_EVENTS  = new Set(['BET_PLACED','BET_GRADED_LOSS']);
      var lrq = sb.from('ledger').select('ledger_id,player_id,event_type,amount,direction');
      if (clubId) lrq = lrq.eq('club_id', clubId);
      const { data: canonLedger } = await lrq;
      (canonLedger||[]).forEach(function(r) {
        var pid = r.player_id||'unknown';
        var amt = parseFloat(r.amount||0);
        var et  = (r.event_type||'').toUpperCase();
        if (!SETTLEMENT_CREDIT_EVENTS.has(et) && !SETTLEMENT_DEBIT_EVENTS.has(et)) return;
        if (!ledgerNetByPlayer[pid]) { ledgerNetByPlayer[pid]=0; ledgerIdsByPlayer[pid]=[]; }
        if (r.direction==='credit') ledgerNetByPlayer[pid] += amt;
        else if (r.direction==='debit') ledgerNetByPlayer[pid] -= amt;
        ledgerIdsByPlayer[pid].push(r.ledger_id||'?');
      });

      // 5b-iii. Compare per-player: players that appear in either source
      var allPids = new Set([
        ...Object.keys(ticketNetByPlayer),
        ...Object.keys(ledgerNetByPlayer)
      ]);
      allPids.forEach(function(pid) {
        var tNet = rnd(ticketNetByPlayer[pid] || 0);
        var lNet = rnd(ledgerNetByPlayer[pid] || 0);
        var delta = rnd(tNet - lNet);
        if (Math.abs(delta) > 0.02) {
          ledgerXCheck.push({
            playerId:     pid,
            ticketNet:    tNet,
            ledgerNet:    lNet,
            delta:        delta,
            ticketIds:    (ticketIdsByPlayer[pid]||[]).slice(0,10),
            ledgerIds:    (ledgerIdsByPlayer[pid]||[]).slice(0,10),
            detail:       'ticketNet='+tNet+' ledgerNet='+lNet+' delta='+delta
          });
        }
      });

      // Also flag: club has tickets but NO ledger entries at all (fully missing ledger)
      var hasAnyTicketNet = Object.keys(ticketNetByPlayer).length > 0;
      var hasAnyLedger    = Object.keys(ledgerNetByPlayer).length > 0;
      if (hasAnyTicketNet && !hasAnyLedger) {
        mismatches.push({ category:'ledger_entirely_missing',
          detail:'tickets exist but canonical ledger has no settlement entries for this club' });
      }
    } catch(_xcErr) {
      console.warn('[settlement-reconciliation] ledger x-check error:', _xcErr.message);
      ledgerXCheck = [{ error:_xcErr.message, detail:'ledger_xcheck_failed' }];
    }

    // Merge ledger x-check mismatches into main mismatches array
    ledgerXCheck.forEach(function(x) {
      if (!x.error) mismatches.push(Object.assign({ category:'ticket_vs_ledger' }, x));
    });

    var overallStatus = mismatches.length===0 ? 'balanced' : 'mismatch';
    console.log('[settlement-reconciliation] status='+overallStatus+
      ' legacyMismatches='+(mismatches.filter(function(m){return m.category!=='ticket_vs_ledger';}).length)+
      ' ledgerXCheckMismatches='+ledgerXCheck.filter(function(x){return !x.error;}).length);

    res.json({ ok:true, clubId:clubId||null, ticketTotals, ledgerTotals,
      settlementPreviewTotals:previewTotals, latestRollover,
      ledgerCrossCheck: ledgerXCheck,
      mismatches, status:overallStatus });
  } catch(e) {
    console.error('[reconciliation] error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// GET /api/grade/status — returns last-graded timestamp + recent results
app.get('/api/grade/status', async (req, res) => {
  const sb = getSupabase();
  const containment = _gradingContainmentStatus();
  if (!sb) return res.json({ enabled:false, reason:'supabase_not_configured',
    containment, settlementEnabled:GRADING_SETTLEMENT_ENABLED,
    dryRunEnabled:GRADE_RUN_DRY_RUN_ENABLED });
  try {
    const { data: recent } = await sb.from('audit_events')
      .select('id,event_type,ticket_id,payload,created_at')
      .eq('event_type','ticket_graded_server')
      .order('created_at',{ ascending:false }).limit(10);
    const { data: active } = await sb.from('tickets')
      .select('id',{ count:'exact' }).in('status',['active','open']);
    res.json({ enabled:true, lastGradedAt: recent&&recent[0] ? recent[0].created_at : null,
      recentGrades: recent||[], activeTicketCount: active ? active.length : 0,
      containment, settlementEnabled:GRADING_SETTLEMENT_ENABLED,
      dryRunEnabled:GRADE_RUN_DRY_RUN_ENABLED });
  } catch(e) { res.status(500).json({ enabled:true, error:e.message }); }
});
// ════════════════════════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  const _startSHA = 'v6-decode-fallback'; // bumped for v6
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  PocketBooks Sports Backend  sha='+_startSHA+'    ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  PORT='+PORT+'  NODE_ENV='+process.env.NODE_ENV+'  DEV_AUTH_BYPASS='+process.env.DEV_AUTH_BYPASS);
  console.log('║  SUPABASE_URL='+(process.env.SUPABASE_URL?'set':'MISSING'));
  console.log('║  SESSION_SECRET='+(process.env.SESSION_SECRET && process.env.SESSION_SECRET !== 'dev-insecure-secret-change-in-prod' ? 'set':'MISSING/default'));
  if (!GRADING_SETTLEMENT_ENABLED)
    console.warn('[grading] SETTLEMENT DISABLED reason='+GRADING_DISABLED_REASON+
      ' dryRun='+GRADE_RUN_DRY_RUN_ENABLED+
      ' workerSettlement='+WORKER_GRADE_SETTLEMENT_ENABLED+
      ' manualSettlement='+MANUAL_GRADE_SETTLEMENT_ENABLED);
  if (!BROWSER_TICKET_MIRROR_WRITES_ENABLED || !BROWSER_LEDGER_MIRROR_WRITES_ENABLED)
    console.warn('[mirror] browser writes containment ticketWrites='+BROWSER_TICKET_MIRROR_WRITES_ENABLED+
      ' ledgerWrites='+BROWSER_LEDGER_MIRROR_WRITES_ENABLED);
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log(`✅ Server running on port ${PORT}`);
  // Init DB after server is bound
  initDB()
    .then(() => console.log('✅ DB ready'))
    .then(() => _migrateOddsSnapshotsSchema())
    .catch(e => console.error('DB init failed:', e.message));
});
// redeploy trigger 1779788685
