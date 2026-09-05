require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const espnScoreboard = require('./lib/espn-scoreboard');
const unresolvedGradingMonitor = require('./lib/unresolved-grading-monitor');
const ncaafTeamLogos = require('./lib/ncaaf-team-logos');
const soccerTeamLogos = require('./lib/soccer-team-logos');
const owlsBookmakerAdapter = require('./lib/owls-bookmaker-adapter');
const owlsLiveScores = require('./lib/owls-live-scores');
const { io: socketIoClient } = require('socket.io-client');

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
  '/api/auth/token':         { maxReqs:60,  windowMs:60000, keyBy:'ip' },
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

// Production defaults: settlement ON unless explicitly disabled via env.
// Set GRADING_SETTLEMENT_ENABLED=false to opt out (e.g. during migration testing).
const _GRADING_DEFAULT_ON = process.env.NODE_ENV === 'production';
const GRADING_SETTLEMENT_ENABLED = _envFlag('GRADING_SETTLEMENT_ENABLED', _GRADING_DEFAULT_ON);
const GRADE_RUN_DRY_RUN_ENABLED = _envFlag('GRADE_RUN_DRY_RUN_ENABLED', !_GRADING_DEFAULT_ON);
const WORKER_GRADE_SETTLEMENT_ENABLED = _envFlag('WORKER_GRADE_SETTLEMENT_ENABLED', _GRADING_DEFAULT_ON);
const MANUAL_GRADE_SETTLEMENT_ENABLED = _envFlag('MANUAL_GRADE_SETTLEMENT_ENABLED', _GRADING_DEFAULT_ON);
const BROWSER_TICKET_MIRROR_WRITES_ENABLED = _envFlag('BROWSER_TICKET_MIRROR_WRITES_ENABLED', false);
const BROWSER_LEDGER_MIRROR_WRITES_ENABLED = _envFlag('BROWSER_LEDGER_MIRROR_WRITES_ENABLED', false);
// Live betting: on in production unless explicitly disabled (matches grading default).
// Set LIVE_BETTING_ENABLED=false to opt out during migration / testing.
const LIVE_BETTING_ENABLED = _envFlag('LIVE_BETTING_ENABLED', _GRADING_DEFAULT_ON);
const GRADING_DISABLED_REASON = process.env.GRADING_DISABLED_REASON || 'grade_ticket_tx_missing';
const _BROWSER_TERMINAL_STATUSES = new Set(['won','lost','push','pushed','void','voided','refunded','settled','canceled','cancelled']);
const LIVE_PLACEMENT_REJECTION_CODES = new Set([
  'live_betting_disabled',
  'odds_changed',
  'line_changed',
  'odds_stale',
  'market_unavailable',
  'live_stake_above_max',
  'live_payout_above_max',
  'live_sport_disabled',
  'live_parlays_disabled',
  'snapshot_missing',
  'provider_unhealthy',
  'final_recheck_failed'
]);
const _liveDiagnostics = {
  counters:Object.create(null),
  recent:[]
};

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

function _normalizeLiveRejectionCode(code, reason) {
  if (code === 'odds_service_unavailable' && reason === 'snapshot_missing') return 'snapshot_missing';
  return code || 'unknown';
}

function _recordLiveDiagnosticEvent(code, ctx) {
  if (!LIVE_PLACEMENT_REJECTION_CODES.has(code)) return;
  const now = new Date().toISOString();
  const prev = _liveDiagnostics.counters[code] || { count:0, lastAt:null };
  const entry = {
    code,
    at:now,
    phase:ctx&&ctx.phase || null,
    reason:ctx&&ctx.reason || null,
    sport:ctx&&ctx.sport || null,
    clubId:ctx&&ctx.clubId || null,
    canonicalGameKey:ctx&&ctx.canonicalGameKey || null,
    leg:ctx&&ctx.leg || null,
    legIndex:ctx&&ctx.legIndex,
    liveBettingEnabled:LIVE_BETTING_ENABLED
  };
  _liveDiagnostics.counters[code] = {
    count:prev.count + 1,
    lastAt:now,
    sport:entry.sport,
    clubId:entry.clubId,
    canonicalGameKey:entry.canonicalGameKey
  };
  _liveDiagnostics.recent.push(entry);
  if (_liveDiagnostics.recent.length > 50) {
    _liveDiagnostics.recent.splice(0, _liveDiagnostics.recent.length - 50);
  }
}

function _recordLivePlacementRejection(code, ctx) {
  const normalized = _normalizeLiveRejectionCode(code, ctx && ctx.reason);
  _recordLiveDiagnosticEvent(normalized, ctx || {});
  if (ctx && ctx.phase === 'final_snapshot') {
    _recordLiveDiagnosticEvent('final_recheck_failed', Object.assign({}, ctx, { reason:normalized }));
  }
  const count = _liveDiagnostics.counters[normalized] && _liveDiagnostics.counters[normalized].count || 0;
  console.warn('LIVE_PLACEMENT_REJECTED', JSON.stringify(_sanitizeLog(Object.assign({
    code:normalized,
    count,
    liveBettingEnabled:LIVE_BETTING_ENABLED
  }, ctx||{}))));
}

function _liveRejectionContextFromLegs(legs, result, extra) {
  const idx = result && Number.isInteger(result.legIndex) ? result.legIndex : -1;
  const leg = idx >= 0 && Array.isArray(legs) ? legs[idx] : null;
  return Object.assign({
    reason:result&&result.reason||null,
    leg:result&&result.leg||leg&&leg.pick||null,
    legIndex:idx >= 0 ? idx : undefined,
    sport:result&&result.sport || leg&&leg.sport || null,
    canonicalGameKey:leg&&(leg.canonicalGameKey||leg.canonical_game_key) || null
  }, extra||{});
}

function _getLiveProviderDiagnostics(nowMs) {
  nowMs = nowMs || Date.now();
  const cache = typeof LIVE_MARKET_CACHE !== 'undefined' ? LIVE_MARKET_CACHE : null;
  const updatedAt = cache && cache.updatedAt ? new Date(cache.updatedAt).getTime() : NaN;
  const lastSuccessAt = cache && cache.lastSuccessAt ? new Date(cache.lastSuccessAt).getTime() : NaN;
  const cacheAgeMs = !isNaN(updatedAt) ? nowMs - updatedAt : null;
  const lastSuccessAgeMs = !isNaN(lastSuccessAt) ? nowMs - lastSuccessAt : null;
  const staleForLive = cacheAgeMs == null || cacheAgeMs > LIVE_SNAPSHOT_TTL_MS;
  const noRecentSuccess = lastSuccessAgeMs == null ||
    lastSuccessAgeMs > Math.max(LIVE_SNAPSHOT_TTL_MS, LIVE_CACHE_POLL_INTERVAL_MS * 3);
  const healthy = !!cache &&
    cache.sourceStatus === 'healthy' &&
    cache.gameCount > 0 &&
    !staleForLive &&
    !noRecentSuccess;
  return {
    provider:ODDS_PROVIDER,
    healthy,
    status:cache&&cache.sourceStatus || 'uninitialized',
    gameCount:cache&&cache.gameCount || 0,
    marketCount:cache&&cache.marketCount || 0,
    cacheAgeMs,
    lastSuccessfulPollAt:cache&&cache.lastSuccessAt || null,
    lastSuccessAgeMs,
    staleForLive,
    noRecentSuccess
  };
}

function rateLimitMiddleware(req, res, next) {
  // Dev/test minting is not rate-limited: /api/dev/host-token is non-prod only,
  // and /api/auth/token skips the limiter outside production so local/test
  // workflows are not blocked after a handful of logins.
  if (req.path === '/api/dev/host-token') return next();
  if (req.path === '/api/auth/token' && process.env.NODE_ENV !== 'production') return next();
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
const _ALWAYS_ALLOWED_ORIGINS = [
  'https://pocketbookssports.com',
  'https://www.pocketbookssports.com',
];
const _ALLOWED_ORIGINS_RAW = [
  ...(process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(function(s){ return s.trim(); }).filter(Boolean)
    : ['https://pocketbooks-sports.vercel.app',
       'https://pocketbooks-sports-git-main.vercel.app']),
  ..._ALWAYS_ALLOWED_ORIGINS,
].filter(function(origin, i, arr){ return origin && arr.indexOf(origin) === i; });

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
    try {
      const r = await _upsertOddsSnapshots();
      if (r && r.ok) {
        console.log('SNAPSHOT_UPSERT_RESULT source=job ok=true rows='+(r.rowsUpserted||0));
      } else {
        console.error('SNAPSHOT_UPSERT_RESULT source=job ok=false reason='+(r && (r.reason||r.error) || 'unknown')+
          ' code='+(r && r.code || '?')+' rows='+(r && r.rowsUpserted || 0));
      }
    } catch(e) {
      console.error('SNAPSHOT_UPSERT_RESULT source=job ok=false reason=threw message='+JSON.stringify(String(e && e.message || e).slice(0,300)));
    }
    logEvent('info','job:odds_refresh',{ jobId:job.job_id });
    // In-process poller is the 5s production path. If it is not running
    // (no provider keys at boot, or poller never started), keep refreshing
    // via the worker so lastSuccessAt / cacheAgeMs do not freeze after the
    // single BOOT_odds_refresh job.
    if (typeof _oddsPollerStarted === 'undefined' || !_oddsPollerStarted) {
      const delayMs = (typeof LIVE_CACHE_POLL_INTERVAL_MS === 'number' && LIVE_CACHE_POLL_INTERVAL_MS > 0)
        ? LIVE_CACHE_POLL_INTERVAL_MS : 5000;
      enqueueJob('odds_refresh', {}, {
        runAfter: new Date(Date.now() + delayMs).toISOString()
      });
    }
  },
  result_refresh: async function(job) {
    const p = job.payload_json||{};
    const sports = p.sports||(CACHE_SPORTS||['baseball_mlb']);
    await _refreshResultSnapshots(sports, p.daysBack||3);
    if (!_mlbGradePollerStarted) {
      enqueueJob('result_refresh', p, {
        runAfter: new Date(Date.now() + MLB_GRADE_POLL_MS).toISOString()
      });
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
    if (!_mlbGradePollerStarted) {
      enqueueJob('grade_run', p, {
        runAfter: new Date(Date.now() + MLB_GRADE_POLL_MS).toISOString()
      });
    }
  },
  settlement_close_check: async function(job) {
    // Check for clubs with no activity this week — log only, no auto-close
    logEvent('info','job:settlement_close_check',{ jobId:job.job_id });
  },
  payment_reconciliation: async function(job) {
    logEvent('info','job:payment_reconciliation',{ jobId:job.job_id });
  }
};

// Extracted grade core for reuse by worker. No auth — grades every club.
async function _runGradeCore(fakeReq, sb) {
  const { daysBack=3, playerId, clubId } = fakeReq.body||{};
  const skipReasons = {};
  let graded=0, skipped=0;
  function bumpSkip(reason) {
    skipped++;
    const key = reason || 'unknown';
    skipReasons[key] = (skipReasons[key] || 0) + 1;
  }
  console.log('GRADE_CORE_START daysBack='+daysBack+' clubId='+(clubId||'ALL')+
    ' playerId='+(playerId||'ALL')+' settlement='+!!GRADING_SETTLEMENT_ENABLED+
    ' workerSettlement='+!!WORKER_GRADE_SETTLEMENT_ENABLED);
  let tq = sb.from('tickets').select('id,type,status,risk_amount,potential_profit,estimated_payout,graded_at,player_id,club_id').in('status',['active','open']);
  if (playerId) tq = tq.eq('player_id',playerId);
  if (clubId)   tq = tq.eq('club_id',clubId);
  const { data:tickets, error:tErr } = await tq;
  if (tErr) {
    console.error('GRADE_CORE_TICKETS_FAIL '+tErr.message);
    return { graded:0, skipped:0, error:tErr.message, skipReasons:skipReasons };
  }
  if (!tickets||!tickets.length) {
    console.log('GRADE_CORE_DONE tickets=0 graded=0 skipped=0');
    return { graded:0, skipped:0, skipReasons:skipReasons };
  }
  const ticketIds = tickets.map(function(t){ return t.id; });
  const clubs = [...new Set(tickets.map(function(t){ return t.club_id || 'null'; }))];
  console.log('GRADE_CORE_TICKETS n='+tickets.length+' clubs='+clubs.length);
  const { data:allLegs, error:lErr } = await sb.from('ticket_legs').select('*').in('ticket_id',ticketIds);
  if (lErr) console.warn('GRADE_CORE_LEGS_FAIL '+lErr.message);
  const sports = [...new Set((allLegs||[]).map(function(l){
    return _oddsApiSportKey(l.sport || l.league || 'baseball_mlb');
  }))];
  let snapshotsUpserted = 0;
  let freshSnapRows = [];
  const extraYmds = _pastScoreboardYmdsFromLegs(allLegs, 14);
  try {
    const refreshed = await _refreshResultSnapshots(sports.length ? sports : ['baseball_mlb'], daysBack, extraYmds);
    snapshotsUpserted = (refreshed && typeof refreshed.upserted === 'number')
      ? refreshed.upserted : (typeof refreshed === 'number' ? refreshed : 0);
    freshSnapRows = (refreshed && refreshed.rows) || [];
  } catch(_e) { console.warn('GRADE_CORE_REFRESH_FAIL '+_e.message); }
  const uniqueKeys = [...new Set((allLegs||[]).map(function(l){ return l.canonical_game_key||''; }).filter(Boolean))];
  const lookupKeys = [];
  uniqueKeys.forEach(function(k) {
    _gameKeyLookupCandidates(k).forEach(function(c){ lookupKeys.push(c); });
  });
  const { data:snapRows, error:sErr } = lookupKeys.length
    ? await sb.from('result_snapshots').select('*').in('canonical_game_key',lookupKeys)
    : { data:[], error:null };
  if (sErr) console.warn('GRADE_CORE_SNAPSHOT_LOAD_FAIL '+sErr.message);
  // Recent snapshots so team-name fallback works when stored ESPN keys
  // don't overlap ticket_legs.canonical_game_key candidates.
  const sinceIso = new Date(Date.now() - (Math.max(14, parseInt(daysBack,10)||3)+1)*86400000).toISOString();
  const { data:recentSnaps, error:rErr } = await sb.from('result_snapshots')
    .select('*').gte('fetched_at', sinceIso).limit(400);
  if (rErr) console.warn('GRADE_CORE_SNAPSHOT_RECENT_FAIL '+rErr.message);
  const resultsByKey = {};
  (snapRows||[]).concat(recentSnaps||[]).concat(freshSnapRows).forEach(function(r){
    _indexResultByLookupKeys(resultsByKey, r);
  });
  const espnKeys = _uniqueResultRows(resultsByKey).map(function(r){
    return r.canonical_game_key || '';
  }).filter(Boolean);
  const espnSample = espnKeys.slice(0, 12);
  console.log('GRADE_KEY_COMPARE espnKeys='+espnKeys.length+
    ' sample='+JSON.stringify(espnSample)+
    ' ticketKeys='+uniqueKeys.length);
  uniqueKeys.slice(0, 24).forEach(function(tk) {
    const hit = _lookupResultByGameKey(resultsByKey, tk);
    const hitKey = (hit && hit.canonical_game_key) || '';
    const hitStatus = hit ? (hit.status || 'unknown') : 'miss';
    console.log('GRADE_KEY_COMPARE ticketKey='+tk+
      ' espnHitKey='+hitKey+
      ' match='+(hit?'true':'false')+
      ' hitStatus='+hitStatus);
  });
  const matchedKeys = uniqueKeys.filter(function(k){ return !!_lookupResultByGameKey(resultsByKey, k); });
  const unmatchedSample = uniqueKeys.filter(function(k){ return !_lookupResultByGameKey(resultsByKey, k); }).slice(0, 8);
  console.log('GRADE_CORE_SNAPSHOTS upserted='+snapshotsUpserted+
    ' dbRows='+(snapRows||[]).length+' recentRows='+(recentSnaps||[]).length+
    ' freshRows='+freshSnapRows.length+' uniqueTicketKeys='+uniqueKeys.length+
    ' matchedKeys='+matchedKeys.length+' unmatchedSample='+JSON.stringify(unmatchedSample));
  let skipLogs = 0;
  for (const ticket of tickets) {
    try {
      if (ticket.graded_at) { bumpSkip('already_graded'); continue; }
      const ticketLegs = (allLegs||[]).filter(function(l){ return l.ticket_id===ticket.id; });
      const outcome = _deriveTicketOutcome(ticket, ticketLegs, resultsByKey);
      if (outcome.outcome==='error'||outcome.outcome==='pending') {
        const reason = (outcome.reason||outcome.outcome||'pending').slice(0,80);
        bumpSkip(reason);
        if (skipLogs < 20) {
          skipLogs++;
          const leg0 = ticketLegs[0] || {};
          const hit = _lookupResultForLeg(resultsByKey, leg0);
          console.log('GRADE_TICKET_SKIP ticketId='+ticket.id+
            ' ticketKey='+(leg0.canonical_game_key||'')+
            ' home='+(leg0.home_team||'')+' away='+(leg0.away_team||'')+
            ' pick='+(leg0.pick||'')+' market='+(leg0.market||'')+
            ' match='+(hit?'true':'false')+
            ' espnHitKey='+((hit && hit.canonical_game_key)||'')+
            ' hitStatus='+(hit?(hit.status||'unknown'):'miss')+
            ' reason='+reason);
        }
        continue;
      }
      // GRD-2: recompute profit when pushed legs drop out of a parlay
      let profit = parseFloat(ticket.potential_profit)||0;
      let overrideProfit = null;
      if (outcome.pushReduced && outcome.wonLegObjects) {
        const risk = parseFloat(ticket.risk_amount)||0;
        const allOddsValid = outcome.wonLegObjects.every(function(l){ return l.odds && l.odds !== 0; });
        if (!allOddsValid) {
          console.warn('GRADE_CORE_SKIP ticketId='+ticket.id+' reason=push_reduced_null_odds');
          bumpSkip('push_reduced_null_odds');
          continue;
        }
        const decProd = outcome.wonLegObjects.reduce(function(acc,l){ return acc*_sgAmToDecimal(l.odds); }, 1.0);
        overrideProfit = Math.round((risk*(decProd-1))*100)/100;
        profit = overrideProfit;
      }
      if (!GRADING_SETTLEMENT_ENABLED || !WORKER_GRADE_SETTLEMENT_ENABLED) {
        console.warn('GRADE_CORE_SKIP ticketId='+ticket.id+
          ' outcome='+outcome.outcome+' reason=settlement_blocked '+GRADING_DISABLED_REASON);
        bumpSkip('settlement_blocked');
        continue;
      }
      const gr = await _callMoneyRpc('grade_ticket_tx',{
        p_ticket_id:ticket.id, p_club_id:ticket.club_id||'', p_player_id:ticket.player_id,
        p_grade_result:outcome.outcome, p_profit:profit,
        p_idempotency_key:'GR_'+outcome.outcome+'_'+ticket.id, p_created_by:'worker',
        p_override_profit:overrideProfit  // null on normal path; non-null for push-reduced parlays
      });
      if (gr.ok||gr.idempotent) {
        graded++;
        _lastGradedAt = new Date().toISOString();
        console.log('GRADE_CORE_GRADED ticketId='+ticket.id+' result='+outcome.outcome+
          ' clubId='+(ticket.club_id||'null')+' lastGradedAt='+_lastGradedAt);
        try {
          await sb.from('audit_events').insert({
            event_type:'ticket_graded_server',
            ticket_id:ticket.id, club_id:ticket.club_id||null, actor_id:'worker',
            payload:{ result:outcome.outcome, source:'worker', playerId:ticket.player_id,
                      pushReduced:overrideProfit!=null, overrideProfit }
          });
        } catch(_ae) {}
      } else {
        bumpSkip('rpc_'+(gr.error||'rejected'));
      }
    } catch(_e) {
      logEvent('error','grade_core_ticket_error',{ ticketId:ticket.id, err:_e.message });
      bumpSkip('exception');
    }
  }
  console.log('GRADE_CORE_DONE tickets='+tickets.length+' graded='+graded+
    ' skipped='+skipped+' skipReasons='+JSON.stringify(skipReasons)+
    ' lastResult='+_lastResultSuccessAt+' lastGradedAt='+_lastGradedAt);
  return { graded, skipped, skipReasons:skipReasons, snapshotsUpserted:snapshotsUpserted, lastGradedAt:_lastGradedAt };
}

// ── WORKER LOOP ───────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const WORKER_ID = 'worker_'+crypto.randomBytes(4).toString('hex');
const WORKER_POLL_MS = parseInt(process.env.WORKER_POLL_MS)||20000; // 20s default
const MLB_GRADE_POLL_MS = parseInt(process.env.MLB_GRADE_POLL_MS, 10) || 60000;
let _lastResultSuccessAt = null;
let _lastGradePollAt = null;
let _lastGradeRunAt = null;
let _lastGradedAt = null;
let _mlbGradePollerStarted = false;
let _gradePollInFlight = false;

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
  enqueueJob('grade_run',{},{idempotencyKey:'BOOT_grade_run'});
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

function _pocketbooksEthAddress() {
  return process.env.POCKETBOOKS_ETH_ADDRESS || process.env.WALLET_ERC20 || '0x61F74cD55bA283269eb86a2AA7a882B2e1a9225F';
}
function _pocketbooksBtcAddress() {
  return process.env.POCKETBOOKS_BTC_ADDRESS || process.env.WALLET_BTC || 'bc1qu6um0h9qdy8nn6w3m2t4x3ava8lp6tm96erwc4';
}
function _usdtContract() {
  return (process.env.POCKETBOOKS_USDT_CONTRACT || '0xdAC17F958D2ee523a2206206994597C13D831ec7').toLowerCase();
}
function _usdcContract() {
  return (process.env.POCKETBOOKS_USDC_CONTRACT || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48').toLowerCase();
}
function _btcConfirmationsRequired() {
  const n = parseInt(process.env.BTC_CONFIRMATIONS_REQUIRED, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}
function _ethConfirmationsRequired() {
  const n = parseInt(process.env.ETH_CONFIRMATIONS_REQUIRED, 10);
  return Number.isFinite(n) && n >= 0 ? n : 12;
}

const CRYPTO_WALLETS = {
  USDT: { ERC20: _pocketbooksEthAddress() },
  USDC: { ERC20: _pocketbooksEthAddress() },
  ETH:  { ERC20: _pocketbooksEthAddress() },
  BTC:  { Bitcoin_SegWit: _pocketbooksBtcAddress() }
};
const INTENT_TTL_MS     = 60 * 60 * 1000;
const FLAG_MISSING_MS   = 30 * 60 * 1000;
const FLAG_UNCONF_MS    = 30 * 60 * 1000;

function _normalizeCryptoSymbol(raw) {
  return String(raw||'').trim().toUpperCase();
}
function _normalizeCryptoNetwork(symbol, network) {
  const s = _normalizeCryptoSymbol(symbol);
  const n = String(network||'').replace(/[-\s]/g,'').toUpperCase();
  if (s === 'BTC') return 'Bitcoin_SegWit';
  if (n === 'ERC20' || n === 'ETHEREUM' || n === 'ETHEREUMERC20' || n === 'ETH') return 'ERC20';
  if (n === 'BITCOIN' || n === 'BITCOINSEGWIT' || n === 'BITCOINMAINNET' || n === 'BTC') return 'Bitcoin_SegWit';
  return network || (s === 'BTC' ? 'Bitcoin_SegWit' : 'ERC20');
}
function _resolveWallet(symbol, network) {
  const s = _normalizeCryptoSymbol(symbol);
  if (s === 'BTC') return _pocketbooksBtcAddress();
  if (s === 'ETH' || s === 'USDT' || s === 'USDC') return _pocketbooksEthAddress();
  const w = CRYPTO_WALLETS[s];
  return w ? w[network]||w[Object.keys(w)[0]]||null : null;
}

// Request ID (must be defined before app.use — crypto routes follow immediately)
const _SAFE_REQ_ID_RE = /^[a-zA-Z0-9_\-]{6,64}$/;
function requestIdMiddleware(req, res, next) {
  const incoming = (req.headers['x-request-id']||'').trim();
  req.requestId = _SAFE_REQ_ID_RE.test(incoming)
    ? incoming
    : 'req_'+Date.now().toString(36)+'_'+crypto.randomBytes(4).toString('hex');
  res.setHeader('x-request-id', req.requestId);
  next();
}

const app = express();

// Core middleware MUST run before any route. Express matches in registration
// order — a later app.use(express.json()) never runs for routes above it.
app.use(requestIdMiddleware);
app.use(_hardenedCors);
app.use(express.json({ limit:'100kb' }));
app.use(securityHeadersMiddleware);
app.use(payloadSizeMiddleware);
app.use(rateLimitMiddleware);

// POST /api/crypto/deposits/create-intent
app.post('/api/crypto/deposits/create-intent', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const nested = (body.deposit && typeof body.deposit === 'object') ? body.deposit
               : (body.intent && typeof body.intent === 'object') ? body.intent
               : (body.payload && typeof body.payload === 'object') ? body.payload
               : {};
  const q = req.query || {};
  const clubId = body.clubId || body.club_id || nested.clubId || q.clubId;
  const playerId = body.playerId || body.player_id || nested.playerId || q.playerId;
  const packageAmountDiamonds = body.packageAmountDiamonds || body.package_amount_diamonds
    || body.diamonds || nested.packageAmountDiamonds;
  const expectedUsd = body.expectedUsd || body.expected_usd || nested.expectedUsd;
  const cryptoSymbol = _normalizeCryptoSymbol(
    body.cryptoSymbol || body.crypto_symbol || body.symbol || body.method
    || nested.cryptoSymbol || nested.crypto_symbol || nested.symbol || nested.method
    || q.cryptoSymbol || q.crypto_symbol
  );
  const network = _normalizeCryptoNetwork(
    cryptoSymbol,
    body.network || nested.network || q.network
  );
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
const SCANNER_ENABLED   = process.env.BLOCKCHAIN_SCANNER_ENABLED !== 'false';
const AUTO_CREDIT_CRYPTO= process.env.AUTO_CREDIT_CONFIRMED_CRYPTO === 'true';
const AMOUNT_TOLERANCE  = 0.02; // 2% underpay tolerance
const MIN_CONFIRMATIONS = 3;
const CRYPTO_SCAN_INTERVAL_MS = 2 * 60 * 1000;
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
let _cryptoScanTimer = null;
let _cryptoScanTickRunning = false;

function _addrEq(a, b) {
  return String(a||'').toLowerCase() === String(b||'').toLowerCase();
}

function _topicToAddress(topic) {
  if (!topic || String(topic).length < 40) return '';
  return ('0x' + String(topic).slice(-40)).toLowerCase();
}

function _hexToDecimalAmount(hex, decimals) {
  try {
    const bi = BigInt(hex);
    const base = 10n ** BigInt(decimals);
    const whole = bi / base;
    const frac = bi % base;
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return parseFloat(whole.toString() + (fracStr ? '.' + fracStr : ''));
  } catch (_e) { return 0; }
}

function _isBtcNetwork(network, symbol) {
  const n = String(network||'').toLowerCase();
  const s = String(symbol||'').toUpperCase();
  return s === 'BTC' || n.indexOf('bitcoin') >= 0 || n === 'btc';
}

function _httpsGet(url, timeoutMs) {
  const httpsMod = require('https');
  return new Promise(function(resolve) {
    const req = httpsMod.get(url, {
      headers: { 'User-Agent': 'pocketbooks-sports-backend/1.0', 'Accept': 'application/json' }
    }, function(res) {
      let d = '';
      res.on('data', function(c){ d += c; });
      res.on('end', function() {
        const statusCode = res.statusCode || 0;
        if (statusCode >= 400) {
          return resolve({ ok:false, error:'http_'+statusCode, statusCode:statusCode, text:d.slice(0,200) });
        }
        let parsed = null;
        try { parsed = JSON.parse(d); } catch (_e) { parsed = null; }
        resolve({ ok:true, statusCode:statusCode, data:parsed, text:d });
      });
    });
    req.on('error', function(e){ resolve({ ok:false, error:e.message }); });
    req.setTimeout(timeoutMs || 12000, function(){ req.destroy(); resolve({ ok:false, error:'timeout' }); });
  });
}

function _scanSummary(scanResult) {
  return {
    valid: !!scanResult.valid,
    status: scanResult.status,
    confirmations: scanResult.confirmations || 0,
    to_address: scanResult.toAddress || scanResult.to_address || null,
    amount_btc: scanResult.amount_btc != null ? scanResult.amount_btc : null,
    amount_usd: scanResult.amount_usd != null ? scanResult.amount_usd : (scanResult.amountUsdEstimate != null ? scanResult.amountUsdEstimate : null),
    token: scanResult.token || null,
    error: scanResult.errorMessage || null
  };
}

function _baseScanResult(txHash, network, extra) {
  return Object.assign({
    txHash: txHash,
    network: network,
    valid: false,
    status: 'scan_error',
    confirmations: 0,
    amountCrypto: null,
    amountUsdEstimate: null,
    amount_btc: null,
    amount_usd: null,
    token: null,
    fromAddress: null,
    toAddress: null,
    to_address: null,
    errorMessage: null
  }, extra || {});
}

async function _btcUsdEstimate(amountBtc) {
  if (!(amountBtc > 0)) return null;
  const tick = await _httpsGet('https://blockchain.info/ticker');
  const last = tick.ok && tick.data && tick.data.USD && (tick.data.USD.last || tick.data.USD['15m']);
  const px = parseFloat(last);
  if (!Number.isFinite(px) || px <= 0) return null;
  return Math.round(amountBtc * px * 100) / 100;
}

async function _ethUsdEstimate(amountEth) {
  if (!(amountEth > 0)) return null;
  const spot = await _httpsGet('https://api.coinbase.com/v2/prices/ETH-USD/spot');
  const amt = spot.ok && spot.data && spot.data.data && spot.data.data.amount;
  const px = parseFloat(amt);
  if (!Number.isFinite(px) || px <= 0) return null;
  return Math.round(amountEth * px * 100) / 100;
}

async function _scanBtcTx(txHash) {
  const dest = _pocketbooksBtcAddress();
  const need = _btcConfirmationsRequired();
  const txRes = await _httpsGet('https://blockchain.info/rawtx/' + encodeURIComponent(txHash) + '?format=json');
  if (!txRes.ok) {
    const notFound = txRes.statusCode === 404 || /not found/i.test(txRes.text || txRes.error || '');
    console.log('[CRYPTO_SCAN_BTC] hash=' + String(txHash).slice(0,18) + ' ok=false err=' + (notFound ? 'not_found' : (txRes.error||'http')));
    return _baseScanResult(txHash, 'BTC', {
      status: notFound ? 'not_found' : 'scan_error',
      toAddress: dest, to_address: dest, token: 'BTC',
      errorMessage: notFound ? null : (txRes.error || 'btc_fetch_failed')
    });
  }
  const tx = txRes.data;
  if (!tx || tx.error || !tx.hash) {
    console.log('[CRYPTO_SCAN_BTC] hash=' + String(txHash).slice(0,18) + ' not_found');
    return _baseScanResult(txHash, 'BTC', {
      status: 'not_found', toAddress: dest, to_address: dest, token: 'BTC',
      errorMessage: (tx && tx.error) || 'not_found'
    });
  }
  const destLc = dest.toLowerCase();
  let paidSats = 0;
  let matchedAddr = null;
  (tx.out || []).forEach(function(o) {
    const addr = String(o.addr || '');
    if (addr && addr.toLowerCase() === destLc) {
      paidSats += Number(o.value || 0);
      matchedAddr = addr;
    }
  });
  let confirmations = 0;
  if (tx.block_height && tx.block_height > 0) {
    const heightRes = await _httpsGet('https://blockchain.info/q/getblockcount');
    const chainHeight = parseInt((heightRes.text || '').trim(), 10);
    if (Number.isFinite(chainHeight) && chainHeight >= tx.block_height) {
      confirmations = chainHeight - tx.block_height + 1;
    } else {
      confirmations = 1;
    }
  }
  const amountBtc = paidSats / 1e8;
  const paidOk = paidSats > 0;
  const amountUsd = await _btcUsdEstimate(amountBtc);
  let status = 'mismatch';
  if (paidOk && confirmations >= need) status = 'found_confirmed';
  else if (paidOk) status = 'found_pending';
  const fromAddr = tx.inputs && tx.inputs[0] && tx.inputs[0].prev_out && tx.inputs[0].prev_out.addr || null;
  console.log('[CRYPTO_SCAN_BTC] hash=' + String(txHash).slice(0,18) +
    ' valid=' + (paidOk && confirmations >= need) +
    ' conf=' + confirmations + '/' + need +
    ' paidSats=' + paidSats +
    ' status=' + status);
  return _baseScanResult(txHash, 'BTC', {
    valid: paidOk && confirmations >= need,
    status: status,
    confirmations: confirmations,
    amountCrypto: amountBtc,
    amount_btc: amountBtc,
    amountUsdEstimate: amountUsd,
    amount_usd: amountUsd,
    token: 'BTC',
    fromAddress: fromAddr,
    toAddress: matchedAddr || dest,
    to_address: matchedAddr || dest,
    errorMessage: paidOk ? null : 'wallet_mismatch'
  });
}

async function _etherscanProxy(action, extraQuery) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  const url = 'https://api.etherscan.io/api?module=proxy&action=' + encodeURIComponent(action) +
    (extraQuery || '') + '&apikey=' + encodeURIComponent(apiKey);
  const res = await _httpsGet(url);
  if (!res.ok) return { ok:false, error:res.error };
  const body = res.data;
  if (!body) return { ok:false, error:'empty_etherscan_body' };
  if (body.status === '0' && body.message && String(body.message).toUpperCase() === 'NOTOK') {
    return { ok:false, error:String(body.result || body.message || 'etherscan_notok') };
  }
  return { ok:true, result: body.result };
}

async function _scanEthFamilyTx(txHash, symbol) {
  const dest = _pocketbooksEthAddress();
  const need = _ethConfirmationsRequired();
  const token = String(symbol || 'ETH').toUpperCase();
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    console.warn('[CRYPTO_SCAN_NO_ETHERSCAN_KEY] token=' + token + ' hash=' + String(txHash).slice(0,18));
    return _baseScanResult(txHash, 'ETH', {
      status: 'scan_error', toAddress: dest, to_address: dest, token: token,
      errorMessage: 'etherscan_api_key_missing'
    });
  }
  const receiptWrap = await _etherscanProxy('eth_getTransactionReceipt', '&txhash=' + encodeURIComponent(txHash));
  const txWrap = await _etherscanProxy('eth_getTransactionByHash', '&txhash=' + encodeURIComponent(txHash));
  const headWrap = await _etherscanProxy('eth_blockNumber', '');
  if (!txWrap.ok) {
    console.log('[CRYPTO_SCAN_ETH] hash=' + String(txHash).slice(0,18) + ' token=' + token + ' err=' + txWrap.error);
    return _baseScanResult(txHash, 'ETH', {
      status: 'scan_error', toAddress: dest, to_address: dest, token: token,
      errorMessage: txWrap.error || 'etherscan_tx_failed'
    });
  }
  if (!txWrap.result) {
    console.log('[CRYPTO_SCAN_ETH] hash=' + String(txHash).slice(0,18) + ' token=' + token + ' not_found');
    return _baseScanResult(txHash, 'ETH', {
      status: 'not_found', toAddress: dest, to_address: dest, token: token
    });
  }
  const tx = txWrap.result;
  const receipt = receiptWrap.ok ? receiptWrap.result : null;
  let confirmations = 0;
  const txBlockHex = (receipt && receipt.blockNumber) || tx.blockNumber;
  const headHex = headWrap.ok ? headWrap.result : null;
  if (txBlockHex && headHex) {
    const txBlock = parseInt(txBlockHex, 16);
    const head = parseInt(headHex, 16);
    if (Number.isFinite(txBlock) && Number.isFinite(head) && head >= txBlock) {
      confirmations = head - txBlock + 1;
    }
  }
  const fromAddress = tx.from || (receipt && receipt.from) || null;
  if (receipt && receipt.status && receipt.status !== '0x1') {
    console.log('[CRYPTO_SCAN_ETH] hash=' + String(txHash).slice(0,18) + ' token=' + token + ' failed_receipt');
    return _baseScanResult(txHash, 'ETH', {
      status: 'mismatch', confirmations: confirmations, fromAddress: fromAddress,
      toAddress: dest, to_address: dest, token: token, errorMessage: 'tx_failed'
    });
  }

  if (token === 'ETH') {
    const toAddr = (receipt && receipt.to) || tx.to || null;
    const paidOk = _addrEq(toAddr, dest);
    const amountEth = _hexToDecimalAmount(tx.value || '0x0', 18);
    const amountUsd = await _ethUsdEstimate(amountEth);
    let status = 'mismatch';
    if (paidOk && confirmations >= need) status = 'found_confirmed';
    else if (paidOk) status = 'found_pending';
    console.log('[CRYPTO_SCAN_ETH] hash=' + String(txHash).slice(0,18) +
      ' token=ETH valid=' + (paidOk && confirmations >= need) +
      ' conf=' + confirmations + '/' + need + ' status=' + status);
    return _baseScanResult(txHash, 'ETH', {
      valid: paidOk && confirmations >= need,
      status: status,
      confirmations: confirmations,
      amountCrypto: amountEth,
      amountUsdEstimate: amountUsd,
      amount_usd: amountUsd,
      token: 'ETH',
      fromAddress: fromAddress,
      toAddress: toAddr || dest,
      to_address: toAddr || dest,
      errorMessage: paidOk ? null : 'wallet_mismatch'
    });
  }

  const wantContract = token === 'USDC' ? _usdcContract() : _usdtContract();
  const logs = (receipt && receipt.logs) || [];
  let paidRaw = 0n;
  let matchedTo = null;
  logs.forEach(function(log) {
    if (!_addrEq(log.address, wantContract)) return;
    const topics = log.topics || [];
    if (!_addrEq(topics[0], ERC20_TRANSFER_TOPIC)) return;
    const toAddr = _topicToAddress(topics[2]);
    if (!_addrEq(toAddr, dest)) return;
    try { paidRaw += BigInt(log.data || '0x0'); } catch (_e) {}
    matchedTo = toAddr;
  });
  const amountToken = _hexToDecimalAmount('0x' + paidRaw.toString(16), 6);
  const paidOk = paidRaw > 0n;
  let status = 'mismatch';
  if (paidOk && confirmations >= need) status = 'found_confirmed';
  else if (paidOk) status = 'found_pending';
  console.log('[CRYPTO_SCAN_ETH] hash=' + String(txHash).slice(0,18) +
    ' token=' + token + ' valid=' + (paidOk && confirmations >= need) +
    ' conf=' + confirmations + '/' + need + ' status=' + status);
  return _baseScanResult(txHash, 'ETH', {
    valid: paidOk && confirmations >= need,
    status: status,
    confirmations: confirmations,
    amountCrypto: amountToken,
    amountUsdEstimate: amountToken,
    amount_usd: amountToken,
    token: token,
    fromAddress: fromAddress,
    toAddress: matchedTo || dest,
    to_address: matchedTo || dest,
    errorMessage: paidOk ? null : 'token_transfer_not_found'
  });
}

async function _verifyCryptoTx(txHash, network, mockResult, cryptoSymbol) {
  if (!SCANNER_ENABLED) {
    return _baseScanResult(txHash, network, { errorMessage:'scanner_not_configured' });
  }
  if (mockResult) {
    return Object.assign(_baseScanResult(txHash, network, { errorMessage:null }), mockResult);
  }
  const symbol = String(cryptoSymbol || '').toUpperCase();
  try {
    if (_isBtcNetwork(network, symbol)) return await _scanBtcTx(txHash);
    const token = symbol || 'ETH';
    return await _scanEthFamilyTx(txHash, token);
  } catch (e) {
    console.warn('[CRYPTO_SCAN_ERROR] hash=' + String(txHash).slice(0,18) + ' err=' + e.message);
    return _baseScanResult(txHash, network, { errorMessage: e.message || 'scan_exception' });
  }
}

function _onChainMeetsExpected(intent, scanResult) {
  const expected = parseFloat(intent.expected_usd || 0);
  if (!(expected > 0)) return true;
  const actualUsd = parseFloat(scanResult.amountUsdEstimate || scanResult.amount_usd || 0);
  if (actualUsd > 0) return actualUsd >= expected * (1 - AMOUNT_TOLERANCE);
  return false;
}

function _matchScanToIntent(scanResult, intent) {
  if (!intent) return { matched:false, reason:'no_intent' };
  if (scanResult.status==='scan_error') return { matched:false, reason:'scan_error' };
  if (scanResult.status==='not_found')  return { matched:false, reason:'not_found' };
  const expectedWallet = intent.assigned_wallet_address ||
    (_isBtcNetwork(intent.network, intent.crypto_symbol) ? _pocketbooksBtcAddress() : _pocketbooksEthAddress());
  const actualWallet   = (scanResult.toAddress || scanResult.to_address || '').toLowerCase();
  if (actualWallet && expectedWallet && actualWallet !== expectedWallet.toLowerCase())
    return { matched:false, reason:'wallet_mismatch', expected:expectedWallet, actual:scanResult.toAddress };
  const expectedUsd = parseFloat(intent.expected_usd||0);
  const actualUsd   = parseFloat(scanResult.amountUsdEstimate||scanResult.amount_usd||0);
  if (expectedUsd>0 && actualUsd>0) {
    const minAcceptable = expectedUsd*(1-AMOUNT_TOLERANCE);
    if (actualUsd<minAcceptable)
      return { matched:false, reason:'amount_short', expectedUsd, actualUsd, minAcceptable };
  }
  if (scanResult.status==='mismatch') return { matched:false, reason:scanResult.errorMessage||'mismatch' };
  return { matched:true,
           matchedIntentId:intent.intent_id, matchedPlayerId:intent.player_id,
           matchedClubId:intent.club_id, scanStatus:scanResult.status,
           confirmations:scanResult.confirmations };
}

function _scanRowFromResult(scanResult, intent, matchResult, hash, network) {
  const now = new Date().toISOString();
  return {
    scan_id: 'SCAN_'+String(hash).slice(0,16)+'_'+Date.now(),
    tx_hash: hash,
    network: network,
    crypto_symbol: intent && intent.crypto_symbol || scanResult.token || null,
    status: scanResult.status,
    confirmations: scanResult.confirmations||0,
    amount_crypto: scanResult.amountCrypto||null,
    amount_usd_estimate: scanResult.amountUsdEstimate||null,
    from_address: scanResult.fromAddress||null,
    to_address: scanResult.toAddress||scanResult.to_address||null,
    matched_intent_id: matchResult && matchResult.matched ? matchResult.matchedIntentId : null,
    matched_player_id: matchResult && matchResult.matched ? matchResult.matchedPlayerId : null,
    matched_club_id:   matchResult && matchResult.matched ? matchResult.matchedClubId : null,
    scanned_at: now,
    raw_json: _scanSummary(scanResult),
    error_message: scanResult.errorMessage||null
  };
}

async function _creditHostDiamondPurchase(sb, intent, scanResult) {
  const diamonds = parseFloat(intent.package_amount_diamonds);
  if (!(diamonds > 0)) return { ok:false, error:'invalid_package' };
  const txHash = intent.tx_hash;
  const iKey = 'CRYPTO_HD_' + (txHash || intent.intent_id);

  const { data: alreadyHash } = await sb.from('crypto_deposit_intents')
    .select('intent_id,status')
    .eq('tx_hash', txHash)
    .in('status', ['credited','confirmed'])
    .neq('intent_id', intent.intent_id)
    .limit(1);
  if (alreadyHash && alreadyHash[0]) {
    console.warn('[CRYPTO_SCAN_DUP] intent=' + intent.intent_id + ' other=' + alreadyHash[0].intent_id);
    return { ok:false, error:'duplicate_tx', otherIntentId: alreadyHash[0].intent_id };
  }

  const { data: existingLedger } = await sb.from('host_diamond_ledger')
    .select('ledger_id').eq('idempotency_key', iKey).limit(1);
  if (existingLedger && existingLedger[0]) {
    return { ok:true, idempotent:true, ledgerId: existingLedger[0].ledger_id };
  }

  const { data: creditedSame } = await sb.from('crypto_deposit_intents')
    .select('intent_id').eq('intent_id', intent.intent_id).eq('status','credited').limit(1);
  if (creditedSame && creditedSame[0]) return { ok:true, idempotent:true };

  if (!_onChainMeetsExpected(intent, scanResult)) {
    console.warn('[CRYPTO_SCAN_AMOUNT_SHORT] intent=' + intent.intent_id);
    return { ok:false, error:'amount_short' };
  }

  const { data: balRow } = await sb.from('host_diamond_balances')
    .select('*').eq('club_id', intent.club_id).limit(1);
  const host = balRow && balRow[0];
  if (!host) {
    console.warn('[CRYPTO_SCAN_NO_BALANCE] club=' + intent.club_id + ' intent=' + intent.intent_id);
    return { ok:false, error:'host_diamond_balance_missing' };
  }

  const balBefore = parseFloat(host.balance_diamonds);
  const balAfter = balBefore + diamonds;
  const now = new Date().toISOString();
  const { error: balErr } = await sb.from('host_diamond_balances')
    .update({ balance_diamonds: balAfter, updated_at: now }).eq('club_id', intent.club_id);
  if (balErr) {
    console.warn('[CRYPTO_SCAN_CREDIT_FAIL] intent=' + intent.intent_id + ' err=' + balErr.message);
    return { ok:false, error: balErr.message };
  }
  const ledger = await _writeHostDiamondLedger(sb, {
    ledgerId: iKey, clubId: intent.club_id, hostActorId: host.host_actor_id,
    eventType: 'HOST_DIAMOND_PURCHASE', amount: diamonds, direction: 'credit',
    balanceBefore: balBefore, balanceAfter: balAfter,
    createdBy: 'crypto_scanner', reason: 'crypto_purchase:' + intent.intent_id,
    idempotencyKey: iKey,
    metadata: { source: 'crypto_purchase', txHash: txHash, cryptoSymbol: intent.crypto_symbol }
  });
  if (!ledger || !ledger.ok) {
    await sb.from('host_diamond_balances')
      .update({ balance_diamonds: balBefore, updated_at: now }).eq('club_id', intent.club_id);
    console.warn('[CRYPTO_SCAN_CREDIT_ROLLBACK] intent=' + intent.intent_id +
      ' err=' + ((ledger && ledger.error) || 'ledger_write_failed'));
    return { ok:false, error: (ledger && ledger.error) || 'ledger_write_failed', rolled_back:true };
  }
  console.log('[CRYPTO_SCAN_CREDIT] intent=' + intent.intent_id + ' +' + diamonds + 'd club=' + intent.club_id);
  return { ok:true, diamonds: diamonds, balanceAfter: balAfter, ledgerId: iKey, already_credited: !!ledger.idempotent };
}

async function _persistCryptoScan(sb, intent, scanResult) {
  const hash = intent.tx_hash;
  const network = intent.network;
  const matchResult = _matchScanToIntent(scanResult, intent);
  const scanRow = _scanRowFromResult(scanResult, intent, matchResult, hash, network);
  const { error } = await sb.from('crypto_tx_scans').insert(scanRow);
  if (error) console.warn('[CRYPTO_SCAN_WRITE_FAIL] intent=' + intent.intent_id + ' err=' + error.message);
  return { scanRow: scanRow, matchResult: matchResult };
}

async function _processScannedIntent(sb, intent, scanResult) {
  const now = new Date().toISOString();
  const { matchResult } = await _persistCryptoScan(sb, intent, scanResult);

  if (intent.status === 'credited') {
    console.log('[CRYPTO_SCAN_SKIP] intent=' + intent.intent_id + ' already_credited');
    return { action: 'already_credited' };
  }

  if (matchResult.reason === 'scan_error' || scanResult.status === 'scan_error') {
    return { action: 'scan_error', error: scanResult.errorMessage };
  }
  if (scanResult.status === 'not_found') return { action: 'not_found' };

  const dup = await sb.from('crypto_deposit_intents')
    .select('intent_id,status').eq('tx_hash', intent.tx_hash)
    .neq('intent_id', intent.intent_id)
    .in('status', ['credited','confirmed','hash_submitted','pending_review'])
    .limit(1);
  if (dup.data && dup.data[0] && dup.data[0].status === 'credited') {
    await sb.from('crypto_deposit_intents').update({
      status: 'rejected', reject_reason: 'duplicate_tx', updated_at: now
    }).eq('intent_id', intent.intent_id).neq('status', 'credited');
    console.warn('[CRYPTO_SCAN_DUP] rejected intent=' + intent.intent_id);
    return { action: 'duplicate_tx' };
  }

  if (scanResult.status === 'found_pending' || (matchResult.matched && !scanResult.valid)) {
    if (intent.status !== 'pending_review' && intent.status !== 'confirmed') {
      await sb.from('crypto_deposit_intents').update({ status:'pending_review', updated_at:now })
        .eq('intent_id', intent.intent_id);
    }
    console.log('[CRYPTO_SCAN_WAIT] intent=' + intent.intent_id + ' conf=' + (scanResult.confirmations||0));
    return { action: 'waiting_confirmations', confirmations: scanResult.confirmations||0 };
  }

  if (scanResult.status === 'mismatch' || !matchResult.matched) {
    if (intent.status !== 'pending_review') {
      await sb.from('crypto_deposit_intents').update({ status:'pending_review', updated_at:now })
        .eq('intent_id', intent.intent_id);
    }
    return { action: 'mismatch', reason: matchResult.reason };
  }

  if (scanResult.valid && scanResult.status === 'found_confirmed') {
    await sb.from('crypto_deposit_intents').update({ status:'confirmed', updated_at:now })
      .eq('intent_id', intent.intent_id).neq('status', 'credited');
    const credit = await _creditHostDiamondPurchase(sb, Object.assign({}, intent, { status:'confirmed' }), scanResult);
    if (credit.ok) {
      await sb.from('crypto_deposit_intents').update({
        status:'credited', credited_at: now, credited_by: 'crypto_scanner',
        idempotency_key: credit.ledgerId || ('CRYPTO_HD_' + intent.tx_hash),
        updated_at: now
      }).eq('intent_id', intent.intent_id);
      emitEvent('balance_changed', { clubId: intent.club_id, event: 'host_diamond_purchase', diamonds: intent.package_amount_diamonds },
        { clubId: intent.club_id, playerId: intent.player_id });
      return { action: 'credited', diamonds: intent.package_amount_diamonds };
    }
    if (credit.error === 'duplicate_tx') {
      await sb.from('crypto_deposit_intents').update({
        status:'rejected', reject_reason:'duplicate_tx', updated_at:now
      }).eq('intent_id', intent.intent_id).neq('status','credited');
      return { action: 'duplicate_tx' };
    }
    return { action: 'confirmed_not_credited', error: credit.error };
  }
  return { action: 'noop' };
}

async function _cryptoScanTick() {
  if (_cryptoScanTickRunning) return;
  const sb = getSupabase();
  if (!sb || !SCANNER_ENABLED) return;
  _cryptoScanTickRunning = true;
  try {
    const { data: intents, error } = await sb.from('crypto_deposit_intents')
      .select('*')
      .in('status', ['hash_submitted','pending_review','confirmed'])
      .not('tx_hash', 'is', null)
      .order('updated_at', { ascending: true })
      .limit(25);
    if (error) {
      console.warn('[CRYPTO_SCAN_ERROR] list=' + error.message);
      return;
    }
    const list = intents || [];
    console.log('[CRYPTO_SCAN_TICK] n=' + list.length);
    for (let i = 0; i < list.length; i++) {
      const intent = list[i];
      if (!intent.tx_hash) continue;
      try {
        const scanResult = await _verifyCryptoTx(intent.tx_hash, intent.network, null, intent.crypto_symbol);
        await _processScannedIntent(sb, intent, scanResult);
      } catch (e) {
        console.warn('[CRYPTO_SCAN_ERROR] intent=' + intent.intent_id + ' err=' + e.message);
      }
    }
  } finally {
    _cryptoScanTickRunning = false;
  }
}

function _startCryptoScanner() {
  if (process.env.CRYPTO_SCANNER_DISABLED === 'true') {
    console.log('[CRYPTO_SCAN_LOOP] disabled');
    return;
  }
  const tick = async function() {
    try { await _cryptoScanTick(); }
    catch (e) { console.warn('[CRYPTO_SCAN_ERROR] tick=' + e.message); }
    _cryptoScanTimer = setTimeout(tick, CRYPTO_SCAN_INTERVAL_MS);
  };
  _cryptoScanTimer = setTimeout(tick, 15000);
  console.log('[CRYPTO_SCAN_LOOP] started intervalMs=' + CRYPTO_SCAN_INTERVAL_MS);
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

    // Run scanner (same engine as the 2-minute auto-scanner)
    const scanResult = await _verifyCryptoTx(hash, network, mockResult||null, intent.crypto_symbol);
    const matchResult= _matchScanToIntent(scanResult, intent);

    const now    = new Date().toISOString();
    const scanRow = _scanRowFromResult(scanResult, intent, matchResult, hash, network);
    const scanId = scanRow.scan_id;
    await sb.from('crypto_tx_scans').insert(scanRow);

    // Update intent status based on scan
    let newIntentStatus = intent.status;
    if (matchResult.matched && scanResult.status==='found_pending') newIntentStatus='pending_review';
    if (matchResult.matched && scanResult.status==='found_confirmed') newIntentStatus='confirmed';
    if (!matchResult.matched && scanResult.status==='not_found') newIntentStatus=intent.status;
    await sb.from('crypto_deposit_intents')
      .update({ status:newIntentStatus, updated_at:now })
      .eq('intent_id',intent.intent_id);

    if (!mockResult && scanResult.valid && scanResult.status==='found_confirmed') {
      const credit = await _creditHostDiamondPurchase(sb, Object.assign({}, intent, { status:'confirmed' }), scanResult);
      if (credit.ok) {
        await sb.from('crypto_deposit_intents').update({
          status:'credited', credited_at:now, credited_by:'crypto_scanner',
          idempotency_key: credit.ledgerId || ('CRYPTO_HD_'+hash), updated_at:now
        }).eq('intent_id',intent.intent_id);
        newIntentStatus='credited';
        emitEvent('balance_changed', { clubId:intent.club_id, event:'host_diamond_purchase', diamonds:intent.package_amount_diamonds },
          { clubId:intent.club_id, playerId:intent.player_id }, req.requestId);
      } else if (credit.error==='duplicate_tx') {
        await sb.from('crypto_deposit_intents').update({
          status:'rejected', reject_reason:'duplicate_tx', updated_at:now
        }).eq('intent_id',intent.intent_id).neq('status','credited');
        newIntentStatus='rejected';
      }
    }

    // Auto-credit if enabled and confirmed
    let autoCredited = false;
    if (AUTO_CREDIT_CRYPTO && newIntentStatus!=='credited' && matchResult.matched &&
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

// ── Admin crypto / diamond-purchase verification ────────────────────────────
const CRYPTO_ADMIN_APPROVE_MAX = 10;
const CRYPTO_ADMIN_APPROVE_WINDOW_MS = 60 * 60 * 1000;
const _cryptoAdminApproveByActor = new Map();

function _checkCryptoAdminApproveRate(adminId) {
  const now = Date.now();
  const key = String(adminId || 'unknown');
  let stamps = (_cryptoAdminApproveByActor.get(key) || []).filter(function(t) {
    return (now - t) < CRYPTO_ADMIN_APPROVE_WINDOW_MS;
  });
  if (stamps.length >= CRYPTO_ADMIN_APPROVE_MAX) {
    const oldest = stamps[0] || now;
    const retryAfterSec = Math.max(1, Math.ceil((CRYPTO_ADMIN_APPROVE_WINDOW_MS - (now - oldest)) / 1000));
    _cryptoAdminApproveByActor.set(key, stamps);
    return { allowed:false, retryAfterSec:retryAfterSec };
  }
  stamps.push(now);
  _cryptoAdminApproveByActor.set(key, stamps);
  return { allowed:true };
}

function _logCryptoAdminApprove(adminId, intentId, txHash, diamonds) {
  console.log('[CRYPTO_ADMIN_APPROVE] adminId=' + (adminId || '') +
    ' intentId=' + (intentId || '') +
    ' txHash=' + (txHash || '') +
    ' diamonds=' + diamonds +
    ' ts=' + new Date().toISOString());
}

function _mergeIntentMeta(intent, extra) {
  const prev = (intent && intent.metadata_json && typeof intent.metadata_json === 'object')
    ? intent.metadata_json : {};
  return Object.assign({}, prev, extra || {});
}

async function _findDuplicateCreditedTx(sb, txHash, exceptIntentId) {
  if (!txHash) return null;
  const { data } = await sb.from('crypto_deposit_intents')
    .select('intent_id,status')
    .eq('tx_hash', txHash)
    .eq('status', 'credited')
    .neq('intent_id', exceptIntentId)
    .limit(1);
  return (data && data[0]) || null;
}

async function _atomicAdminCreditHostDiamonds(sb, intent, createdBy) {
  const diamonds = parseFloat(intent.package_amount_diamonds);
  if (!(diamonds > 0)) return { ok:false, error:'invalid_package' };
  const txHash = intent.tx_hash;
  const iKey = 'CRYPTO_HD_' + (txHash || intent.intent_id);

  const { data: existingLedger } = await sb.from('host_diamond_ledger')
    .select('ledger_id').eq('idempotency_key', iKey).limit(1);
  if (existingLedger && existingLedger[0]) {
    return { ok:true, already_credited:true, ledgerId:existingLedger[0].ledger_id, diamonds:diamonds };
  }

  const { data: balRow } = await sb.from('host_diamond_balances')
    .select('*').eq('club_id', intent.club_id).limit(1);
  const host = balRow && balRow[0];
  if (!host) return { ok:false, error:'host_diamond_balance_missing' };

  const balBefore = parseFloat(host.balance_diamonds);
  const balAfter = balBefore + diamonds;
  const now = new Date().toISOString();
  const { error: balErr } = await sb.from('host_diamond_balances')
    .update({ balance_diamonds: balAfter, updated_at: now }).eq('club_id', intent.club_id);
  if (balErr) return { ok:false, error:balErr.message };

  const ledger = await _writeHostDiamondLedger(sb, {
    ledgerId: iKey, clubId: intent.club_id, hostActorId: host.host_actor_id,
    eventType: 'HOST_DIAMOND_PURCHASE', amount: diamonds, direction: 'credit',
    balanceBefore: balBefore, balanceAfter: balAfter,
    createdBy: createdBy || 'admin',
    reason: 'crypto_admin_approve:' + intent.intent_id,
    idempotencyKey: iKey,
    metadata: { source:'crypto_admin_approve', txHash:txHash, cryptoSymbol:intent.crypto_symbol }
  });
  if (!ledger || !ledger.ok) {
    await sb.from('host_diamond_balances')
      .update({ balance_diamonds: balBefore, updated_at: now }).eq('club_id', intent.club_id);
    return { ok:false, error:(ledger && ledger.error) || 'ledger_write_failed', rolled_back:true };
  }
  return {
    ok:true, diamonds:diamonds, balanceAfter:balAfter, ledgerId:iKey,
    already_credited: !!ledger.idempotent
  };
}

async function _handleAdminCryptoApprove(req, res, intentId) {
  const actor = req._actor || {};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole !== 'platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  if (!intentId) return res.status(400).json({ ok:false, error:'missing_intentId' });
  const adminId = actor.actorId || 'admin';
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const { data } = await sb.from('crypto_deposit_intents').select('*').eq('intent_id', intentId).limit(1);
    const intent = data && data[0];
    if (!intent) return res.status(404).json({ ok:false, error:'intent_not_found' });
    if (intent.status === 'credited') {
      return res.json({ ok:true, already_credited:true, idempotent:true, intentId:intent.intent_id });
    }
    if (intent.status === 'rejected') return res.status(409).json({ ok:false, error:'intent_rejected' });

    const rate = _checkCryptoAdminApproveRate(adminId);
    if (!rate.allowed) {
      return res.status(429).json({ ok:false, error:'rate_limited', retryAfterSec:rate.retryAfterSec });
    }

    const dup = await _findDuplicateCreditedTx(sb, intent.tx_hash, intent.intent_id);
    if (dup) {
      return res.status(409).json({ ok:false, error:'duplicate_tx', otherIntentId:dup.intent_id });
    }

    const credit = await _atomicAdminCreditHostDiamonds(sb, intent, adminId);
    if (credit.already_credited) {
      const nowIdem = new Date().toISOString();
      await sb.from('crypto_deposit_intents').update({
        status:'credited', credited_at:intent.credited_at || nowIdem,
        credited_by:intent.credited_by || adminId,
        idempotency_key:credit.ledgerId, updated_at:nowIdem
      }).eq('intent_id', intent.intent_id).neq('status', 'credited');
      _logCryptoAdminApprove(adminId, intent.intent_id, intent.tx_hash, credit.diamonds);
      return res.json({ ok:true, already_credited:true, idempotent:true, intentId:intent.intent_id });
    }
    if (!credit.ok) {
      const status = credit.error === 'host_diamond_balance_missing' ? 402 : 500;
      return res.status(status).json({ ok:false, error:credit.error, rolled_back:!!credit.rolled_back });
    }

    const now = new Date().toISOString();
    await sb.from('crypto_deposit_intents').update({
      status:'credited', credited_at:now, credited_by:adminId,
      idempotency_key:credit.ledgerId, updated_at:now,
      metadata_json:_mergeIntentMeta(intent, { credited_by:adminId, approved_at:now })
    }).eq('intent_id', intent.intent_id);
    _logCryptoAdminApprove(adminId, intent.intent_id, intent.tx_hash, credit.diamonds);
    emitEvent('balance_changed', {
      clubId:intent.club_id, event:'host_diamond_purchase', diamonds:credit.diamonds
    }, { clubId:intent.club_id, playerId:intent.player_id }, req.requestId);
    _writeAuthAudit('crypto_deposit_credited', adminId, intent.club_id,
      req.path, { intentId:intent.intent_id, diamonds:credit.diamonds, txHash:intent.tx_hash });
    return res.json({
      ok:true, intentId:intent.intent_id, diamonds:credit.diamonds,
      status:'credited', ledgerId:credit.ledgerId, balanceAfter:credit.balanceAfter
    });
  } catch(e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
}

async function _handleAdminCryptoReject(req, res, intentId, reason) {
  const actor = req._actor || {};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole !== 'platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const why = (reason || '').trim();
  if (!intentId || !why) return res.status(400).json({ ok:false, error:'missing_intentId_or_reason' });
  const adminId = actor.actorId || 'admin';
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const { data } = await sb.from('crypto_deposit_intents').select('*').eq('intent_id', intentId).limit(1);
    const intent = data && data[0];
    if (!intent) return res.status(404).json({ ok:false, error:'intent_not_found' });
    if (intent.status === 'credited') return res.status(409).json({ ok:false, error:'already_credited' });
    const now = new Date().toISOString();
    await sb.from('crypto_deposit_intents').update({
      status:'rejected',
      reject_reason:why,
      credited_by:adminId,
      updated_at:now,
      metadata_json:_mergeIntentMeta(intent, {
        rejected_by:adminId, reject_reason:why, rejected_at:now
      })
    }).eq('intent_id', intent.intent_id);
    emitEvent('balance_changed', { playerId:intent.player_id, event:'deposit_rejected' },
      { clubId:intent.club_id, playerId:intent.player_id }, req.requestId);
    _writeAuthAudit('crypto_deposit_rejected', adminId, intent.club_id,
      req.path, { intentId:intent.intent_id, reason:why, rejected_by:adminId });
    return res.json({
      ok:true, intentId:intent.intent_id, status:'rejected',
      reject_reason:why, rejected_by:adminId
    });
  } catch(e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
}

// POST /api/admin/crypto/deposits/confirm
app.post('/api/admin/crypto/deposits/confirm', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const { intentId } = req.body || {};
  return _handleAdminCryptoApprove(req, res, intentId);
});

// POST /api/admin/crypto/deposits/reject
app.post('/api/admin/crypto/deposits/reject', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const { intentId, reason, reject_reason } = req.body || {};
  return _handleAdminCryptoReject(req, res, intentId, reason || reject_reason);
});

// POST /api/admin/diamonds/purchases/:id/approve
app.post('/api/admin/diamonds/purchases/:id/approve', requirePermissionScoped('settle_player'), async (req, res) => {
  return _handleAdminCryptoApprove(req, res, req.params && req.params.id);
});

// POST /api/admin/diamonds/purchases/:id/reject
app.post('/api/admin/diamonds/purchases/:id/reject', requirePermissionScoped('settle_player'), async (req, res) => {
  const body = req.body || {};
  return _handleAdminCryptoReject(req, res, req.params && req.params.id, body.reason || body.reject_reason);
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

  // Deduct + activate only after a durable host_diamond_ledger debit exists.
  // HOST_ACTIVE_BETTOR_CHARGE is a host-diamond event — never write it through
  // _writeLedgerEntry (player sportsbook LEDGER_EVENT_TYPES rejects it as
  // invalid_eventType, which previously left a silent .catch warn).
  const ledgerId = 'HAB_'+clubId+'_'+playerId+'_'+weekStart;
  const now = new Date(nowMs||Date.now()).toISOString();
  const balAfter = host.balance_diamonds - HOST_ACTIVE_BETTOR_FEE;

  const ledgerWrite = await _writeHostDiamondLedger(sb, {
    ledgerId, clubId, hostActorId:host.host_actor_id,
    eventType:'HOST_ACTIVE_BETTOR_CHARGE', amount:HOST_ACTIVE_BETTOR_FEE, direction:'debit',
    balanceBefore:host.balance_diamonds, balanceAfter:balAfter,
    createdBy:'system', reason:'active_bettor_fee:'+playerId+':'+weekStart,
    idempotencyKey:ledgerId, metadata:{ playerId, weekStart, ticketId }
  });
  if (ledgerWrite && ledgerWrite.idempotent) {
    // Concurrent first-bet race: ledger already written for this week.
    // Ensure the weekly_active_bettors row exists so retries don't re-enter.
    await sb.from('weekly_active_bettors').upsert({
      club_id:clubId, player_id:playerId, week_start:weekStart,
      first_ticket_id:ticketId, activated_at:now,
      charged_diamonds:HOST_ACTIVE_BETTOR_FEE, charge_ledger_id:ledgerId
    }, { onConflict:'club_id,player_id,week_start' }).then(function(){}, function(){});
    return { ok:true, charged:false, reason:'already_active_this_week', weekStart, ledgerId };
  }
  if (!ledgerWrite || !ledgerWrite.ok) {
    return {
      ok:false, error:'host_diamond_ledger_write_failed', httpStatus:503,
      detail:(ledgerWrite && ledgerWrite.error) || 'ledger_write_failed', weekStart
    };
  }

  await sb.from('host_diamond_balances')
    .update({ balance_diamonds: balAfter, updated_at:now })
    .eq('club_id', clubId);

  const { error: wabErr } = await sb.from('weekly_active_bettors').insert({
    club_id:clubId, player_id:playerId, week_start:weekStart,
    first_ticket_id:ticketId, activated_at:now,
    charged_diamonds:HOST_ACTIVE_BETTOR_FEE, charge_ledger_id:ledgerId
  });
  if (wabErr) {
    // Unique race after ledger write — treat as already charged this week.
    if (wabErr.code === '23505') {
      return { ok:true, charged:false, reason:'already_active_this_week', weekStart, ledgerId };
    }
    console.error('[host/active-bettor] weekly_active_bettors insert failed after ledger write:', wabErr.message);
    return {
      ok:false, error:'weekly_active_bettor_insert_failed', httpStatus:503,
      detail:wabErr.message, weekStart, ledgerId
    };
  }

  console.log('[host/active-bettor] CHARGED playerId='+playerId+
    ' -'+HOST_ACTIVE_BETTOR_FEE+'d week='+weekStart+' balance='+balAfter);

  return {
    ok:true, charged:true, chargedDiamonds:HOST_ACTIVE_BETTOR_FEE,
    ledgerEvent:'HOST_ACTIVE_BETTOR_CHARGE', weekStart, ledgerId
  };
}

// ── Host diamond ledger writer ──────────────────────────────────────────────────────────────────────────
const VALID_HD_EVENT_TYPES = new Set([
  'HOST_DIAMOND_TOPUP','HOST_ACTIVE_BETTOR_CHARGE',
  'HOST_DIAMOND_ADJUSTMENT','HOST_DIAMOND_REFUND',
  'HOST_DIAMOND_PURCHASE'
]);

async function _writeHostDiamondLedger(sb, params) {
  if (!sb) return { ok:false, error:'supabase_not_configured' };
  const { ledgerId, clubId, hostActorId, eventType, amount, direction,
          balanceBefore, balanceAfter, createdBy, reason, idempotencyKey, metadata } = params;
  if (!VALID_HD_EVENT_TYPES.has(eventType)) {
    return { ok:false, error:'invalid_host_diamond_eventType:'+eventType };
  }
  if (direction !== 'credit' && direction !== 'debit') {
    return { ok:false, error:'invalid_host_diamond_direction:'+direction };
  }
  try {
    const { error } = await sb.from('host_diamond_ledger').insert({
      ledger_id:ledgerId, club_id:clubId, host_actor_id:hostActorId,
      event_type:eventType, amount_diamonds:amount, direction,
      balance_before:balanceBefore, balance_after:balanceAfter,
      created_at:new Date().toISOString(), created_by:createdBy||'system',
      reason:reason||null, idempotency_key:idempotencyKey||null,
      metadata_json:metadata||{}
    });
    if (error) {
      if (error.code === '23505') return { ok:true, idempotent:true, ledgerId };
      console.warn('[hdl] ledger write error:', error.message);
      return { ok:false, error:error.message, code:error.code };
    }
    return { ok:true, ledgerId };
  } catch(e) {
    console.warn('[hdl] ledger write error:', e.message);
    return { ok:false, error:e.message };
  }
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

// Request ID middleware defined above (before const app / routes).
// ───────────────────────────────────────────────────────────────────────────

// ── Supabase mirror client (Phase A — passive write only) ─────────────────────
// Loaded lazily so missing env never crashes startup.
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const envCheck = {
    hasUrl: !!url,
    hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    hasAnonKey: !!process.env.SUPABASE_ANON_KEY,
    hasDatabaseUrl: !!process.env.DATABASE_URL,
  };
  if (!url || !key) {
    console.error('[supabase] client init skipped — missing env');
    console.error('[supabase] env check:', envCheck);
    return null;
  }
  try {
    const { createClient } = require('@supabase/supabase-js');
    const clientOpts = { auth: { persistSession: false, autoRefreshToken: false } };
    // Node < 22 has no native WebSocket; @supabase/realtime-js requires transport: ws
    const nodeMajor = parseInt(String(process.versions && process.versions.node || '99').split('.')[0], 10);
    if (nodeMajor < 22 || typeof globalThis.WebSocket === 'undefined') {
      clientOpts.realtime = { transport: require('ws') };
    }
    _supabase = createClient(url, key, clientOpts);
    console.log('[supabase] client initialised — mirror writes enabled');
  } catch(e) {
    console.error('[supabase] client init failed:', e.message);
    console.error('[supabase] stack:', e.stack);
    console.error('[supabase] env check:', envCheck);
  }
  return _supabase;
}

// Live ticket_legs.odds_snapshot_id is uuid; odds_snapshots.snapshot_id is a
// text key like "mlb|Team|...|moneyline|...|ts". Only pass real UUIDs.
function _uuidOrNull(v) {
  return (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
    ? v : null;
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
          id:                 crypto.randomUUID(),
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

// Core middleware (json/cors/rate-limit/…) is registered immediately after
// `const app = express()` so every route below — including crypto deposits —
// sees a parsed body.

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
  const _healthMeta = require('./lib/build-info').toHealthPayload();
  const _gitSha = _healthMeta.gitSha;
  res.json({ ok:dbOk, status:'ok', uptime, version:process.env.APP_VERSION||_healthMeta.version||'unknown',
    gitSha:_gitSha, commit:process.env.COMMIT_SHA||_healthMeta.commit,
    bakedSHA:_gitSha, buildMarker:_gitSha, dbStatus, oddsStatus,
    resultStatus:_lastResultSuccessAt?'healthy':(_mlbGradePollerStarted?'starting':'unknown'),
    queueStatus:'not_implemented',
    liveBettingEnabled: !!LIVE_BETTING_ENABLED,
    lastOddsSuccessAt:lastOdds, lastResultSuccessAt:_lastResultSuccessAt,
    lastGradePollAt:_lastGradePollAt, lastGradeRunAt:_lastGradeRunAt,
    lastGradedAt:_lastGradedAt,
    gradePollerStarted:_mlbGradePollerStarted,
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
    { key:'POCKETBOOKS_ETH_ADDRESS',  reason:'crypto deposit wallet (ETH/USDT/USDC)' },
    { key:'POCKETBOOKS_BTC_ADDRESS',  reason:'crypto deposit wallet (BTC)' },
    { key:'ETHERSCAN_API_KEY',        reason:'ETH/USDT/USDC blockchain scanner' },
    { key:'ENABLE_WORKER',            reason:'background job worker' },
  ];
  const OPTIONAL = [
    'BLOCKCHAIN_SCANNER_ENABLED','AUTO_CREDIT_CONFIRMED_CRYPTO',
    'WALLET_ERC20','WALLET_BTC',
    'POCKETBOOKS_USDT_CONTRACT','POCKETBOOKS_USDC_CONTRACT',
    'BTC_CONFIRMATIONS_REQUIRED','ETH_CONFIRMATIONS_REQUIRED',
    'APP_VERSION','COMMIT_SHA','LOG_VERBOSE','LIVE_BETTING_ENABLED',
    'TELEGRAM_BOT_TOKEN','TELEGRAM_WEBHOOK_SECRET'
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
    `CREATE TABLE IF NOT EXISTS player_notifications (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      player_id text NOT NULL,
      type text NOT NULL,
      title text NOT NULL,
      message text NOT NULL,
      read boolean DEFAULT false,
      created_at timestamptz DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS player_notifications_player_created_idx ON player_notifications (player_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS player_notifications_player_unread_idx ON player_notifications (player_id) WHERE read = false`,
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

// Login identifier columns on public.users. Postgres schema uses `name`
// (display name). Supabase mirror may also have display_name / username.
const LOGIN_NAME_COL_CANDIDATES = ['name', 'display_name', 'username'];
let _loginNameCols = null;
async function getLoginNameColumns() {
  if (_loginNameCols) return _loginNameCols;
  try {
    const r = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users'
         AND column_name = ANY($1::text[])`,
      [LOGIN_NAME_COL_CANDIDATES]
    );
    _loginNameCols = r.rows.map(row => row.column_name);
  } catch (_e) {
    _loginNameCols = ['name'];
  }
  if (!_loginNameCols.length) _loginNameCols = ['name'];
  return _loginNameCols;
}

app.post('/api/auth/login', async (req, res) => {
  const raw = String((req.body && (req.body.email || req.body.identifier)) || '').trim();
  const password = req.body && req.body.password;
  if (!raw || !password) return res.status(400).json({ error: 'Missing fields' });
  const lower = raw.toLowerCase();
  const alnum = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const candidates = [lower];
  if (alnum) {
    candidates.push('telegram+' + alnum + '@pocketbooks.local');
    candidates.push('signal+' + alnum + '@pocketbooks.local');
  }
  try {
    const nameCols = await getLoginNameColumns();
    const nameMatch = nameCols.map(c => `lower(trim(${c}))=$2`).join(' OR ');
    const r = await query(
      `SELECT * FROM users
       WHERE lower(email)=ANY($1::text[]) OR ${nameMatch}
       ORDER BY CASE WHEN lower(email)=ANY($1::text[]) THEN 0 ELSE 1 END
       LIMIT 1`,
      [candidates, lower]
    );
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
    const code = String(req.params.code || '').toUpperCase();
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('clubs')
        .select('id,name,code,description,is_locked,active')
        .eq('code', code)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data || data.active === false) return res.status(404).json({ error: 'Club not found' });
      return res.json(Object.assign({}, data, {
        is_locked: !!data.is_locked,
        is_active: data.active !== false
      }));
    }
    const r = await query('SELECT id,name,code,description,COALESCE(is_locked,false) AS is_locked,COALESCE(active,true) AS active FROM clubs WHERE code=$1 AND COALESCE(active,true)=true', [code]);
    if (!r.rows.length) return res.status(404).json({ error: 'Club not found' });
    const row = r.rows[0];
    res.json(Object.assign({}, row, { is_locked: !!row.is_locked, is_active: !!row.active }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clubs/request', auth, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ ok:false, error: 'missing_code' });
  try {
    const codeUp = String(code).toUpperCase();
    const actorId = String(req.user.id);
    const sb = getSupabase();
    let c = null;
    if (sb) {
      const { data, error } = await sb.from('clubs').select('*').eq('code', codeUp).limit(1).maybeSingle();
      if (error) throw error;
      if (!data || data.active === false) return res.status(404).json({ ok:false, error: 'Club not found' });
      c = data;
    } else {
      const club = await query('SELECT * FROM clubs WHERE code=$1 AND COALESCE(active,true)=true', [codeUp]);
      if (!club.rows.length) return res.status(404).json({ ok:false, error: 'Club not found' });
      c = club.rows[0];
    }
    if (c.is_locked) {
      return res.status(403).json({
        ok: false,
        error: 'club_locked',
        message: 'This club is not accepting new members right now'
      });
    }
    const clubId = String(c.id);
    if (sb) {
      const { data: existing } = await sb.from('club_memberships')
        .select('actor_id,status').eq('club_id', clubId).eq('actor_id', actorId).limit(1);
      if (existing && existing.length) {
        return res.status(400).json({ ok:false, error: 'Already a member', status: existing[0].status });
      }
      const now = new Date().toISOString();
      const { error: insErr } = await sb.from('club_memberships').insert({
        actor_id: actorId, club_id: clubId, role: 'player', status: 'pending',
        joined_at: now, updated_at: now
      });
      if (insErr) throw insErr;
    } else {
      const exists = await query('SELECT actor_id,status FROM club_memberships WHERE club_id=$1 AND actor_id=$2', [clubId, actorId]);
      if (exists.rows.length) return res.status(400).json({ ok:false, error: 'Already a member', status: exists.rows[0].status });
      await query('INSERT INTO club_memberships (club_id,actor_id,status,role,joined_at,updated_at) VALUES ($1,$2,$3,$4,NOW(),NOW())',
        [clubId, actorId, 'pending', 'player']);
    }
    res.json({ ok:true, success: true, club: { id: c.id, name: c.name, code: c.code, is_locked: !!c.is_locked } });
  } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
});

app.get('/api/clubs/:id/members', auth, async (req, res) => {
  try {
    const r = await query(`SELECT m.*,u.name,u.email,CASE WHEN m.total_bets>0 THEN ROUND((m.wins::float/m.total_bets*100)::numeric,1) ELSE 0 END as win_rate FROM club_memberships m JOIN users u ON m.player_id=u.id WHERE m.club_id=$1 AND m.host_id=$2 ORDER BY m.joined_at DESC`, [req.params.id, req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clubs/:id/requests', auth, async (req, res) => {
  try {
    const clubId = String(req.params.id);
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('club_memberships')
        .select('id,actor_id,club_id,role,status,joined_at,updated_at')
        .eq('club_id', clubId)
        .eq('status', 'pending')
        .order('joined_at', { ascending: false });
      if (error) throw error;
      const rows = data || [];
      const actorIds = rows.map(function(r){ return r.actor_id; }).filter(Boolean);
      var usersById = Object.create(null);
      if (actorIds.length) {
        const { data: users } = await sb.from('users')
          .select('id,name,email,username')
          .in('id', actorIds);
        (users || []).forEach(function(u){ usersById[String(u.id)] = u; });
      }
      const requests = rows.map(function(r){
        var u = usersById[String(r.actor_id)] || {};
        return {
          id: r.id,
          membershipId: r.id,
          actor_id: r.actor_id,
          player_id: r.actor_id,
          playerId: r.actor_id,
          club_id: r.club_id,
          status: r.status,
          role: r.role,
          joined_at: r.joined_at,
          name: u.name || u.username || null,
          username: u.username || u.name || null,
          email: u.email || null,
          playerName: u.name || u.username || u.email || 'Player'
        };
      });
      return res.json({ ok: true, requests: requests });
    }
    const r = await query(
      `SELECT m.*, COALESCE(u.name,u.username,u.email) AS player_name, u.email, u.username
       FROM club_memberships m
       LEFT JOIN users u ON u.id::text = m.actor_id::text
       WHERE m.club_id=$1 AND m.status='pending'
       ORDER BY m.joined_at DESC`,
      [clubId]
    );
    res.json({
      ok: true,
      requests: (r.rows || []).map(function(row){
        return Object.assign({}, row, {
          playerId: row.actor_id || row.player_id,
          playerName: row.player_name || row.username || row.email || 'Player',
          membershipId: row.id
        });
      })
    });
  } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
});

// Alias used by overnight join-request flow
app.get('/api/club/pending-requests', auth, async (req, res) => {
  const clubId = (req.query && (req.query.clubId || req.query.club_id)) || req._clubId
    || (req.body && (req.body.clubId || req.body.club_id));
  if (!clubId) return res.status(400).json({ ok:false, error:'missing_clubId' });
  // Reuse /api/clubs/:id/requests handler by mutating params and delegating.
  req.params = Object.assign({}, req.params || {}, { id: String(clubId) });
  try {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('club_memberships')
        .select('id,actor_id,club_id,role,status,joined_at,updated_at')
        .eq('club_id', String(clubId))
        .eq('status', 'pending')
        .order('joined_at', { ascending: false });
      if (error) throw error;
      const rows = data || [];
      const actorIds = rows.map(function(r){ return r.actor_id; }).filter(Boolean);
      var usersById = Object.create(null);
      if (actorIds.length) {
        const { data: users } = await sb.from('users')
          .select('id,name,email,username')
          .in('id', actorIds);
        (users || []).forEach(function(u){ usersById[String(u.id)] = u; });
      }
      const requests = rows.map(function(r){
        var u = usersById[String(r.actor_id)] || {};
        return {
          id: r.id,
          membershipId: r.id,
          actor_id: r.actor_id,
          player_id: r.actor_id,
          playerId: r.actor_id,
          club_id: r.club_id,
          status: r.status,
          role: r.role,
          joined_at: r.joined_at,
          name: u.name || u.username || null,
          username: u.username || u.name || null,
          email: u.email || null,
          playerName: u.name || u.username || u.email || 'Player'
        };
      });
      return res.json({ ok: true, requests: requests });
    }
    const r = await query(
      `SELECT m.*, COALESCE(u.name,u.username,u.email) AS player_name, u.email, u.username
       FROM club_memberships m
       LEFT JOIN users u ON u.id::text = m.actor_id::text
       WHERE m.club_id=$1 AND m.status='pending'
       ORDER BY m.joined_at DESC`,
      [String(clubId)]
    );
    res.json({
      ok: true,
      requests: (r.rows || []).map(function(row){
        return Object.assign({}, row, {
          playerId: row.actor_id || row.player_id,
          playerName: row.player_name || row.username || row.email || 'Player',
          membershipId: row.id
        });
      })
    });
  } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
});

app.patch('/api/clubs/:id/requests/:memberId', auth, async (req, res) => {
  const { action, max_bet, max_daily_risk, max_payout, max_open_risk, balanceStart, starting_balance, credit_limit } = req.body || {};
  const status = action === 'approve' ? 'approved' : 'rejected';
  const startBal = parseFloat(balanceStart != null ? balanceStart : (starting_balance != null ? starting_balance : credit_limit));
  const mb = parseFloat(max_bet); const md = parseFloat(max_daily_risk); const mp = parseFloat(max_payout);
  try {
    const credit = Number.isFinite(startBal) ? startBal : null;
    const r = await query(
      `UPDATE club_memberships SET status=$1,approved_at=${action==='approve'?'NOW()':'NULL'},
        credit_limit=COALESCE($4,credit_limit), max_bet=COALESCE($5,max_bet), balance=COALESCE($4,balance)
       WHERE id=$2 AND host_id=$3 RETURNING *`,
      [status, req.params.memberId, req.user.id, credit, Number.isFinite(mb) ? mb : null]);
    if (action === 'approve' && r.rows[0]) {
      const pid = r.rows[0].player_id;
      await query(
        `INSERT INTO player_limits (club_id,user_id,max_bet,max_daily_risk,max_payout,updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (club_id,user_id) DO UPDATE SET
           max_bet=EXCLUDED.max_bet, max_daily_risk=EXCLUDED.max_daily_risk,
           max_payout=EXCLUDED.max_payout, updated_at=NOW()`,
        [req.params.id, pid,
          Number.isFinite(mb) ? mb : 100,
          Number.isFinite(md) ? md : 500,
          Number.isFinite(mp) ? mp : 2000]);
    }
    res.json(Object.assign({}, r.rows[0] || {}, { ok:true, max_open_risk: max_open_risk != null ? parseFloat(max_open_risk) : null }));
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

function _maskOddsKey(key) {
  if (!key) return 'MISSING';
  const s = String(key);
  if (s.length <= 8) return 'set(****)';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

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
// MMA often has no lines on pinnacle/FD/DK in Owls while betonline (and similar)
// carry the full fight card. Append these only for the MMA poll — other sports
// keep OWLS_BOOKS unchanged.
const OWLS_MMA_BOOKS_EXTRA = process.env.OWLS_MMA_BOOKS || 'betonline,bet365,bovada,williamhill_us';
const OWLS_ALTERNATES    = process.env.OWLS_INSIGHT_ALTERNATES === 'true';
// WebSocket real-time feed (opt-in — default false so production keeps REST polling).
const OWLS_USE_WEBSOCKET     = process.env.OWLS_USE_WEBSOCKET === 'true';
const OWLS_WS_FALLBACK_POLL_MS = 30 * 1000;
const OWLS_WS_RECONNECT_MS     = 5 * 1000;
const OWLS_WS_CONNECTED_POLL_MS = 5 * 60 * 1000; // slow heartbeat while WS is live
// While WS is connected, still run REST when cache age exceeds this (WS-only
// updates can stall / deliver empty snapshots without refreshing lastSuccessAt).
const OWLS_WS_STALE_REST_MS = _envMs('OWLS_WS_STALE_REST_MS', 90 * 1000);

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
  // NASCAR: NOT on unified GET /api/v1/{sport}/odds (404). Polled via Bookmaker
  // Source API v2 under sport group `motorsport`, filtered to nascar-* leagues.
  nascar:'nascar',                      nascar_cup:'nascar',
  formula1:'f1',                        f1:'f1',
  // ── Soccer (Owls v1 path key is exactly `soccer`; leagues are event fields) ──
  // /api/odds/soccer serves the combined soccer feed. Aliases map to that key.
  soccer:'soccer',
  soccer_epl:'soccer',                  epl:'soccer',               premier_league:'soccer',
  soccer_england_premier_league:'soccer',
  soccer_uefa_champs_league:'soccer',   ucl:'soccer',               champions_league:'soccer',
  soccer_usa_mls:'soccer',              mls:'soccer',
  soccer_fifa_world_cup:'soccer',       worldcup:'soccer',          world_cup:'soccer',
  soccer_uefa_european_championship:'soccer', euros:'soccer',
  soccer_spain_la_liga:'soccer',        laliga:'soccer',            la_liga:'soccer',
  soccer_italy_serie_a:'soccer',        serie_a:'soccer',           seriea:'soccer',
  soccer_germany_bundesliga:'soccer',   bundesliga:'soccer',
  soccer_france_ligue_one:'soccer',     ligue1:'soccer',            ligue_one:'soccer',
  // legacy short keys previously invented as Owls path segments → still map
  soccer_ucl:'soccer', soccer_mls:'soccer', soccer_worldcup:'soccer', soccer_euros:'soccer',
  soccer_laliga:'soccer', soccer_seriea:'soccer', soccer_bundesliga:'soccer', soccer_ligue1:'soccer',
  // ── Other international team sports ──
  cricket:'cricket',
  cricket_ipl:'cricket_ipl',            ipl:'cricket_ipl',
  cricket_international_t20:'cricket_t20', t20:'cricket_t20',
  rugbyunion_six_nations:'rugby',       rugby_union:'rugby',     rugby:'rugby',
  'rugby-union':'rugby',
  rugbyleague:'rugby_league',           rugby_league:'rugby_league', nrl:'rugby_league',
  'rugby-league':'rugby_league',
  aussierules_afl:'afl',                afl:'afl',
  // ── Individual sports (Owls v1 path key is exactly `tennis`; ATP/WTA are leagues) ──
  tennis:'tennis',                      atp:'tennis',              wta:'tennis',
  tennis_atp:'tennis',                  tennis_wta:'tennis',
  // Golf / Rugby / NASCAR: NOT on unified GET /api/v1/{sport}/odds (404). Polled via
  // Bookmaker Source API v2 (/api/v2/bookmaker/{sport}/leagues + ?league=).
  // Tour / competition aliases roll into the lobby golf / rugby / nascar tabs.
  golf:'golf',                          golf_pga:'golf',           pga:'golf',
  pga_tour:'golf',                      golf_pga_championship:'golf',
  golf_masters_tournament:'golf',
  golf_us_open:'golf',                  golf_the_open_championship:'golf',
  golf_liv:'golf',                      liv:'golf',
  golf_european:'golf',                 golf_european_tour:'golf',
  table_tennis:'table_tennis',          tabletennis:'table_tennis',
  // ── Esports ──
  cs2:'cs2',                            counterstrike:'cs2',     csgo:'cs2',
  valorant:'valorant',
  lol:'lol',                            leagueoflegends:'lol',
  dota2:'dota2',                        dota:'dota2',
  rocketleague:'rocketleague',          rl:'rocketleague'
};

// Soccer lobby tab: Owls exposes a single `/api/v1/soccer/odds` feed (all leagues).
// Poll that exact path key once; /api/odds/soccer serves the combined cache.
const OWLS_SOCCER_TAB_KEYS = [
  'soccer'
];

// Tennis lobby tab: Owls exposes a single `/api/v1/tennis/odds` feed (ATP+WTA+…).
const OWLS_TENNIS_TAB_KEYS = [
  'tennis'
];

// Golf lobby tab: Bookmaker v2 sport group `golf` (tours discovered via /leagues).
const OWLS_GOLF_TAB_KEYS = [
  'golf'
];

// Rugby lobby tab: Bookmaker v2 sport group `rugby` (comps discovered via /leagues).
const OWLS_RUGBY_TAB_KEYS = [
  'rugby'
];

// MMA lobby tab: Owls path key is exactly `mma` (UFC + other promotions).
const OWLS_MMA_TAB_KEYS = [
  'mma'
];

// NASCAR lobby tab: Bookmaker v2 sport group `motorsport` (nascar-* leagues only).
const OWLS_NASCAR_TAB_KEYS = [
  'nascar'
];

// The exhaustive list of short keys this backend is willing to surface when
// OWLS_ENABLED_SPORTS=all. Derived from OWLS_SPORT_MAP values (deduped).
// Soccer and tennis Owls path keys are included via the map values.
const OWLS_ALL_SPORTS = (function(){
  var seen = {}, out = [];
  Object.values(OWLS_SPORT_MAP).forEach(function(v){ if (v && !seen[v]) { seen[v]=true; out.push(v); } });
  if (!seen.soccer) { seen.soccer = true; out.push('soccer'); }
  if (!seen.tennis) { seen.tennis = true; out.push('tennis'); }
  if (!seen.golf) { seen.golf = true; out.push('golf'); }
  if (!seen.rugby) { seen.rugby = true; out.push('rugby'); }
  if (!seen.mma) { seen.mma = true; out.push('mma'); }
  if (!seen.nascar) { seen.nascar = true; out.push('nascar'); }
  return out;
})();

/** Merge configured books with sport-specific extras (deduped, order preserved). */
function _owlsBooksForSport(sportKey) {
  var owlsSport = _mapToOwlsSport(sportKey) || String(sportKey || '').toLowerCase();
  var base = String(OWLS_BOOKS || '').split(',').map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean);
  var extra = [];
  if (owlsSport === 'mma') {
    extra = String(OWLS_MMA_BOOKS_EXTRA || '').split(',').map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean);
  }
  var seen = {}, out = [];
  base.concat(extra).forEach(function(b) {
    if (!b || seen[b]) return;
    seen[b] = true;
    out.push(b);
  });
  return out.length ? out.join(',') : (OWLS_BOOKS || 'pinnacle,fanduel,draftkings');
}

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

// Sports the live-odds poller fetches — defined early so boot-time REST
// bootstrap (_triggerImmediateOddsRefresh) can read CACHE_SPORTS safely.
const _CACHE_SPORTS_BASE = ['baseball_mlb','basketball_nba','americanfootball_nfl','icehockey_nhl'];
const _CACHE_SPORT_KEY_BY_SHORT = {
  mlb:'baseball_mlb', nba:'basketball_nba', wnba:'basketball_wnba',
  nfl:'americanfootball_nfl', nhl:'icehockey_nhl',
  ncaab:'basketball_ncaab', ncaaf:'americanfootball_ncaaf', ncaabaseball:'baseball_ncaa',
  mma:'mma_mixed_martial_arts', boxing:'boxing_boxing',
  nascar:'nascar', f1:'formula1',
  // Soccer/tennis: Owls path keys are exactly `soccer` and `tennis` (docs sports list).
  soccer:'soccer',
  soccer_epl:'soccer', soccer_ucl:'soccer', soccer_mls:'soccer',
  soccer_worldcup:'soccer', soccer_euros:'soccer',
  soccer_laliga:'soccer', soccer_seriea:'soccer',
  soccer_bundesliga:'soccer', soccer_ligue1:'soccer',
  soccer_uefa_champs_league:'soccer', soccer_usa_mls:'soccer',
  soccer_fifa_world_cup:'soccer', soccer_uefa_european_championship:'soccer',
  soccer_spain_la_liga:'soccer', soccer_italy_serie_a:'soccer',
  soccer_germany_bundesliga:'soccer', soccer_france_ligue_one:'soccer',
  cricket:'cricket', cricket_ipl:'cricket_ipl', cricket_t20:'cricket_international_t20',
  rugby:'rugby', rugby_union:'rugby', rugby_league:'rugby_league', afl:'aussierules_afl',
  tennis:'tennis', tennis_atp:'tennis', tennis_wta:'tennis',
  golf:'golf', golf_pga:'golf', golf_liv:'golf', golf_european:'golf',
  table_tennis:'table_tennis',
  cs2:'cs2', valorant:'valorant', lol:'lol', dota2:'dota2', rocketleague:'rocketleague'
};
// Build Owls poll list: always include soccer + tennis + golf + rugby + mma +
// nascar so lobby tabs can serve from cache. Golf/rugby/nascar use Bookmaker v2.
const CACHE_SPORTS = (function() {
  if (ODDS_PROVIDER !== 'owls_insight') return _CACHE_SPORTS_BASE;
  var seen = {}, out = [];
  function addShort(s) {
    var k = _CACHE_SPORT_KEY_BY_SHORT[s] || s;
    if (!seen[k]) { seen[k] = true; out.push(k); }
  }
  OWLS_SAFE_SPORTS.forEach(function(s) {
    if (s === 'soccer') OWLS_SOCCER_TAB_KEYS.forEach(addShort);
    else if (s === 'tennis') OWLS_TENNIS_TAB_KEYS.forEach(addShort);
    else if (s === 'golf') OWLS_GOLF_TAB_KEYS.forEach(addShort);
    else if (s === 'rugby') OWLS_RUGBY_TAB_KEYS.forEach(addShort);
    else if (s === 'mma') OWLS_MMA_TAB_KEYS.forEach(addShort);
    else if (s === 'nascar') OWLS_NASCAR_TAB_KEYS.forEach(addShort);
    else addShort(s);
  });
  OWLS_SOCCER_TAB_KEYS.forEach(addShort);
  OWLS_TENNIS_TAB_KEYS.forEach(addShort);
  OWLS_GOLF_TAB_KEYS.forEach(addShort);
  OWLS_RUGBY_TAB_KEYS.forEach(addShort);
  OWLS_MMA_TAB_KEYS.forEach(addShort);
  OWLS_NASCAR_TAB_KEYS.forEach(addShort);
  return out;
})();

function _mapToOwlsSport(key) { return OWLS_SPORT_MAP[key] || null; }
function _mapSportToOwls(key) { return _mapToOwlsSport(key); }

function _isSoccerCacheSportKey(gameSportKey) {
  var g = String(gameSportKey || '').toLowerCase();
  if (!g) return false;
  if (g === 'soccer' || g.indexOf('soccer_') === 0 || g.indexOf('soccer') === 0) return true;
  for (var i = 0; i < OWLS_SOCCER_TAB_KEYS.length; i++) {
    var short = OWLS_SOCCER_TAB_KEYS[i];
    var full = _CACHE_SPORT_KEY_BY_SHORT[short] || short;
    if (g === short || g === full) return true;
  }
  return false;
}

function _isTennisCacheSportKey(gameSportKey) {
  var g = String(gameSportKey || '').toLowerCase();
  if (!g) return false;
  if (g === 'tennis' || g.indexOf('tennis_') === 0) return true;
  if (g === 'atp' || g === 'wta') return true;
  for (var i = 0; i < OWLS_TENNIS_TAB_KEYS.length; i++) {
    var short = OWLS_TENNIS_TAB_KEYS[i];
    var full = _CACHE_SPORT_KEY_BY_SHORT[short] || short;
    if (g === short || g === full) return true;
  }
  return false;
}

function _isGolfCacheSportKey(gameSportKey) {
  var g = String(gameSportKey || '').toLowerCase();
  if (!g) return false;
  if (g === 'golf' || g.indexOf('golf') === 0 || g === 'pga' || g === 'pga_tour' || g === 'liv') return true;
  for (var i = 0; i < OWLS_GOLF_TAB_KEYS.length; i++) {
    var short = OWLS_GOLF_TAB_KEYS[i];
    var full = _CACHE_SPORT_KEY_BY_SHORT[short] || short;
    if (g === short || g === full) return true;
  }
  return false;
}

function _isRugbyCacheSportKey(gameSportKey) {
  var g = String(gameSportKey || '').toLowerCase();
  if (!g) return false;
  if (g === 'rugby' || g.indexOf('rugby') === 0 || g === 'nrl') return true;
  for (var i = 0; i < OWLS_RUGBY_TAB_KEYS.length; i++) {
    var short = OWLS_RUGBY_TAB_KEYS[i];
    var full = _CACHE_SPORT_KEY_BY_SHORT[short] || short;
    if (g === short || g === full) return true;
  }
  return false;
}

function _isMmaCacheSportKey(gameSportKey) {
  var g = String(gameSportKey || '').toLowerCase();
  if (!g) return false;
  if (g === 'mma' || g === 'mma_mixed_martial_arts' || g.indexOf('mma') === 0) return true;
  for (var i = 0; i < OWLS_MMA_TAB_KEYS.length; i++) {
    var short = OWLS_MMA_TAB_KEYS[i];
    var full = _CACHE_SPORT_KEY_BY_SHORT[short] || short;
    if (g === short || g === full) return true;
  }
  return false;
}

// Cache: { "sport:name" -> canonical }
const _teamNormCache = new Map();

async function _owlsApiGetJson(path, queryParams) {
  if (!OWLS_KEY) return null;
  var qs = '';
  if (queryParams && typeof queryParams === 'object') {
    qs = '?' + Object.keys(queryParams).map(function(k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(queryParams[k]);
    }).join('&');
  }
  var url = OWLS_BASE_URL + path + qs;
  return new Promise(function(resolve) {
    var parsed;
    try { parsed = new URL(url); } catch(_e) { return resolve(null); }
    var chunks = [];
    var req = https.request({
      hostname: parsed.hostname, port: parsed.port || 443,
      path: parsed.pathname + parsed.search, method: 'GET',
      headers: {
        Authorization: 'Bearer ' + OWLS_KEY,
        Accept: 'application/json',
        'User-Agent': 'PocketBooksSports/2.0'
      }
    }, function(res) {
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch(_e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.setTimeout(8000, function() { req.destroy(); resolve(null); });
  });
}

async function _normalizeTeamName(name, sport) {
  const key = sport + ':' + name;
  if (_teamNormCache.has(key)) return _teamNormCache.get(key);
  try {
    const data = await _owlsApiGetJson('/api/v1/normalize', { name: name, sport: sport });
    const canonical = (data && data.canonical) || name;
    _teamNormCache.set(key, canonical);
    setTimeout(function() { _teamNormCache.delete(key); }, 86400000);
    return canonical;
  } catch(e) {
    return name;
  }
}

async function _normalizeTeamNames(names, sport) {
  const uncached = names.filter(function(n) { return !_teamNormCache.has(sport + ':' + n); });
  if (uncached.length > 0) {
    try {
      const data = await _owlsApiGetJson('/api/v1/normalize/batch', {
        names: uncached.join(','), sport: sport
      });
      (data && data.results || []).forEach(function(r) {
        const cacheKey = sport + ':' + r.input;
        _teamNormCache.set(cacheKey, r.canonical || r.input);
        setTimeout(function() { _teamNormCache.delete(cacheKey); }, 86400000);
      });
    } catch(e) {}
  }
  return names.map(function(n) { return _teamNormCache.get(sport + ':' + n) || n; });
}

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
  if (k==='player_tackles_assists' || k==='tackles_assists')         return 'Tackles + Asts';
  if (k==='player_tackles' || k==='tackles')                         return 'Tackles';
  // ----- MLB -----
  if (k==='pitcher_strikeouts' || k==='player_strikeouts')           return 'Strikeouts';
  if (k==='pitcher_outs')                                            return 'Pitching Outs';
  if (k==='pitcher_earned_runs')                                     return 'Earned Runs';
  if (k==='pitcher_walks')                                           return 'Walks Allowed';
  if (k==='pitcher_hits_allowed')                                    return 'Hits Allowed';
  if (k==='batter_hits' || k==='player_hits' || k==='player_to_record_a_hit'
      || k==='to_record_a_hit' || k==='record_a_hit')                return 'Hits';
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

function _americanToDecimalOdds(americanOdds) {
  const n = Number(americanOdds);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0
    ? Math.round((n / 100 + 1) * 10000) / 10000
    : Math.round((100 / Math.abs(n) + 1) * 10000) / 10000;
}

function _logInvalidSnapshotOdds(entry, outcome, provider, reason, rawOdds) {
  try {
    console.warn('SNAPSHOT_ROW_SKIPPED_INVALID_ODDS ' + JSON.stringify({
      provider: provider || entry && (entry.sportsbook || entry.bookmaker) || 'unknown',
      reason,
      rawOdds,
      canonicalGameKey: entry && (entry.cKey || entry.canonicalKey) || null,
      providerGameId: entry && (entry.providerGameId || entry.gameId) || null,
      market: entry && (entry.marketType || entry.market) || null,
      selection: outcome && outcome.name || entry && (entry.teamOrSide || entry.playerName) || null
    }));
  } catch(_e) {
    console.warn('SNAPSHOT_ROW_SKIPPED_INVALID_ODDS provider='+(provider||'unknown')+' reason='+reason);
  }
}

function _logOwlsUnavailableMarketSkip(payload) {
  try {
    console.warn('OWLS_MARKET_UNAVAILABLE_SKIPPED ' + JSON.stringify(payload));
  } catch(_e) {
    console.warn('OWLS_MARKET_UNAVAILABLE_SKIPPED reason=market_unavailable_skipped');
  }
}

// Expand nested alternateLines on spread/total outcomes into flat cache entries.
function _expandOwlsOutcomeAlternates(oc, mt, baseEntry, ck, pushFn) {
  var altLines = oc.alternateLines || oc.alternate_lines;
  if (!Array.isArray(altLines) || !altLines.length) return;
  if (mt !== 'spread' && mt !== 'total') return;
  altLines.forEach(function(alt) {
    if (!alt || typeof alt !== 'object') return;
    var altPoint = alt.point != null ? alt.point
                 : alt.handicap != null ? alt.handicap
                 : alt.spread != null ? alt.spread : undefined;
    if (altPoint == null) return;
    // Some feeds bundle both sides on one alt row for totals.
    if (mt === 'total' && (alt.overPrice != null || alt.underPrice != null
        || alt.over != null || alt.under != null)) {
      var overP = alt.overPrice != null ? alt.overPrice : alt.over;
      var underP = alt.underPrice != null ? alt.underPrice : alt.under;
      if (overP != null) {
        var overEntry = Object.assign({}, baseEntry, {
          teamOrSide: 'Over', line: altPoint,
          odds: _toAmericanOdds(parseFloat(overP) || 0),
          overUnder: 'Over', isAlternate: true
        });
        overEntry.canonicalMarketKey = _buildCanonicalMarketKey({
          canonicalGameKey: ck, marketType: overEntry.marketType,
          propType: overEntry.propType, team: overEntry.teamOrSide
        });
        overEntry.canonicalSelectionKey = _buildCanonicalSelectionKey({
          marketType: overEntry.marketType, team: overEntry.teamOrSide,
          player: overEntry.playerName, side: overEntry.overUnder || overEntry.teamOrSide,
          line: overEntry.line
        });
        pushFn(overEntry);
      }
      if (underP != null) {
        var underEntry = Object.assign({}, baseEntry, {
          teamOrSide: 'Under', line: altPoint,
          odds: _toAmericanOdds(parseFloat(underP) || 0),
          overUnder: 'Under', isAlternate: true
        });
        underEntry.canonicalMarketKey = _buildCanonicalMarketKey({
          canonicalGameKey: ck, marketType: underEntry.marketType,
          propType: underEntry.propType, team: underEntry.teamOrSide
        });
        underEntry.canonicalSelectionKey = _buildCanonicalSelectionKey({
          marketType: underEntry.marketType, team: underEntry.teamOrSide,
          player: underEntry.playerName, side: underEntry.overUnder || underEntry.teamOrSide,
          line: underEntry.line
        });
        pushFn(underEntry);
      }
      return;
    }
    var altPrice = alt.price != null ? alt.price
                 : alt.odds != null ? alt.odds
                 : alt.american != null ? alt.american : null;
    if (altPrice == null) return;
    var altEntry = Object.assign({}, baseEntry, {
      line: altPoint,
      odds: _toAmericanOdds(parseFloat(altPrice) || 0),
      isAlternate: true
    });
    altEntry.canonicalMarketKey = _buildCanonicalMarketKey({
      canonicalGameKey: ck, marketType: altEntry.marketType,
      propType: altEntry.propType, team: altEntry.teamOrSide
    });
    altEntry.canonicalSelectionKey = _buildCanonicalSelectionKey({
      marketType: altEntry.marketType, team: altEntry.teamOrSide,
      player: altEntry.playerName, side: altEntry.overUnder || altEntry.teamOrSide,
      line: altEntry.line
    });
    pushFn(altEntry);
  });
}

function _owlsIsAlternateMarketKey(mktKeyLc, mt) {
  if (mt !== 'spread' && mt !== 'total') return false;
  return /alternate|(^|_)alt_/.test(mktKeyLc || '');
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
    var ct     = ev.commence_time || ev.start_time || ev.game_time || ev.startTime
               || ev.scheduled_start || ev.commenceTime || ev.start || '';
    var league = ev.league || ev.league_name || ev.competition || ev.promotion ||
                 ev.sport_title || ev.event_name || null;
    var date   = _isoDateFromValue(ct);
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

    // Owls odds `eventId` matches /scores/live `id` (e.g. mlb:Away@Home-YYYYMMDD).
    var owlsEventId = ev.eventId || ev.event_id || null;
    var gEntry = { id:evId, sport_key:sport, commence_time:ct,
      home_team:home, away_team:away, canonicalKey:ck,
      eventId: owlsEventId || null,
      owlsEventId: owlsEventId || null,
      league: league || null,
      status:gameStatus, completed:!!evCompleted, canceled:!!evCanceled,
      isLive:!!evLive,
      // Scoreboard (null when the feed doesn't supply it — frontend hides empty fields)
      homeScore: homeScore!=null ? Number(homeScore) : null,
      awayScore: awayScore!=null ? Number(awayScore) : null,
      period, clock, inning, inningHalf, outs, basesOccupied: basesOcc,
      possession, down, distance,
      setScore: null, gameScore: null, statusDetail: null,
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
                           /^(suspended|paused|inactive|removed|halted)$/.test(rawMktStatus);
        var mktClosed    = mkt.closed === true || mkt.is_closed === true ||
                           /^(closed|settled|final)$/.test(rawMktStatus);
        if (mktSuspended || mktClosed) {
          warnings.push((mktClosed?'closed:':'suspended:')+evId+':'+mktKey);
          _logOwlsUnavailableMarketSkip({
            provider: 'owls',
            reason: 'market_unavailable_skipped',
            unavailableType: mktClosed ? 'closed' : 'suspended',
            rawStatus: rawMktStatus || null,
            status: mkt.status || null,
            state: mkt.state || null,
            suspended: mkt.suspended === true || mkt.is_suspended === true,
            closed: mkt.closed === true || mkt.is_closed === true,
            providerGameId: evId || null,
            canonicalGameKey: ck || null,
            sport: sport || null,
            marketKey: mktKey || null,
            marketName: mkt.name || mkt.label || null,
            homeTeam: home || null,
            awayTeam: away || null
          });
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

          if (_owlsIsAlternateMarketKey(mktKeyLc, mt)) entry.isAlternate = true;

          gEntry.markets.push(entry);
          _expandOwlsOutcomeAlternates(oc, mt, entry, ck, function(altEntry) {
            gEntry.markets.push(altEntry);
          });
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

// Owls HTTP GET with status — used by Bookmaker v2 (golf/rugby) so we can
// distinguish 401/403 (no access), 404 (unsupported), and empty-but-ok.
function _owlsHttpGetJson(pathAndQuery) {
  if (!OWLS_KEY) {
    return Promise.resolve({ ok:false, status:0, error:'owls_insight_not_configured' });
  }
  var url = OWLS_BASE_URL + pathAndQuery;
  return new Promise(function(resolve) {
    var parsed;
    try { parsed = new URL(url); } catch(_e) {
      return resolve({ ok:false, status:0, error:'invalid_url', url:pathAndQuery });
    }
    var reqPath = parsed.pathname + parsed.search;
    var driver = parsed.protocol === 'https:' ? https : require('http');
    var chunks = [];
    var req = driver.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: reqPath, method: 'GET',
      headers: {
        Authorization: 'Bearer ' + OWLS_KEY,
        Accept: 'application/json',
        'User-Agent': 'PocketBooksSports/2.0'
      }
    }, function(res) {
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString('utf8');
        var preview = body.slice(0, 160).replace(/\s+/g, ' ');
        if (res.statusCode === 401 || res.statusCode === 403) {
          return resolve({ ok:false, status:res.statusCode, error:'owls_insight_unauthorized', url:reqPath, bodyPreview:preview });
        }
        if (res.statusCode === 429) {
          return resolve({ ok:false, status:429, error:'provider_rate_limited', url:reqPath, bodyPreview:preview });
        }
        if (res.statusCode === 404) {
          return resolve({ ok:false, status:404, error:'owls_insight_not_found', url:reqPath, bodyPreview:preview });
        }
        if (res.statusCode >= 500) {
          return resolve({ ok:false, status:res.statusCode, error:'owls_insight_server_error', url:reqPath, bodyPreview:preview });
        }
        if (res.statusCode !== 200) {
          return resolve({ ok:false, status:res.statusCode, error:'owls_insight_http_error', url:reqPath, bodyPreview:preview });
        }
        try {
          resolve({ ok:true, status:200, data: JSON.parse(body), url:reqPath });
        } catch(e) {
          resolve({ ok:false, status:200, error:'json_parse_error', detail:e.message, url:reqPath, bodyPreview:preview });
        }
      });
    });
    req.setTimeout(15000, function() {
      req.destroy();
      resolve({ ok:false, status:0, error:'timeout', url:reqPath });
    });
    req.on('error', function(e) {
      resolve({ ok:false, status:0, error:e.message, url:reqPath });
    });
    req.end();
  });
}

function _stampBookmakerMarketEntry(entry, game) {
  if (!entry || !game) return;
  var ck = game.canonicalKey || entry.canonicalKey || null;
  entry.canonicalMarketKey = _buildCanonicalMarketKey({
    canonicalGameKey: ck,
    marketType: entry.marketType,
    propType: entry.propType,
    team: entry.teamOrSide
  });
  entry.canonicalSelectionKey = _buildCanonicalSelectionKey({
    marketType: entry.marketType,
    team: entry.teamOrSide,
    player: entry.playerName,
    side: entry.overUnder || entry.teamOrSide,
    line: entry.line
  });
}

/**
 * Golf + Rugby + NASCAR: poll Owls Bookmaker.eu Source API v2.
 * Discovers leagues dynamically — never hardcodes a single competition.
 * NASCAR lobby key filters Bookmaker `motorsport` leagues to nascar-*.
 * Empty boards → ok + games:[] (not 404). Auth/tier failures → !ok.
 */
async function fetchOddsFromOwlsBookmakerV2(sportKey) {
  var lobbySport = String(sportKey || '').toLowerCase();
  var bmSport = owlsBookmakerAdapter.bookmakerSportSlug(lobbySport);
  if (!bmSport) {
    return { ok:false, error:'unsupported_bookmaker_sport:' + sportKey };
  }
  if (!OWLS_KEY) {
    return { ok:false, error:'owls_insight_not_configured' };
  }

  var leaguesPath = '/api/v2/bookmaker/' + bmSport + '/leagues';
  var leaguesRes = await _owlsHttpGetJson(leaguesPath);
  if (!leaguesRes.ok) {
    console.warn('[owls-bookmaker] leagues failed sport=' + bmSport +
      ' lobby=' + lobbySport +
      ' status=' + (leaguesRes.status || '?') +
      ' error=' + (leaguesRes.error || 'unknown') +
      ' url=' + (leaguesRes.url || leaguesPath));
    return {
      ok: false,
      error: leaguesRes.error || 'bookmaker_leagues_failed',
      status: leaguesRes.status,
      url: leaguesRes.url || leaguesPath,
      source: 'bookmaker-v2'
    };
  }

  var leagueList = owlsBookmakerAdapter.filterLeaguesForLobbySport(
    lobbySport,
    owlsBookmakerAdapter.extractLeagueKeys(leaguesRes.data)
  );
  console.log('[owls-bookmaker] leagues sport=' + bmSport +
    ' lobby=' + lobbySport +
    ' count=' + leagueList.length +
    ' keys=' + JSON.stringify(leagueList.map(function(l){ return l.leagueKey; }).slice(0, 12)));

  if (!leagueList.length) {
    return owlsBookmakerAdapter.buildBookmakerFetchResult([], {
      warnings: ['no_leagues'],
      meta: { sport: lobbySport, bookmakerSport: bmSport, leagueCount: 0, source: 'bookmaker-v2' },
      stampMarket: _stampBookmakerMarketEntry
    });
  }

  var allGames = [];
  var warnings = [];
  var leagueErrors = [];
  var nowMs = Date.now();

  // Sequential per-league fetches keep us polite on Bookmaker's slower cycle.
  for (var i = 0; i < leagueList.length; i++) {
    var league = leagueList[i];
    var mktPath = '/api/v2/bookmaker/' + bmSport +
      '?league=' + encodeURIComponent(league.leagueKey);
    var mktRes = await _owlsHttpGetJson(mktPath);
    if (!mktRes.ok) {
      leagueErrors.push(league.leagueKey + ':' + (mktRes.error || mktRes.status || 'err'));
      warnings.push('league_fetch_failed:' + league.leagueKey);
      continue;
    }
    var normalized = owlsBookmakerAdapter.normalizeBookmakerLeaguePayload(mktRes.data, {
      // Stamp games with the lobby short key (nascar), not the Bookmaker group.
      sportKey: lobbySport,
      leagueKey: league.leagueKey,
      leagueName: league.leagueName || league.leagueKey,
      nowMs: nowMs
    });
    (normalized.games || []).forEach(function(g) { allGames.push(g); });
    (normalized.warnings || []).forEach(function(w) { warnings.push(w); });
  }

  var result = owlsBookmakerAdapter.buildBookmakerFetchResult(allGames, {
    warnings: warnings,
    meta: {
      sport: lobbySport,
      bookmakerSport: bmSport,
      leagueCount: leagueList.length,
      leagueErrors: leagueErrors.length ? leagueErrors : undefined,
      source: 'bookmaker-v2'
    },
    stampMarket: _stampBookmakerMarketEntry
  });

  var mktCount = 0;
  result.games.forEach(function(g) { mktCount += (g.markets || []).length; });
  console.log('[owls-bookmaker] fetch ok sport=' + lobbySport +
    ' bookmaker=' + bmSport +
    ' leagues=' + leagueList.length +
    ' games=' + result.games.length +
    ' markets=' + mktCount +
    ' sourceStatus=' + result.sourceStatus +
    (leagueErrors.length ? ' leagueErrors=' + JSON.stringify(leagueErrors.slice(0, 5)) : ''));

  return result;
}

async function fetchOddsFromOwlsInsight(sportKey) {
  if (!OWLS_KEY) {
    console.warn('[owls] OWLS_INSIGHT_API_KEY not set');
    return { ok:false, error:'owls_insight_not_configured' };
  }
  var owlsSport = _mapToOwlsSport(sportKey);
  if (!owlsSport) return { ok:false, error:'unsupported_sport:'+sportKey };

  // Golf + Rugby + NASCAR are NOT on the unified v1 odds endpoint (confirmed 404).
  // Route only these sports through Bookmaker v2. NFL/MLB/etc stay on v1.
  if (owlsBookmakerAdapter.isBookmakerV2Sport(owlsSport)) {
    return fetchOddsFromOwlsBookmakerV2(owlsSport);
  }

  var booksCsv = _owlsBooksForSport(sportKey);
  var url = OWLS_BASE_URL+'/api/v1/'+owlsSport+'/odds?books='+encodeURIComponent(booksCsv)+'&alternates='+OWLS_ALTERNATES;
  return new Promise(function(resolve){
    var parsed; try { parsed = new URL(url); } catch(_){
      console.warn('[owls-rest] fetch invalid url sport='+sportKey+' url='+parsedPathForLog(url));
      return resolve({ok:false,error:'invalid_url'});
    }
    var reqPath = parsed.pathname+parsed.search;
    var driver = parsed.protocol==='https:' ? https : require('http');
    var chunks = [];
    var req = driver.request({
      hostname:parsed.hostname, port:parsed.port||(parsed.protocol==='https:'?443:80),
      path:reqPath, method:'GET',
      headers:{ 'Authorization':'Bearer '+OWLS_KEY, 'Accept':'application/json' }
    }, function(res){
      res.on('data',function(c){chunks.push(c);});
      res.on('end',function(){
        var body = Buffer.concat(chunks).toString('utf8');
        var bodyPreview = body.slice(0, 160).replace(/\s+/g, ' ');
        if (res.statusCode===401||res.statusCode===403) {
          console.warn('[owls-rest] fetch unauthorized sport='+sportKey+' status='+res.statusCode+
            ' url='+reqPath+' body='+bodyPreview);
          return resolve({ok:false,error:'owls_insight_unauthorized',status:res.statusCode,url:reqPath});
        }
        if (res.statusCode===429) {
          console.warn('[owls-rest] fetch rate-limited sport='+sportKey+' status=429 url='+reqPath);
          return resolve({ok:false,error:'provider_rate_limited',status:429,url:reqPath});
        }
        if (res.statusCode>=500) {
          console.warn('[owls-rest] fetch server error sport='+sportKey+' status='+res.statusCode+
            ' url='+reqPath+' body='+bodyPreview);
          return resolve({ok:false,error:'owls_insight_server_error',status:res.statusCode,url:reqPath});
        }
        if (res.statusCode!==200) {
          console.warn('[owls-rest] fetch http error sport='+sportKey+' status='+res.statusCode+
            ' url='+reqPath+' body='+bodyPreview);
          return resolve({ok:false,error:'owls_insight_http_error',status:res.statusCode,url:reqPath});
        }
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
          var normalized = _normalizeOwlsResponse(data, sportKey) || {ok:false,error:'normalize_failed',url:reqPath};
          if (normalized.ok) {
            var gameCount = Array.isArray(normalized.games) ? normalized.games.length : 0;
            console.log('[owls-rest] fetch ok sport='+sportKey+' status=200 url='+reqPath+' games='+gameCount);
          } else {
            console.warn('[owls-rest] fetch normalize failed sport='+sportKey+' status=200 url='+reqPath+
              ' error='+(normalized.error||'unknown')+' body='+bodyPreview);
          }
          resolve(normalized);
        } catch(_e) {
          console.warn('[owls-rest] fetch json parse error sport='+sportKey+' url='+reqPath+
            ' detail='+_e.message+' body='+bodyPreview);
          resolve({ok:false,error:'json_parse_error',detail:_e.message,url:reqPath});
        }
      });
    });
    req.setTimeout(10000,function(){
      console.warn('[owls-rest] fetch timeout sport='+sportKey+' url='+reqPath);
      req.destroy();
      resolve({ok:false,error:'timeout',url:reqPath});
    });
    req.on('error',function(e){
      console.warn('[owls-rest] fetch network error sport='+sportKey+' url='+reqPath+' detail='+e.message);
      resolve({ok:false,error:e.message,url:reqPath});
    });
    req.end();
  });
}

function parsedPathForLog(url) {
  try {
    var u = new URL(url);
    return u.pathname + u.search;
  } catch(_e) {
    return String(url || '').replace(/\/\/[^/]+/, '//***');
  }
}
// ────────────────────────────────────────────────────────────────────────────

function fetchOdds(sport) {
  return new Promise((resolve) => {
    if (!ODDS_KEY) { console.error('[ODDS] ODDS_API_KEY is not set — set it in Railway environment variables'); return resolve(null); }
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=us&markets=spreads,totals,h2h&oddsFormat=american&bookmakers=draftkings`;
    const req = https.get(url, (res) => {
      let d = '';
      if (res.statusCode && res.statusCode >= 400) {
        console.error('[ODDS] HTTP '+res.statusCode+' sport='+sport);
      }
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          // Odds API returns an error object (not array) on quota/auth errors
          if (parsed && parsed.error_code) {
            console.error('[ODDS] API error sport='+sport+':', parsed.error_code, parsed.message);
            resolve({ _error: parsed.error_code, _message: parsed.message });
          } else if (!Array.isArray(parsed)) {
            console.error('[ODDS] unexpected non-array body sport='+sport+' http='+res.statusCode);
            resolve({ _error: 'unexpected_body', _message: 'non_array_response' });
          } else {
            resolve(parsed);
          }
        } catch(e) { console.error('[ODDS] parse error sport='+sport+':', e.message); resolve({ _error: 'parse_error', _message: e.message }); }
      });
    });
    req.on('error', e => { console.error('[ODDS] fetch error sport='+sport+':', e.message); resolve({ _error: 'network_error', _message: e.message }); });
    req.setTimeout(8000, () => { req.destroy(); resolve({ _error: 'timeout', _message: 'request_timeout' }); });
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

// club_memberships.role uses host/admin/cohost/staff; JWT + session rows
// store those strings. Permission checks only understand ROLE_RANK keys.
// Without this map, role "host" becomes view_only, session_claim_mismatch
// fires, and /api/host/dashboard never builds the players list.
const AUTH_ROLE_ALIASES = {
  host: 'full_admin',
  admin: 'full_admin',
  owner: 'owner',
  cohost: 'settlement_manager',
  staff: 'risk_viewer',
  user: 'player',
  player: 'player',
  full_admin: 'full_admin',
  settlement_manager: 'settlement_manager',
  risk_viewer: 'risk_viewer',
  view_only: 'view_only'
};
function _normalizeAuthRole(role) {
  var raw = String(role || '').toLowerCase().trim();
  var mapped = AUTH_ROLE_ALIASES[raw] || raw;
  return ROLE_RANK[mapped] != null ? mapped : 'view_only';
}

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

function _getRoleRank(role) { return ROLE_RANK[_normalizeAuthRole(role)] != null ? ROLE_RANK[_normalizeAuthRole(role)] : -99; }

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
function _membershipStatusActive(status) {
  const s = String(status || '').toLowerCase();
  return s === 'active' || s === 'approved';
}

async function _resolveTokenRole(actorId, clubId, requestedRole) {
  if (!actorId) return { error:'missing_actorId' };
  if (!clubId)  return { error:'missing_clubId' };
  const m = await _membershipLoad(actorId, clubId);
  if (IS_PRODUCTION) {
    if (!m)                     return { error:'membership_not_found' };
    if (!_membershipStatusActive(m.status))  return { error:'membership_inactive', status:m.status };
    // platform_admin only from server allowlist
    if (requestedRole === 'platform_admin' && !PLATFORM_ADMIN_ALLOWLIST.includes(actorId))
      return { error:'cannot_self_issue_elevated_role' };
    return { ok:true, role:m.role, membership:m };
  }
  // Dev: DB wins if available, else use requested or default
  if (m && _membershipStatusActive(m.status)) return { ok:true, role:m.role, membership:m };
  const role = ROLE_RANK[requestedRole] != null ? requestedRole : 'player';
  return { ok:true, role, membership:null };
}

// Re-check membership freshness at request time (called from requireActor)
async function _checkMembershipFreshness(actorId, clubId, tokenRole) {
  if (!actorId || !clubId) return { ok:true }; // dev-bypass actors skip
  const m = await _membershipLoad(actorId, clubId);
  if (!m)                     return { ok:false, reason:'membership_not_found' };
  if (!_membershipStatusActive(m.status))  return { ok:false, reason:'membership_inactive', status:m.status };
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
    const role    = _normalizeAuthRole(p.role);
    const club    = p.clubId || p.club_id || '';
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
        if (_normalizeAuthRole(memSession.role) !== role || String(memSession.club_id||'') !== String(club||'')) {
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
        if (!_membershipStatusActive(m.status)) {
          _writeAuthAudit('membership_inactive', p.sub, club, req.path, { status:m.status, jti });
          return { error:'membership_inactive', status:401, auditEvent:'membership_inactive' };
        }
        if (_normalizeAuthRole(m.role) !== _normalizeAuthRole(role) && m.role !== role) {
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
  'BET_GRADED_PUSH','SETTLEMENT_APPLIED','WEEKLY_ROLLOVER','BALANCE_ADJUSTMENT',
  'PARLAY_INSURANCE_REFUND','CASHOUT_SETTLEMENT'
]);
const LEDGER_DEBIT_EVENTS  = new Set(['BET_PLACED','SETTLEMENT_APPLIED']);
const LEDGER_CREDIT_EVENTS = new Set(['BET_CANCELED_REFUND','BET_GRADED_WIN','BET_GRADED_PUSH','BALANCE_ADJUSTMENT','PARLAY_INSURANCE_REFUND','CASHOUT_SETTLEMENT']);

function _ledgerDirection(eventType) {
  if (LEDGER_DEBIT_EVENTS.has(eventType))  return 'debit';
  if (LEDGER_CREDIT_EVENTS.has(eventType)) return 'credit';
  return 'neutral';
}

function _ledgerId(eventType) {
  return 'LE_'+eventType.slice(0,4)+'_'+Date.now()+'_'+_crypto.randomBytes(4).toString('hex');
}

// Derive ledger balance from rows (canonical `ledger` table: credit/debit directions)
function _deriveLedgerBalance(startingLimit, rows) {
  let bal = parseFloat(startingLimit)||0;
  (rows||[]).forEach(function(r) {
    const amt = parseFloat(r.amount||r.amount_cents/100||0);
    if (r.direction==='credit') bal+=amt;
    else if (r.direction==='debit') bal-=amt;
  });
  return Math.round(bal*100)/100;
}

// Derive available balance from mirror `ledger_entries` (signed amounts + balance_after).
// Risk is debited at bet_placed, so the latest balance_after IS available (includes open risk).
function _deriveBalanceFromLedgerEntries(startingBalance, entries) {
  const rows = (entries||[]).slice().sort(function(a,b){
    return new Date(a.created_at||0).getTime() - new Date(b.created_at||0).getTime();
  });
  if (!rows.length) {
    return startingBalance != null && !isNaN(parseFloat(startingBalance))
      ? Math.round(parseFloat(startingBalance)*100)/100
      : null;
  }
  const last = rows[rows.length-1];
  if (last && last.balance_after != null && !isNaN(parseFloat(last.balance_after))) {
    return Math.round(parseFloat(last.balance_after)*100)/100;
  }
  let bal = parseFloat(startingBalance)||0;
  rows.forEach(function(r){ bal += parseFloat(r.amount)||0; });
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

// Credit a player's available balance via ledger + ledger_entries mirror.
// Used for parlay insurance refunds and host cash-out settlements.
async function _creditPlayerAccount(opts) {
  const sb = getSupabase();
  if (!sb) return { ok:false, error:'supabase_not_configured' };
  const amt = Math.round((parseFloat(opts.amount)||0)*100)/100;
  if (!(amt > 0)) return { ok:false, error:'invalid_amount' };
  const clubId = opts.clubId || '';
  const playerId = opts.playerId || '';
  const eventType = opts.eventType;
  const leType = opts.ledgerEntriesType || eventType;
  const iKey = opts.idempotencyKey || ('CR_'+eventType+'_'+Date.now());
  let startBal = 0;
  try {
    const { data: mem } = await sb.from('club_members').select('balance_start')
      .eq('club_id', clubId).eq('player_id', playerId).limit(1);
    if (mem && mem[0] && mem[0].balance_start != null) startBal = parseFloat(mem[0].balance_start)||0;
  } catch(_e) {}
  let before = startBal;
  try {
    var lq = sb.from('ledger_entries').select('amount,balance_after,created_at')
      .eq('player_id', playerId).order('created_at', { ascending:true });
    if (clubId) lq = lq.eq('club_id', clubId);
    const { data: ledRows } = await lq;
    if (ledRows && ledRows.length)
      before = _deriveBalanceFromLedgerEntries(startBal, ledRows);
  } catch(_e) {}
  const after = Math.round((before + amt)*100)/100;
  try {
    await sb.from('ledger_entries').upsert({
      id: iKey, club_id: clubId||null, player_id: playerId,
      ticket_id: opts.ticketId||null, type: leType, amount: amt,
      balance_before: before, balance_after: after,
      reason: opts.reason || eventType,
      created_at: new Date().toISOString(),
      created_by: opts.createdBy || 'system'
    }, { onConflict:'id' });
  } catch(e) {
    if (e && e.code !== '23505') console.warn('[credit] ledger_entries:', e.message);
  }
  try {
    await _writeLedgerEntry({
      clubId: clubId, playerId: playerId, ticketId: opts.ticketId,
      eventType: eventType, amount: amt,
      balanceBefore: before, balanceAfter: after,
      idempotencyKey: iKey, createdBy: opts.createdBy || 'system',
      reason: opts.reason || eventType, metadataJson: opts.metadataJson || null
    });
  } catch(e) {
    if (!(e && (e.code === '23505' || String(e.message||'').indexOf('invalid_eventType')>=0)))
      console.warn('[credit] ledger:', e.message);
  }
  return { ok:true, balanceBefore: before, balanceAfter: after, ledgerEntryId: iKey };
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

function _envMs(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const LIVE_SNAPSHOT_TTL_MS    = _envMs('LIVE_SNAPSHOT_TTL_MS',    10 * 1000);
const PREGAME_SNAPSHOT_TTL_MS = _envMs('PREGAME_SNAPSHOT_TTL_MS', 120 * 1000);
const SNAPSHOT_TTL_MS         = PREGAME_SNAPSHOT_TTL_MS; // backwards-compat alias
const CACHE_STALE_RECOVERY_MS = _envMs('CACHE_STALE_RECOVERY_MS', 5 * 60 * 1000);
const SNAPSHOT_UPSERT_BATCH_SIZE = Math.max(50, parseInt(process.env.SNAPSHOT_UPSERT_BATCH_SIZE || '200', 10) || 200);
// SNAPSHOT_TOLERANCE removed — RISK-9: exact-match odds required; no drift window allowed.

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
  if (k === 'moneyline' || k === 'h2h' || k === 'to win' || k === 'win') return MARKET_TYPES.MONEYLINE;
  if (k === 'spread'    || k === 'spreads'
   || k === 'run_line'  || k === 'runline'  || k === 'run line'
   || k === 'puck_line' || k === 'puckline' || k === 'puck line'
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
    // Strip lobby suffixes before slugifying — otherwise
    // "Miami Marlins To Win" becomes "miami_marlins_to_win" and misses
    // the DB key "miami_marlins".
    const team = _stripToWinSuffix(input.team || input.teamOrSide || input.selection || '');
    return _normalizePlayerName(team);
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

  // For team markets (spread/run-line) the frontend embeds the point spread
  // directly in leg.pick: "Toronto Blue Jays +1.5". Separate the team name
  // and extract the line so _buildCanonicalSelectionKey can produce a valid
  // spread key ("team_slug:1.5"). Without this, leg.line is null and the
  // canonical key is null → Tier 1 is skipped entirely.
  let _teamForKey = _stripToWinSuffix(leg.team || leg.teamOrSide || '');
  if (!_teamForKey) _teamForKey = null;
  let _lineForKey = line;
  if (isTeamMarket && !_teamForKey && leg.pick) {
    const _pickClean = _stripToWinSuffix(leg.pick);
    const _m = _pickClean.match(/^(.*?)\s+([+-]?\d+\.?\d*)\s*$/);
    if (_m) {
      _teamForKey = _m[1].trim();
      if (_lineForKey == null) _lineForKey = parseFloat(_m[2]);
    } else {
      // Lobby moneyline labels are "Colorado Rockies To Win" — strip the suffix
      // so the canonical key matches DB selection_key "colorado rockies".
      _teamForKey = _pickClean;
    }
  }
  // Totals: lobby pick is "Over 9" / "Under 8.5" and often omits leg.line.
  // Parse side + numeric line so canonical_selection_key is "over:9" not null.
  let _sideForKey = side;
  if (isSideMarket && leg.pick) {
    const _ou = String(leg.pick).match(/\b(over|under)\b(?:\s+([+-]?\d+(?:\.\d+)?))?/i);
    if (_ou) {
      if (!_sideForKey) _sideForKey = _ou[1];
      if (_lineForKey == null && _ou[2] != null) _lineForKey = parseFloat(_ou[2]);
    }
  }

  const canonicalSelectionKey = _buildCanonicalSelectionKey({
    marketType,
    team:   _teamForKey || (isTeamMarket ? _stripToWinSuffix(leg.pick) : null),
    player: playerName,
    side:   _sideForKey || (isSideMarket ? leg.pick : null),
    line:   _lineForKey,
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
  let legacySelectionKey, legacyMarketKey, rawOdds, oddsAmerican, line;
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
    rawOdds         = entry.odds;
    line            = entry.line != null ? entry.line : null;
  } else {
    legacySelectionKey = String(outcome.name || '').toLowerCase();
    legacyMarketKey    = String(entry.market || '').toLowerCase();
    rawOdds            = outcome.price;
    line               = outcome.point != null ? outcome.point : null;
  }

  const rawOddsNum = Number(rawOdds);
  if (!Number.isFinite(rawOddsNum)) {
    _logInvalidSnapshotOdds(entry, outcome, provider, 'non_finite_american_odds', rawOdds);
    return null;
  }

  oddsAmerican = Math.round(_toAmericanOdds(rawOddsNum));
  if (!Number.isFinite(oddsAmerican) || oddsAmerican === 0) {
    _logInvalidSnapshotOdds(entry, outcome, provider, 'invalid_american_odds', rawOdds);
    return null;
  }

  const oddsDecimal = _americanToDecimalOdds(oddsAmerican);
  if (!Number.isFinite(oddsDecimal) || oddsDecimal <= 1) {
    _logInvalidSnapshotOdds(entry, outcome, provider, 'invalid_decimal_odds', oddsAmerican);
    return null;
  }

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

function _getLiveCacheAgeMs() {
  const cache = typeof LIVE_MARKET_CACHE !== 'undefined' ? LIVE_MARKET_CACHE : null;
  if (!cache || !cache.updatedAt) return Infinity;
  return Date.now() - new Date(cache.updatedAt).getTime();
}

// When DB snapshots are stale/missing but the in-memory poll cache is fresh,
// derive a snapshot-shaped object for placement verification (fail-closed on
// stale cache — never falls back to client odds).
function _lookupSnapshotFromLiveCache(cKey, marketForLookup, pickForLookup) {
  const cache = typeof LIVE_MARKET_CACHE !== 'undefined' ? LIVE_MARKET_CACHE : null;
  if (!cache || !cache.updatedAt || !cache.gameCount) return null;
  const cacheAgeMs = _getLiveCacheAgeMs();
  if (!Number.isFinite(cacheAgeMs) || cacheAgeMs > PREGAME_SNAPSHOT_TTL_MS) return null;

  const pickNorm = _normalizePickForSnapshotLookup(pickForLookup);
  const marketNorm = (marketForLookup || 'moneyline').toLowerCase();
  const mapKey = cKey + '|' + marketNorm;
  const byKey = cache.marketsByCanonicalKey || {};

  function snapFromEntry(entry, outcome) {
    if (!entry) return null;
    const isOwls = !!entry.marketType;
    let legacySelectionKey, rawOdds;
    if (isOwls) {
      if (entry.marketType === 'player_prop' && entry.playerName) {
        const side = (entry.overUnder || '').toLowerCase();
        const ln   = entry.line != null ? entry.line : '';
        legacySelectionKey = `${entry.playerName} ${side} ${ln}`.trim().toLowerCase();
      } else {
        legacySelectionKey = String(entry.teamOrSide || '').toLowerCase();
      }
      if (String(entry.marketType || '').toLowerCase() !== marketNorm) return null;
      rawOdds = entry.odds;
    } else if (outcome) {
      legacySelectionKey = String(outcome.name || '').toLowerCase();
      rawOdds = outcome.price;
    } else {
      return null;
    }
    if (_normalizePickForSnapshotLookup(legacySelectionKey) !== pickNorm) return null;
    const oddsAmerican = Math.round(_toAmericanOdds(Number(rawOdds)));
    if (!Number.isFinite(oddsAmerican) || oddsAmerican === 0) return null;
    const oddsDecimal = _americanToDecimalOdds(oddsAmerican);
    const pointLine = isOwls
      ? (entry.line != null ? entry.line : null)
      : (outcome && outcome.point != null ? outcome.point : null);
    return {
      odds_american: oddsAmerican,
      odds_decimal: oddsDecimal,
      point_line: pointLine,
      canonical_game_key: entry.canonicalKey || entry.cKey || cKey,
      market_key: marketNorm,
      selection_key: pickNorm,
      fetched_at: cache.updatedAt,
      commence_time: entry.commenceTime || null,
      event_status: entry.gameStatus || null,
      market_status: entry.marketStatus || null,
      suspended: !!entry.suspended,
      event_completed: !!entry.eventCompleted,
      event_canceled: !!entry.eventCanceled,
      event_live: !!entry.eventLive,
      _source: 'live_cache'
    };
  }

  // Bookmaker-style cache entry (Odds API path)
  const direct = byKey[mapKey];
  if (direct && !Array.isArray(direct) && Array.isArray(direct.outcomes)) {
    for (const o of direct.outcomes) {
      const s = snapFromEntry(direct, o);
      if (s) return s;
    }
  }

  // Owls overlay: array of per-outcome entries keyed by canonical game key
  const owlsList = byKey[cKey];
  if (Array.isArray(owlsList)) {
    for (const entry of owlsList) {
      const s = snapFromEntry(entry, null);
      if (s) return s;
    }
  }

  // Prefix fallback: cache is dated (sport|Away|Home|YYYY-MM-DD) while the
  // searched key may still be empty-dated or a short/hyphenated sibling.
  const prefix = _gameKeyPrefixWithoutDate(cKey);
  if (prefix) {
    const today = new Date().toISOString().slice(0, 10);
    const keys = Object.keys(byKey).filter(function(k) {
      return k === cKey || k.indexOf(prefix) === 0 ||
        _gameKeyPrefixWithoutDate(k) === prefix;
    });
    keys.sort(function(a, b) {
      const da = String(a).split('|').pop() || '';
      const db = String(b).split('|').pop() || '';
      if (da === today && db !== today) return -1;
      if (db === today && da !== today) return 1;
      return db.localeCompare(da);
    });
    for (let i = 0; i < keys.length; i++) {
      const list = byKey[keys[i]];
      if (Array.isArray(list)) {
        for (const entry of list) {
          const s = snapFromEntry(entry, null);
          if (s) return s;
        }
      } else if (list && Array.isArray(list.outcomes)) {
        for (const o of list.outcomes) {
          const s = snapFromEntry(list, o);
          if (s) return s;
        }
      }
    }
  }

  return null;
}

async function _upsertSnapshotRowsChunked(sb, rows) {
  if (!rows || !rows.length) {
    console.log('SNAPSHOT_UPSERT_SKIP reason=empty_batch');
    return { ok:true, rowsUpserted:0 };
  }
  let rowsUpserted = 0;
  const batchCount = Math.ceil(rows.length / SNAPSHOT_UPSERT_BATCH_SIZE);
  console.log('SNAPSHOT_UPSERT_WRITE rows='+rows.length+' batches='+batchCount+' batchSize='+SNAPSHOT_UPSERT_BATCH_SIZE);
  for (let i = 0; i < rows.length; i += SNAPSHOT_UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + SNAPSHOT_UPSERT_BATCH_SIZE);
    const batchIndex = Math.floor(i / SNAPSHOT_UPSERT_BATCH_SIZE) + 1;
    try {
      const { error: upsertErr } = await sb.from('odds_snapshots').upsert(batch,
        { onConflict:'canonical_game_key,market_key,selection_key' });
      if (upsertErr) throw upsertErr;
      rowsUpserted += batch.length;
      console.log('SNAPSHOT_UPSERT_BATCH_OK batch='+batchIndex+'/'+batchCount+' rows='+batch.length+' total='+rowsUpserted);
    } catch(e) {
      const msg = (e && e.message) || '';
      const code = (e && (e.code||e.statusCode)) || '?';
      if (/canonical_market_key|canonical_selection_key|market_type|player_name|prop_type|prop_side|player_team|provider_game_id/.test(msg)) {
        console.warn('SNAPSHOT_UPSERT_FALLBACK reason=optional_columns_missing code='+code+' msg='+JSON.stringify(msg.slice(0,200)));
        const legacyRows = batch.map(function(r) {
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
        const { error: legacyErr } = await sb.from('odds_snapshots').upsert(legacyRows,
          { onConflict:'canonical_game_key,market_key,selection_key' });
        if (legacyErr) {
          console.error(_fmtSnapshotErr('SNAPSHOT_UPSERT_FAIL legacy', legacyErr, legacyRows));
          return { ok:false, error:legacyErr.message, code:legacyErr.code||'?', rowsUpserted };
        }
        rowsUpserted += legacyRows.length;
        console.log('SNAPSHOT_UPSERT_BATCH_OK batch='+batchIndex+'/'+batchCount+' rows='+legacyRows.length+' total='+rowsUpserted+' via=legacy');
        continue;
      }
      console.error(_fmtSnapshotErr('SNAPSHOT_UPSERT_FAIL primary', e, batch));
      return { ok:false, error:msg || String(e), code:code, rowsUpserted };
    }
  }
  return { ok:true, rowsUpserted };
}

async function _upsertOddsSnapshots() {
  const sb  = getSupabase();
  const now = new Date().toISOString();
  const exp = new Date(Date.now()+SNAPSHOT_TTL_MS).toISOString();
  const cache = LIVE_MARKET_CACHE;
  const cacheKeysPreview = Object.keys((cache && cache.marketsByCanonicalKey) || {});
  console.log('SNAPSHOT_UPSERT_BEGIN games='+(cache && cache.gameCount || 0)+
    ' markets='+(cache && cache.marketCount || 0)+
    ' keys='+cacheKeysPreview.length+
    ' hasSb='+(!!sb)+
    ' provider='+(ODDS_PROVIDER||'unknown'));
  if (!sb) {
    console.log('SNAPSHOT_UPSERT_SKIP reason=no_supabase games='+(cache && cache.gameCount || 0));
    return { ok:false, reason:'no_supabase', rowsUpserted:0 };
  }
  if (!cache.gameCount) {
    console.log('SNAPSHOT_UPSERT_SKIP reason=no_games_in_cache hasSb=true');
    return { ok:false, reason:'no_games_in_cache', rowsUpserted:0 };
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
  console.log('SNAPSHOT_ITERATION_BEGIN provider='+provider+' games='+cache.gameCount+' keys='+cacheKeys.length+' cacheMarketCount='+cache.marketCount);

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
    console.log('SNAPSHOT_UPSERT_SKIP reason=no_rows_after_iteration provider='+provider+
      ' games='+cache.gameCount+
      ' cacheMarketCount='+cache.marketCount+
      ' seenEntries='+seenEntries+
      ' skipReasons='+JSON.stringify(skipReasons)+
      ' sampleSkips='+JSON.stringify(sampleSkips));
    return { ok:false, reason:'no_rows', rowsUpserted:0 };
  }

  console.log('SNAPSHOT_UPSERT_READY provider='+provider+' games='+cache.gameCount+
    ' rows='+rows.length+
    ' seenEntries='+seenEntries+
    ' skipReasons='+JSON.stringify(skipReasons));
  await _logSnapshotSchemaOnce(sb, rows[0]);
  const result = await _upsertSnapshotRowsChunked(sb, rows);
  if (result.ok) {
    console.log('SNAPSHOT_UPSERT_OK rows='+result.rowsUpserted+' games='+cache.gameCount+' batchSize='+SNAPSHOT_UPSERT_BATCH_SIZE);
  } else {
    console.error('SNAPSHOT_UPSERT_FAIL rowsPartial='+result.rowsUpserted+
      ' code='+(result.code||'?')+
      ' message='+JSON.stringify(String(result.error||'').slice(0,300)));
  }
  return result;
}

// Expand short/legacy sport prefixes on a canonical game key so lobby keys
// like "mlb|Miami Marlins|..." match Owls snapshots "baseball_mlb|Miami Marlins|...".
function _expandSportPrefixOnGameKey(cKey) {
  if (!cKey) return cKey;
  const parts = String(cKey).split('|');
  if (!parts[0]) return cKey;
  const raw = parts[0].toLowerCase();
  const map = (typeof _CACHE_SPORT_KEY_BY_SHORT !== 'undefined' && _CACHE_SPORT_KEY_BY_SHORT) || {};
  const expanded = map[raw] || raw;
  if (expanded === parts[0]) return String(cKey);
  parts[0] = expanded;
  return parts.join('|');
}

// Convert hyphenated team slugs to Owls display names:
//   "colorado-rockies" → "Colorado Rockies"
function _unhyphenateGameKeyTeams(cKey) {
  if (!cKey) return cKey;
  const parts = String(cKey).split('|');
  if (parts.length < 3) return String(cKey);
  function titleCaseWords(s) {
    return String(s || '').replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }
  parts[1] = titleCaseWords(parts[1]);
  parts[2] = titleCaseWords(parts[2]);
  return parts.join('|');
}

// Title-case / spaced team names → hyphen slugs:
//   "Boston Red Sox" → "boston-red-sox"
function _hyphenateGameKeyTeams(cKey) {
  if (!cKey) return cKey;
  const parts = String(cKey).split('|');
  if (parts.length < 3) return String(cKey);
  function slug(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '-');
  }
  parts[1] = slug(parts[1]);
  parts[2] = slug(parts[2]);
  return parts.join('|');
}

// baseball_mlb|... → MLB|... so ticket Owls keys match legacy slug snapshots.
function _collapseSportPrefixOnGameKey(cKey) {
  if (!cKey) return cKey;
  const parts = String(cKey).split('|');
  if (!parts[0]) return cKey;
  const collapsed = (typeof _sportPrefix === 'function') ? _sportPrefix(parts[0]) : parts[0];
  if (!collapsed || collapsed === parts[0]) return String(cKey);
  parts[0] = collapsed;
  return parts.join('|');
}

function _gameKeyLookupCandidates(cKey) {
  const seen = {};
  const out = [];
  function add(k) {
    if (!k || seen[k]) return;
    seen[k] = true;
    out.push(k);
  }
  const prefixes = [cKey, _expandSportPrefixOnGameKey(cKey), _collapseSportPrefixOnGameKey(cKey)];
  prefixes.forEach(function(p) {
    add(p);
    add(_unhyphenateGameKeyTeams(p));
    add(_hyphenateGameKeyTeams(p));
  });
  return out;
}

// Lobby / Owls keys sometimes arrive as "sport|Away|Home|" with no date
// while odds_snapshots stores "...|2026-08-30". Fill from scheduledStart
// when it is a real ISO timestamp; display strings like "Sun 7:10 PM"
// do not parse in Node and stay empty.
function _isoDateFromValue(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const ms = new Date(s).getTime();
  if (!isNaN(ms)) return new Date(ms).toISOString().slice(0, 10);
  return '';
}

function _gameKeyNeedsDateFlex(cKey) {
  const parts = String(cKey || '').split('|');
  if (parts.length < 4) return true;
  return !/^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 1] || '');
}

function _fillEmptyGameKeyDate(cKey, dateStr) {
  if (!cKey || !dateStr) return cKey;
  const parts = String(cKey).split('|');
  if (parts.length < 4) return String(cKey);
  if (/^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 1] || '')) return String(cKey);
  parts[parts.length - 1] = dateStr;
  return parts.join('|');
}

function _gameKeyPrefixWithoutDate(cKey) {
  const parts = String(cKey || '').split('|');
  if (parts.length < 3) return '';
  return parts[0] + '|' + parts[1] + '|' + parts[2] + '|';
}

function _pickDateFlexSnapshotRow(rows, today) {
  if (!rows || !rows.length) return null;
  function dateOf(r) {
    const parts = String((r && r.canonical_game_key) || '').split('|');
    return parts[parts.length - 1] || '';
  }
  function isTodayDate(d) {
    return d === today || (today && String(d).indexOf(today) === 0);
  }
  const todayRows = rows.filter(function(r) { return isTodayDate(dateOf(r)); });
  const pool = todayRows.length ? todayRows : rows;
  const keys = [];
  const seen = {};
  pool.forEach(function(r) {
    const k = (r && r.canonical_game_key) || '';
    if (k && !seen[k]) { seen[k] = true; keys.push(k); }
  });
  if (keys.length > 1) {
    if (todayRows.length > 0) return null;
    let latest = '';
    keys.forEach(function(k) {
      const d = String(k).split('|').pop() || '';
      if (d > latest) latest = d;
    });
    const latestKeys = keys.filter(function(k) { return String(k).split('|').pop() === latest; });
    if (latestKeys.length !== 1) return null;
    const latestRows = pool.filter(function(r) { return r.canonical_game_key === latestKeys[0]; });
    latestRows.sort(function(a, b) {
      return new Date(b.fetched_at || 0) - new Date(a.fetched_at || 0);
    });
    return latestRows[0] || null;
  }
  pool.sort(function(a, b) {
    return new Date(b.fetched_at || 0) - new Date(a.fetched_at || 0);
  });
  return pool[0] || null;
}

async function _lookupSnapshotByDateFlexPrefix(sb, cKey, marketForLookup, pickForLookup) {
  const prefixes = [];
  const seen = {};
  _gameKeyLookupCandidates(cKey).forEach(function(k) {
    const p = _gameKeyPrefixWithoutDate(k);
    if (!p || seen[p]) return;
    seen[p] = true;
    prefixes.push(p);
  });
  const today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < prefixes.length; i++) {
    const prefix = prefixes[i];
    const { data, error } = await sb.from('odds_snapshots').select('*')
      .like('canonical_game_key', prefix + '%')
      .eq('market_key', marketForLookup)
      .eq('selection_key', pickForLookup)
      .limit(12);
    if (error) throw error;
    const picked = _pickDateFlexSnapshotRow(data || [], today);
    if (picked) return { snap: picked, prefix: prefix };
  }
  return null;
}

// Strip lobby moneyline suffixes ("To Win", extra spaces) but keep the
// numeric line so totals/spreads can still parse "Over 9" → side+line.
function _stripToWinSuffix(pick) {
  return String(pick || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+to\s+win\s*$/i, '')
    .replace(/\s+ml\s*$/i, '')
    .trim();
}

function _normalizePickForSnapshotLookup(pick) {
  return _stripToWinSuffix(pick)
    .toLowerCase()
    .replace(/\s[+-]?\d+\.?\d*$/, '')
    .trim();
}

function _gameKeySearchHint(cKey) {
  const parts = String(cKey || '').split('|');
  const away = String(parts[1] || '').replace(/-/g, ' ');
  const words = away.split(/\s+/).filter(function(w) { return w.length >= 5; });
  const hint = (words[words.length - 1] || away).replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 40);
  return hint;
}

function _logSnapshotLookupHit(strategy, snap, extra) {
  const foundKey = snap && (snap.canonical_game_key || snap._source || '') || '';
  const foundMkt = snap && (snap.market_key || '') || '';
  const foundSel = snap && (snap.selection_key || '') || '';
  const foundCsk = snap && (snap.canonical_selection_key || '') || '';
  console.log('SNAPSHOT_LOOKUP_HIT strategy=' + strategy
    + ' found=true'
    + ' foundKey=' + foundKey
    + ' foundMarket=' + foundMkt
    + ' foundSelection=' + foundSel
    + ' foundCsk=' + foundCsk
    + (extra ? ' ' + extra : ''));
}

async function _logClosestSnapshotKeys(sb, cKey, marketForLookup, pickForLookup) {
  const hint = _gameKeySearchHint(cKey);
  if (!hint || hint.length < 3) {
    console.log('SNAPSHOT_LOOKUP_MISS found=false closest=skipped reason=no_hint'
      + ' searchedKey=' + JSON.stringify(cKey)
      + ' market=' + JSON.stringify(marketForLookup)
      + ' selection=' + JSON.stringify(pickForLookup));
    return;
  }
  try {
    const { data, error } = await sb.from('odds_snapshots')
      .select('canonical_game_key,market_key,selection_key,canonical_selection_key')
      .ilike('canonical_game_key', '%' + hint + '%')
      .eq('market_key', marketForLookup)
      .limit(6);
    if (error) throw error;
    const compact = (data || []).map(function(r) {
      return (r.canonical_game_key || '') + '>' + (r.market_key || '')
        + '>' + (r.selection_key || '') + '>' + (r.canonical_selection_key || '');
    }).join(';');
    console.log('SNAPSHOT_LOOKUP_MISS found=false'
      + ' searchedKey=' + JSON.stringify(cKey)
      + ' market=' + JSON.stringify(marketForLookup)
      + ' selection=' + JSON.stringify(pickForLookup)
      + ' closestHint=' + hint
      + ' closest=' + (compact || '(none)'));
  } catch (e) {
    console.log('SNAPSHOT_LOOKUP_MISS found=false closest=error'
      + ' searchedKey=' + JSON.stringify(cKey)
      + ' msg=' + String((e && e.message) || e).slice(0, 120));
  }
}

// Phase L: fail-closed odds verification
// Production: any error → odds_service_unavailable (never use client odds)
// Dev+bypass: warn and fall back to client odds
async function _verifyLegOddsSnapshot(sb, leg, nowMs, oddsChangePolicy) {
  nowMs = nowMs||Date.now();
  const rawKeyIn = leg.canonicalGameKey||'';
  const dateFromLeg = _isoDateFromValue(leg.scheduledStart || leg.commenceTime || leg.commence_time || '');
  const rawKey = _fillEmptyGameKeyDate(rawKeyIn, dateFromLeg) || rawKeyIn;
  const keyCandidates = _gameKeyLookupCandidates(rawKey);
  const preferredKey = keyCandidates[keyCandidates.length - 1] || rawKey;
  const cKey   = preferredKey;
  const market = (leg.market||'moneyline').toLowerCase();
  // Normalize display-label market names to the DB-stored keys for Tier 2 lookup.
  // e.g. "to win" → "moneyline", "run line" / "puck line" → "spread"
  const marketForLookup = _coerceMarketType(market) || market;
  const pick   = String(leg.pick || '');
  const pickClean = _stripToWinSuffix(pick);
  let pickForLookup = _normalizePickForSnapshotLookup(pickClean);
  const owlsSportForNorm = _mapToOwlsSport(_oddsApiSportKey(leg.sport || leg.league || '')) || 'mlb';
  const isTeamMarketLookup = marketForLookup === 'moneyline' || marketForLookup === 'spread' ||
    marketForLookup === 'first_half_moneyline' || marketForLookup === 'first_half_spread';
  if (isTeamMarketLookup && pickForLookup) {
    pickForLookup = (await _normalizeTeamName(pickForLookup, owlsSportForNorm)).toLowerCase();
  }
  // bypassOk is NEVER true in production — snapshot fallback to client odds
  // must be impossible even if DEV_AUTH_BYPASS is accidentally set in Railway env.
  const bypassOk = !IS_PRODUCTION;
  let snap = null;
  let matchStrategy = null;

  // ----- Canonical identity (priority #11) -----
  // Rebuild identity against the Owls-style game key so canonical_market_key
  // matches what _upsertOddsSnapshots wrote (baseball_mlb|Away|Home|date|total).
  const ident = _normalizeLegIdentity(Object.assign({}, leg, {
    canonicalGameKey: preferredKey,
    pick: pickClean
  })) || {};
  const cmk = ident.canonicalMarketKey || null;
  const csk = ident.canonicalSelectionKey || null;

  const contractGameId = leg.gameId || leg.providerGameId || leg.provider_game_id || null;
  console.log('SNAPSHOT_LOOKUP_BEGIN'
    + ' cKey=' + JSON.stringify(rawKeyIn)
    + ' filledKey=' + JSON.stringify(rawKey)
    + ' dateFromLeg=' + JSON.stringify(dateFromLeg)
    + ' preferredKey=' + JSON.stringify(preferredKey)
    + ' market=' + JSON.stringify(market)
    + ' marketForLookup=' + JSON.stringify(marketForLookup)
    + ' pick=' + JSON.stringify(pick)
    + ' pickClean=' + JSON.stringify(pickClean)
    + ' selection=' + JSON.stringify(pickForLookup)
    + ' gameId=' + JSON.stringify(contractGameId)
    + ' line=' + JSON.stringify(leg.line != null ? leg.line : null)
    + ' scheduledStart=' + JSON.stringify(leg.scheduledStart || null)
    + ' cmk=' + JSON.stringify(cmk)
    + ' csk=' + JSON.stringify(csk)
    + ' keyCandidates=' + JSON.stringify(keyCandidates));

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
        matchStrategy = 'canonical';
        if (ident.marketType === MARKET_TYPES.PLAYER_PROP) {
          console.log(`PROP_SNAPSHOT_MATCH gameKey=${ident.gameKey} player=${_normalizePlayerName(ident.playerName||'')} propType=${_normalizePropType(ident.propType||'')} side=${(ident.side||'').toLowerCase()} line=${ident.line!=null?ident.line:'?'} via=canonical`);
        }
        _logSnapshotLookupHit('canonical', snap, 'cmk=' + cmk + ' csk=' + csk);
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

  // Tier 1b: totals/spreads — exact line in canonical_selection_key missed
  // (lobby Over 9 vs snapshot over:8.5). Same market + same side only; never
  // cross moneyline. Caller still applies exact odds + exact line checks.
  if (!snap && cmk && (ident.marketType === MARKET_TYPES.TOTAL
      || ident.marketType === MARKET_TYPES.PERIOD_TOTAL
      || ident.marketType === MARKET_TYPES.TEAM_TOTAL
      || ident.marketType === MARKET_TYPES.SPREAD
      || ident.marketType === MARKET_TYPES.PERIOD_SPREAD)) {
    const sidePrefix = (csk && String(csk).indexOf('under') === 0) ? 'under:'
      : (csk && String(csk).indexOf(':') >= 0) ? String(csk).slice(0, String(csk).lastIndexOf(':') + 1)
      : (pick.indexOf('under') >= 0 ? 'under:' : null);
    // Totals: over:/under:. Spreads: team_slug:  — only flex the numeric suffix.
    const likePrefix = sidePrefix || (ident.marketType === MARKET_TYPES.TOTAL
      || ident.marketType === MARKET_TYPES.PERIOD_TOTAL
      || ident.marketType === MARKET_TYPES.TEAM_TOTAL
        ? (pick.indexOf('under') >= 0 ? 'under:' : 'over:')
        : null);
    if (likePrefix) {
      try {
        const { data, error } = await sb.from('odds_snapshots').select('*')
          .eq('canonical_market_key', cmk)
          .like('canonical_selection_key', likePrefix + '%')
          .limit(4);
        if (error) throw error;
        if (data && data[0]) {
          snap = data[0];
          matchStrategy = 'canonical_line_flex';
          _logSnapshotLookupHit('canonical_line_flex', snap,
            'cmk=' + cmk + ' searchedCsk=' + csk + ' likePrefix=' + likePrefix);
        }
      } catch (flexErr) {
        const msg = (flexErr && flexErr.message) || '';
        if (!/canonical_market_key|canonical_selection_key/.test(msg)) {
          console.warn('[snapshot] canonical line-flex lookup error:', msg);
        }
      }
    }
  }

  // Tier 2: legacy lookup by (canonical_game_key, market_key, selection_key).
  // selection_key in the DB stores only the team/side name with no spread:
  //   e.g. "toronto blue jays"  (NOT "toronto blue jays +1.5")
  //   e.g. "over"               (NOT "over 9")
  //   e.g. "colorado rockies"   (NOT "colorado rockies to win")
  if (!snap) {
    try {
      for (let ki = 0; ki < keyCandidates.length; ki++) {
        const tryKey = keyCandidates[ki];
        const { data, error } = await sb.from('odds_snapshots').select('*')
          .eq('canonical_game_key', tryKey).eq('market_key', marketForLookup).eq('selection_key', pickForLookup)
          .limit(1);
        if (error) throw error;
        if (data && data[0]) {
          snap = data[0];
          matchStrategy = 'legacy';
          if (ident.marketType === MARKET_TYPES.PLAYER_PROP) {
            console.log(`PROP_SNAPSHOT_MATCH gameKey=${ident.gameKey} player=${_normalizePlayerName(ident.playerName||'')} propType=${_normalizePropType(ident.propType||'')} side=${(ident.side||'').toLowerCase()} line=${ident.line!=null?ident.line:'?'} via=legacy`);
          }
          _logSnapshotLookupHit('legacy', snap,
            'searchedKey=' + tryKey + ' market=' + marketForLookup + ' selection=' + pickForLookup);
          break;
        }
      }
    } catch(dbErr) {
      console.warn('[snapshot] DB error:', dbErr.message, 'leg='+leg.pick);
      if (bypassOk) {
        console.warn('[snapshot] DEV FALLBACK — using client odds (production would reject)');
        return { ok:true, devFallback:true, warn:'snapshot_db_error',
                 acceptedOddsAmerican:parseInt(leg.odds,10)||0,
                 acceptedOddsDecimal:null, isLive:false };
      }
      return { ok:false, code:'odds_service_unavailable', reason:'db_error', leg:leg.pick };
    }
  }

  // Tier 2b: prefix-match the game key date. Covers empty dates, timezone
  // off-by-one, and leftover display-string suffixes. Prefer today's dated
  // row; refuse doubleheaders.
  if (!snap) {
    try {
      const flexed = await _lookupSnapshotByDateFlexPrefix(sb, preferredKey, marketForLookup, pickForLookup);
      if (flexed && flexed.snap) {
        snap = flexed.snap;
        matchStrategy = 'date_flex';
        _logSnapshotLookupHit('date_flex', snap,
          'searchedKey=' + rawKeyIn + ' prefix=' + flexed.prefix
          + ' market=' + marketForLookup + ' selection=' + pickForLookup);
      }
    } catch (flexErr) {
      console.warn('[snapshot] date-flex lookup error:', (flexErr && flexErr.message) || flexErr);
    }
  }

  // Tier 2c: contract gameId → provider_game_id (Owls/provider event id).
  if (!snap && contractGameId) {
    try {
      const { data, error } = await sb.from('odds_snapshots').select('*')
        .eq('provider_game_id', String(contractGameId))
        .eq('market_key', marketForLookup)
        .eq('selection_key', pickForLookup)
        .limit(1);
      if (error) throw error;
      if (data && data[0]) {
        snap = data[0];
        matchStrategy = 'provider_game_id';
        _logSnapshotLookupHit('provider_game_id', snap,
          'gameId=' + contractGameId + ' market=' + marketForLookup + ' selection=' + pickForLookup);
      }
    } catch (gidErr) {
      const msg = (gidErr && gidErr.message) || '';
      if (!/provider_game_id/.test(msg)) {
        console.warn('[snapshot] provider_game_id lookup error:', msg);
      }
    }
  }

  // Tier 3: fresh in-memory poll cache when DB row is missing or stale.
  if (!snap || _classifyMarket(snap, nowMs) === 'stale') {
    let cacheSnap = null;
    let cacheKeyUsed = null;
    for (let ki = 0; ki < keyCandidates.length; ki++) {
      cacheSnap = _lookupSnapshotFromLiveCache(keyCandidates[ki], marketForLookup, pickForLookup);
      if (cacheSnap) { cacheKeyUsed = keyCandidates[ki]; break; }
    }
    if (cacheSnap) {
      matchStrategy = 'live_cache';
      _logSnapshotLookupHit('live_cache', cacheSnap,
        'searchedKey=' + cacheKeyUsed + ' market=' + marketForLookup + ' selection=' + pickForLookup);
      snap = cacheSnap;
    }
  }

  // Snapshot not found via either tier
  if (!snap) {
    if (ident.marketType === MARKET_TYPES.PLAYER_PROP) {
      console.log(`PROP_SNAPSHOT_MISS gameKey=${ident.gameKey} player=${_normalizePlayerName(ident.playerName||'')} propType=${_normalizePropType(ident.propType||'')} side=${(ident.side||'').toLowerCase()} line=${ident.line!=null?ident.line:'?'} cmk=${cmk||'-'} csk=${csk||'-'}`);
    }
    await _logClosestSnapshotKeys(sb, preferredKey, marketForLookup, pickForLookup);
    if (bypassOk) {
      console.warn('[snapshot] MISSING — DEV FALLBACK for', leg.pick);
      return { ok:true, devFallback:true, warn:'odds_snapshot_missing',
               acceptedOddsAmerican:parseInt(leg.odds,10)||0, acceptedOddsDecimal:null, isLive:false };
    }
    return { ok:false, code:'odds_service_unavailable', reason:'snapshot_missing', leg:leg.pick };
  }

  if (!matchStrategy) {
    _logSnapshotLookupHit('existing', snap, '');
  }

  // Market state classification
  const state = _classifyMarket(snap, nowMs);
  if (state === 'stale') {
    if (bypassOk) {
      console.warn('[snapshot] STALE — DEV FALLBACK for', leg.pick);
      return { ok:true, devFallback:true, warn:'odds_stale',
               acceptedOddsAmerican:snap.odds_american, acceptedOddsDecimal:parseFloat(snap.odds_decimal), isLive:false };
    }
    const ageMs = nowMs - new Date(snap.fetched_at).getTime();
    return { ok:false, code:'odds_stale', leg:leg.pick, ageMs };
  }
  // Hard blocks — game is over or market is unavailable. Live is allowed.
  if (state === 'final')
    return {
      ok:false,
      code:'market_unavailable',
      leg:leg.pick,
      reason:'game_final',
      userMessage:'game is final'
    };
  if (state === 'canceled')
    return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'game_canceled' };
  if (state === 'suspended')
    return { ok:false, code:'market_unavailable', leg:leg.pick, reason:'suspended' };

  // Live / in-progress: server-authoritative (never trust client leg.isLive).
  // isFinal already rejected above. When LIVE_BETTING_ENABLED, allow live bets;
  // otherwise reject with an explicit live-betting-disabled message.
  const commenceTime = snap.commence_time||snap.commenceTime;
  const commenceMs = commenceTime ? new Date(commenceTime).getTime() : NaN;
  const hasCommenced = !isNaN(commenceMs) && nowMs >= commenceMs;
  const isLiveMarket = state === 'live' || hasCommenced;
  if (isLiveMarket) {
    if (!LIVE_BETTING_ENABLED) {
      return {
        ok:false,
        code:'live_betting_disabled',
        leg:leg.pick,
        reason: state === 'live' ? 'server_live' : 'event_started',
        commenceTime: commenceTime || null,
        userMessage:'live betting disabled'
      };
    }
  }

  // RISK-9: Zero-tolerance exact-match odds.
  // No drift window, no accept_better, no accept_any_with_confirm.
  // submitted odds must equal server snapshot odds exactly (integer comparison).
  const rawSubmittedOdds = leg.odds;
  const rawServerOdds    = snap.odds_american;
  const submittedOdds = Number(rawSubmittedOdds);
  const serverOdds    = Number(rawServerOdds);

  if (rawSubmittedOdds == null || rawSubmittedOdds === '' ||
      rawServerOdds == null || rawServerOdds === '' ||
      !Number.isFinite(submittedOdds) || !Number.isFinite(serverOdds) ||
      submittedOdds === 0 || serverOdds === 0) {
    return { ok:false, code:'invalid_snapshot_odds', leg:leg.pick };
  }

  if (submittedOdds !== serverOdds) {
    return {
      ok:          false,
      code:        'odds_changed',
      leg:         leg.pick,
      submittedOdds,
      serverOdds,
      reason:      'exact_match_required'
    };
  }

  if (_marketRequiresPointLineExact(ident.marketType || market, market)) {
    const submittedLine = _extractSubmittedPointLine(leg);
    const serverLineRaw = snap.point_line!=null ? snap.point_line : snap.pointLine;
    const serverLine = Number(serverLineRaw);
    if (!Number.isFinite(submittedLine) || !Number.isFinite(serverLine) ||
        Math.abs(submittedLine - serverLine) > 0.000001) {
      return {
        ok:false,
        code:'line_changed',
        leg:leg.pick,
        submittedPointLine:Number.isFinite(submittedLine) ? submittedLine : null,
        serverPointLine:Number.isFinite(serverLine) ? serverLine : null,
        reason:'exact_line_required'
      };
    }
  }

  return {
    ok:true,
    snapshotId:           snap.snapshot_id,
    acceptedOddsAmerican: serverOdds,
    acceptedOddsDecimal:  parseFloat(snap.odds_decimal),
    acceptedPointLine:    snap.point_line!=null?parseFloat(snap.point_line):null,
    commenceTime:         commenceTime,
    isLive:               state === 'live',   // server-authoritative; never trust client leg.isLive
    // Prefer the snapshot's Owls key so ticket_legs grade against the same
    // identity we looked up (not the lobby's short "mlb|..." key).
    canonicalGameKey:     snap.canonical_game_key || preferredKey || rawKey
  };
}

function _marketRequiresPointLineExact(marketType, market) {
  const m = String(marketType||market||'').toLowerCase();
  return m === MARKET_TYPES.SPREAD || m === MARKET_TYPES.TOTAL ||
    m === MARKET_TYPES.PERIOD_SPREAD || m === MARKET_TYPES.PERIOD_TOTAL ||
    m.includes('spread') || m.includes('total') ||
    m.includes('run line') || m.includes('puck line') ||
    m.includes('alternate spread') || m.includes('alternate total') ||
    m.includes('alt spread') || m.includes('alt total');
}

function _extractSubmittedPointLine(leg) {
  if (!leg) return NaN;
  const direct = leg.pointLine!=null ? leg.pointLine
    : leg.point_line!=null ? leg.point_line
    : leg.line!=null ? leg.line
    : leg.accepted_point_line!=null ? leg.accepted_point_line
    : null;
  if (direct != null && direct !== '') return Number(direct);
  const text = String(leg.pick||leg.selectionLabel||'');
  const m = text.match(/(?:^|\s)([+-]?\d+(?:\.\d+)?)(?:\s|$)/);
  return m ? Number(m[1]) : NaN;
}

// Place-bet snapshot contract. Frontend _buildContractPlaceLeg and this
// ingest MUST agree. Extra aliases (scheduled_start, commenceTime,
// providerGameId) are fallbacks only — these seven fields are canonical.
const PLACE_BET_LEG_CONTRACT_FIELDS = Object.freeze([
  'pick', 'market', 'odds', 'line', 'canonicalGameKey', 'scheduledStart', 'gameId'
]);

function _ingestPlaceBetLeg(leg) {
  const out = Object.assign({}, leg || {});
  out.pick = _stripToWinSuffix(out.pick || '');
  out.canonicalGameKey = out.canonicalGameKey || out.canonical_game_key || out.gameKey || null;
  out.scheduledStart   = out.scheduledStart || out.scheduled_start || out.commenceTime || out.commence_time || null;
  out.gameId           = out.gameId || out.providerGameId || out.provider_game_id || null;
  if (out.gameId != null && out.gameId !== '') out.gameId = String(out.gameId);
  else out.gameId = null;
  out.providerGameId   = out.providerGameId || out.provider_game_id || out.gameId || null;
  if (!out.market && out.marketType) out.market = out.marketType;
  const coerced = _coerceMarketType(out.market);
  if (coerced) out.market = coerced;
  else if (out.market) out.market = String(out.market).toLowerCase().trim();
  if (out.odds != null && typeof out.odds !== 'number') {
    const parsedOdds = Number(String(out.odds).replace('+', ''));
    if (Number.isFinite(parsedOdds)) out.odds = parsedOdds;
  }
  if (out.line != null && out.line !== '' && typeof out.line !== 'number') {
    const parsedLine = Number(out.line);
    if (Number.isFinite(parsedLine)) out.line = parsedLine;
  }
  if (out.line == null || out.line === '' || !Number.isFinite(Number(out.line))) {
    const parsedFromPick = _extractSubmittedPointLine(out);
    out.line = Number.isFinite(parsedFromPick) ? parsedFromPick : null;
  } else {
    out.line = Number(out.line);
  }
  if (out.market === 'moneyline') out.line = null;
  if (out.canonicalGameKey) {
    const filledKey = _fillEmptyGameKeyDate(out.canonicalGameKey, _isoDateFromValue(out.scheduledStart));
    const cands = _gameKeyLookupCandidates(filledKey || out.canonicalGameKey);
    out.canonicalGameKey = cands[cands.length - 1] || filledKey || out.canonicalGameKey;
  }
  return out;
}

function _validatePlaceBetLegContract(leg, i, errors) {
  if (!leg.pick) errors.push('leg'+i+'_missing_pick');
  if (!leg.market) errors.push('leg'+i+'_missing_market');
  if (typeof leg.odds !== 'number' || !Number.isFinite(leg.odds)) errors.push('leg'+i+'_invalid_odds');
  if (leg.line != null && !Number.isFinite(Number(leg.line))) errors.push('leg'+i+'_invalid_line');
  if (!leg.canonicalGameKey) errors.push('leg'+i+'_missing_canonicalGameKey');
  if (!leg.scheduledStart) errors.push('leg'+i+'_missing_scheduledStart');
  if (!leg.gameId) errors.push('leg'+i+'_missing_gameId');
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
  const fetchedMs = new Date(snap.fetched_at||snap.fetchedAt).getTime();
  const ageMs = nowMs - fetchedMs;
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
  const ct = snap.commence_time||snap.commenceTime;
  let isLiveSnapshot = snap.eventLive === true || evStatus === 'live' || evStatus === 'in_play' || evStatus === 'in_progress';
  if (!isLiveSnapshot && ct) {
    const ms = new Date(ct).getTime();
    if (!isNaN(ms) && nowMs >= ms) isLiveSnapshot = true;
  }
  const ttlMs = isLiveSnapshot ? LIVE_SNAPSHOT_TTL_MS : PREGAME_SNAPSHOT_TTL_MS;
  if (!Number.isFinite(fetchedMs) || ageMs > ttlMs) return 'stale';
  if (isLiveSnapshot)
    return 'live';
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
      dev_fallback:           vr.devFallback||false,
      server_is_live:         vr.isLive||false,   // server-derived; used by RPC, not client leg.isLive
      canonicalGameKey:       vr.canonicalGameKey || legs[i].canonicalGameKey
    }));
  }
  const payout = Math.round(stake*product*100)/100;
  const profit = Math.round((payout-stake)*100)/100;
  return { ok:true, payout, profit, legs:enrichedLegs };
}

// Wire snapshot upsert into live cache poll
const _origPoll = pollLiveOddsLoop;
const pollLiveOddsLoopWithSnapshots = async function() {
  try {
    await _origPoll();
  } catch (pollErr) {
    console.error('[poll] pollLiveOddsLoop error:', pollErr.message);
  }
  try {
    const r = await _upsertOddsSnapshots();
    if (r && r.ok) {
      console.log('SNAPSHOT_UPSERT_RESULT ok=true rows='+(r.rowsUpserted||0));
    } else {
      console.error('SNAPSHOT_UPSERT_RESULT ok=false reason='+(r && (r.reason||r.error) || 'unknown')+
        ' code='+(r && r.code || '?')+' rows='+(r && r.rowsUpserted || 0));
    }
  } catch (upsertErr) {
    console.error('SNAPSHOT_UPSERT_RESULT ok=false reason=threw message='+JSON.stringify(String(upsertErr && upsertErr.message || upsertErr).slice(0,300)));
  }
};
// Recursive setTimeout poller (not setInterval).
// setInterval fires every 5s even when the previous async tick is still
// running. Overlapping Owls/Odds-API fetches + snapshot upserts exhaust
// sockets and the loop looks "stopped" (lastSuccessAt frozen, cacheAgeMs
// climbs). Scheduling the next tick in `finally` serializes runs and
// guarantees the loop survives a thrown error.
// Live betting (DK-style) wants 5s refresh so price/score updates feel
// real-time. Allow env override via LIVE_ODDS_POLL_MS for ops tuning.
const LIVE_CACHE_POLL_INTERVAL_MS = _envMs('LIVE_ODDS_POLL_MS', 5 * 1000);
const CACHE_POLL_INTERVAL = LIVE_CACHE_POLL_INTERVAL_MS; // backwards-compat alias
const POLL_WATCHDOG_STALE_MS = 30 * 1000;
const POLL_WATCHDOG_CHECK_MS = 10 * 1000;

function _getOddsPollIntervalMs() {
  if (OWLS_USE_WEBSOCKET && ODDS_PROVIDER === 'owls_insight') {
    // Stretch to 5m heartbeat only when WS is connected AND the live cache is
    // still fresh. Empty/stale cache (or connection-limit fallback) keeps the
    // faster REST cadence so lastSuccessAt cannot freeze.
    return _shouldSkipOwlsRestWhileWsConnected()
      ? OWLS_WS_CONNECTED_POLL_MS : OWLS_WS_FALLBACK_POLL_MS;
  }
  return LIVE_CACHE_POLL_INTERVAL_MS;
}

let _oddsPollTimer = null;
let _oddsWatchdogTimer = null;
let _oddsPollGeneration = 0;
let _oddsPollLastStartedAt = 0;
let _oddsPollerStarted = false;
let _oddsWatchdogRefreshAt = 0;

function _clearOddsPollTimer() {
  if (_oddsPollTimer) {
    clearTimeout(_oddsPollTimer);
    _oddsPollTimer = null;
  }
}

function _scheduleOddsPollTick(delayMs) {
  _clearOddsPollTimer();
  _oddsPollTimer = setTimeout(_runOddsPollTick, delayMs);
}

async function _runOddsPollTick() {
  _oddsPollTimer = null;
  const generation = _oddsPollGeneration;
  _oddsPollLastStartedAt = Date.now();
  try {
    await pollLiveOddsLoopWithSnapshots();
  } catch (tickErr) {
    console.error('[poll] uncaught tick error:', tickErr && tickErr.message);
  } finally {
    if (generation === _oddsPollGeneration) {
      _scheduleOddsPollTick(_getOddsPollIntervalMs());
    }
  }
}

function _startOddsPoller(reason) {
  _oddsPollGeneration++;
  _oddsPollerStarted = true;
  _clearOddsPollTimer();
  console.log('[poll] startup keyPresent='+(!!ODDS_KEY)+
    ' keyMasked='+_maskOddsKey(ODDS_KEY)+
    ' provider='+ODDS_PROVIDER+
    ' pollerScheduled=true intervalMs='+LIVE_CACHE_POLL_INTERVAL_MS+
    ' reason='+(reason||'boot'));
  _scheduleOddsPollTick(0);
}

function _oddsPollerWatchdogTick() {
  try {
    const ageMs = _oddsPollLastStartedAt ? (Date.now() - _oddsPollLastStartedAt) : Infinity;
    const cacheAgeMs = _getLiveCacheAgeMs();
    const cacheStale = !Number.isFinite(cacheAgeMs) || cacheAgeMs > OWLS_WS_STALE_REST_MS;
    if (ageMs > POLL_WATCHDOG_STALE_MS) {
      console.warn('[poll] watchdog restart — last tick started '+ageMs+'ms ago');
      _startOddsPoller('watchdog_stale');
    }
    // Restarting the poller alone is not enough when WS is "connected" and the
    // tick skips REST — force a real REST refresh so lastSuccessAt advances.
    const now = Date.now();
    if (cacheStale && (ODDS_KEY || (ODDS_PROVIDER === 'owls_insight' && OWLS_KEY)) &&
        (now - _oddsWatchdogRefreshAt >= OWLS_WS_FALLBACK_POLL_MS)) {
      _oddsWatchdogRefreshAt = now;
      console.warn('[poll] watchdog stale cache ageMs='+cacheAgeMs+
        ' — triggering immediate REST refresh');
      _triggerImmediateOddsRefresh('watchdog_stale').catch(function(e) {
        console.error('[poll] watchdog refresh error:', e && e.message);
      });
    }
  } catch (wdErr) {
    console.error('[poll] watchdog error:', wdErr && wdErr.message);
  } finally {
    _oddsWatchdogTimer = setTimeout(_oddsPollerWatchdogTick, POLL_WATCHDOG_CHECK_MS);
  }
}

function _startOddsPollerWatchdog() {
  if (_oddsWatchdogTimer) {
    clearTimeout(_oddsWatchdogTimer);
    _oddsWatchdogTimer = null;
  }
  _oddsWatchdogTimer = setTimeout(_oddsPollerWatchdogTick, POLL_WATCHDOG_CHECK_MS);
}

if (ODDS_KEY || (ODDS_PROVIDER === 'owls_insight' && OWLS_KEY)) {
  _startOddsPoller('boot');
  _startOddsPollerWatchdog();
  if (OWLS_USE_WEBSOCKET) {
    setTimeout(function(){ _initOwlsWebSocket(); }, 0);
  }
  // Immediate REST bootstrap — defer until module init finishes (CACHE_SPORTS,
  // LIVE_MARKET_CACHE, etc.) so the poll path cannot hit TDZ errors.
  setImmediate(function() {
    _triggerImmediateOddsRefresh('boot_immediate').catch(function(e) {
      console.error('[poll] boot immediate refresh error:', e && e.message);
    });
  });
  // Live scores poller (independent of odds WS skip).
  setImmediate(function() { _startLiveScorePoller(); });
} else {
  console.error('[poll] startup keyPresent=false keyMasked=MISSING provider='+ODDS_PROVIDER+
    ' pollerScheduled=false reason=no_api_key');
}

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
  market_risk_exceeded:     422,
  live_stake_above_max:     422,
  live_payout_above_max:    422,
  live_sport_disabled:      422,
  live_parlays_disabled:    422
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
  } catch(_e){ console.warn('[bets/place] club_risk_settings read error (cs defaults applied):', _e.message); }

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
  if ((type==='parlay'||type==='roundrobin'||type==='sgp') && cs.allow_parlays===false)
    return { ok:false, code:'parlays_disabled' };
  if (type==='teaser' && cs.allow_teasers===false)
    return { ok:false, code:'teasers_disabled' };
  if (type==='roundrobin' && cs.allow_round_robins===false)
    return { ok:false, code:'round_robins_disabled' };
  if ((type==='parlay'||type==='roundrobin'||type==='sgp') && cs.max_parlay_legs && legsArr.length > cs.max_parlay_legs)
    return { ok:false, code:'too_many_parlay_legs', max:cs.max_parlay_legs, legs:legsArr.length };

  const liveLegs = legsArr.filter(function(l){ return !!l.server_is_live; });
  if (liveLegs.length > 0) {
    if (cs.allow_live_betting !== true)
      return { ok:false, code:'live_betting_disabled' };
    if (liveLegs.length > 1 && cs.allow_live_parlays !== true)
      return { ok:false, code:'live_parlays_disabled' };
    if ((type==='parlay'||type==='roundrobin'||type==='sgp') && cs.allow_live_parlays !== true)
      return { ok:false, code:'live_parlays_disabled' };
    if (cs.max_live_stake && s > parseFloat(cs.max_live_stake))
      return { ok:false, code:'live_stake_above_max', max:cs.max_live_stake, stake:s };
    if (cs.max_live_payout && pay > parseFloat(cs.max_live_payout))
      return { ok:false, code:'live_payout_above_max', max:cs.max_live_payout, payout:pay };
    const enabledLiveSports = Array.isArray(cs.live_enabled_sports)
      ? cs.live_enabled_sports.map(function(v){ return String(v||'').toLowerCase(); }).filter(Boolean)
      : [];
    if (enabledLiveSports.length === 0)
      return { ok:false, code:'live_sport_disabled', sport:null };
    for (let i=0; i<liveLegs.length; i++) {
      const sport = (liveLegs[i].sport||'').toLowerCase();
      if (!enabledLiveSports.includes(sport)) {
        const originalIndex = legsArr.indexOf(liveLegs[i]);
        return { ok:false, code:'live_sport_disabled', sport, legIndex:originalIndex };
      }
    }
  }

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
    if (cs.allow_live_betting===false && leg.server_is_live)
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

  if (liveLegs.length > 0 && (cs.max_live_event_exposure || cs.max_live_market_exposure)) {
    try {
      const { data:activeTix } = await sb.from('tickets').select('id,risk_amount')
        .eq('club_id',clubId).in('status',['active','open']);
      const ticketRisk = {};
      const ticketIds = (activeTix||[]).map(function(t){
        ticketRisk[t.id] = parseFloat(t.risk_amount||0);
        return t.id;
      });
      let activeLegs = [];
      if (ticketIds.length) {
        const { data } = await sb.from('ticket_legs')
          .select('ticket_id,canonical_game_key,market')
          .in('ticket_id', ticketIds);
        activeLegs = data || [];
      }
      for (let i=0; i<liveLegs.length; i++) {
        const leg = liveLegs[i];
        const gameKey = leg.canonicalGameKey || leg.canonical_game_key || '';
        const marketKey = (leg.market||'moneyline').toLowerCase();
        const eventExposure = activeLegs.reduce(function(sum,l){
          return l.canonical_game_key === gameKey ? sum + (ticketRisk[l.ticket_id]||0) : sum;
        }, 0);
        if (cs.max_live_event_exposure && eventExposure + s > parseFloat(cs.max_live_event_exposure)) {
          return { ok:false, code:'event_risk_exceeded',
            max:cs.max_live_event_exposure, current:eventExposure, stake:s, legIndex:i };
        }
        const marketExposure = activeLegs.reduce(function(sum,l){
          return l.canonical_game_key === gameKey && String(l.market||'').toLowerCase() === marketKey
            ? sum + (ticketRisk[l.ticket_id]||0) : sum;
        }, 0);
        if (cs.max_live_market_exposure && marketExposure + s > parseFloat(cs.max_live_market_exposure)) {
          return { ok:false, code:'market_risk_exceeded',
            max:cs.max_live_market_exposure, current:marketExposure, stake:s, legIndex:i };
        }
      }
    } catch(_e){ throw _e; }
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
      if (actor.error) {
        return res.status(actor.status||401).json({ ok:false, error:actor.error,
          reason:scope.reason, requestedClubId, action });
      }
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
    if (action === 'place_bet') {
      if (!isSelf) return { allowed:false, reason:'not_own_account', status:403 };
      if (actor.role !== 'player') {
        return { allowed:false, reason:'host_betting_disabled', status:403 };
      }
      return { allowed:true };
    }
    const isPrivileged = rank >= ROLE_RANK.full_admin;
    if (!isSelf && !isPrivileged) {
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

// ODDS_TOLERANCE_PTS removed — RISK-9: exact-match odds required; no tolerance window allowed.
const CACHE_STALE_THRESHOLD = 5 * 60 * 1000; // 5min stale threshold

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
function _slugTeamForCKey(name) {
  return (name || '').toLowerCase().replace(/\s+/g, '-');
}

function _owlsSportForGame(game) {
  return _mapToOwlsSport(_oddsApiSportKey(game.sport_key)) || String(game.sport_key || '').toLowerCase();
}

function _buildCKeyFromGameSync(game) {
  const sport = _sportPrefix(game.sport_key);
  const owlsSport = _owlsSportForGame(game);
  const awayRaw = game.away_team || '';
  const homeRaw = game.home_team || '';
  const awayNorm = _teamNormCache.get(owlsSport + ':' + awayRaw) || awayRaw;
  const homeNorm = _teamNormCache.get(owlsSport + ':' + homeRaw) || homeRaw;
  const dateStr = (game.commence_time || '').slice(0, 10);
  return sport + '|' + _slugTeamForCKey(awayNorm) + '|' + _slugTeamForCKey(homeNorm) + '|' + dateStr;
}

async function _buildCKeyFromGame(game) {
  const sport = _sportPrefix(game.sport_key);
  const owlsSport = _owlsSportForGame(game);
  const awayRaw = game.away_team || '';
  const homeRaw = game.home_team || '';
  const [awayNorm, homeNorm] = await Promise.all([
    awayRaw ? _normalizeTeamName(awayRaw, owlsSport) : '',
    homeRaw ? _normalizeTeamName(homeRaw, owlsSport) : ''
  ]);
  const dateStr = (game.commence_time || '').slice(0, 10);
  return sport + '|' + _slugTeamForCKey(awayNorm) + '|' + _slugTeamForCKey(homeNorm) + '|' + dateStr;
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

async function _buildCacheFromGames(gamesArr, prevCache, fetchDurationMs) {
  const now = new Date().toISOString();
  // A completed fetch that returned [] is a successful poll (offseason / empty
  // slate). Callers must not pass error/failed fetches here — those should
  // leave lastSuccessAt untouched so cacheAgeMs still looks dead.
  if (!Array.isArray(gamesArr) || !gamesArr.length) {
    return {
      updatedAt:now, lastSuccessAt:now, games:[],
      marketsByCanonicalKey:{}, marketsByProviderGameId:{},
      gameCount:0, marketCount:0, fetchDurationMs:fetchDurationMs||0,
      sourceStatus:'empty', warnings:['empty_slate']
    };
  }
  const teamNamesBySport = {};
  gamesArr.forEach(function(game) {
    const owlsSport = _owlsSportForGame(game);
    if (!teamNamesBySport[owlsSport]) teamNamesBySport[owlsSport] = [];
    const seen = teamNamesBySport[owlsSport];
    if (game.away_team && seen.indexOf(game.away_team) < 0) seen.push(game.away_team);
    if (game.home_team && seen.indexOf(game.home_team) < 0) seen.push(game.home_team);
  });
  await Promise.all(Object.keys(teamNamesBySport).map(function(sport) {
    return _normalizeTeamNames(teamNamesBySport[sport], sport);
  }));
  const byKey = {}, byId = {};
  let marketCount = 0;
  for (const game of gamesArr) {
    const cKey   = _buildCKeyFromGameSync(game);
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
// Owls WebSocket connection state (only used when OWLS_USE_WEBSOCKET=true).
let _owlsWsSocket = null;
let _owlsWsConnected = false;
let _owlsWsReconnectTimer = null;
let _owlsWsEmptyCacheFallbackTimer = null;
let _owlsWsForceRestFallback = false; // Connection limit / empty WS → prefer REST
let _owlsWsEmptySnapshotRestAt = 0;
const OWLS_WS_EMPTY_CACHE_FALLBACK_MS = 30 * 1000;

// True only when WS is connected, cache has games, and cache is still fresh.
// Otherwise REST must keep polling so lastSuccessAt / cacheAgeMs cannot freeze.
function _shouldSkipOwlsRestWhileWsConnected() {
  if (!OWLS_USE_WEBSOCKET || !_owlsWsConnected) return false;
  if (_owlsWsForceRestFallback) return false;
  if (!LIVE_MARKET_CACHE || !LIVE_MARKET_CACHE.gameCount) return false;
  const age = _getLiveCacheAgeMs();
  if (!Number.isFinite(age) || age > OWLS_WS_STALE_REST_MS) return false;
  return true;
}
// Rate-limit for Odds API fallback when Owls is unavailable: max 1 poll/min
let _oddsApiFallbackLastRun = 0;
const _ODDS_API_FALLBACK_INTERVAL_MS = 60 * 1000;
// After OUT_OF_USAGE_CREDITS, stop hammering The Odds API every 5s.
let _oddsApiQuotaBlockedUntil = 0;
const _ODDS_API_QUOTA_BACKOFF_MS = 2 * 60 * 1000;

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

function _oddsApiQuotaBlocked() {
  return Date.now() < _oddsApiQuotaBlockedUntil;
}

// Poll The Odds API directly and atomically replace LIVE_MARKET_CACHE.
async function _runOddsApiPoll(trigger) {
  if (!ODDS_KEY) {
    console.log('[live cache] ODDS_API_KEY not set — skipping poll trigger='+trigger);
    return false;
  }
  if (_oddsApiQuotaBlocked()) {
    console.warn('[live cache] Odds API quota backoff remainingMs='+
      (_oddsApiQuotaBlockedUntil - Date.now())+' trigger='+trigger+
      ' — lastSuccessfulPollAt unchanged');
    return false;
  }
  const start = Date.now();
  const allGames = [];
  let sportsOk = 0;
  let sportsErr = 0;
  let quotaHit = false;
  try {
    await Promise.all(CACHE_SPORTS.map(async function(sport) {
      const games = await fetchOdds(sport);
      if (Array.isArray(games)) {
        sportsOk++;
        allGames.push(...games);
        return;
      }
      sportsErr++;
      if (games && games._error === 'OUT_OF_USAGE_CREDITS') quotaHit = true;
    }));
    if (quotaHit) {
      _oddsApiQuotaBlockedUntil = Date.now() + _ODDS_API_QUOTA_BACKOFF_MS;
      console.error('[live cache] Odds API OUT_OF_USAGE_CREDITS — backing off '+
        _ODDS_API_QUOTA_BACKOFF_MS+'ms trigger='+trigger);
    }
    // API errors are not an empty slate. Do not update lastSuccessAt.
    if (sportsOk === 0) {
      console.error('[live cache] all sports failed trigger='+trigger+
        ' errors='+sportsErr+' — lastSuccessfulPollAt unchanged');
      _recordLiveDiagnosticEvent('provider_unhealthy', {
        phase:'provider_poll', reason:quotaHit?'odds_api_quota':'odds_api_all_sports_failed', trigger
      });
      return false;
    }
    const fetchDurationMs = Date.now() - start;
    const newCache = await _buildCacheFromGames(allGames, LIVE_MARKET_CACHE, fetchDurationMs);
    LIVE_MARKET_CACHE = newCache;
    console.log('[live cache] updated trigger='+trigger+' games='+newCache.gameCount+
      ' markets='+newCache.marketCount+' sportsOk='+sportsOk+
      ' sourceStatus='+newCache.sourceStatus+' fetch='+fetchDurationMs+'ms');
    return true;
  } catch(e) {
    console.error('[live cache] poll error trigger='+trigger+' — preserving previous cache:', e.message);
    _recordLiveDiagnosticEvent('provider_unhealthy', {
      phase:'provider_poll', reason:'odds_api_poll_error', trigger
    });
  }
  return false;
}

// Owls REST fetch — always hits the API (never skipped for WS). Shared by
// boot bootstrap, admin refresh, WS empty-cache fallback, and poll ticks.
async function _runOwlsRestPoll(trigger) {
  if (!OWLS_KEY) {
    console.warn('[owls-rest] OWLS_INSIGHT_API_KEY not set — skipping trigger='+trigger);
    return { ok:false, reason:'no_owls_key', trigger };
  }
  const start = Date.now();
  const allGames = [];
  const owlsResults = [];
  const sportErrors = [];
  try {
    console.log('[owls-rest] poll start trigger='+trigger+' sports='+CACHE_SPORTS.length+
      ' list='+JSON.stringify(CACHE_SPORTS));
    await Promise.all(CACHE_SPORTS.map(async function(sport) {
      const result = await fetchOddsFromOwlsInsight(sport);
      if (result && result.ok && Array.isArray(result.games)) {
        owlsResults.push(result);
        result.games.forEach(function(g){ allGames.push(g); });
      } else if (result && result.ok) {
        sportErrors.push(sport+':games_not_array');
        console.warn('[owls-rest] skip sport='+sport+' trigger='+trigger+
          ' reason=games_not_array type='+typeof (result && result.games));
      } else if (result && !result.ok) {
        sportErrors.push(sport+':'+(result.error||'unknown'));
        console.warn('[owls-rest] fetch error sport='+sport+': '+(result.error||'unknown')+
          ' status='+(result.status||'?')+' url='+(result.url||'?')+' trigger='+trigger);
        _recordLiveDiagnosticEvent('provider_unhealthy', {
          phase:'provider_poll', sport, reason:result.error||'owls_fetch_error', trigger
        });
      } else {
        sportErrors.push(sport+':null_result');
        console.warn('[owls-rest] skip sport='+sport+' trigger='+trigger+' reason=null_result');
      }
    }));
    const fetchDurationMs = Date.now()-start;
    console.log('[owls-rest] poll collected trigger='+trigger+' sportsOk='+owlsResults.length+
      ' games='+allGames.length+' errors='+sportErrors.length+
      (sportErrors.length ? ' detail='+JSON.stringify(sportErrors) : ''));
    const applyStart = Date.now();
    const applied = await _applyOwlsResultsToCache(owlsResults, allGames, fetchDurationMs);
    console.log('[owls-rest] cache apply trigger='+trigger+' ok='+!!applied.ok+
      ' games='+(applied.gameCount||0)+' markets='+(applied.marketCount||0)+
      ' applyMs='+(Date.now()-applyStart));
    if (applied.ok) {
      console.log('[owls-rest] cache updated trigger='+trigger+' games='+applied.gameCount+
        ' markets='+applied.marketCount+' sportsOk='+owlsResults.length+
        ' sourceStatus='+applied.sourceStatus+' fetch='+fetchDurationMs+'ms');
      // Refresh scores alongside odds (WS may skip later odds REST ticks).
      _pollOwlsLiveScores('after_odds_'+trigger).catch(function(){});
      return { ok:true, gameCount:applied.gameCount, marketCount:applied.marketCount,
        sourceStatus:applied.sourceStatus, trigger };
    }
    console.warn('[owls-rest] all sports failed trigger='+trigger+' — lastSuccessfulPollAt unchanged');
    _recordLiveDiagnosticEvent('provider_unhealthy', {
      phase:'provider_poll', reason:'owls_all_sports_failed', trigger
    });
    return { ok:false, reason:'owls_all_sports_failed', trigger };
  } catch(e) {
    console.error('[owls-rest] poll error trigger='+trigger+':', e.message);
    _recordLiveDiagnosticEvent('provider_unhealthy', {
      phase:'provider_poll', reason:'owls_poll_error', trigger
    });
    return { ok:false, reason:'owls_poll_error', error:e.message, trigger };
  }
}

// Immediate REST poll + snapshot upsert (boot, admin refresh, WS fallback).
async function _triggerImmediateOddsRefresh(trigger) {
  let pollResult;
  if (ODDS_PROVIDER === 'owls_insight' && OWLS_KEY) {
    pollResult = await _runOwlsRestPoll(trigger);
  } else {
    const ok = await _runOddsApiPoll(trigger);
    const cache = LIVE_MARKET_CACHE;
    pollResult = { ok, gameCount:cache.gameCount, marketCount:cache.marketCount,
      sourceStatus:cache.sourceStatus, trigger };
  }
  try {
    const r = await _upsertOddsSnapshots();
    if (r && r.ok) {
      console.log('SNAPSHOT_UPSERT_RESULT source='+trigger+' ok=true rows='+(r.rowsUpserted||0));
    } else {
      console.error('SNAPSHOT_UPSERT_RESULT source='+trigger+' ok=false reason='+
        (r && (r.reason||r.error) || 'unknown'));
    }
  } catch (upsertErr) {
    console.error('SNAPSHOT_UPSERT_RESULT source='+trigger+' ok=false reason=threw message='+
      JSON.stringify(String(upsertErr && upsertErr.message || upsertErr).slice(0,300)));
  }
  const cache = LIVE_MARKET_CACHE;
  return {
    ok:!!pollResult.ok,
    gameCount:cache.gameCount,
    marketCount:cache.marketCount,
    updatedAt:cache.updatedAt,
    sourceStatus:cache.sourceStatus,
    trigger
  };
}

// Apply normalized Owls per-sport results to LIVE_MARKET_CACHE (shared by REST poll + WS).
async function _applyOwlsResultsToCache(owlsResults, allGames, fetchDurationMs) {
  if ((!allGames || !allGames.length) && owlsResults && owlsResults.length) {
    for (const r of owlsResults) {
      if (r && Array.isArray(r.games)) {
        r.games.forEach(function(g){ allGames.push(g); });
      }
    }
  }
  const newCache = await _buildCacheFromGames(allGames, LIVE_MARKET_CACHE, fetchDurationMs);

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

  const gameById = {};
  let cKeyFallbackHits = 0;
  for (const g of allGames) if (g && g.id) gameById[g.id] = g;
  for (const ck of Object.keys(overlayByCK)) {
    for (const e of overlayByCK[ck]) {
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

  newCache.marketsByCanonicalKey   = overlayByCK;
  newCache.marketsByProviderGameId = overlayByPGI;
  newCache.marketCount             = overlayMarketCount;

  console.log(`OWLS_CACHE_SNAPSHOTS_READY games=${newCache.gameCount} markets=${overlayMarketCount}`);

  // Never clobber a populated live cache with an empty snapshot (WS often
  // reconnects with games=0/markets=0 while REST already has a full slate).
  if (newCache.gameCount === 0 && LIVE_MARKET_CACHE.gameCount > 0) {
    console.warn('[owls-cache] refusing empty snapshot overwrite — keeping live cache games='+
      LIVE_MARKET_CACHE.gameCount+' markets='+LIVE_MARKET_CACHE.marketCount);
    return { ok:false, reason:'empty_snapshot_refused', gameCount:0, marketCount:0 };
  }

  if (owlsResults.length > 0) {
    LIVE_MARKET_CACHE = newCache;
    try { _hydrateLiveMarketCacheWithScores(); } catch(_hs) {}
    return { ok:true, gameCount:newCache.gameCount, marketCount:overlayMarketCount,
      sourceStatus:newCache.sourceStatus };
  }
  return { ok:false };
}

// Poll live odds and atomically replace cache
async function pollLiveOddsLoop() {
  const cacheAgeMs = _getLiveCacheAgeMs();
  const criticallyStale = cacheAgeMs > CACHE_STALE_RECOVERY_MS;

  // Provider switch: Owls Insight vs The Odds API
  console.log('[odds-provider] selected='+ODDS_PROVIDER+' hasOwlsKey='+(!!OWLS_KEY)+' hasOddsKey='+(!!ODDS_KEY)+
    ' cacheAgeMs='+cacheAgeMs);

  const quotaBlocked = _oddsApiQuotaBlocked();

  // When cache is critically stale, prefer Odds API refresh (bypasses Owls)
  // unless Owls is the configured provider or quota is exhausted.
  if (criticallyStale && ODDS_KEY && !quotaBlocked && ODDS_PROVIDER !== 'owls_insight') {
    console.warn('[poll] cache critically stale ageMs='+cacheAgeMs+' — forcing Odds API refresh');
    _oddsApiFallbackLastRun = Date.now();
    await _runOddsApiPoll('cache_stale_recovery');
    return;
  }

  if (ODDS_PROVIDER === 'owls_insight' || (quotaBlocked && OWLS_KEY)) {
    if (quotaBlocked && ODDS_PROVIDER !== 'owls_insight') {
      console.warn('[poll] Odds API quota blocked — trying Owls Insight fallback');
    }
    // WebSocket provides real-time updates — skip REST only while connected
    // AND the live cache is still fresh with games. Empty/stale cache must
    // keep REST polling even if the socket reports connected.
    if (_shouldSkipOwlsRestWhileWsConnected()) {
      return;
    }
    const restResult = await _runOwlsRestPoll('poll_tick');
    if (restResult.ok) return;
    // When Owls is the configured provider, never fall back to The Odds API
    // (quota exhausted / empty slate → keep serving Owls cache or empty).
    if (ODDS_PROVIDER === 'owls_insight') return;
    // Owls failed or returned empty. Fall through to the Odds API path when:
    //   (a) the cache is empty (fresh deploy / first poll), OR
    //   (b) the cache is populated but stale (older than PREGAME_SNAPSHOT_TTL_MS)
    // Rate-limited to 1 poll/min so Odds API quota is protected — unless critically stale.
    const _cacheAgeForFb = _getLiveCacheAgeMs();
    const _needsFallback = !LIVE_MARKET_CACHE.gameCount || _cacheAgeForFb >= PREGAME_SNAPSHOT_TTL_MS;
    if (!ODDS_KEY || !_needsFallback || _oddsApiQuotaBlocked()) return;
    const _fbNow = Date.now();
    const _rateLimitOk = criticallyStale ||
      (_fbNow - _oddsApiFallbackLastRun >= _ODDS_API_FALLBACK_INTERVAL_MS);
    if (!_rateLimitOk) return;
    _oddsApiFallbackLastRun = _fbNow;
    console.log('[owls-fallback] Owls unavailable + cache stale ageMs='+_cacheAgeForFb+
      ' — running Odds API fallback poll');
    await _runOddsApiPoll('owls_fallback');
    return;
  }
  // Default provider: The Odds API
  await _runOddsApiPoll('primary');
}

// ════════════════════════════════════════════════════════════════════════════
// OWLS INSIGHT WEBSOCKET (real-time odds-update feed)
// ════════════════════════════════════════════════════════════════════════════

// Map Owls short sport key → canonical cache sport key for normalization.
function _owlsWsSportKey(sport) {
  if (!sport) return 'unknown';
  const s = String(sport).toLowerCase();
  return _CACHE_SPORT_KEY_BY_SHORT[s] || s;
}

// Parse odds-update WebSocket payload into normalized per-sport results.
// WS payloads may mirror the REST /odds response ({ data, success, meta })
// or wrap multiple sports ({ sports: { mlb: {...}, nba: {...} } }).
function _parseOwlsWsOddsPayload(payload) {
  const owlsResults = [];
  const allGames = [];
  if (!payload) return { owlsResults, allGames };

  function _ingest(sportRaw, owlsData) {
    if (!owlsData) return;
    const sportKey = _owlsWsSportKey(sportRaw);
    const wrapped = (owlsData.data || owlsData.events || Array.isArray(owlsData))
      ? owlsData : { data: owlsData };
    const normalized = _normalizeOwlsResponse(wrapped, sportKey);
    if (normalized && normalized.ok) {
      owlsResults.push(normalized);
      normalized.games.forEach(function(g){ allGames.push(g); });
    }
  }

  if (payload.sports && typeof payload.sports === 'object' && !Array.isArray(payload.sports)) {
    Object.keys(payload.sports).forEach(function(sport){ _ingest(sport, payload.sports[sport]); });
    return { owlsResults, allGames };
  }

  if (payload.sport && (payload.data || payload.events || payload.success !== undefined)) {
    _ingest(payload.sport, payload);
    return { owlsResults, allGames };
  }

  const sportGuess = payload.sport_key || payload.sport ||
    (payload.meta && payload.meta.sport) || 'unknown';
  _ingest(sportGuess, payload);
  return { owlsResults, allGames };
}

function _setOwlsWsProviderHealthy() {
  LIVE_MARKET_CACHE = Object.assign({}, LIVE_MARKET_CACHE, { sourceStatus:'healthy' });
}

function _rescheduleOddsPollForWsState() {
  if (typeof _scheduleOddsPollTick === 'function' && _oddsPollerStarted) {
    _scheduleOddsPollTick(_getOddsPollIntervalMs());
  }
}

function _clearOwlsWsEmptyCacheFallback() {
  if (_owlsWsEmptyCacheFallbackTimer) {
    clearTimeout(_owlsWsEmptyCacheFallbackTimer);
    _owlsWsEmptyCacheFallbackTimer = null;
  }
}

function _scheduleOwlsWsEmptyCacheFallback() {
  _clearOwlsWsEmptyCacheFallback();
  if (!OWLS_USE_WEBSOCKET || ODDS_PROVIDER !== 'owls_insight' || !OWLS_KEY) return;
  _owlsWsEmptyCacheFallbackTimer = setTimeout(async function() {
    _owlsWsEmptyCacheFallbackTimer = null;
    if (!_owlsWsConnected) return;
    const age = _getLiveCacheAgeMs();
    const needsRest = !LIVE_MARKET_CACHE.gameCount ||
      !Number.isFinite(age) || age > OWLS_WS_STALE_REST_MS;
    if (!needsRest) return;
    console.warn('[owls-ws] connected but cache empty/stale after '+
      OWLS_WS_EMPTY_CACHE_FALLBACK_MS+'ms ageMs='+age+' — running REST bootstrap');
    try {
      await _triggerImmediateOddsRefresh('ws_empty_cache_fallback');
    } catch (e) {
      console.error('[owls-ws] empty-cache fallback error:', e && e.message);
    }
  }, OWLS_WS_EMPTY_CACHE_FALLBACK_MS);
}

async function _handleOwlsWsOddsUpdate(payload) {
  const start = Date.now();
  try {
    const parsed = _parseOwlsWsOddsPayload(payload);
    const applied = await _applyOwlsResultsToCache(parsed.owlsResults, parsed.allGames, Date.now()-start);
    if (applied.ok) {
      console.log('[owls-ws] odds-update games='+applied.gameCount+' markets='+applied.marketCount);
      try {
        const r = await _upsertOddsSnapshots();
        if (r && r.ok) {
          console.log('SNAPSHOT_UPSERT_RESULT source=owls-ws ok=true rows='+(r.rowsUpserted||0));
        } else {
          console.error('SNAPSHOT_UPSERT_RESULT source=owls-ws ok=false reason='+
            (r && (r.reason||r.error) || 'unknown'));
        }
      } catch (upsertErr) {
        console.error('[owls-ws] snapshot upsert error:', upsertErr && upsertErr.message);
      }
    } else if (applied.reason === 'empty_snapshot_refused') {
      // WS delivered an empty slate while REST cache is populated — keep REST
      // hot so lastSuccessAt cannot freeze behind a "connected" socket.
      const now = Date.now();
      if (now - _owlsWsEmptySnapshotRestAt >= OWLS_WS_FALLBACK_POLL_MS) {
        _owlsWsEmptySnapshotRestAt = now;
        console.warn('[owls-ws] empty snapshot ignored — triggering REST refresh');
        try {
          await _triggerImmediateOddsRefresh('ws_empty_snapshot_fallback');
        } catch (e) {
          console.error('[owls-ws] empty-snapshot REST fallback error:', e && e.message);
        }
      }
      _rescheduleOddsPollForWsState();
    }
  } catch (e) {
    console.error('[owls-ws] odds-update error:', e.message);
  }
}

function _scheduleOwlsWsReconnect() {
  if (_owlsWsReconnectTimer) return;
  _owlsWsReconnectTimer = setTimeout(function() {
    _owlsWsReconnectTimer = null;
    if (!OWLS_USE_WEBSOCKET || !OWLS_KEY) return;
    console.log('[owls-ws] attempting reconnect');
    _initOwlsWebSocket();
  }, OWLS_WS_RECONNECT_MS);
}

function _initOwlsWebSocket() {
  if (!OWLS_USE_WEBSOCKET || !OWLS_KEY || ODDS_PROVIDER !== 'owls_insight') return;
  if (_owlsWsSocket) {
    try { _owlsWsSocket.removeAllListeners(); _owlsWsSocket.disconnect(); } catch(_e) {}
    _owlsWsSocket = null;
  }

  console.log('[owls-ws] connecting url='+OWLS_BASE_URL+' useWebSocket='+OWLS_USE_WEBSOCKET);
  const socket = socketIoClient(OWLS_BASE_URL, {
    query: { apiKey: OWLS_KEY },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: OWLS_WS_RECONNECT_MS,
    reconnectionDelayMax: OWLS_WS_RECONNECT_MS
  });
  _owlsWsSocket = socket;

  socket.on('connect', function() {
    _owlsWsConnected = true;
    _owlsWsForceRestFallback = false;
    console.log('[owls-ws] connected id='+socket.id);
    _setOwlsWsProviderHealthy();
    _rescheduleOddsPollForWsState();
    _scheduleOwlsWsEmptyCacheFallback();
  });

  socket.on('disconnect', function(reason) {
    _owlsWsConnected = false;
    _clearOwlsWsEmptyCacheFallback();
    console.log('[owls-ws] disconnected reason='+reason+' — REST fallback every '+
      OWLS_WS_FALLBACK_POLL_MS+'ms');
    _rescheduleOddsPollForWsState();
  });

  socket.on('connect_error', function(err) {
    const msg = (err && err.message) || String(err || '');
    console.error('[owls-ws] connect error:', msg);
    if (/connection limit/i.test(msg)) {
      _owlsWsForceRestFallback = true;
      _owlsWsConnected = false;
      console.warn('[owls-ws] Connection limit reached — forcing aggressive REST polling every '+
        OWLS_WS_FALLBACK_POLL_MS+'ms (WS slot unavailable)');
      _rescheduleOddsPollForWsState();
      _triggerImmediateOddsRefresh('ws_connection_limit').catch(function(e) {
        console.error('[owls-ws] connection-limit REST fallback error:', e && e.message);
      });
    }
    _scheduleOwlsWsReconnect();
  });

  socket.on('error', function(err) {
    console.error('[owls-ws] error:', err && (err.message || String(err)));
    _scheduleOwlsWsReconnect();
  });

  socket.on('odds-update', function(payload) {
    _handleOwlsWsOddsUpdate(payload);
  });

  // Not yet handled — subscribe when product needs these feeds:
  //   player-props-update    — player props from Pinnacle
  //   draftkings-props-update — DraftKings props
  //   fanduel-props-update   — FanDuel props
  //   esports-update         — CS2, Valorant, LoL, Dota 2
  //   pinnacle-realtime      — sharp odds feed
}

// Boot kick is `_startOddsPoller('boot')` above (setTimeout 0 + watchdog).
// Do not call pollLiveOddsLoopWithSnapshots() again here — a second
// overlapping first tick is what the serialized scheduler is meant to prevent.

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

  // Match outcome by pick name (case-insensitive). Strip "To Win" so
  // lobby "Miami Marlins To Win" matches provider outcome "Miami Marlins".
  const pickNorm = _normalizePickForSnapshotLookup(leg.pick);
  const outcome = (liveMarket.outcomes||[]).find(o =>
    o.name && pickNorm && _normalizePickForSnapshotLookup(o.name) === pickNorm
  );
  if (!outcome) return { ok:false, code:'market_closed', leg:leg.pick, reason:'outcome_not_found' };

  // Drift check (American points)
  const drift = Math.abs(outcome.price - parseInt(leg.odds,10));
  if (drift > 0) {
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
    const pickNorm = _normalizePickForSnapshotLookup(leg.pick);
    const outcome = entry && (entry.outcomes||[]).find(o =>
      o.name && pickNorm && _normalizePickForSnapshotLookup(o.name) === pickNorm);
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
    const pickNorm = _normalizePickForSnapshotLookup(leg.pick);
    const outcome = liveMarket && (liveMarket.outcomes||[]).find(o =>
      o.name && pickNorm && _normalizePickForSnapshotLookup(o.name) === pickNorm);
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
  // NFL slate spans a full week; default 3 days often returns [] mid-week.
  const defaultDays = (_oddsApiSportKey(sport) === 'americanfootball_nfl') ? '7' : '3';
  const daysFrom = req.query.daysFrom || defaultDays;
  try {
    const fetched = await _fetchScoresForSport(sport, daysFrom);
    const games = (fetched && fetched.games) || [];
    if (!games.length && fetched && fetched.error) {
      const status = fetched.errorCode === 'OUT_OF_USAGE_CREDITS' ? 402 : 502;
      return res.status(status).json({ error: fetched.error, error_code: fetched.errorCode || null, source: fetched.source || null });
    }
    res.json(games.map(function(g) {
      const pub = espnScoreboard.toPublicScore(g, sport, fetched && fetched.source);
      if (g.homeLogoUrl) pub.homeLogoUrl = g.homeLogoUrl;
      if (g.awayLogoUrl) pub.awayLogoUrl = g.awayLogoUrl;
      return pub;
    }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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
  // Presentation-only: attach Owls /scores/live fields when odds row lacks them.
  try {
    if ((g.homeScore == null && g.awayScore == null) && typeof LIVE_SCORE_CACHE !== 'undefined' && LIVE_SCORE_CACHE && LIVE_SCORE_CACHE.bySport) {
      var sportShortProbe = String(sportLabel || g.sport_key || '').toLowerCase();
      var idxProbe = LIVE_SCORE_CACHE.bySport[sportShortProbe];
      if (!idxProbe) {
        if (sportShortProbe.indexOf('mlb') >= 0) idxProbe = LIVE_SCORE_CACHE.bySport.mlb;
        else if (sportShortProbe.indexOf('soccer') >= 0) idxProbe = LIVE_SCORE_CACHE.bySport.soccer;
        else if (sportShortProbe.indexOf('tennis') >= 0) idxProbe = LIVE_SCORE_CACHE.bySport.tennis;
        else if (sportShortProbe.indexOf('ncaaf') >= 0) idxProbe = LIVE_SCORE_CACHE.bySport.ncaaf;
        else if (sportShortProbe.indexOf('nfl') >= 0) idxProbe = LIVE_SCORE_CACHE.bySport.nfl;
        else if (sportShortProbe.indexOf('nba') >= 0) idxProbe = LIVE_SCORE_CACHE.bySport.nba;
        else if (sportShortProbe.indexOf('ncaab') >= 0) idxProbe = LIVE_SCORE_CACHE.bySport.ncaab;
        else if (sportShortProbe.indexOf('nhl') >= 0) idxProbe = LIVE_SCORE_CACHE.bySport.nhl;
      }
      if (idxProbe) {
        var scored = owlsLiveScores.matchScoreToGame(g, idxProbe);
        if (scored) owlsLiveScores.applyScoreFieldsToGame(g, scored);
      }
    }
  } catch(_scoreAttach) {}
  var canonicalGameKey = g.canonicalKey || g.canonicalGameKey || null;
  var providerGameId   = g.id || g.providerGameId || null;
  var moneyline = [];
  var spreads   = [];
  var totals    = [];
  var altSpreads = [];
  var altTotals  = [];
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
  // Primary: Owls flat g.markets = [{marketType, teamOrSide, odds, line, sportsbook}]
  // Fallback: Odds API g.bookmakers = [{key, markets:[{key, outcomes:[{name, price, point}]}]}]
  var mkts = Array.isArray(g.markets) ? g.markets : [];
  if (!mkts.length && Array.isArray(g.bookmakers)) {
    g.bookmakers.forEach(function(bm) {
      var bmKey = (bm && (bm.key || bm.id)) || 'odds-api';
      (bm && bm.markets || []).forEach(function(mkt) {
        var mt = mkt.key === 'h2h' ? 'moneyline'
               : mkt.key === 'spreads' ? 'spread'
               : mkt.key === 'totals'  ? 'total'
               : null;
        if (!mt) return;
        (mkt.outcomes || []).forEach(function(oc) {
          mkts.push({ marketType: mt, teamOrSide: oc.name, odds: oc.price,
                      line: oc.point != null ? oc.point : undefined,
                      sportsbook: bmKey });
        });
      });
    });
  }
  for (var i = 0; i < mkts.length; i++) {
    var m = mkts[i]; if (!m) continue;
    var mt = m.marketType; var side = m.teamOrSide; var price = m.odds;
    if (typeof price !== 'number' || !side) continue;
    var key = mt + '|' + side;
    if (mt === 'moneyline') {
      if (_pick(key, m.sportsbook)) {
        var existing = moneyline.findIndex(function(x){ return x.team === side; });
        var row = {
          team: side, odds: price,
          market: 'moneyline',
          canonicalGameKey: m.canonicalGameKey || canonicalGameKey,
          providerGameId:   m.providerGameId   || providerGameId,
          scheduledStart:   g.commence_time || null
        };
        if (existing >= 0) moneyline[existing] = row; else moneyline.push(row);
      }
    } else if (mt === 'spread') {
      if (typeof m.line !== 'number') continue;
      var spKey = mt + '|' + side + '|' + m.line;
      var spTarget = m.isAlternate ? altSpreads : spreads;
      if (_pick(spKey, m.sportsbook)) {
        var ex = spTarget.findIndex(function(x){ return x.team === side && x.line === m.line; });
        var rr = {
          team: side, line: m.line, odds: price,
          market: 'spread',
          canonicalGameKey: m.canonicalGameKey || canonicalGameKey,
          providerGameId:   m.providerGameId   || providerGameId,
          scheduledStart:   g.commence_time || null
        };
        if (ex >= 0) spTarget[ex] = rr; else spTarget.push(rr);
      }
    } else if (mt === 'total') {
      if (typeof m.line !== 'number') continue;
      // Owls Over/Under outcomes share a line; key by side + line.
      var totKey = mt + '|' + side + '|' + m.line;
      var totTarget = m.isAlternate ? altTotals : totals;
      if (_pick(totKey, m.sportsbook)) {
        var et = totTarget.findIndex(function(x){ return x.name === side && x.line === m.line; });
        var rt = {
          name: side, line: m.line, odds: price,
          market: 'total',
          canonicalGameKey: m.canonicalGameKey || canonicalGameKey,
          providerGameId:   m.providerGameId   || providerGameId,
          scheduledStart:   g.commence_time || null
        };
        if (et >= 0) totTarget[et] = rt; else totTarget.push(rt);
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
          canonicalGameKey: m.canonicalGameKey || canonicalGameKey,
          scheduledStart: g.commence_time || null,
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
  var gameStateText = g.gameStateText || _formatGameStateText(sportShort, {
    status, period:g.period, clock:g.clock,
    inning:g.inning, inningHalf:g.inningHalf, outs:g.outs,
    down:g.down, distance:g.distance,
    setScore:g.setScore, gameScore:g.gameScore, statusDetail:g.statusDetail
  });
  var projected = {
    id:    g.id || g.providerGameId || ((g.away_team||'')+'@'+(g.home_team||'')+'@'+(g.commence_time||'')),
    canonicalGameKey: canonicalGameKey,
    providerGameId: providerGameId,
    eventId: g.eventId || g.owlsEventId || null,
    sport: sportLabel || g.sport_key || '',
    home:  g.home_team || '',
    away:  g.away_team || '',
    time:  g.commence_time || null,
    scheduledStart: g.commence_time || null,
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
    setScore:  g.setScore  || null,
    gameScore: g.gameScore || null,
    statusDetail: g.statusDetail || null,
    gameStateText: gameStateText,
    league: g.league || null,
    moneyline: moneyline,
    spreads:   spreads,
    totals:    totals,
    alt_spreads: altSpreads,
    alt_totals:  altTotals,
    // Player props — array of { propType, playerName, team, line, overOdds,
    // underOdds, marketKey, providerGameId }. Empty when the feed doesn't
    // provide props for this game.
    props:     props
  };
  // Presentation-only team logo enrichment — never affects markets/odds/IDs.
  _attachNcaafTeamLogos(projected, sportShort, g);
  _attachSoccerTeamLogos(projected, sportShort, g);
  return projected;
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
    if (s.statusDetail) return String(s.statusDetail);
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
    if (s.clock) {
      var clk = String(s.clock);
      return /'$/.test(clk) ? clk : clk + "'";
    }
    if (s.statusDetail && /^\d/.test(String(s.statusDetail))) return String(s.statusDetail);
    return '';
  }
  if (sp.indexOf('tennis') >= 0) {
    var bits = [];
    if (s.setScore) bits.push(String(s.setScore));
    else if (s.period != null) bits.push('Set ' + s.period);
    if (s.gameScore) bits.push(String(s.gameScore));
    else if (s.statusDetail) bits.push(String(s.statusDetail));
    return bits.join(' · ');
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
// For sport=soccer, combine the soccer feed (and any soccer_* keys in cache).
// For sport=tennis, combine the tennis feed (ATP/WTA share Owls path `tennis`).
// Golf / rugby lobby tabs likewise roll tour / union+league keys together.
function _owlsCacheFlatGamesForSport(requestedSport, sportLabel) {
  var cache = (typeof LIVE_MARKET_CACHE !== 'undefined') ? LIVE_MARKET_CACHE : null;
  if (!cache || !Array.isArray(cache.games) || !cache.games.length) return [];
  var short = String(requestedSport||'').toLowerCase();
  var full  = _CACHE_SPORT_KEY_BY_SHORT[short] || short;
  var combineSoccer = (short === 'soccer');
  var combineTennis = (short === 'tennis');
  var combineGolf = (short === 'golf');
  var combineRugby = (short === 'rugby');
  var combineMma = (short === 'mma');
  var out = [];
  var seenIds = {};
  for (var i = 0; i < cache.games.length; i++) {
    var g = cache.games[i];
    if (combineSoccer) {
      if (!_isSoccerCacheSportKey(g.sport_key)) continue;
    } else if (combineTennis) {
      if (!_isTennisCacheSportKey(g.sport_key)) continue;
    } else if (combineGolf) {
      if (!_isGolfCacheSportKey(g.sport_key)) continue;
    } else if (combineRugby) {
      if (!_isRugbyCacheSportKey(g.sport_key)) continue;
    } else if (combineMma) {
      if (!_isMmaCacheSportKey(g.sport_key)) continue;
    } else if (!_isMatchingSport(g.sport_key, short, full)) {
      continue;
    }
    var flat = _projectOwlsGameToFlat(g, sportLabel || short.toUpperCase());
    if (flat && flat.home && flat.away) {
      var dedupe = flat.id || (flat.away+'@'+flat.home+'@'+flat.time);
      if (seenIds[dedupe]) continue;
      seenIds[dedupe] = true;
      out.push(flat);
    }
  }
  return out;
}

app.get('/api/odds/:sport', async (req, res) => {
  const sportMap = { nfl:'americanfootball_nfl', nba:'basketball_nba', mlb:'baseball_mlb', nhl:'icehockey_nhl', soccer:'soccer_usa_mls', ufl:'americanfootball_ufl' };
  const sportShort = String(req.params.sport||'').toLowerCase();
  const sport = sportMap[sportShort] || sportShort;
  // ── Owls Insight path: serve from the in-memory cache the poller fills.
  // Never fall back to The Odds API when Owls is the configured provider
  // (empty cache → 200 + [] — not 402 from exhausted Odds API quota).
  if (ODDS_PROVIDER === 'owls_insight') {
    const flat = _owlsCacheFlatGamesForSport(sportShort, sportShort.toUpperCase());
    const cache = (typeof LIVE_MARKET_CACHE !== 'undefined') ? LIVE_MARKET_CACHE : null;
    res.setHeader('X-Provider',      'owls_insight');
    res.setHeader('X-Source-Status', (cache && cache.sourceStatus) || 'unknown');
    res.setHeader('X-Games-Count',   String(flat.length));
    if (sportShort === 'soccer') {
      res.setHeader('X-Soccer-Leagues', OWLS_SOCCER_TAB_KEYS.join(','));
    }
    if (sportShort === 'tennis') {
      res.setHeader('X-Tennis-Keys', OWLS_TENNIS_TAB_KEYS.join(','));
    }
    if (sportShort === 'golf') {
      res.setHeader('X-Golf-Keys', OWLS_GOLF_TAB_KEYS.join(','));
    }
    if (sportShort === 'rugby') {
      res.setHeader('X-Rugby-Keys', OWLS_RUGBY_TAB_KEYS.join(','));
    }
    if (sportShort === 'mma') {
      res.setHeader('X-Mma-Keys', OWLS_MMA_TAB_KEYS.join(','));
    }
    if (cache && cache.updatedAt) {
      res.setHeader('X-Cache-Age',   String(Math.max(0, Math.round((Date.now() - new Date(cache.updatedAt).getTime()) / 1000))));
    }
    // Sort live games first, then upcoming by commence_time, then final at the bottom.
    flat.sort(_compareGamesForBoard);
    console.log('[odds] source=owls-cache sport='+sportShort+' games='+flat.length+
      ' live='+flat.filter(function(g){return g.status==='live';}).length+
      (sportShort === 'soccer' ? ' leagues='+OWLS_SOCCER_TAB_KEYS.join('+') : '')+
      (sportShort === 'tennis' ? ' keys='+OWLS_TENNIS_TAB_KEYS.join('+') : '')+
      (sportShort === 'golf' ? ' keys='+OWLS_GOLF_TAB_KEYS.join('+') : '')+
      (sportShort === 'rugby' ? ' keys='+OWLS_RUGBY_TAB_KEYS.join('+') : '')+
      (sportShort === 'mma' ? ' keys='+OWLS_MMA_TAB_KEYS.join('+') : '')+
      ' sourceStatus='+(cache&&cache.sourceStatus||'unknown'));
    // MMA fight cards are denser than major-league boards — allow a wider page.
    var boardLimit = (sportShort === 'mma') ? 80 : 50;
    return res.json(flat.slice(0, boardLimit));
  }
  // ── Legacy Odds API path (only when ODDS_PROVIDER != owls_insight) ─
  console.log('[odds] source=backend-proxy sport='+req.params.sport+' key_fingerprint='+(ODDS_KEY?ODDS_KEY.slice(0,4)+'...'+ODDS_KEY.slice(-4):'MISSING'));
  try {
    const games = await fetchOdds(sport);
    if (games === null) { return res.status(503).json({ error: 'ODDS_API_KEY not configured on server.' }); }
    if (games && games._error) { return res.status(402).json({ error: games._message, error_code: games._error }); }
    const formatted = await Promise.all((Array.isArray(games) ? games : []).slice(0,20).map(async function(g) {
      const status = _deriveGameStatus(g);
      const canonicalGameKey = await _buildCKeyFromGame(g);
      const baseMeta = {
        canonicalGameKey,
        providerGameId: g.id || null,
        scheduledStart: g.commence_time || null
      };
      return {
        id: g.id, sport: g.sport_title||req.params.sport.toUpperCase(),
        canonicalGameKey,
        providerGameId: g.id || null,
        home: g.home_team, away: g.away_team, time: g.commence_time,
        scheduledStart: g.commence_time || null,
        status, isLive: status==='live', isFinal: status==='final', isCanceled: status==='canceled',
        // Odds API /odds doesn't include live scores — hydrate from /scores cache when present
        homeScore: null, awayScore: null, period:null, clock:null, inning:null,
        outs:null, basesOccupied:null, possession:null, gameStateText: status==='final'?'Final':'',
        spreads: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='spreads')?.outcomes||[]).map(o=>Object.assign({team:o.name,line:o.point,odds:o.price,market:'spread'}, baseMeta)),
        totals: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='totals')?.outcomes||[]).map(o=>Object.assign({name:o.name,line:o.point,odds:o.price,market:'total'}, baseMeta)),
        moneyline: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='h2h')?.outcomes||[]).map(o=>Object.assign({team:o.name,odds:o.price,market:'moneyline'}, baseMeta)),
        // Legacy Odds API path doesn't currently surface props; the Owls
        // path is the source of player props. Empty array keeps the UI
        // contract uniform.
        props: []
      };
    }));
    formatted.sort(_compareGamesForBoard);
    res.json(formatted);
  } catch(e) { console.error('Odds endpoint error:', e.message); res.json([]); }
});

function _amToDecimalCmp(odds) {
  var n = parseFloat(odds);
  if (!isFinite(n) || n === 0) return null;
  return n > 0 ? (n / 100) + 1 : (100 / Math.abs(n)) + 1;
}
function _bookShortLabel(name) {
  var k = String(name || '').toLowerCase();
  if (k.indexOf('draftkings') >= 0 || k === 'dk') return 'DK';
  if (k.indexOf('fanduel') >= 0 || k === 'fd') return 'FD';
  if (k.indexOf('betmgm') >= 0 || k.indexOf('mgm') >= 0) return 'BetMGM';
  if (k.indexOf('caesars') >= 0) return 'Caesars';
  if (k.indexOf('pinnacle') >= 0) return 'PIN';
  return String(name || 'MKT');
}
function _cmpMarketKey(mt) {
  var m = String(mt || '').toLowerCase();
  if (m === 'h2h' || m === 'ml' || m === 'moneyline') return 'moneyline';
  if (m === 'spreads' || m === 'spread') return 'spread';
  if (m === 'totals' || m === 'total') return 'total';
  if (m === 'player_prop' || m === 'prop') return 'player_prop';
  return m;
}

function _buildOddsComparisonForSport(sportShort) {
  var cache = (typeof LIVE_MARKET_CACHE !== 'undefined') ? LIVE_MARKET_CACHE : null;
  var markets = [];
  if (!cache || !Array.isArray(cache.games)) {
    return { ok:true, sport: sportShort, markets: markets, gameCount: 0 };
  }
  var short = String(sportShort || '').toLowerCase();
  var full = _CACHE_SPORT_KEY_BY_SHORT[short] || short;
  var combineSoccer = (short === 'soccer');
  var combineTennis = (short === 'tennis');
  var combineGolf = (short === 'golf');
  var combineRugby = (short === 'rugby');
  var MAIN_BOOKS = { draftkings:1, fanduel:1, betmgm:1, caesars:1 };

  for (var i = 0; i < cache.games.length; i++) {
    var g = cache.games[i];
    if (!g) continue;
    if (combineSoccer) {
      if (!_isSoccerCacheSportKey(g.sport_key)) continue;
    } else if (combineTennis) {
      if (!_isTennisCacheSportKey(g.sport_key)) continue;
    } else if (combineGolf) {
      if (!_isGolfCacheSportKey(g.sport_key)) continue;
    } else if (combineRugby) {
      if (!_isRugbyCacheSportKey(g.sport_key)) continue;
    } else if (!_isMatchingSport(g.sport_key, short, full)) {
      continue;
    }
    var gameId = g.id || g.providerGameId || '';
    var mkts = Array.isArray(g.markets) ? g.markets.slice() : [];
    if (!mkts.length && Array.isArray(g.bookmakers)) {
      g.bookmakers.forEach(function(bm) {
        var bmKey = (bm && (bm.key || bm.id)) || 'odds-api';
        (bm && bm.markets || []).forEach(function(mkt) {
          var mt = _cmpMarketKey(mkt.key);
          (mkt.outcomes || []).forEach(function(oc) {
            mkts.push({
              marketType: mt, teamOrSide: oc.name, odds: oc.price,
              line: oc.point != null ? oc.point : undefined,
              sportsbook: bmKey, playerName: oc.description || oc.player || null,
              overUnder: oc.name
            });
          });
        });
      });
    }
    // Group quotes by market+side+line. Our displayed line prefers Pinnacle
    // (same rule as _projectOwlsGameToFlat). Market best is the highest
    // decimal among DK/FD/BetMGM.
    var groups = {};
    mkts.forEach(function(m) {
      if (!m || typeof m.odds !== 'number') return;
      var mt = _cmpMarketKey(m.marketType);
      var side = m.teamOrSide || m.playerName || '';
      if (!side) return;
      var line = (m.line != null && m.line !== '') ? m.line : '';
      var key = mt + '|' + String(side).toLowerCase() + '|' + String(line);
      if (!groups[key]) groups[key] = { market: mt, pick: side, line: line === '' ? null : line, quotes: [] };
      groups[key].quotes.push({
        book: m.sportsbook || 'unknown',
        odds: m.odds,
        dec: _amToDecimalCmp(m.odds)
      });
    });
    Object.keys(groups).forEach(function(key) {
      var grp = groups[key];
      var our = null;
      grp.quotes.forEach(function(q) {
        if (!q.dec) return;
        if (!our) { our = q; return; }
        if (String(q.book).toLowerCase() === 'pinnacle' && String(our.book).toLowerCase() !== 'pinnacle')
          our = q;
      });
      if (!our) return;
      var retail = grp.quotes.filter(function(q) {
        var k = String(q.book || '').toLowerCase();
        return MAIN_BOOKS[k] || k.indexOf('draftkings')>=0 || k.indexOf('fanduel')>=0 || k.indexOf('betmgm')>=0;
      });
      var pool = retail.length ? retail : grp.quotes;
      var best = null;
      var sum = 0, n = 0;
      pool.forEach(function(q) {
        if (!q.dec) return;
        sum += q.dec; n++;
        if (!best || q.dec > best.dec) best = q;
      });
      var avg = n ? (sum / n) : our.dec;
      var direction = 'even';
      if (our.dec - avg > 0.012) direction = 'better';
      else if (best && best.dec - our.dec > 0.012) direction = 'worse';
      markets.push({
        gameId: gameId,
        home: g.home_team || g.home || '',
        away: g.away_team || g.away || '',
        market: grp.market,
        pick: grp.pick,
        line: grp.line,
        ourOdds: our.odds,
        ourBook: _bookShortLabel(our.book),
        marketBestOdds: best ? best.odds : our.odds,
        bestBook: best ? _bookShortLabel(best.book) : _bookShortLabel(our.book),
        marketAvgDecimal: Math.round(avg * 1000) / 1000,
        direction: direction
      });
    });
  }
  return { ok:true, sport: sportShort, markets: markets, gameCount: cache.games.length };
}

// GET /api/odds-comparison/:sport — our line vs Owls multi-book market (cache only)
app.get('/api/odds-comparison/:sport', async (req, res) => {
  const sportShort = String(req.params.sport || '').toLowerCase();
  try {
    const payload = _buildOddsComparisonForSport(sportShort);
    res.json(payload);
  } catch(e) {
    console.error('[odds-comparison]', e.message);
    res.status(500).json({ ok:false, error:e.message, markets:[] });
  }
});

// ── GET /api/props/:sport ───────────────────────────────────────────────────
// Fetches player props from Owls /api/v1/{sport}/props. 60s response cache.
const _PROPS_RESPONSE_CACHE = Object.create(null);
const PROPS_CACHE_TTL_MS = 60 * 1000;
const PROPS_SUPPORTED_SPORTS = ['mlb', 'nba', 'nfl', 'nhl', 'ncaab', 'ncaaf', 'wnba'];
const _PROPS_DISPLAY_BOOKS = ['draftkings', 'fanduel', 'betmgm', 'caesars'];
const _PROPS_EXCLUDED_BOOKS = ['pinnacle'];
// Props fetch books — prefer mainstream US books (not sharp/pinnacle-only).
const _PROPS_FETCH_BOOKS = (process.env.OWLS_PROPS_BOOKS || 'draftkings,fanduel,betmgm,caesars')
  .split(',').map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean);
const _PROPS_MAX_ABS_ODDS = 2000;
// NFL display prop types we always want to surface when Owls posts them.
const _NFL_PROP_TYPES_INCLUDE = {
  'Passing Yards': 1, 'Passing TDs': 1, 'Pass Completions': 1,
  'Interceptions Thrown': 1, 'Rushing Yards': 1, 'Receiving Yards': 1,
  'Receptions': 1, 'Anytime TD': 1, 'First TD': 1, 'Sacks': 1, 'Tackles': 1,
  'Rushing TDs': 1, 'Receiving TDs': 1, 'Pass Attempts': 1, 'Tackles + Asts': 1
};
// Discrete allowed lines (exact match). MLB keep tight; NFL counting stats use
// ranges below so milestone / alt half-points aren't wiped.
const _PROPS_ALLOWED_LINES_BY_CATEGORY = {
  // MLB
  'Hits': [0.5, 1.5, 2.5],
  'Strikeouts': [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
  'Home Runs': [0.5],
  'RBIs': [0.5, 1.5, 2.5]
};
// Continuous ranges — NFL yardage + counting stats (alts included).
const _PROPS_LINE_RANGES_BY_CATEGORY = {
  'Passing Yards': { min: 0.5, max: 499.5 },
  'Rushing Yards': { min: 0.5, max: 249.5 },
  'Receiving Yards': { min: 0.5, max: 249.5 },
  'Passing TDs': { min: 0.5, max: 7.5 },
  'Rushing TDs': { min: 0.5, max: 5.5 },
  'Receiving TDs': { min: 0.5, max: 5.5 },
  'Anytime TD': { min: 0.5, max: 0.5 },
  'First TD': { min: 0.5, max: 0.5 },
  'Receptions': { min: 0.5, max: 20.5 },
  'Pass Completions': { min: 0.5, max: 55.5 },
  'Pass Attempts': { min: 0.5, max: 70.5 },
  'Interceptions Thrown': { min: 0.5, max: 5.5 },
  'Sacks': { min: 0.5, max: 6.5 },
  'Tackles': { min: 0.5, max: 20.5 },
  'Tackles + Asts': { min: 0.5, max: 20.5 }
};
const _OWLS_PROP_CATEGORY_LABELS = {
  hits: 'Hits', runs: 'Runs Scored', rbis: 'RBIs', home_runs: 'Home Runs',
  stolen_bases: 'Stolen Bases', total_bases: 'Total Bases',
  strikeouts_pitcher: 'Strikeouts', strikeouts_batter: 'Strikeouts',
  walks: 'Walks', earned_runs: 'Earned Runs', outs_recorded: 'Pitching Outs',
  hits_allowed: 'Hits Allowed', hits_runs_rbis: 'Hits + Runs + RBIs',
  points: 'Points', rebounds: 'Rebounds', assists: 'Assists',
  threes_made: '3-Pointers Made', steals: 'Steals', blocks: 'Blocks',
  pts_rebs: 'Pts + Reb', pts_asts: 'Pts + Ast', rebs_asts: 'Reb + Ast',
  pts_rebs_asts: 'Pts + Reb + Ast',
  passing_yards: 'Passing Yards', passing_tds: 'Passing TDs',
  pass_yards: 'Passing Yards', pass_tds: 'Passing TDs',
  pass_completions: 'Pass Completions', completions: 'Pass Completions',
  pass_attempts: 'Pass Attempts', attempts: 'Pass Attempts',
  pass_interceptions: 'Interceptions Thrown', interceptions: 'Interceptions Thrown',
  rushing_yards: 'Rushing Yards', rushing_tds: 'Rushing TDs',
  rush_yards: 'Rushing Yards', rush_tds: 'Rushing TDs',
  receiving_yards: 'Receiving Yards', reception_yards: 'Receiving Yards',
  receiving_tds: 'Receiving TDs', reception_tds: 'Receiving TDs',
  receptions: 'Receptions',
  touchdowns: 'Anytime TD', anytime_td: 'Anytime TD',
  first_td: 'First TD', player_first_td: 'First TD',
  sacks: 'Sacks', player_sacks: 'Sacks',
  tackles: 'Tackles', player_tackles: 'Tackles',
  player_tackles_assists: 'Tackles + Asts', tackles_assists: 'Tackles + Asts',
  goals: 'Goals', hockey_assists: 'Assists', hockey_points: 'Points',
  shots_on_goal: 'Shots on Goal'
};

function _americanToImpliedPct(odds) {
  var o = parseInt(odds, 10);
  if (!o || isNaN(o)) return 50;
  if (o > 0) return Math.round(100 / (o / 100 + 1));
  return Math.round((Math.abs(o) / (Math.abs(o) + 100)) * 100);
}

function _owlsPropCategoryLabel(category) {
  var k = String(category || '').toLowerCase();
  if (_OWLS_PROP_CATEGORY_LABELS[k]) return _OWLS_PROP_CATEGORY_LABELS[k];
  var mapped = _owlsPropType(k);
  if (mapped) return mapped;
  return k.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

function _betterAmericanOdds(a, b) {
  if (typeof a !== 'number' || isNaN(a)) return b;
  if (typeof b !== 'number' || isNaN(b)) return a;
  return a > b ? a : b;
}

function _propLineCategory(propType) {
  var t = String(propType || '').trim();
  // ----- MLB (exact / narrow — must not match NFL labels) -----
  if (t === 'Hits' || /to record a hit/i.test(t)) return 'Hits';
  if (t === 'Strikeouts' || /^pitcher\s+strikeouts$/i.test(t) || /\bstrikeouts?\b/i.test(t)) {
    // Guard: only treat as MLB Ks when it looks like a pitching/batter K market
    if (/pass|rush|receiv|sack|yard|completion|attempt|td|touchdown/i.test(t)) return null;
    return 'Strikeouts';
  }
  if (t === 'Home Runs' || /home\s*runs?/i.test(t)) return 'Home Runs';
  if (t === 'RBIs' || /\brbis?\b/i.test(t)) return 'RBIs';
  // ----- NFL / NCAAF -----
  if (t === 'Passing Yards' || /passing\s*yards?/i.test(t) || /pass\s*yards?/i.test(t)) return 'Passing Yards';
  if (t === 'Rushing Yards' || /rushing\s*yards?/i.test(t) || /rush\s*yards?/i.test(t)) return 'Rushing Yards';
  if (t === 'Receiving Yards' || /receiving\s*yards?/i.test(t) || /reception\s*yards?/i.test(t)) return 'Receiving Yards';
  if (t === 'Passing TDs' || /passing\s*t(?:d|ouchdown)s?/i.test(t) || /pass\s*t(?:d|ouchdown)s?/i.test(t)) return 'Passing TDs';
  if (t === 'Rushing TDs' || /rushing\s*t(?:d|ouchdown)s?/i.test(t) || /rush\s*t(?:d|ouchdown)s?/i.test(t)) return 'Rushing TDs';
  if (t === 'Receiving TDs' || /receiving\s*t(?:d|ouchdown)s?/i.test(t) || /reception\s*t(?:d|ouchdown)s?/i.test(t)) return 'Receiving TDs';
  if (t === 'Anytime TD' || /anytime\s*t(?:d|ouchdown)/i.test(t)) return 'Anytime TD';
  if (t === 'First TD' || /first\s*t(?:d|ouchdown)/i.test(t)) return 'First TD';
  if (t === 'Receptions' || /^receptions$/i.test(t)) return 'Receptions';
  if (t === 'Pass Completions' || /pass\s*completions?/i.test(t) || /^completions$/i.test(t)) return 'Pass Completions';
  if (t === 'Pass Attempts' || /pass\s*attempts?/i.test(t) || /^attempts$/i.test(t)) return 'Pass Attempts';
  if (t === 'Interceptions Thrown' || /interceptions?\s*(thrown)?$/i.test(t)) return 'Interceptions Thrown';
  if (t === 'Sacks' || /^sacks?$/i.test(t)) return 'Sacks';
  if (t === 'Tackles' || /^tackles$/i.test(t)) return 'Tackles';
  if (t === 'Tackles + Asts' || /tackles?\s*\+?\s*asts?/i.test(t)) return 'Tackles + Asts';
  return null;
}

function _isHalfPointLine(line) {
  // Books almost always post .5 lines for O/U props; allow integers too.
  return Number.isFinite(line) && (Math.abs(line * 2) % 1 < 1e-9);
}

function _isAllowedPropLine(propType, line) {
  if (typeof line !== 'number' || isNaN(line)) return false;
  var cat = _propLineCategory(propType);
  // Unknown categories: keep (do not let MLB-only rules wipe NFL/NBA/etc.).
  if (!cat) return true;
  var allowed = _PROPS_ALLOWED_LINES_BY_CATEGORY[cat];
  if (allowed) return allowed.indexOf(line) >= 0;
  var range = _PROPS_LINE_RANGES_BY_CATEGORY[cat];
  if (range) {
    if (line < range.min || line > range.max) return false;
    return _isHalfPointLine(line);
  }
  return true;
}

function _normalizePropsSportParam(sport) {
  var s = String(sport || '').toLowerCase();
  var mapped = _mapToOwlsSport(s);
  return mapped || s;
}

function _selectMainstreamPropBooks(books) {
  var list = Array.isArray(books) ? books : [];
  var mainstream = list.filter(function(b) {
    var k = String(b && b.key || '').toLowerCase();
    return _PROPS_DISPLAY_BOOKS.indexOf(k) >= 0;
  });
  if (mainstream.length) return mainstream;
  // Prefer non-pinnacle when present, but NEVER wipe the board — if the only
  // books Owls returned are sharp/excluded, keep them so NFL props still surface.
  var nonExcluded = list.filter(function(b) {
    var k = String(b && b.key || '').toLowerCase();
    return _PROPS_EXCLUDED_BOOKS.indexOf(k) < 0;
  });
  return nonExcluded.length ? nonExcluded : list;
}

function _propYesNoOdds(prop) {
  // Owls yes/no (Anytime TD / First TD) may use yesPrice/noPrice or a single price.
  var yesOdds = null;
  var noOdds = null;
  if (typeof prop.yesPrice === 'number') yesOdds = prop.yesPrice;
  else if (typeof prop.yesOdds === 'number') yesOdds = prop.yesOdds;
  else if (typeof prop.price === 'number' && prop.side !== 'no' && prop.side !== 'under') yesOdds = prop.price;
  if (typeof prop.noPrice === 'number') noOdds = prop.noPrice;
  else if (typeof prop.noOdds === 'number') noOdds = prop.noOdds;
  return { yesOdds: yesOdds, noOdds: noOdds };
}

function _propsDedupeKey(p) {
  // Exact identity for display: player + prop type + line + side (case-insensitive).
  // Keep best American odds only — never emit book-level duplicates.
  return [
    String(p.playerName || '').toLowerCase().trim(),
    String(p.propType || '').toLowerCase().trim(),
    String(p.line),
    String(p.side || '').toLowerCase().trim()
  ].join('|');
}

function _filterPropsForDisplay(props) {
  var list = Array.isArray(props) ? props : [];
  var bestByKey = Object.create(null);
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!p || !p.playerName) continue;
    if (typeof p.odds !== 'number' || isNaN(p.odds)) continue;
    if (Math.abs(p.odds) > _PROPS_MAX_ABS_ODDS) continue;
    // Drop basketball "Points" that sometimes leaks into NFL Owls payloads.
    if (String(p.sport || '').toUpperCase() === 'NFL' && String(p.propType || '') === 'Points') continue;
    if (!_isAllowedPropLine(p.propType, p.line)) continue;
    var dedupeKey = _propsDedupeKey(p);
    var prev = bestByKey[dedupeKey];
    if (!prev || p.odds > prev.odds) bestByKey[dedupeKey] = p;
  }
  var out = Object.keys(bestByKey).map(function(k) { return bestByKey[k]; });
  out.sort(function(a, b) {
    if (a.propType !== b.propType) return a.propType < b.propType ? -1 : 1;
    if (a.playerName !== b.playerName) return (a.playerName || '').localeCompare(b.playerName || '');
    if (a.line !== b.line) return Number(a.line) - Number(b.line);
    return (a.side || '').localeCompare(b.side || '');
  });
  return out;
}

function _normalizeOwlsPropsApiResponse(owlsData, sportShort) {
  if (!owlsData || owlsData.success === false) return [];
  var games = Array.isArray(owlsData.data) ? owlsData.data
    : (Array.isArray(owlsData.games) ? owlsData.games
    : (Array.isArray(owlsData) ? owlsData : []));
  var out = [];
  var sportLabel = String(sportShort || '').toUpperCase();
  for (var gi = 0; gi < games.length; gi++) {
    var game = games[gi];
    if (!game) continue;
    var home = game.homeTeam || game.home_team || '';
    var away = game.awayTeam || game.away_team || '';
    var gameId = game.gameId || game.id || null;
    var books = _selectMainstreamPropBooks(game.books || game.bookmakers || []);
    // Some Owls payloads put props on the game itself (no per-book nesting).
    if ((!books || !books.length) && Array.isArray(game.props) && game.props.length) {
      books = [{ key: 'owls', props: game.props }];
    }
    var bestByKey = Object.create(null);
    for (var bi = 0; bi < books.length; bi++) {
      var book = books[bi];
      var props = Array.isArray(book && book.props) ? book.props
        : (Array.isArray(book && book.markets) ? book.markets : []);
      for (var pi = 0; pi < props.length; pi++) {
        var prop = props[pi];
        if (!prop) continue;
        var playerName = prop.playerName || prop.player || prop.name || null;
        if (!playerName) continue;
        var propType = _owlsPropCategoryLabel(
          prop.category || prop.propType || prop.market || prop.marketKey || prop.key
        );
        var line = prop.line;
        if (typeof line !== 'number' || isNaN(line)) {
          // Yes/no TD markets often omit line — treat as 0.5 so UI can show them.
          if (/anytime\s*td|first\s*td|last\s*td/i.test(propType) || prop.yesPrice != null || prop.noPrice != null) {
            line = 0.5;
          } else {
            continue;
          }
        }
        var overOdds = (typeof prop.overPrice === 'number') ? prop.overPrice
          : ((typeof prop.overOdds === 'number') ? prop.overOdds : null);
        var underOdds = (typeof prop.underPrice === 'number') ? prop.underPrice
          : ((typeof prop.underOdds === 'number') ? prop.underOdds : null);
        if (overOdds == null && underOdds == null) {
          var yn = _propYesNoOdds(prop);
          if (typeof yn.yesOdds === 'number') overOdds = yn.yesOdds;
          if (typeof yn.noOdds === 'number') underOdds = yn.noOdds;
        }
        var dedupeKey = String(playerName).toLowerCase() + '|' + propType + '|' + line;
        if (bestByKey[dedupeKey]) {
          var existing = bestByKey[dedupeKey];
          existing.overOdds = _betterAmericanOdds(existing.overOdds, overOdds);
          existing.underOdds = _betterAmericanOdds(existing.underOdds, underOdds);
        } else {
          bestByKey[dedupeKey] = {
            propType: propType,
            playerName: playerName,
            team: prop.team || prop.playerTeam || null,
            line: line,
            overOdds: overOdds,
            underOdds: underOdds
          };
        }
      }
    }
    Object.keys(bestByKey).forEach(function(key) {
      var p = bestByKey[key];
      var base = {
        gameId: gameId,
        canonicalGameKey: game.canonicalGameKey || null,
        home: home,
        away: away,
        scheduledStart: game.commenceTime || game.commence_time || game.startTime || null,
        sport: sportLabel,
        propType: p.propType,
        playerName: p.playerName,
        team: p.team,
        line: p.line
      };
      if (typeof p.overOdds === 'number') {
        out.push(Object.assign({}, base, {
          side: 'over',
          odds: p.overOdds,
          pick: p.playerName + ' Over ' + p.line + ' ' + p.propType
        }));
      }
      if (typeof p.underOdds === 'number') {
        out.push(Object.assign({}, base, {
          side: 'under',
          odds: p.underOdds,
          pick: p.playerName + ' Under ' + p.line + ' ' + p.propType
        }));
      }
    });
  }
  out.sort(function(a, b) {
    if (a.propType !== b.propType) return a.propType < b.propType ? -1 : 1;
    if (a.playerName !== b.playerName) return (a.playerName || '').localeCompare(b.playerName || '');
    return (a.side || '').localeCompare(b.side || '');
  });
  return out;
}

function _fetchOwlsPropsOnce(sportShort, booksCsv) {
  if (!OWLS_KEY) return Promise.resolve({ ok: false, error: 'owls_insight_not_configured' });
  var owlsSport = _mapToOwlsSport(sportShort);
  if (!owlsSport) return Promise.resolve({ ok: false, error: 'unsupported_sport:' + sportShort });
  var path = '/api/v1/' + owlsSport + '/props';
  var url = OWLS_BASE_URL + path + '?books=' + encodeURIComponent(booksCsv || OWLS_BOOKS);
  return new Promise(function(resolve) {
    var parsed;
    try { parsed = new URL(url); } catch (_e) {
      return resolve({ ok: false, error: 'invalid_url', url: url });
    }
    var reqPath = parsed.pathname + parsed.search;
    var driver = parsed.protocol === 'https:' ? https : require('http');
    var chunks = [];
    var req = driver.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: reqPath,
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + OWLS_KEY,
        Accept: 'application/json',
        'User-Agent': 'PocketBooksSports/2.0'
      }
    }, function(res) {
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString('utf8');
        var bodyPreview = body.slice(0, 160).replace(/\s+/g, ' ');
        if (res.statusCode !== 200) {
          console.warn('[owls-props] fetch http error sport=' + sportShort + ' status=' + res.statusCode +
            ' url=' + reqPath + ' body=' + bodyPreview);
          return resolve({ ok: false, error: 'owls_props_http_error', status: res.statusCode, url: url });
        }
        try {
          var data = JSON.parse(body);
          var props = _normalizeOwlsPropsApiResponse(data, sportShort);
          var gameCount = Array.isArray(data.data) ? data.data.length
            : (Array.isArray(data.games) ? data.games.length : 0);
          console.log('[owls-props] fetch ok sport=' + sportShort + ' url=' + reqPath +
            ' games=' + gameCount + ' props=' + props.length);
          resolve({ ok: true, props: props, url: url, raw: data });
        } catch (_e) {
          console.warn('[owls-props] fetch json parse error sport=' + sportShort + ' url=' + reqPath +
            ' detail=' + _e.message + ' body=' + bodyPreview);
          resolve({ ok: false, error: 'owls_props_json_error', url: url });
        }
      });
    });
    req.on('error', function(e) {
      console.warn('[owls-props] fetch network error sport=' + sportShort + ' url=' + reqPath + ' detail=' + e.message);
      resolve({ ok: false, error: 'owls_props_network_error', url: url });
    });
    req.setTimeout(15000, function() {
      req.destroy();
      console.warn('[owls-props] fetch timeout sport=' + sportShort + ' url=' + reqPath);
      resolve({ ok: false, error: 'owls_props_timeout', url: url });
    });
    req.end();
  });
}

async function fetchPropsFromOwlsInsight(sportShort) {
  // Prefer mainstream US books for display props; fall back to configured OWLS_BOOKS.
  var primaryBooks = (_PROPS_FETCH_BOOKS && _PROPS_FETCH_BOOKS.length)
    ? _PROPS_FETCH_BOOKS.join(',')
    : (OWLS_BOOKS || 'draftkings,fanduel,betmgm,caesars');
  var first = await _fetchOwlsPropsOnce(sportShort, primaryBooks);
  var merged = (first.ok && first.props) ? first.props.slice() : [];
  // NFL/NCAAF: if thin, merge a second fetch with sharp+soft books so we clear 50+.
  var needExpand = String(sportShort || '').toLowerCase() === 'nfl'
    || String(sportShort || '').toLowerCase() === 'ncaaf';
  if (needExpand && merged.length < 50) {
    var expandBooks = Array.from(new Set(
      (primaryBooks + ',' + (OWLS_BOOKS || '') + ',pinnacle,bet365,williamhill_us,bovada')
        .split(',').map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean)
    )).join(',');
    if (expandBooks !== primaryBooks) {
      var second = await _fetchOwlsPropsOnce(sportShort, expandBooks);
      if (second.ok && second.props && second.props.length) {
        merged = merged.concat(second.props);
      }
    }
  }
  // Enrich NFL/NCAAF from The Odds API so Completions/INTs/Anytime TD/Sacks/etc.
  // Always supplement NFL/NCAAF with Odds API props — yardage + specialty coverage.
  // The 60s response cache bounds credit burn regardless of how often this runs.
  if (needExpand) {
    if (!ODDS_KEY) {
      console.warn('[owls-props] ODDS_KEY not configured — skipping Odds API NFL enrichment');
    } else {
      try {
        var oddsProps = await fetchNflPropsFromOddsApi();
        if (oddsProps && oddsProps.length) {
          console.log('[owls-props] odds-api enrich sport=' + sportShort
            + ' owls=' + merged.length + ' added=' + oddsProps.length);
          merged = merged.concat(oddsProps);
        }
      } catch (e) {
        console.warn('[owls-props] odds-api enrich failed:', e && e.message);
      }
    }
  }
  if (!merged.length && first.ok === false) return first;
  return { ok: true, props: merged, url: first && first.url };
}

var _NFL_ODDS_API_PROP_MARKETS = [
  'player_pass_yds', 'player_pass_tds', 'player_pass_completions', 'player_pass_interceptions',
  'player_rush_yds', 'player_reception_yds', 'player_receptions',
  'player_anytime_td', 'player_1st_td', 'player_sacks', 'player_tackles_assists'
];

function _oddsApiMarketToPropType(key) {
  var k = String(key || '').toLowerCase();
  if (k === 'player_pass_yds') return 'Passing Yards';
  if (k === 'player_pass_tds') return 'Passing TDs';
  if (k === 'player_pass_completions') return 'Pass Completions';
  if (k === 'player_pass_interceptions') return 'Interceptions Thrown';
  if (k === 'player_rush_yds') return 'Rushing Yards';
  if (k === 'player_reception_yds') return 'Receiving Yards';
  if (k === 'player_receptions') return 'Receptions';
  if (k === 'player_anytime_td') return 'Anytime TD';
  if (k === 'player_1st_td' || k === 'player_first_td') return 'First TD';
  if (k === 'player_sacks') return 'Sacks';
  if (k === 'player_tackles_assists') return 'Tackles + Asts';
  if (k === 'player_tackles') return 'Tackles';
  return _owlsPropType(k) || null;
}

function _httpGetJson(url, timeoutMs) {
  return new Promise(function(resolve) {
    var parsed;
    try { parsed = new URL(url); } catch (_e) { return resolve(null); }
    var chunks = [];
    var req = https.request({
      hostname: parsed.hostname, port: 443,
      path: parsed.pathname + parsed.search, method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'PocketBooksSports/2.0' }
    }, function(res) {
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.setTimeout(timeoutMs || 12000, function() { req.destroy(); resolve(null); });
    req.end();
  });
}

async function fetchNflPropsFromOddsApi() {
  if (!ODDS_KEY) return [];
  var sportKey = 'americanfootball_nfl';
  var eventsUrl = 'https://api.the-odds-api.com/v4/sports/' + sportKey +
    '/events?apiKey=' + encodeURIComponent(ODDS_KEY);
  var events = await _httpGetJson(eventsUrl, 10000);
  if (!Array.isArray(events) || !events.length) return [];
  // Prefer nearest kickoffs; cap to control Odds API credit burn.
  events = events.slice().sort(function(a, b) {
    return String(a.commence_time || '').localeCompare(String(b.commence_time || ''));
  }).slice(0, 16);
  var markets = _NFL_ODDS_API_PROP_MARKETS.join(',');
  var bookmakers = 'draftkings,fanduel,betmgm,caesars';
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (!ev || !ev.id) continue;
    var url = 'https://api.the-odds-api.com/v4/sports/' + sportKey +
      '/events/' + encodeURIComponent(ev.id) + '/odds?apiKey=' + encodeURIComponent(ODDS_KEY) +
      '&regions=us&oddsFormat=american&bookmakers=' + encodeURIComponent(bookmakers) +
      '&markets=' + encodeURIComponent(markets);
    var data = await _httpGetJson(url, 12000);
    if (!data || !Array.isArray(data.bookmakers)) continue;
    var home = data.home_team || ev.home_team || '';
    var away = data.away_team || ev.away_team || '';
    var gameId = 'nfl:' + away + '@' + home + '-' + String(data.commence_time || ev.commence_time || '').slice(0, 10).replace(/-/g, '');
    var best = Object.create(null);
    data.bookmakers.forEach(function(bm) {
      (bm.markets || []).forEach(function(mkt) {
        var propType = _oddsApiMarketToPropType(mkt.key);
        if (!propType) return;
        (mkt.outcomes || []).forEach(function(oc) {
          var playerName = oc.description || oc.name;
          if (!playerName) return;
          var side = 'over';
          var line = typeof oc.point === 'number' ? oc.point : 0.5;
          var nameLow = String(oc.name || '').toLowerCase();
          if (nameLow === 'under' || nameLow === 'no') side = 'under';
          else if (nameLow === 'over' || nameLow === 'yes') side = 'over';
          else if (/under|no\b/.test(nameLow)) side = 'under';
          // Anytime / First TD: description is player, name is Yes/No
          if (/anytime td|first td/i.test(propType)) {
            if (nameLow === 'no') side = 'under';
            else side = 'over';
            if (typeof oc.point !== 'number') line = 0.5;
          }
          var odds = typeof oc.price === 'number' ? oc.price : null;
          if (odds == null) return;
          var key = String(playerName).toLowerCase() + '|' + propType + '|' + line + '|' + side;
          var prev = best[key];
          if (!prev || odds > prev.odds) {
            best[key] = {
              gameId: gameId,
              home: home,
              away: away,
              scheduledStart: data.commence_time || ev.commence_time || null,
              sport: 'NFL',
              propType: propType,
              playerName: playerName,
              team: null,
              line: line,
              side: side,
              odds: odds,
              pick: playerName + ' ' + (side === 'over' ? 'Over' : 'Under') + ' ' + line + ' ' + propType
            };
          }
        });
      });
    });
    Object.keys(best).forEach(function(k) { out.push(best[k]); });
  }
  return out;
}

function _collectPropsForSport(sportShort) {
  var games = _owlsCacheFlatGamesForSport(sportShort, sportShort.toUpperCase());
  var out = [];
  for (var gi = 0; gi < games.length; gi++) {
    var g = games[gi];
    var props = Array.isArray(g.props) ? g.props : [];
    for (var pi = 0; pi < props.length; pi++) {
      var p = props[pi];
      if (!p || !p.playerName) continue;
      var base = {
        gameId: g.id,
        canonicalGameKey: g.canonicalGameKey || null,
        home: g.home,
        away: g.away,
        scheduledStart: g.scheduledStart || g.time || null,
        sport: sportShort.toUpperCase(),
        propType: p.propType,
        playerName: p.playerName,
        team: p.team || null,
        line: p.line
      };
      if (typeof p.overOdds === 'number') {
        out.push(Object.assign({}, base, {
          side: 'over',
          odds: p.overOdds,
          pick: p.playerName + ' Over ' + p.line + ' ' + p.propType
        }));
      }
      if (typeof p.underOdds === 'number') {
        out.push(Object.assign({}, base, {
          side: 'under',
          odds: p.underOdds,
          pick: p.playerName + ' Under ' + p.line + ' ' + p.propType
        }));
      }
    }
  }
  out.sort(function(a, b) {
    if (a.propType !== b.propType) return a.propType < b.propType ? -1 : 1;
    if (a.playerName !== b.playerName) return (a.playerName || '').localeCompare(b.playerName || '');
    return (a.side || '').localeCompare(b.side || '');
  });
  return out;
}

function _filterPropsByGameId(props, gameId) {
  if (!gameId) return props;
  var gid = String(gameId);
  return (props || []).filter(function(p) {
    if (!p) return false;
    if (String(p.gameId || '') === gid) return true;
    if (String(p.providerGameId || '') === gid) return true;
    if (String(p.canonicalGameKey || '') === gid) return true;
    return false;
  });
}

function _normalizeTeamNameForPropsMatch(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Case-insensitive exact or partial team name match. Empty query = no constraint. */
function _propsTeamNameMatches(query, candidate) {
  var q = _normalizeTeamNameForPropsMatch(query);
  if (!q) return true;
  var c = _normalizeTeamNameForPropsMatch(candidate);
  if (!c) return false;
  return c === q || c.indexOf(q) >= 0 || q.indexOf(c) >= 0;
}

/**
 * Parse teams from prop gameId forms like:
 *   mlb:Boston Red Sox@Baltimore Orioles-20260903
 *   Boston Red Sox@Baltimore Orioles-20260903
 * Returns { away, home } or null.
 */
function _parseTeamsFromPropGameId(gameId) {
  var s = String(gameId || '').trim();
  if (!s || s.indexOf('@') < 0) return null;
  var body = s;
  var colon = body.indexOf(':');
  if (colon >= 0) body = body.slice(colon + 1);
  var at = body.indexOf('@');
  if (at < 0) return null;
  var away = body.slice(0, at).trim();
  var homePart = body.slice(at + 1).trim();
  var dateSuffix = homePart.match(/^(.*)-(\d{8})$/);
  var home = (dateSuffix ? dateSuffix[1] : homePart).trim();
  if (!home || !away) return null;
  return { home: home, away: away };
}

function _propHomeAwayTeams(p) {
  var home = p && p.home;
  var away = p && p.away;
  if (home && away) return { home: home, away: away };
  var parsed = _parseTeamsFromPropGameId(
    (p && (p.gameId || p.providerGameId || p.canonicalGameKey)) || ''
  );
  if (!parsed) return { home: home || '', away: away || '' };
  return {
    home: home || parsed.home,
    away: away || parsed.away
  };
}

function _filterPropsByTeams(props, home, away) {
  var h = home != null && String(home).trim() !== '' ? String(home) : '';
  var a = away != null && String(away).trim() !== '' ? String(away) : '';
  if (!h && !a) return props || [];
  return (props || []).filter(function(p) {
    if (!p) return false;
    var teams = _propHomeAwayTeams(p);
    return _propsTeamNameMatches(h, teams.home)
      && _propsTeamNameMatches(a, teams.away);
  });
}

app.get('/api/props/:sport', async function(req, res) {
  var sport = _normalizePropsSportParam(req.params.sport);
  if (PROPS_SUPPORTED_SPORTS.indexOf(sport) < 0) {
    return res.status(400).json({ ok: false, error: 'props_not_supported', sport: sport });
  }
  var gameId = req.query.gameId ? String(req.query.gameId) : null;
  var homeTeam = req.query.home ? String(req.query.home) : null;
  var awayTeam = req.query.away ? String(req.query.away) : null;
  var now = Date.now();
  var cached = _PROPS_RESPONSE_CACHE[sport];
  var fullProps = [];
  var source = 'owls_props_api';
  var cacheHit = false;
  if (cached && (now - cached.at) < PROPS_CACHE_TTL_MS) {
    fullProps = cached.data.props || [];
    source = cached.data.source || source;
    cacheHit = true;
  } else {
    if (ODDS_PROVIDER === 'owls_insight' && OWLS_KEY) {
      var fetched = await fetchPropsFromOwlsInsight(sport);
      var fromApi = (fetched.ok && fetched.props) ? fetched.props : [];
      var fromCache = _collectPropsForSport(sport) || [];
      var mergedRaw = fromApi.concat(fromCache);
      fullProps = _filterPropsForDisplay(mergedRaw);
      if (fromApi.length && fromCache.length) source = 'owls_props_api+cache';
      else if (fromApi.length) source = 'owls_props_api';
      else source = 'owls_cache_fallback';
    } else {
      fullProps = _filterPropsForDisplay(_collectPropsForSport(sport));
      source = 'owls_cache_fallback';
    }
    // Short-circuit cache when NFL slate is still thin so expand-fetch can retry soon.
    var cacheTtl = (sport === 'nfl' && fullProps.length < 50) ? 15 * 1000 : PROPS_CACHE_TTL_MS;
    _PROPS_RESPONSE_CACHE[sport] = {
      at: now - (PROPS_CACHE_TTL_MS - cacheTtl),
      data: {
        ok: true,
        sport: sport,
        props: fullProps,
        count: fullProps.length,
        source: source,
        updatedAt: new Date().toISOString()
      }
    };
  }
  // Prefer gameId when present; fall back to home/away whenever teams are
  // provided (including when gameId is absent or matches nothing).
  var outProps = fullProps;
  var filterMode = null;
  if (gameId) {
    outProps = _filterPropsByGameId(fullProps, gameId);
    filterMode = 'gameId';
  }
  if ((homeTeam || awayTeam) && (!gameId || outProps.length === 0)) {
    outProps = _filterPropsByTeams(fullProps, homeTeam, awayTeam);
    filterMode = 'teams';
  }
  var data = {
    ok: true,
    sport: sport,
    props: outProps,
    count: outProps.length,
    source: source,
    updatedAt: new Date().toISOString()
  };
  if (gameId) {
    data.gameId = gameId;
    data.filtered = true;
  }
  if (homeTeam || awayTeam) {
    data.home = homeTeam;
    data.away = awayTeam;
    data.filtered = true;
  }
  if (filterMode) data.filterMode = filterMode;
  res.setHeader('X-Cache', cacheHit ? 'HIT' : 'MISS');
  res.setHeader('X-Provider', 'owls_insight');
  res.setHeader('X-Props-Source', source);
  if (filterMode) res.setHeader('X-Props-Filter', filterMode);
  res.json(data);
});

// ── GET /api/splits/:sport ────────────────────────────────────────────────────
// Public betting splits (% of handle on each side). 2min cache. Uses recent
// ticket_legs when available; falls back to moneyline implied probability.
const _SPLITS_RESPONSE_CACHE = Object.create(null);
const SPLITS_CACHE_TTL_MS = 2 * 60 * 1000;

async function _aggregateLegSplits(sportShort) {
  var sb = getSupabase();
  var byGame = Object.create(null);
  if (!sb) return byGame;
  try {
    var since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    var { data: legs, error } = await sb.from('ticket_legs')
      .select('canonical_game_key,pick,market,risk_amount,sport,home_team,away_team,provider_game_id')
      .gte('created_at', since)
      .limit(5000);
    if (error || !Array.isArray(legs)) return byGame;
    var sportU = sportShort.toUpperCase();
    for (var i = 0; i < legs.length; i++) {
      var leg = legs[i];
      if (!leg) continue;
      var ls = String(leg.sport || '').toUpperCase();
      if (ls && ls !== sportU && ls.indexOf(sportU) < 0) continue;
      var gKey = leg.canonical_game_key || leg.provider_game_id || ((leg.away_team || '') + '@' + (leg.home_team || ''));
      if (!gKey) continue;
      var bucket = byGame[gKey] || (byGame[gKey] = { homeRisk: 0, awayRisk: 0, overRisk: 0, underRisk: 0, totalRisk: 0 });
      var risk = parseFloat(leg.risk_amount) || 1;
      var pick = String(leg.pick || '').toLowerCase();
      var mkt = String(leg.market || '').toLowerCase();
      bucket.totalRisk += risk;
      if (mkt.indexOf('total') >= 0 || pick.indexOf('over') >= 0 || pick.indexOf('under') >= 0) {
        if (pick.indexOf('over') >= 0) bucket.overRisk += risk;
        else if (pick.indexOf('under') >= 0) bucket.underRisk += risk;
      } else if (leg.home_team && pick.indexOf(String(leg.home_team).toLowerCase()) >= 0) {
        bucket.homeRisk += risk;
      } else if (leg.away_team && pick.indexOf(String(leg.away_team).toLowerCase()) >= 0) {
        bucket.awayRisk += risk;
      }
    }
  } catch (_e) { /* non-fatal */ }
  return byGame;
}

function _pctPair(a, b) {
  var tot = (a || 0) + (b || 0);
  if (tot <= 0) return { a: 50, b: 50 };
  return { a: Math.round((a / tot) * 100), b: Math.round((b / tot) * 100) };
}

async function _collectSplitsForSport(sportShort) {
  var games = _owlsCacheFlatGamesForSport(sportShort, sportShort.toUpperCase());
  var legMap = await _aggregateLegSplits(sportShort);
  var out = [];
  for (var i = 0; i < games.length; i++) {
    var g = games[i];
    var gKey = g.canonicalGameKey || g.id;
    var legs = legMap[gKey] || null;
    var awML = (Array.isArray(g.moneyline) ? g.moneyline : []).find(function(m){ return m && m.team === g.away; });
    var hwML = (Array.isArray(g.moneyline) ? g.moneyline : []).find(function(m){ return m && m.team === g.home; });
    var mlFallback = _pctPair(_americanToImpliedPct(awML && awML.odds), _americanToImpliedPct(hwML && hwML.odds));
    var ml = legs && (legs.awayRisk + legs.homeRisk) > 0
      ? _pctPair(legs.awayRisk, legs.homeRisk)
      : { a: mlFallback.a, b: mlFallback.b };
    var ov = (Array.isArray(g.totals) ? g.totals : []).find(function(t){ return t && t.name === 'Over'; });
    var un = (Array.isArray(g.totals) ? g.totals : []).find(function(t){ return t && t.name === 'Under'; });
    var totFallback = _pctPair(_americanToImpliedPct(ov && ov.odds), _americanToImpliedPct(un && un.odds));
    var tot = legs && (legs.overRisk + legs.underRisk) > 0
      ? _pctPair(legs.overRisk, legs.underRisk)
      : { a: totFallback.a, b: totFallback.b };
    out.push({
      gameId: g.id,
      canonicalGameKey: gKey,
      home: g.home,
      away: g.away,
      moneyline: { awayPct: ml.a, homePct: ml.b },
      total: { overPct: tot.a, underPct: tot.b },
      source: legs && legs.totalRisk > 0 ? 'tickets' : 'implied'
    });
  }
  return out;
}

app.get('/api/splits/:sport', async function(req, res) {
  var sport = _normalizePropsSportParam(req.params.sport);
  var now = Date.now();
  var cached = _SPLITS_RESPONSE_CACHE[sport];
  if (cached && (now - cached.at) < SPLITS_CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached.data);
  }
  try {
    var splits = await _collectSplitsForSport(sport);
    var data = { ok: true, sport: sport, splits: splits, count: splits.length, updatedAt: new Date().toISOString() };
    _SPLITS_RESPONSE_CACHE[sport] = { at: now, data: data };
    res.setHeader('X-Cache', 'MISS');
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/value-bets/:sport ────────────────────────────────────────────────
// Owls EV scanner — positive expected value opportunities. 2min cache.
const _VALUE_BETS_CACHE = Object.create(null);
const VALUE_BETS_CACHE_TTL_MS = 2 * 60 * 1000;

async function fetchEvFromOwlsInsight(sportKey, opts) {
  opts = opts || {};
  if (!OWLS_KEY) return { ok: false, error: 'owls_insight_not_configured' };
  var owlsSport = _mapToOwlsSport(sportKey);
  if (!owlsSport) return { ok: false, error: 'unsupported_sport:' + sportKey };
  var minEv = opts.minEv != null ? opts.minEv : 0;
  var url = OWLS_BASE_URL + '/api/v1/' + owlsSport + '/ev?min_ev=' + encodeURIComponent(minEv);
  return new Promise(function(resolve) {
    var parsed;
    try { parsed = new URL(url); } catch (_e) { return resolve({ ok: false, error: 'invalid_url' }); }
    var reqPath = parsed.pathname + parsed.search;
    var driver = parsed.protocol === 'https:' ? https : require('http');
    var chunks = [];
    var req = driver.request({
      hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: reqPath, method: 'GET',
      headers: { Authorization: 'Bearer ' + OWLS_KEY, Accept: 'application/json' }
    }, function(res) {
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return resolve({ ok: false, error: 'owls_ev_http_error', status: res.statusCode });
        }
        try {
          var data = JSON.parse(body);
          resolve({ ok: true, data: data });
        } catch (_pe) {
          resolve({ ok: false, error: 'owls_ev_parse_error' });
        }
      });
    });
    req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
    req.end();
  });
}

function _normalizeOwlsEvResponse(owlsData, sportKey) {
  var bets = [];
  if (!owlsData || !owlsData.success) return bets;
  var rows = owlsData.data;
  if (!rows) return bets;
  var events = Array.isArray(rows) ? rows : (Array.isArray(rows.events) ? rows.events : Object.values(rows));
  events.forEach(function(ev) {
    if (!ev) return;
    var opps = ev.opportunities || ev.ev || [];
    if (!Array.isArray(opps)) opps = [];
    opps.forEach(function(o) {
      if (!o) return;
      bets.push({
        eventId: ev.eventId || ev.id || null,
        sport: sportKey,
        away: ev.awayTeam || ev.away || null,
        home: ev.homeTeam || ev.home || null,
        matchup: (ev.awayTeam || ev.away || '') + ' @ ' + (ev.homeTeam || ev.home || ''),
        team: o.team || o.side || null,
        pick: o.team || o.side || null,
        side: o.side || null,
        market: o.market || 'h2h',
        book: o.book || null,
        bookPrice: o.bookPrice != null ? o.bookPrice : o.odds,
        odds: o.bookPrice != null ? o.bookPrice : o.odds,
        evPct: o.evPct != null ? o.evPct : o.ev,
        edgePp: o.edgePp != null ? o.edgePp : null,
        fairPrice: o.fairPrice != null ? o.fairPrice : null
      });
    });
  });
  bets.sort(function(a, b) { return (b.evPct || 0) - (a.evPct || 0); });
  return bets;
}

app.get('/api/value-bets/:sport', async function(req, res) {
  var sport = _normalizePropsSportParam(req.params.sport);
  var minEv = parseFloat(req.query.min_ev || req.query.minEv || '0') || 0;
  var now = Date.now();
  var cacheKey = sport + ':' + minEv;
  var cached = _VALUE_BETS_CACHE[cacheKey];
  if (cached && (now - cached.at) < VALUE_BETS_CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached.data);
  }
  try {
    var result = await fetchEvFromOwlsInsight(sport, { minEv: minEv });
    if (!result.ok) {
      return res.status(result.status === 401 || result.status === 403 ? 503 : 502).json({
        ok: false, sport: sport, error: result.error, bets: [], count: 0
      });
    }
    var bets = _normalizeOwlsEvResponse(result.data, sport);
    var data = { ok: true, sport: sport, bets: bets, count: bets.length, updatedAt: new Date().toISOString() };
    _VALUE_BETS_CACHE[cacheKey] = { at: now, data: data };
    res.setHeader('X-Cache', 'MISS');
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, bets: [], count: 0 });
  }
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
  rugby:             { label:'Rugby',            sportGroup:'international', icon:'🏉',   logoUrl:'/sports/logos/rugby.svg',         sortOrder:64 },
  rugby_league:      { label:'Rugby League',     sportGroup:'international', icon:'🏉',   logoUrl:'/sports/logos/rugby.svg',         sortOrder:65 },
  afl:               { label:'AFL',              sportGroup:'international', icon:'🏉',   logoUrl:'/sports/logos/afl.svg',           sortOrder:66 },
  // ── Individual (71–80) ──
  tennis:            { label:'Tennis',           sportGroup:'individual',    icon:'🎾',   logoUrl:null,                              sortOrder:71 },
  tennis_atp:        { label:'ATP',              sportGroup:'individual',    icon:'🎾',   logoUrl:'/sports/logos/atp.svg',           sortOrder:72 },
  tennis_wta:        { label:'WTA',              sportGroup:'individual',    icon:'🎾',   logoUrl:'/sports/logos/wta.svg',           sortOrder:73 },
  golf:              { label:'Golf',             sportGroup:'individual',    icon:'⛳',   logoUrl:'/sports/logos/pga.svg',           sortOrder:73 },
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
const _POPULAR_US_SPORTS = { mlb:1, nba:1, nfl:1, nhl:1, wnba:1, ncaab:1, ncaaf:1, mma:1, boxing:1, nascar:1, golf:1, golf_pga:1 };

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
  // Unified soccer tab: treat as enabled when any soccer tab league is enabled,
  // or when `soccer` itself is listed.
  if (enabledSet.soccer || OWLS_SOCCER_TAB_KEYS.some(function(k){ return !!enabledSet[k]; }) ||
      ODDS_PROVIDER === 'owls_insight') {
    enabledSet.soccer = true;
  }
  // Unified tennis tab (Owls path key `tennis` covers ATP/WTA).
  if (enabledSet.tennis || OWLS_TENNIS_TAB_KEYS.some(function(k){ return !!enabledSet[k]; }) ||
      enabledSet.tennis_atp || enabledSet.tennis_wta ||
      ODDS_PROVIDER === 'owls_insight') {
    enabledSet.tennis = true;
  }
  // Unified golf / rugby lobby tabs — always advertise when Owls is the provider
  // so the grid can dim empty cells instead of hiding them.
  if (enabledSet.golf || OWLS_GOLF_TAB_KEYS.some(function(k){ return !!enabledSet[k]; }) ||
      enabledSet.golf_pga || enabledSet.golf_liv || enabledSet.golf_european ||
      ODDS_PROVIDER === 'owls_insight') {
    enabledSet.golf = true;
  }
  if (enabledSet.rugby || OWLS_RUGBY_TAB_KEYS.some(function(k){ return !!enabledSet[k]; }) ||
      enabledSet.rugby_union || enabledSet.rugby_league ||
      ODDS_PROVIDER === 'owls_insight') {
    enabledSet.rugby = true;
  }
  // MMA lobby tab — always advertise when Owls is the provider so the grid
  // can dim empty cells instead of hiding the sport.
  if (enabledSet.mma || OWLS_MMA_TAB_KEYS.some(function(k){ return !!enabledSet[k]; }) ||
      ODDS_PROVIDER === 'owls_insight') {
    enabledSet.mma = true;
  }
  // Roll league game counts into the unified soccer tab for lobby badges.
  const soccerRollup = { games:0, markets:0, live:0, upcoming:0, final:0 };
  for (let si = 0; si < OWLS_SOCCER_TAB_KEYS.length; si++) {
    const sc = counts[OWLS_SOCCER_TAB_KEYS[si]];
    if (!sc) continue;
    soccerRollup.games += sc.games;
    soccerRollup.markets += sc.markets;
    soccerRollup.live += sc.live;
    soccerRollup.upcoming += sc.upcoming;
    soccerRollup.final += sc.final;
  }
  // Also count any other soccer_* cache keys (MLS, World Cup, etc.)
  for (const ck in counts) {
    if (ck === 'soccer' || OWLS_SOCCER_TAB_KEYS.indexOf(ck) >= 0) continue;
    if (!_isSoccerCacheSportKey(ck) && String(ck).indexOf('soccer') !== 0) continue;
    const sc = counts[ck];
    soccerRollup.games += sc.games;
    soccerRollup.markets += sc.markets;
    soccerRollup.live += sc.live;
    soccerRollup.upcoming += sc.upcoming;
    soccerRollup.final += sc.final;
  }
  if (soccerRollup.games > 0 || enabledSet.soccer) {
    counts.soccer = soccerRollup;
  }
  // Roll tennis_* cache keys into the unified tennis tab.
  const tennisRollup = { games:0, markets:0, live:0, upcoming:0, final:0 };
  for (let ti = 0; ti < OWLS_TENNIS_TAB_KEYS.length; ti++) {
    const tc = counts[OWLS_TENNIS_TAB_KEYS[ti]];
    if (!tc) continue;
    tennisRollup.games += tc.games;
    tennisRollup.markets += tc.markets;
    tennisRollup.live += tc.live;
    tennisRollup.upcoming += tc.upcoming;
    tennisRollup.final += tc.final;
  }
  for (const ck in counts) {
    if (ck === 'tennis' || OWLS_TENNIS_TAB_KEYS.indexOf(ck) >= 0) continue;
    if (!_isTennisCacheSportKey(ck)) continue;
    const tc = counts[ck];
    tennisRollup.games += tc.games;
    tennisRollup.markets += tc.markets;
    tennisRollup.live += tc.live;
    tennisRollup.upcoming += tc.upcoming;
    tennisRollup.final += tc.final;
  }
  if (tennisRollup.games > 0 || enabledSet.tennis) {
    counts.tennis = tennisRollup;
  }
  // Roll golf_* tour keys into the unified golf tab.
  const golfRollup = { games:0, markets:0, live:0, upcoming:0, final:0 };
  for (let gi = 0; gi < OWLS_GOLF_TAB_KEYS.length; gi++) {
    const gc = counts[OWLS_GOLF_TAB_KEYS[gi]];
    if (!gc) continue;
    golfRollup.games += gc.games;
    golfRollup.markets += gc.markets;
    golfRollup.live += gc.live;
    golfRollup.upcoming += gc.upcoming;
    golfRollup.final += gc.final;
  }
  for (const ck in counts) {
    if (ck === 'golf' || OWLS_GOLF_TAB_KEYS.indexOf(ck) >= 0) continue;
    if (!_isGolfCacheSportKey(ck)) continue;
    const gc = counts[ck];
    golfRollup.games += gc.games;
    golfRollup.markets += gc.markets;
    golfRollup.live += gc.live;
    golfRollup.upcoming += gc.upcoming;
    golfRollup.final += gc.final;
  }
  if (golfRollup.games > 0 || enabledSet.golf) {
    counts.golf = golfRollup;
  }
  // Roll rugby / rugby_league cache keys into the unified rugby tab.
  const rugbyRollup = { games:0, markets:0, live:0, upcoming:0, final:0 };
  for (let ri = 0; ri < OWLS_RUGBY_TAB_KEYS.length; ri++) {
    const rc = counts[OWLS_RUGBY_TAB_KEYS[ri]];
    if (!rc) continue;
    rugbyRollup.games += rc.games;
    rugbyRollup.markets += rc.markets;
    rugbyRollup.live += rc.live;
    rugbyRollup.upcoming += rc.upcoming;
    rugbyRollup.final += rc.final;
  }
  for (const ck in counts) {
    if (ck === 'rugby' || OWLS_RUGBY_TAB_KEYS.indexOf(ck) >= 0) continue;
    if (!_isRugbyCacheSportKey(ck)) continue;
    const rc = counts[ck];
    rugbyRollup.games += rc.games;
    rugbyRollup.markets += rc.markets;
    rugbyRollup.live += rc.live;
    rugbyRollup.upcoming += rc.upcoming;
    rugbyRollup.final += rc.final;
  }
  if (rugbyRollup.games > 0 || enabledSet.rugby) {
    counts.rugby = rugbyRollup;
  }
  // Roll mma cache keys into the unified MMA tab.
  const mmaRollup = { games:0, markets:0, live:0, upcoming:0, final:0 };
  for (let mi = 0; mi < OWLS_MMA_TAB_KEYS.length; mi++) {
    const mc = counts[OWLS_MMA_TAB_KEYS[mi]];
    if (!mc) continue;
    mmaRollup.games += mc.games;
    mmaRollup.markets += mc.markets;
    mmaRollup.live += mc.live;
    mmaRollup.upcoming += mc.upcoming;
    mmaRollup.final += mc.final;
  }
  for (const ck in counts) {
    if (ck === 'mma' || OWLS_MMA_TAB_KEYS.indexOf(ck) >= 0) continue;
    if (!_isMmaCacheSportKey(ck)) continue;
    const mc = counts[ck];
    mmaRollup.games += mc.games;
    mmaRollup.markets += mc.markets;
    mmaRollup.live += mc.live;
    mmaRollup.upcoming += mc.upcoming;
    mmaRollup.final += mc.final;
  }
  if (mmaRollup.games > 0 || enabledSet.mma) {
    counts.mma = mmaRollup;
  }

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

// Map ticket sport labels (MLB, mlb, baseball_mlb) to Odds API sport keys.
// Also normalize ESPN paths (football/nfl) and Owls aliases to canonical keys.
function _oddsApiSportKey(sport) {
  const s = String(sport || 'baseball_mlb').toLowerCase().trim();
  if (!s || s === 'unknown') return 'baseball_mlb';
  // ESPN scoreboard path segments → Odds/Owls canonical keys
  if (s === 'football/nfl' || s === 'football_nfl' || s === 'american football' || s === 'americanfootball')
    return 'americanfootball_nfl';
  if (s === 'football/college-football' || s === 'college-football' || s === 'cfb')
    return 'americanfootball_ncaaf';
  if (s === 'basketball/nba') return 'basketball_nba';
  if (s === 'basketball/wnba') return 'basketball_wnba';
  if (s === 'baseball/mlb') return 'baseball_mlb';
  if (s === 'hockey/nhl' || s === 'icehockey/nhl') return 'icehockey_nhl';
  if (typeof _CACHE_SPORT_KEY_BY_SHORT !== 'undefined' && _CACHE_SPORT_KEY_BY_SHORT[s])
    return _CACHE_SPORT_KEY_BY_SHORT[s];
  return s;
}

// Ticket/odds_snapshots keys are "baseball_mlb|Boston Red Sox|New York Yankees|YYYY-MM-DD".
function _resultSnapshotCanonicalKey(game, sport) {
  const sportKey = _oddsApiSportKey((game && game.sport_key) || sport || 'baseball_mlb');
  const away = (game && game.away_team) || '';
  const home = (game && game.home_team) || '';
  const date = _isoDateFromValue((game && game.commence_time) || '')
    || String((game && game.commence_time) || '').slice(0, 10);
  return sportKey + '|' + away + '|' + home + '|' + date;
}

function _indexResultByLookupKeys(resultsByKey, row) {
  if (!row || !resultsByKey) return;
  _gameKeyLookupCandidates(row.canonical_game_key || '').forEach(function(k) {
    resultsByKey[k] = row;
  });
  if (row.away_team && row.home_team) {
    const slug = _buildCKeyFromGameSync({
      sport_key: row.sport || 'baseball_mlb',
      away_team: row.away_team,
      home_team: row.home_team,
      commence_time: row.commence_time || ''
    });
    _gameKeyLookupCandidates(slug).forEach(function(k) { resultsByKey[k] = row; });
  }
}

function _normTeamToken(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _teamNamesLooselyEqual(a, b) {
  const na = _normTeamToken(a), nb = _normTeamToken(b);
  if (!na || !nb) return false;
  return na === nb || na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0;
}

function _uniqueResultRows(resultsByKey) {
  const out = [];
  const seen = [];
  Object.keys(resultsByKey || {}).forEach(function(k) {
    const row = resultsByKey[k];
    if (!row || typeof row !== 'object') return;
    if (seen.indexOf(row) >= 0) return;
    seen.push(row);
    out.push(row);
  });
  return out;
}

function _lookupResultByTeams(resultsByKey, home, away, dateStr) {
  if (!home && !away) return null;
  const rows = _uniqueResultRows(resultsByKey);
  const date = String(dateStr || '').slice(0, 10);
  function dateOk(row) {
    if (!date) return true;
    const rowDate = _isoDateFromValue(row.commence_time || '') || String(row.commence_time || '').slice(0, 10);
    const keyDate = String(row.canonical_game_key || '').split('|').pop();
    if (rowDate && rowDate !== date && keyDate !== date) return false;
    return true;
  }
  function matchOriented(wantHome, wantAway) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const homeOk = !wantHome || _teamNamesLooselyEqual(row.home_team, wantHome);
      const awayOk = !wantAway || _teamNamesLooselyEqual(row.away_team, wantAway);
      if (!homeOk || !awayOk) continue;
      if (!dateOk(row)) continue;
      return row;
    }
    return null;
  }
  return matchOriented(home, away) || matchOriented(away, home);
}

function _lookupResultByGameKey(resultsByKey, cKey) {
  if (!resultsByKey) return null;
  const cands = _gameKeyLookupCandidates(cKey);
  for (let i = 0; i < cands.length; i++) {
    if (resultsByKey[cands[i]]) return resultsByKey[cands[i]];
  }
  const parts = String(cKey || '').split('|');
  if (parts.length >= 3)
    return _lookupResultByTeams(resultsByKey, parts[2], parts[1], parts[3] || '');
  return null;
}

function _lookupResultForLeg(resultsByKey, leg) {
  const cKey = (leg && (leg.canonical_game_key || leg.canonicalGameKey)) || '';
  const hit = _lookupResultByGameKey(resultsByKey, cKey);
  if (hit) return hit;
  if (!leg) return null;
  const parts = String(cKey).split('|');
  const date = _isoDateFromValue(leg.scheduled_start || leg.scheduledStart || leg.commence_time || '')
    || (parts[3] || '');
  const home = leg.home_team || leg.homeTeam || parts[2] || '';
  const away = leg.away_team || leg.awayTeam || parts[1] || '';
  return _lookupResultByTeams(resultsByKey, home, away, date);
}

function _espnScoreboardPath(sport) {
  const k = _oddsApiSportKey(sport);
  if (k === 'baseball_mlb') return 'baseball/mlb';
  if (k === 'basketball_nba') return 'basketball/nba';
  if (k === 'basketball_wnba') return 'basketball/wnba';
  if (k === 'americanfootball_nfl') return 'football/nfl';
  if (k === 'americanfootball_ncaaf') return 'football/college-football';
  if (k === 'basketball_ncaab') return 'basketball/mens-college-basketball';
  if (k === 'icehockey_nhl') return 'hockey/nhl';
  return null;
}

function _utcYmdDaysAgo(n) {
  const d = new Date(Date.now() - (n * 86400000));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function _espnGamesToOddsScores(games, sportKey) {
  return espnScoreboard.espnGamesToOddsScores(games, sportKey);
}

function _scoreIdentityKey(g) {
  const date = String((g && g.commence_time) || '').slice(0, 10);
  const a = _normTeamToken(g && (g.home_team || g.home));
  const b = _normTeamToken(g && (g.away_team || g.away));
  if (!a || !b) return '';
  return [a, b].sort().join('|') + '|' + date;
}

function _gameIsFinalScore(g) {
  if (!g || g.canceled) return false;
  const scores = g.scores;
  const hasScores = Array.isArray(scores) && scores.length >= 2 &&
    scores.every(function(s) { return s && s.score != null && s.score !== ''; });
  return !!(g.completed && hasScores);
}

// Odds API wins when it already has a final. ESPN fills games Odds dropped
// (GRD-7b) and can replace a non-final Odds row when ESPN is actually final.
function _mergeOddsAndEspnScores(odds, espn) {
  const byKey = {};
  function consider(g) {
    if (!g) return;
    const key = _scoreIdentityKey(g);
    if (!key) return;
    const existing = byKey[key];
    if (!existing) { byKey[key] = g; return; }
    if (_gameIsFinalScore(g) && !_gameIsFinalScore(existing)) byKey[key] = g;
  }
  (odds || []).forEach(consider);
  (espn || []).forEach(consider);
  return Object.keys(byKey).map(function(k) { return byKey[k]; });
}

function _pastScoreboardYmdsFromLegs(legs, maxLookbackDays) {
  const now = Date.now();
  const minMs = now - (Math.max(1, parseInt(maxLookbackDays, 10) || 14) * 86400000);
  const seen = {};
  const out = [];
  (legs || []).forEach(function(l) {
    const raw = l && (l.scheduled_start || l.scheduledStart || l.commence_time);
    if (!raw) return;
    const ms = new Date(raw).getTime();
    if (!Number.isFinite(ms) || ms > now || ms < minMs) return;
    const ymd = new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
    if (seen[ymd]) return;
    seen[ymd] = true;
    out.push(ymd);
  });
  return out;
}

async function _fetchOwlsScores(sport) {
  try {
    const owlsSport = _mapSportToOwls(_oddsApiSportKey(sport));
    if (!owlsSport || !OWLS_KEY) return null;
    // Canonical live-score path. Legacy /api/v1/scores/{sport} returns 404.
    const data = await _owlsApiGetJson('/api/v1/' + owlsSport + '/scores/live');
    if (!data) return null;
    if (Array.isArray(data.events)) return data.events;
    if (data.data && Array.isArray(data.data.events)) return data.data.events;
    const sportsBag = data.data && data.data.sports && data.data.sports[owlsSport];
    if (Array.isArray(sportsBag)) return sportsBag;
    return [];
  } catch(e) {
    return null;
  }
}

function _owlsScoresToOddsScores(owlsGames, sportKey) {
  const owlsSport = _mapSportToOwls(_oddsApiSportKey(sportKey)) || sportKey;
  return (owlsGames || []).map(function(g) {
    const parsed = owlsLiveScores.parseOwlsLiveScoreEvent(g, owlsSport);
    if (!parsed) return null;
    return {
      id: parsed.id,
      sport_key: sportKey,
      home_team: parsed.home_team,
      away_team: parsed.away_team,
      commence_time: parsed.commence_time,
      completed: parsed.completed,
      canceled: !!parsed.canceled,
      status: parsed.status,
      homeScore: parsed.homeScore,
      awayScore: parsed.awayScore,
      period: parsed.period,
      clock: parsed.clock,
      inning: parsed.inning,
      inningHalf: parsed.inningHalf,
      scores: [
        { name: parsed.home_team, score: parsed.homeScore != null ? String(parsed.homeScore) : null },
        { name: parsed.away_team, score: parsed.awayScore != null ? String(parsed.awayScore) : null }
      ]
    };
  }).filter(Boolean);
}

// ── Live score cache (Owls /scores/live → hydrate lobby cards) ──────────────
// Independent of odds WebSocket: odds-update payloads do not carry scoreboard
// fields, so scores must poll even when OWLS_USE_WEBSOCKET skips REST odds.
const OWLS_LIVE_SCORE_SPORTS = ['mlb','nfl','nba','nhl','ncaaf','ncaab','soccer','tennis'];
const LIVE_SCORE_POLL_MS = _envMs('LIVE_SCORE_POLL_MS', 10 * 1000);
let LIVE_SCORE_CACHE = {
  updatedAt: null,
  bySport: {},
  eventCount: 0,
  lastError: null
};
let _liveScorePollTimer = null;
let _liveScorePollInFlight = false;

function _hydrateLiveMarketCacheWithScores() {
  if (!LIVE_MARKET_CACHE || !Array.isArray(LIVE_MARKET_CACHE.games)) return { matched:0, unmatchedLive:0 };
  return owlsLiveScores.hydrateGamesWithOwlsScores(
    LIVE_MARKET_CACHE.games,
    LIVE_SCORE_CACHE.bySport || {},
    _formatGameStateText
  );
}

async function _pollOwlsLiveScores(trigger) {
  if (!OWLS_KEY || ODDS_PROVIDER !== 'owls_insight') {
    return { ok:false, reason:'owls_not_configured' };
  }
  if (_liveScorePollInFlight) return { ok:false, reason:'in_flight' };
  _liveScorePollInFlight = true;
  const start = Date.now();
  try {
    const prevBySport = (LIVE_SCORE_CACHE && LIVE_SCORE_CACHE.bySport) || {};
    const bySport = {};
    let eventCount = 0;
    let anyFresh = false;
    await Promise.all(OWLS_LIVE_SCORE_SPORTS.map(async function(sport) {
      const raw = await _fetchOwlsScores(sport);
      // null = transport/API failure — keep prior valid index for this sport.
      // [] = successful empty live board — clear that sport (no stale forever).
      if (raw == null) {
        if (prevBySport[sport]) {
          bySport[sport] = prevBySport[sport];
          eventCount += (prevBySport[sport].list || []).length;
          console.warn('OWLS_SCORES_LIVE_KEEP sport='+sport+' reason=fetch_null trigger='+trigger);
        }
        return;
      }
      const events = Array.isArray(raw) ? raw : [];
      const idx = owlsLiveScores.indexOwlsLiveScores(events, sport);
      bySport[sport] = idx;
      eventCount += idx.list.length;
      anyFresh = true;
      if (idx.list.length) {
        console.log('OWLS_SCORES_LIVE_OK sport='+sport+' events='+idx.list.length+
          ' live='+idx.list.filter(function(e){ return e.status==='live'; }).length+
          ' trigger='+trigger);
      }
    }));
    LIVE_SCORE_CACHE = {
      updatedAt: anyFresh ? new Date().toISOString() : (LIVE_SCORE_CACHE.updatedAt || new Date().toISOString()),
      bySport: bySport,
      eventCount: eventCount,
      lastError: anyFresh ? null : (LIVE_SCORE_CACHE.lastError || 'all_sports_fetch_null')
    };
    const hyd = _hydrateLiveMarketCacheWithScores();
    console.log('OWLS_SCORES_LIVE_HYDRATE trigger='+trigger+' events='+eventCount+
      ' matched='+hyd.matched+' unmatchedLive='+hyd.unmatchedLive+
      ' ms='+(Date.now()-start));
    return { ok:true, eventCount:eventCount, matched:hyd.matched, unmatchedLive:hyd.unmatchedLive };
  } catch(e) {
    // Do not wipe bySport — outer failure leaves prior LIVE_SCORE_CACHE intact.
    LIVE_SCORE_CACHE.lastError = e && e.message ? e.message : String(e);
    console.warn('OWLS_SCORES_LIVE_FAIL trigger='+trigger+' err='+LIVE_SCORE_CACHE.lastError);
    return { ok:false, reason:'error', error:LIVE_SCORE_CACHE.lastError };
  } finally {
    _liveScorePollInFlight = false;
  }
}

function _scheduleLiveScorePoll() {
  if (_liveScorePollTimer) clearTimeout(_liveScorePollTimer);
  _liveScorePollTimer = setTimeout(async function() {
    try { await _pollOwlsLiveScores('interval'); }
    catch(_e) {}
    _scheduleLiveScorePoll();
  }, LIVE_SCORE_POLL_MS);
}

function _startLiveScorePoller() {
  if (!OWLS_KEY || ODDS_PROVIDER !== 'owls_insight') return;
  // Idempotent: avoid duplicate interval chains on accidental re-entry.
  if (_liveScorePollTimer) {
    clearTimeout(_liveScorePollTimer);
    _liveScorePollTimer = null;
  }
  setImmediate(function() {
    _pollOwlsLiveScores('boot').catch(function(){});
  });
  _scheduleLiveScorePoll();
  console.log('[owls-scores] poller started intervalMs='+LIVE_SCORE_POLL_MS+
    ' sports='+OWLS_LIVE_SCORE_SPORTS.join(','));
}

async function _fetchEspnSportScores(sport, daysBack, extraYmds) {
  const sportKey = _oddsApiSportKey(sport);
  const path = _espnScoreboardPath(sportKey);
  if (!path) {
    console.log('RESULT_ESPN_SKIP sport='+sportKey+' reason=no_scoreboard_path');
    return [];
  }
  const days = Math.max(1, parseInt(daysBack, 10) || 3);
  const ymds = [];
  const seenYmd = {};
  function addYmd(ymd) {
    if (!ymd || seenYmd[ymd]) return;
    seenYmd[ymd] = true;
    ymds.push(ymd);
  }
  for (let i = 0; i <= days; i++) addYmd(_utcYmdDaysAgo(i));
  (extraYmds || []).forEach(addYmd);
  if (ymds.length > 12) ymds.length = 12;
  const all = [];
  const seen = {};
  for (let i = 0; i < ymds.length; i++) {
    const ymd = ymds[i];
    const url = 'https://site.api.espn.com/apis/site/v2/sports/'+path+'/scoreboard?dates='+ymd;
    const r = await _httpsGetJson(url, 8000);
    if (r.error || !r.data) {
      console.warn('RESULT_ESPN_FAIL sport='+sportKey+' dates='+ymd+' err='+(r.error||'empty'));
      continue;
    }
    const games = _espnScoreboardToGames(r.data);
    if (!games.length) {
      const keys = espnScoreboard.espnRootKeys(r.data);
      console.warn('RESULT_ESPN_PARSE_EMPTY sport='+sportKey+' dates='+ymd+' keys='+JSON.stringify(keys));
    }
    let added = 0;
    games.forEach(function(g) {
      if (!g.id || seen[g.id]) return;
      seen[g.id] = true;
      all.push(g);
      added++;
    });
    console.log('RESULT_ESPN_FETCH sport='+sportKey+' dates='+ymd+' games='+games.length+' added='+added);
  }
  // NFL: also merge the current regular-season week slate (seasontype=2).
  // Date-window fetches miss upcoming Week 1 games and can miss finals when
  // daysBack is short; week scoreboard is the ESPN path football/nfl uses.
  if (sportKey === 'americanfootball_nfl') {
    try {
      const weekPack = await _fetchEspnNflScores(1);
      (weekPack.games || []).forEach(function(g) {
        if (!g || !g.id || seen[g.id]) return;
        seen[g.id] = true;
        all.push(g);
      });
      // Also pull "current" scoreboard (whatever week ESPN considers active)
      const cur = await _httpsGetJson(
        'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', 8000);
      if (cur.data) {
        _espnScoreboardToGames(cur.data).forEach(function(g) {
          if (!g || !g.id || seen[g.id]) return;
          seen[g.id] = true;
          all.push(g);
        });
      }
    } catch(_nflWeekErr) {
      console.warn('RESULT_ESPN_NFL_WEEK_FAIL err='+(_nflWeekErr.message||_nflWeekErr));
    }
  }
  return all;
}

function _fetchOddsApiScores(sport, daysBack) {
  const sportKey = _oddsApiSportKey(sport);
  if (!ODDS_KEY) {
    console.warn('RESULT_ODDS_SKIP sport='+sportKey+' reason=no_odds_key');
    return Promise.resolve([]);
  }
  const url = 'https://api.the-odds-api.com/v4/sports/'+sportKey+
    '/scores/?apiKey='+ODDS_KEY+'&daysFrom='+(daysBack||3);
  return new Promise(function(resolve){
    const https=require('https');
    const req=https.get(url,function(res){ let d=''; res.on('data',function(c){d+=c;});
      res.on('end',function(){
        try {
          const parsed = JSON.parse(d);
          if (!Array.isArray(parsed)) {
            const code = parsed && (parsed.error_code || parsed.error) || ('http_'+res.statusCode);
            const msg = (parsed && (parsed.message || parsed.error)) || 'odds_scores_not_array';
            console.warn('RESULT_ODDS_FAIL sport='+sportKey+' code='+code+' message='+String(msg).slice(0,200));
            resolve([]);
            return;
          }
          console.log('RESULT_ODDS_OK sport='+sportKey+' games='+parsed.length);
          resolve(parsed);
        } catch(_e) { console.warn('RESULT_ODDS_FAIL sport='+sportKey+' reason=parse'); resolve([]); }
      }); });
    req.on('error',function(e){ console.warn('RESULT_ODDS_FAIL sport='+sportKey+' reason=net '+e.message); resolve([]); });
    req.setTimeout(8000,function(){ req.destroy(); console.warn('RESULT_ODDS_FAIL sport='+sportKey+' reason=timeout'); resolve([]); });
  });
}

async function _fetchScoresForSport(sport, daysBack, extraYmds) {
  const sportKey = _oddsApiSportKey(sport);
  const odds = await _fetchOddsApiScores(sportKey, daysBack);
  const owlsRaw = await _fetchOwlsScores(sportKey);
  const owlsScores = (owlsRaw && owlsRaw.length)
    ? _owlsScoresToOddsScores(owlsRaw, sportKey) : [];
  if (owlsScores.length) {
    console.log('RESULT_OWLS_OK sport='+sportKey+' games='+owlsScores.length+
      ' finals='+owlsScores.filter(_gameIsFinalScore).length);
  }
  const espnGames = await _fetchEspnSportScores(sportKey, daysBack, extraYmds);
  const espnScores = _espnGamesToOddsScores(espnGames, sportKey);
  if (!owlsScores.length) {
    console.log('RESULT_OWLS_EMPTY sport='+sportKey+' espnFallback=true espnGames='+espnScores.length);
  } else if (espnScores.length) {
    console.log('RESULT_ESPN_MERGE sport='+sportKey+' espnGames='+espnScores.length+
      ' espnFinals='+espnScores.filter(_gameIsFinalScore).length);
  }
  // Always merge Owls + ESPN so Owls slate presence does not block ESPN finals
  // (GRD-7b). Prefer whichever source has a completed scoreboard row.
  const supplemental = _mergeOddsAndEspnScores(owlsScores, espnScores);
  const merged = _mergeOddsAndEspnScores(odds || [], supplemental);
  const oddsFinals = (odds || []).filter(_gameIsFinalScore).length;
  const supFinals = supplemental.filter(_gameIsFinalScore).length;
  if (!merged.length) {
    console.warn('RESULT_SCORES source=none sport='+sportKey+' oddsEmpty=true supplementalEmpty=true');
    return { games: [], source: null };
  }
  let supplementalSource = 'espn';
  if (owlsScores.length && espnScores.length) supplementalSource = 'owls+espn';
  else if (owlsScores.length) supplementalSource = 'owls';
  const source = (odds && odds.length && supplemental.length)
    ? ('odds+' + supplementalSource)
    : (supplemental.length ? supplementalSource : 'odds-api');
  console.log('RESULT_SCORES source='+source+' sport='+sportKey+
    ' odds='+(odds||[]).length+' oddsFinal='+oddsFinals+
    ' supplemental='+supplemental.length+' supFinal='+supFinals+
    ' merged='+merged.length);
  return { games: merged, source: source };
}

async function _refreshResultSnapshots(sports, daysBack, extraYmds) {
  sports = sports && sports.length ? sports : ['baseball_mlb'];
  let upserted = 0;
  const allRows = [];
  console.log('RESULT_REFRESH_START sports='+sports.join(',')+' daysBack='+(daysBack||3)+
    ' extraDates='+(extraYmds&&extraYmds.length||0));
  for (let i = 0; i < sports.length; i++) {
    const sport = sports[i];
    try {
      const fetched = await _fetchScoresForSport(sport, daysBack, extraYmds);
      if (Array.isArray(fetched.games) && fetched.games.length) {
        const result = await _upsertResultSnapshots(fetched.games, sport, fetched.source);
        const n = result && typeof result.count === 'number' ? result.count
          : (typeof result === 'number' ? result : 0);
        upserted += n;
        const rows = (result && result.rows) || [];
        rows.forEach(function(r) { allRows.push(r); });
      }
    } catch (_e) {
      console.warn('RESULT_REFRESH_SPORT_FAIL sport='+sport+' err='+_e.message);
      logEvent('warn','job:result_refresh_sport_error',{ sport, err:_e.message });
    }
  }
  console.log('RESULT_REFRESH_DONE upserted='+upserted+' lastResult='+_lastResultSuccessAt);
  return { upserted: upserted, rows: allRows };
}

async function _mlbGradePollTick() {
  if (_gradePollInFlight) {
    console.log('GRADE_POLL_BUSY');
    return;
  }
  _gradePollInFlight = true;
  _lastGradePollAt = new Date().toISOString();
  console.log('GRADE_POLL_START at='+_lastGradePollAt+' intervalMs='+MLB_GRADE_POLL_MS);
  try {
    const sb = getSupabase();
    if (!sb) {
      _lastGradeRunAt = new Date().toISOString();
      console.warn('GRADE_POLL_SKIP reason=supabase_not_configured lastGradeRunAt='+_lastGradeRunAt);
      return;
    }
    const r = await _runGradeCore({ body:{ daysBack:3 } }, sb);
    _lastGradeRunAt = new Date().toISOString();
    console.log('GRADE_POLL_DONE graded='+(r&&r.graded||0)+' skipped='+(r&&r.skipped||0)+
      ' skipReasons='+JSON.stringify((r&&r.skipReasons)||{})+
      ' snapshotsUpserted='+(r&&r.snapshotsUpserted||0)+
      ' lastResult='+_lastResultSuccessAt+' lastGradeRunAt='+_lastGradeRunAt+
      ' lastGradedAt='+_lastGradedAt);
  } catch (e) {
    _lastGradeRunAt = new Date().toISOString();
    console.error('GRADE_POLL_FAIL '+e.message+' lastGradeRunAt='+_lastGradeRunAt);
  } finally {
    _gradePollInFlight = false;
  }
}

function _startMlbGradePoller() {
  if (_mlbGradePollerStarted) return;
  _mlbGradePollerStarted = true;
  console.log('GRADE_POLL_SCHED intervalMs='+MLB_GRADE_POLL_MS+' auth=none clubs=ALL');
  setTimeout(function() {
    _mlbGradePollTick().catch(function(e){ console.error('GRADE_POLL_FAIL '+e.message); });
  }, 15000);
  setInterval(function() {
    _mlbGradePollTick().catch(function(e){ console.error('GRADE_POLL_FAIL '+e.message); });
  }, MLB_GRADE_POLL_MS);
}

// Upsert result snapshots from Odds API / ESPN scores response
async function _upsertResultSnapshots(scoresData, sport, source) {
  if (!Array.isArray(scoresData)) return { count: 0, rows: [] };
  const sb = getSupabase();
  const now = new Date().toISOString();
  const src = source || 'odds-api';
  const rows = scoresData.map(function(game) {
    const sport_key = game.sport_key||sport||'unknown';
    const sp = _oddsApiSportKey(sport_key);
    const cKey = _resultSnapshotCanonicalKey(game, sport);
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
    const rawStatus = String(game.status || game.state || '').toLowerCase();
    const isCanceled = game.canceled === true || game.cancelled === true ||
      /^(canceled|cancelled|abandoned|postponed)$/.test(rawStatus);
    const status = game.completed ? 'final'
                 : isCanceled     ? 'canceled'
                 : (game.scores && game.scores.length) ? 'live'
                 : 'scheduled';
    return {
      result_snapshot_id: 'RS_'+sp+'_'+game.id,
      sport: sp, event_id:String(game.id), canonical_game_key:cKey,
      home_team:game.home_team, away_team:game.away_team,
      commence_time:game.commence_time, status,
      home_score:homeScore, away_score:awayScore, winner,
      final_at:game.completed?now:null,
      source:src, fetched_at:now
    };
  });
  if (!rows.length) return { count: 0, rows: [] };
  if (!sb) return { count: 0, rows: rows };
  try {
    const { error } = await sb.from('result_snapshots').upsert(rows, { onConflict:'canonical_game_key' });
    if (error) {
      console.warn('RESULT_UPSERT_FAIL sport='+sport+' err='+error.message);
      return { count: 0, rows: rows };
    }
    const finals = rows.filter(function(r){ return r.status === 'final'; }).length;
    _lastResultSuccessAt = now;
    console.log('RESULT_UPSERT_OK source='+src+' sport='+sport+' rows='+rows.length+' final='+finals+
      ' sampleKeys='+JSON.stringify(rows.slice(0,8).map(function(r){ return r.canonical_game_key; })));
    return { count: rows.length, rows: rows };
  } catch(e) { console.warn('RESULT_UPSERT_FAIL sport='+sport+' err='+e.message); return { count: 0, rows: rows }; }
}

// Derive leg outcome from result snapshot
function _deriveLegOutcome(leg, result) {
  if (!result) return { outcome:'error', reason:'result_missing' };
  // GRD-7: canceled/postponed/abandoned games grade as push so the player's
  // stake is returned.  For parlays this triggers the GRD-2 push-reduction
  // path (canceled leg drops out; remaining winning legs pay at reduced odds).
  const canceledStatuses = new Set(['canceled','cancelled','postponed','abandoned','suspended','forfeit']);
  if (canceledStatuses.has(result.status)) {
    return { outcome: 'push', reason: 'event_' + result.status };
  }
  // Treat ESPN/Owls "post" and completed flags as final for grading.
  const statusNorm = String(result.status || '').toLowerCase();
  const isFinal = statusNorm === 'final' || statusNorm === 'post' || statusNorm === 'completed' ||
    statusNorm === 'complete' || result.completed === true;
  if (!isFinal) return { outcome:'pending', reason:'result_not_final', status:result.status };
  const market   = (leg.market||'moneyline').toLowerCase().replace('run line','spread').replace('puck line','spread');
  const pick     = (leg.pick||'').toLowerCase();
  const homeTeam = (result.home_team||'').toLowerCase();
  const awayTeam = (result.away_team||'').toLowerCase();
  const homeScore= parseInt(result.home_score,10);
  const awayScore= parseInt(result.away_score,10);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore))
    return { outcome:'pending', reason:'scores_missing' };

  // Derive winner from scores when snapshot omitted it (public scores / Owls).
  let winner = result.winner;
  if (!winner || winner === 'unknown') {
    if (homeScore > awayScore) winner = 'home';
    else if (awayScore > homeScore) winner = 'away';
    else winner = 'tie';
  }

  if (market==='moneyline'||market==='h2h') {
    if (homeScore===awayScore || winner==='tie') return { outcome:'push', reason:'tie' };
    const pickedHome = pick.includes(homeTeam) || _teamNamesLooselyEqual(pick, homeTeam);
    const pickedAway = pick.includes(awayTeam) || _teamNamesLooselyEqual(pick, awayTeam);
    if (winner==='home'&&pickedHome) return { outcome:'won' };
    if (winner==='away'&&pickedAway) return { outcome:'won' };
    // Abbrev / short-name picks: fall back to score-side inference
    if (!pickedHome && !pickedAway) {
      if (winner==='home' && pick && homeTeam.includes(pick)) return { outcome:'won' };
      if (winner==='away' && pick && awayTeam.includes(pick)) return { outcome:'won' };
    }
    return { outcome:'lost' };
  }
  if (market==='spread'||market==='run line'||market==='spreads') {
    const line = parseFloat(leg.accepted_point_line||leg.point||leg.line||0);
    const pickedHome = pick.includes(homeTeam) || _teamNamesLooselyEqual(pick, homeTeam);
    const margin = homeScore-awayScore;
    const adjusted = pickedHome ? margin+line : awayScore-homeScore+line;
    if (Math.abs(adjusted)<0.001) return { outcome:'push' };
    return adjusted>0 ? { outcome:'won' } : { outcome:'lost' };
  }
  if (market==='total'||market==='totals'||market==='over/under') {
    const total = homeScore+awayScore;
    const line  = parseFloat(leg.accepted_point_line||leg.point||leg.line||0);
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
    const result = _lookupResultForLeg(resultsByKey, leg)||null;
    return Object.assign({ leg:leg.pick }, _deriveLegOutcome(leg, result));
  });
  const pending = legOutcomes.find(function(l){ return l.outcome==='pending'||l.outcome==='error'; });
  if (pending) return { outcome:pending.outcome, reason:pending.reason, leg:pending.leg };
  if (type==='single'||type==='straight') return legOutcomes[0];
  // Parlay / Teaser / RoundRobin — any lost leg loses the whole ticket
  const anyLost = legOutcomes.find(function(l){ return l.outcome==='lost'; });
  if (anyLost) {
    const lostLegCount = legOutcomes.filter(function(l){ return l.outcome==='lost'; }).length;
    return { outcome:'lost', lostLegCount: lostLegCount };
  }
  // GRD-2: Separate won legs from pushed legs
  const wonLegs  = legs.filter(function(_,i){ return legOutcomes[i].outcome==='won'; });
  const pushLegs = legs.filter(function(_,i){ return legOutcomes[i].outcome==='push'; });
  if (pushLegs.length > 0 && wonLegs.length > 0) {
    // Partial push: some legs won, some pushed, none lost.
    // Pushed legs drop out; remaining winning legs pay at reduced odds.
    return { outcome:'won', pushReduced:true, wonLegObjects:wonLegs, pushLegCount:pushLegs.length };
  }
  if (pushLegs.length === legs.length) {
    return { outcome:'push' };  // all legs pushed — full stake refund
  }
  return wonLegs.length === legs.length ? { outcome:'won' } : { outcome:'lost' };
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

// Generate all C(arr.length, size) combinations of arr.
// Used by the RR placement path to expand leg subsets per combo.
// Pure function — no side effects.
function _getRrCombos(arr, size) {
  if (!Array.isArray(arr) || size < 1 || size > arr.length) return [];
  if (size === 1) return arr.map(function(x){ return [x]; });
  var out = [];
  arr.forEach(function(x, i) {
    _getRrCombos(arr.slice(i+1), size-1).forEach(function(rest){ out.push([x].concat(rest)); });
  });
  return out;
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
    const iKey   = 'GR_'+result+'_'+ticketId;
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
      .select('id,type,status,risk_amount,potential_profit,estimated_payout,graded_at,player_id,club_id,insurance_enabled')
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
        const lookupKeys = [];
        uniqueKeys.forEach(function(k) {
          _gameKeyLookupCandidates(k).forEach(function(c){ lookupKeys.push(c); });
        });
        const { data: snapRows } = await sb.from('result_snapshots').select('*')
          .in('canonical_game_key', lookupKeys);
        (snapRows||[]).forEach(function(r){ _indexResultByLookupKeys(resultsByKey, r); });
        const sports = [...new Set((allLegs||[]).map(function(l){ return _oddsApiSportKey(l.sport||l.league||'baseball_mlb'); }))];
        const extraYmds = _pastScoreboardYmdsFromLegs(allLegs, 14);
        for (const sport of sports) {
          try {
            const fetched = await _fetchScoresForSport(sport, daysBack, extraYmds);
            const scoresData = (fetched && fetched.games) || [];
            if (Array.isArray(scoresData) && scoresData.length) {
              await _upsertResultSnapshots(scoresData, sport, fetched.source);
              scoresData.forEach(function(g){
                const scores=g.scores||[];
                const h=scores.find(function(s){return s.name===g.home_team;});
                const a=scores.find(function(s){return s.name===g.away_team;});
                const row = {
                  canonical_game_key:_resultSnapshotCanonicalKey(g, sport),
                  status: g.completed ? 'final' : 'scheduled',
                  home_team:g.home_team, away_team:g.away_team,
                  commence_time:g.commence_time,
                  sport:_oddsApiSportKey(g.sport_key||sport),
                  home_score:h?parseInt(h.score,10)||0:null,
                  away_score:a?parseInt(a.score,10)||0:null,
                  winner: (g.completed && h && a)
                    ? (parseInt(h.score,10)>parseInt(a.score,10)?'home':parseInt(a.score,10)>parseInt(h.score,10)?'away':'tie')
                    : null
                };
                _indexResultByLookupKeys(resultsByKey, row);
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
        // GRD-2: recompute profit when pushed legs drop out of a parlay
        let profit = parseFloat(ticket.potential_profit)||0;
        let overrideProfit = null;
        if (outcome.pushReduced && outcome.wonLegObjects) {
          const allOddsValid = outcome.wonLegObjects.every(function(l){ return l.odds && l.odds !== 0; });
          if (!allOddsValid) {
            row.reason='push_reduced_null_odds:cannot_recompute';
            console.warn('[grade/run] push-reduced parlay has null/zero leg odds — skipping ticketId='+ticket.id);
            skipped++;
            results.push(row);
            continue;
          }
          const decProd = outcome.wonLegObjects.reduce(function(acc,l){ return acc*_sgAmToDecimal(l.odds); }, 1.0);
          overrideProfit = Math.round((risk*(decProd-1))*100)/100;
          profit = overrideProfit;
        }

        const payout = combined==='won'?Math.round((risk+profit)*100)/100:combined==='push'?risk:0;
        const delta  = combined==='won'?profit:combined==='push'?0:-risk;

        if (!GRADING_SETTLEMENT_ENABLED) {
          if (!GRADE_RUN_DRY_RUN_ENABLED)
            throw new Error('grading_settlement_disabled:'+GRADING_DISABLED_REASON);
          row.statusAfter=ticket.status; row.result=combined; row.payoutDelta=delta;
          row.dryRun=true; row.settlementDisabled=true; row.reason='dry_run:'+GRADING_DISABLED_REASON;
          row.wouldPayout=payout; row.wouldCanonicalLedgerId='LE_GR_'+ticket.id+'_'+combined;
          if (overrideProfit!=null) { row.pushReduced=true; row.overrideProfit=overrideProfit; }
          skipped++;
          results.push(row);
          continue;
        }

        // Phase I+M: call grade_ticket_tx RPC
        const iKey = 'GR_'+combined+'_'+ticket.id;
        const gradeResult = await _callMoneyRpc('grade_ticket_tx', {
          p_ticket_id:ticket.id, p_club_id:ticket.club_id||'', p_player_id:ticket.player_id,
          p_grade_result:combined, p_profit:profit,
          p_idempotency_key:iKey, p_created_by:'server-grade-api',
          p_override_profit:overrideProfit  // null on normal path; non-null for push-reduced parlays
        });
        if (!gradeResult.ok && !gradeResult.idempotent)
          throw new Error('grade_rpc_rejected:'+gradeResult.error);

        console.log('[grade/run] canonical settlement ok ticketId='+ticket.id+
          ' result='+combined+(overrideProfit!=null?' pushReduced overrideProfit='+overrideProfit:'')+
          ' ledgerEntryId='+(gradeResult.ledger_entry_id||iKey));

        const { data: auditData } = await sb.from('audit_events').insert({
          event_type:'ticket_graded_server',
          ticket_id:ticket.id, club_id:ticket.club_id, actor_id:'server-grade-api',
          payload:{ result:combined, source:'result_snapshot', playerId:ticket.player_id,
                    legCount:ticketLegs.length,
                    payout, delta, pushReduced:overrideProfit!=null, overrideProfit,
                    rpcOk:gradeResult.ok, balanceAfter:gradeResult.balance_after }
        }).select('id');

        row.statusAfter=combined; row.result=combined; row.payoutDelta=delta;
        if (overrideProfit!=null) { row.pushReduced=true; row.overrideProfit=overrideProfit; }
        row.ledgerEntryId=gradeResult.ledger_entry_id||iKey;
        row.canonicalLedgerId=gradeResult.ledger_entry_id||iKey;
        row.auditEventId=auditData&&auditData[0]?auditData[0].id:null;
        row.balanceAfter=gradeResult.balance_after;

        // Parlay insurance: lost by exactly one leg → refund stake as credit.
        var _insOn = ticket.insurance_enabled === true || ticket.insurance_enabled === 'true';
        var _isParlay = String(ticket.type||'').toLowerCase() === 'parlay';
        if (combined === 'lost' && _insOn && _isParlay && ticketLegs.length >= 3 && risk > 0) {
          var lostN = outcome.lostLegCount;
          if (lostN == null) {
            var _lo = ticketLegs.map(function(leg) {
              return _deriveLegOutcome(leg, _lookupResultForLeg(resultsByKey, leg)||null);
            });
            lostN = _lo.filter(function(l){ return l && l.outcome==='lost'; }).length;
          }
          if (lostN === 1) {
            try {
              var insCredit = await _creditPlayerAccount({
                clubId: ticket.club_id||'', playerId: ticket.player_id,
                ticketId: ticket.id, eventType: 'PARLAY_INSURANCE_REFUND',
                ledgerEntriesType: 'PARLAY_INSURANCE_REFUND',
                amount: risk,
                idempotencyKey: 'INS_'+ticket.id,
                createdBy: 'server-grade-api',
                reason: 'parlay_insurance:lost_by_one_leg'
              });
              row.insuranceRefund = risk;
              row.insuranceLedgerId = insCredit.ledgerEntryId;
              if (insCredit.balanceAfter != null) row.balanceAfter = insCredit.balanceAfter;
              console.log('[grade/run] parlay insurance refund ticketId='+ticket.id+' amount='+risk);
            } catch(insErr) {
              console.warn('[grade/run] insurance refund failed ticketId='+ticket.id+':', insErr.message);
              row.insuranceError = insErr.message;
            }
          }
        }

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

// POST /api/club/members/approve — approve pending join + set player_limits / starting balance
app.post('/api/club/members/approve', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor || {};
  const deny  = _requireMemberAdmin(actor);
  if (deny) return res.status(deny.status||403).json({ ok:false, error:deny.error });
  const body = req.body || {};
  const clubId = body.clubId;
  const targetActorId = body.targetActorId || body.playerId;
  if (!targetActorId) return res.status(400).json({ ok:false, error:'missing_targetActorId' });
  if (!clubId) return res.status(400).json({ ok:false, error:'missing_clubId' });

  const startRaw = body.balanceStart != null ? body.balanceStart
    : (body.starting_balance != null ? body.starting_balance : body.credit_limit);
  const startBal = parseFloat(startRaw);
  const maxBet = parseFloat(body.max_bet != null ? body.max_bet : body.maxBet);
  const maxDaily = parseFloat(body.max_daily_risk != null ? body.max_daily_risk : body.maxDailyRisk);
  const maxPayout = parseFloat(body.max_payout != null ? body.max_payout : body.maxPayout);
  const maxOpen = parseFloat(body.max_open_risk != null ? body.max_open_risk : body.maxOpenRisk);
  const now = new Date().toISOString();
  const limitsRow = {
    club_id: String(clubId),
    player_id: String(targetActorId),
    max_bet: Number.isFinite(maxBet) ? maxBet : 100,
    max_daily_risk: Number.isFinite(maxDaily) ? maxDaily : 500,
    max_payout: Number.isFinite(maxPayout) ? maxPayout : 2000,
    updated_at: now
  };
  if (Number.isFinite(maxOpen)) limitsRow.max_open_risk = maxOpen;
  if (Number.isFinite(maxBet)) limitsRow.max_single_bet = maxBet;

  try {
    const sb = getSupabase();
    if (sb) {
      // Prefer status=approved (host approval flow); auth accepts approved|active.
      const { error: memErr } = await sb.from('club_memberships')
        .update({ status:'approved', updated_at:now, updated_by:actor.actorId, approved_at:now })
        .eq('actor_id', String(targetActorId)).eq('club_id', String(clubId)).eq('status','pending');
      if (memErr) {
        // Some schemas use player_id instead of actor_id
        await sb.from('club_memberships')
          .update({ status:'approved', updated_at:now, updated_by:actor.actorId, approved_at:now })
          .eq('player_id', String(targetActorId)).eq('club_id', String(clubId)).eq('status','pending');
      }

      await sb.from('player_limits').upsert(limitsRow, { onConflict:'club_id,player_id' });

      if (Number.isFinite(startBal)) {
        const memberRow = {
          club_id: String(clubId),
          player_id: String(targetActorId),
          balance_start: startBal,
          status: 'approved',
          updated_at: now
        };
        const { error: cmErr } = await sb.from('club_members')
          .upsert(memberRow, { onConflict:'club_id,player_id' });
        if (cmErr) {
          // Fallback: update-only if upsert conflict target differs
          await sb.from('club_members')
            .update({ balance_start: startBal, status:'approved', updated_at:now })
            .eq('club_id', String(clubId)).eq('player_id', String(targetActorId));
          const { data: existing } = await sb.from('club_members').select('player_id')
            .eq('club_id', String(clubId)).eq('player_id', String(targetActorId)).limit(1);
          if (!existing || !existing.length) {
            await sb.from('club_members').insert(memberRow);
          }
        }
      }

      // Best-effort in-app notification for the player
      try {
        await sb.from('notifications').insert({
          user_id: String(targetActorId),
          club_id: String(clubId),
          type: 'club_approved',
          title: 'Club join approved',
          body: 'You were approved to join the club. You can place bets now.',
          read: false,
          created_at: now
        });
      } catch(_n) { /* notifications table may not exist */ }
    }
    _membershipInvalidate(targetActorId, clubId);
    _writeAuthAudit('member_approved', actor.actorId, clubId, '/club/members/approve', {
      targetActorId, balanceStart: Number.isFinite(startBal) ? startBal : null,
      max_bet: limitsRow.max_bet, max_daily_risk: limitsRow.max_daily_risk, max_payout: limitsRow.max_payout
    });
    res.json({
      ok:true, targetActorId, status:'approved',
      balanceStart: Number.isFinite(startBal) ? startBal : null,
      limits: limitsRow
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/club/members/deny — reject pending join request
app.post('/api/club/members/deny', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor || {};
  const deny  = _requireMemberAdmin(actor);
  if (deny) return res.status(deny.status||403).json({ ok:false, error:deny.error });
  const body = req.body || {};
  const clubId = body.clubId;
  const targetActorId = body.targetActorId || body.playerId;
  if (!targetActorId) return res.status(400).json({ ok:false, error:'missing_targetActorId' });
  if (!clubId) return res.status(400).json({ ok:false, error:'missing_clubId' });
  const now = new Date().toISOString();
  try {
    const sb = getSupabase();
    if (sb) {
      let { error } = await sb.from('club_memberships')
        .update({ status:'rejected', updated_at:now, updated_by:actor.actorId })
        .eq('actor_id', String(targetActorId)).eq('club_id', String(clubId)).eq('status','pending');
      if (error) {
        await sb.from('club_memberships')
          .update({ status:'rejected', updated_at:now, updated_by:actor.actorId })
          .eq('player_id', String(targetActorId)).eq('club_id', String(clubId)).eq('status','pending');
      }
      try {
        await sb.from('notifications').insert({
          user_id: String(targetActorId),
          club_id: String(clubId),
          type: 'club_denied',
          title: 'Club join denied',
          body: 'Your request to join the club was denied.',
          read: false,
          created_at: now
        });
      } catch(_n) {}
    }
    _membershipInvalidate(targetActorId, clubId);
    _writeAuthAudit('member_denied', actor.actorId, clubId, '/club/members/deny', { targetActorId });
    res.json({ ok:true, targetActorId, status:'rejected' });
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

// POST /api/club/toggle-lock — host/admin flips clubs.is_locked
app.post('/api/club/toggle-lock', requirePermissionScoped('settle_player'), async (req, res) => {
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor || {};
  const deny  = _requireMemberAdmin(actor);
  if (deny) return res.status(deny.status||403).json({ ok:false, error:deny.error });
  const clubId = (req.body && req.body.clubId) || req._clubId;
  if (!clubId) return res.status(400).json({ ok:false, error:'missing_clubId' });
  try {
    const sb = getSupabase();
    let nextLocked = false;
    if (sb) {
      const { data, error: selErr } = await sb.from('clubs').select('id,is_locked').eq('id', String(clubId)).limit(1).maybeSingle();
      if (selErr) throw selErr;
      if (!data) return res.status(404).json({ ok:false, error:'club_not_found' });
      nextLocked = !data.is_locked;
      const { error: upErr } = await sb.from('clubs').update({ is_locked: nextLocked }).eq('id', String(clubId));
      if (upErr) throw upErr;
    } else {
      const cur = await query('SELECT id, COALESCE(is_locked,false) AS is_locked FROM clubs WHERE id=$1', [clubId]);
      if (!cur.rows.length) return res.status(404).json({ ok:false, error:'club_not_found' });
      nextLocked = !cur.rows[0].is_locked;
      await query('UPDATE clubs SET is_locked=$1 WHERE id=$2', [nextLocked, clubId]);
    }
    _writeAuthAudit('club_lock_toggled', actor.actorId, clubId, '/club/toggle-lock', { is_locked: nextLocked });
    res.json({
      ok: true,
      is_locked: nextLocked,
      message: nextLocked ? 'Club is now locked' : 'Club is now open'
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/club/join-request — player requests to join (respects clubs.is_locked)
// Alias: POST /api/club/request-join (same handler)
async function _clubJoinRequestHandler(req, res) {
  const body = req.body || {};
  const code = body.code || body.clubCode;
  const clubIdIn = body.clubId || body.club_id || null;
  try {
    const actorId = String(req.user.id);
    const sb = getSupabase();
    let c = null;
    if (sb) {
      let q = sb.from('clubs').select('*');
      if (code) q = q.eq('code', String(code).toUpperCase());
      else if (clubIdIn) q = q.eq('id', String(clubIdIn));
      else return res.status(400).json({ ok:false, error:'missing_code' });
      const { data, error } = await q.limit(1).maybeSingle();
      if (error) throw error;
      if (!data || data.active === false) return res.status(404).json({ ok:false, error:'Club not found' });
      c = data;
    } else if (code) {
      const club = await query('SELECT * FROM clubs WHERE code=$1 AND COALESCE(active,true)=true', [String(code).toUpperCase()]);
      if (!club.rows.length) return res.status(404).json({ ok:false, error:'Club not found' });
      c = club.rows[0];
    } else if (clubIdIn) {
      const club = await query('SELECT * FROM clubs WHERE id=$1 AND COALESCE(active,true)=true', [clubIdIn]);
      if (!club.rows.length) return res.status(404).json({ ok:false, error:'Club not found' });
      c = club.rows[0];
    } else {
      return res.status(400).json({ ok:false, error:'missing_code' });
    }
    if (c.is_locked) {
      return res.status(403).json({
        ok: false,
        error: 'club_locked',
        message: 'This club is not accepting new members right now'
      });
    }
    const clubId = String(c.id);
    if (sb) {
      const { data: existing } = await sb.from('club_memberships')
        .select('actor_id,status').eq('club_id', clubId).eq('actor_id', actorId).limit(1);
      if (existing && existing.length) {
        return res.status(400).json({ ok:false, error:'Already a member', status: existing[0].status });
      }
      const now = new Date().toISOString();
      const { error: insErr } = await sb.from('club_memberships').insert({
        actor_id: actorId, club_id: clubId, role: 'player', status: 'pending',
        joined_at: now, updated_at: now
      });
      if (insErr) throw insErr;
    } else {
      const exists = await query('SELECT actor_id,status FROM club_memberships WHERE club_id=$1 AND actor_id=$2', [clubId, actorId]);
      if (exists.rows.length) {
        return res.status(400).json({ ok:false, error:'Already a member', status: exists.rows[0].status });
      }
      await query(
        'INSERT INTO club_memberships (club_id,actor_id,status,role,joined_at,updated_at) VALUES ($1,$2,$3,$4,NOW(),NOW())',
        [clubId, actorId, 'pending', 'player']
      );
    }
    res.json({ ok:true, success:true, club: { id: c.id, name: c.name, code: c.code, is_locked: false } });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
}
app.post('/api/club/join-request', auth, _clubJoinRequestHandler);
app.post('/api/club/request-join', auth, _clubJoinRequestHandler);

// GET /api/club/:id — public club info including lock status (UUID only)
app.get('/api/club/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', async (req, res) => {
  try {
    const id = req.params.id;
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('clubs')
        .select('id,name,code,description,is_locked,active')
        .eq('id', id)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ ok:false, error:'club_not_found' });
      return res.json(Object.assign({ ok:true }, data, {
        is_locked: !!data.is_locked,
        is_active: data.active !== false
      }));
    }
    const r = await query(
      'SELECT id,name,code,description,COALESCE(is_locked,false) AS is_locked,COALESCE(active,true) AS active FROM clubs WHERE id=$1',
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'club_not_found' });
    const row = r.rows[0];
    res.json(Object.assign({ ok:true }, row, { is_locked: !!row.is_locked, is_active: !!row.active }));
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
  const finalStatus = (resolved.membership && resolved.membership.status) || 'active';
  const platRole    = PLATFORM_ADMIN_ALLOWLIST.includes(actorId) ? 'platform_admin' : null;
  const { token, jti } = await issueSessionToken(actorId, finalRole, clubId, 86400, platRole);
  console.log('[auth/token] issued role='+finalRole+(platRole?' [platform_admin]':''));
  res.json({ ok:true, token, jti, actorId, role:finalRole, status:finalStatus, clubId, club_id:clubId, expiresIn:86400 });
});

// POST /api/dev/host-token — unmetered host mint for local/dev only (actor 16).
const DEV_HOST_ACTOR_ID = '16';
const DEV_HOST_CLUB_ID  = 'd616dc2a-95a6-473a-97b1-7da330878479';
app.post('/api/dev/host-token', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ ok:false, error:'not_found' });
  }
  const actorId = DEV_HOST_ACTOR_ID;
  const clubId  = (req.body && req.body.clubId) || DEV_HOST_CLUB_ID;
  const resolved = await _resolveTokenRole(actorId, clubId, 'host');
  const finalRole = (resolved && resolved.ok && resolved.role) ? resolved.role : 'host';
  const finalStatus = (resolved && resolved.membership && resolved.membership.status) || 'active';
  const { token, jti } = await issueSessionToken(actorId, finalRole, clubId, 86400, null);
  console.log('[dev/host-token] issued actor='+actorId+' role='+finalRole);
  res.json({ ok:true, token, jti, actorId, role:finalRole, status:finalStatus, clubId, club_id:clubId, expiresIn:86400, via:'dev-host-token' });
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
  const providerHealthy = cache.sourceStatus === 'healthy' &&
    cache.gameCount > 0 &&
    (cacheAgeMs === null || cacheAgeMs <= PREGAME_SNAPSHOT_TTL_MS);
  // Count markets by state from cache (fast, no DB hit).
  // Same three shapes as _upsertOddsSnapshots:
  //   Odds-API object { outcomes, updatedAt }  — classify once
  //   Owls overlay    [ entry, entry, ... ]    — classify each outcome
  //   Single Owls     { marketType, ... }      — classify the entry
  // Owls arrays have no updatedAt; use cache.updatedAt like _lookupSnapshotFromLiveCache.
  let active=0, live=0, suspended=0, stale=0, finalCount=0, canceled=0;
  Object.values(cache.marketsByCanonicalKey).forEach(function(value) {
    const entries = Array.isArray(value) ? value : [value];
    entries.forEach(function(entry) {
      if (!entry || typeof entry !== 'object') return;
      const state = _classifyMarket({
        fetched_at: entry.updatedAt || cache.updatedAt,
        suspended: entry.suspended,
        commence_time: entry.commenceTime,
        event_status: entry.gameStatus || entry.eventStatus,
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
  });
  const warnings = [];
  if (stale > 0)         warnings.push('stale_markets:'+stale);
  if (suspended > 0)     warnings.push('suspended_markets:'+suspended);
  if (cache.gameCount===0) warnings.push('no_markets_loaded');
  if (cacheAgeMs && cacheAgeMs > PREGAME_SNAPSHOT_TTL_MS) warnings.push('cache_stale');
  const serviceOk = IS_PRODUCTION
    ? providerHealthy
    : true; // dev: always ok
  res.json({
    ok:true, serviceOk,
    liveSnapshotTtlMs:LIVE_SNAPSHOT_TTL_MS,
    pregameSnapshotTtlMs:PREGAME_SNAPSHOT_TTL_MS,
    pollIntervalMs:LIVE_CACHE_POLL_INTERVAL_MS,
    lastSuccessfulPollAt:cache.lastSuccessAt,
    providerHealth:{
      provider:ODDS_PROVIDER,
      status:cache.sourceStatus,
      healthy:providerHealthy,
      gameCount:cache.gameCount,
      marketCount:cache.marketCount,
      cacheAgeMs,
      lastSuccessfulPollAt:cache.lastSuccessAt
    },
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

async function _buildLiveExposureSummary(sb, clubId) {
  const empty = { clubId:clubId||null, liveTicketCount:0, liveLegCount:0, totalOpenRisk:0, bySport:{} };
  if (!sb || !clubId) return empty;
  try {
    const { data:tickets } = await sb.from('tickets')
      .select('id,risk_amount')
      .eq('club_id',clubId)
      .in('status',['active','open']);
    const active = tickets || [];
    if (!active.length) return empty;
    const riskByTicket = {};
    const ids = active.map(function(t) {
      riskByTicket[t.id] = parseFloat(t.risk_amount||0);
      return t.id;
    });
    const { data:legs } = await sb.from('ticket_legs')
      .select('ticket_id,canonical_game_key,market,sport,scheduled_start')
      .in('ticket_id', ids);
    const nowMs = Date.now();
    const liveTicketIds = new Set();
    const bySport = {};
    let liveLegCount = 0;
    (legs||[]).forEach(function(l) {
      const startMs = l.scheduled_start ? new Date(l.scheduled_start).getTime() : NaN;
      if (isNaN(startMs) || startMs > nowMs) return;
      liveLegCount++;
      liveTicketIds.add(l.ticket_id);
      const sport = String(l.sport||'unknown').toLowerCase();
      bySport[sport] = bySport[sport] || { liveLegCount:0, openRisk:0 };
      bySport[sport].liveLegCount++;
    });
    let totalOpenRisk = 0;
    liveTicketIds.forEach(function(tid){ totalOpenRisk += riskByTicket[tid] || 0; });
    Object.keys(bySport).forEach(function(sport) {
      const ticketIdsForSport = new Set((legs||[]).filter(function(l) {
        const startMs = l.scheduled_start ? new Date(l.scheduled_start).getTime() : NaN;
        return !isNaN(startMs) && startMs <= nowMs && String(l.sport||'unknown').toLowerCase() === sport;
      }).map(function(l){ return l.ticket_id; }));
      let risk = 0;
      ticketIdsForSport.forEach(function(tid){ risk += riskByTicket[tid] || 0; });
      bySport[sport].openRisk = Math.round(risk * 100) / 100;
    });
    return {
      clubId,
      liveTicketCount:liveTicketIds.size,
      liveLegCount,
      totalOpenRisk:Math.round(totalOpenRisk * 100) / 100,
      bySport
    };
  } catch(e) {
    return Object.assign({}, empty, { error:e.message });
  }
}

// GET /api/live/diagnostics — lightweight internal live beta visibility.
app.get('/api/live/diagnostics', requirePermissionScoped('view_host_dashboard'), async (req, res) => {
  const sb = getSupabase();
  const actor = req._actor || {};
  const clubId = req._clubId || actor.clubId || (req.query && req.query.clubId) || null;
  const providerHealth = _getLiveProviderDiagnostics(Date.now());
  let currentLiveEnabledClubs = [];
  if (sb) {
    try {
      let q = sb.from('club_risk_settings')
        .select('club_id,allow_live_betting,allow_live_parlays,live_enabled_sports,max_live_stake,max_live_payout,max_live_event_exposure,max_live_market_exposure')
        .eq('allow_live_betting', true)
        .limit(50);
      if (actor.platformRole !== 'platform_admin' && clubId) q = q.eq('club_id', clubId);
      const { data } = await q;
      currentLiveEnabledClubs = data || [];
    } catch(e) {
      currentLiveEnabledClubs = [{ error:e.message }];
    }
  }
  const liveExposureSummary = await _buildLiveExposureSummary(sb, clubId);
  res.json({
    ok:true,
    liveBettingEnabled:LIVE_BETTING_ENABLED,
    providerHealth,
    cacheAgeMs:providerHealth.cacheAgeMs,
    pollIntervalMs:LIVE_CACHE_POLL_INTERVAL_MS,
    liveSnapshotTtlMs:LIVE_SNAPSHOT_TTL_MS,
    rejectionCounters:_liveDiagnostics.counters,
    recentRejections:_liveDiagnostics.recent.slice(-50).reverse(),
    liveExposureSummary,
    currentLiveEnabledClubs
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

// POST /api/odds/refresh — immediate REST bootstrap (admin; not rate-limited)
app.post('/api/odds/refresh', requirePermissionScoped('force_market_refresh'), async (req, res) => {
  try {
    const summary = await _triggerImmediateOddsRefresh('admin_refresh');
    console.log('[live cache] admin odds refresh: games='+summary.gameCount+
      ' markets='+summary.marketCount+' sourceStatus='+summary.sourceStatus);
    res.json(summary);
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});
// ───────────────────────────────────────────────────────────────────────────

function _fmtAmericanOdds(o) {
  if (o == null || o === '') return '';
  var n = parseFloat(o);
  if (isNaN(n)) return String(o);
  return n > 0 ? '+' + n : String(n);
}

function _enrichHostTicket(t, legs) {
  var sels = (legs || []).slice().sort(function(a,b){ return (a.leg_index||0)-(b.leg_index||0); }).map(function(l) {
    var home = l.home_team || '';
    var away = l.away_team || '';
    var odds = _fmtAmericanOdds(l.accepted_odds_american != null ? l.accepted_odds_american : l.odds);
    return {
      pick: l.pick || '',
      market: l.market || l.market_type || '',
      odds: odds,
      line: l.line,
      side: l.side,
      homeTeam: home,
      awayTeam: away,
      matchup: (away && home) ? (away + ' @ ' + home) : (away || home || ''),
      sport: l.sport
    };
  });
  var first = sels[0] || {};
  var uname = t.player_username || t.playerUsername || '';
  return Object.assign({}, t, {
    playerId: t.player_id,
    playerUsername: uname,
    playerName: uname,
    type: t.type || 'Single',
    status: t.status,
    riskAmount: parseFloat(t.risk_amount) || 0,
    potentialProfit: parseFloat(t.potential_profit) || 0,
    estimatedPayout: parseFloat(t.estimated_payout) || 0,
    placedAt: t.placed_at,
    gradedAt: t.graded_at,
    odds: t.odds || first.odds || '',
    pick: first.pick || '',
    matchup: first.matchup || '',
    game: first.matchup || '',
    selections: sels,
    legs: sels
  });
}

// GET /api/host/dashboard?clubId=...
app.get('/api/host/dashboard', requireCanonicalClubId, requirePermissionScoped('view_host_dashboard'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, source:'supabase_not_configured', stats:null });
  if (req._clubId) req.query = Object.assign({}, req.query, { clubId: req._clubId });
  const { clubId, playerId } = req.query;
  try {
    // Load tickets (club-scoped). Extra columns are additive for the host Bets tab.
    let tq = sb.from('tickets')
      .select('id,status,type,odds,risk_amount,potential_profit,estimated_payout,player_id,player_username,placed_at,graded_at,insurance_enabled,cashout_offer_amount,cashout_offer_status')
      .order('placed_at', { ascending:false })
      .limit(1000);
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

    // Join ticket_legs so the host Bets tab can render matchup / pick / odds.
    var legsByTicket = {};
    var ticketIds = (tickets||[]).map(function(t){ return t.id; }).filter(Boolean);
    if (ticketIds.length) {
      try {
        const { data: legData, error: lErr2 } = await sb.from('ticket_legs')
          .select('id,ticket_id,leg_index,pick,market,odds,line,side,sport,home_team,away_team,accepted_odds_american,market_type')
          .in('ticket_id', ticketIds);
        if (lErr2) throw lErr2;
        (legData||[]).forEach(function(l) {
          if (!l || !l.ticket_id) return;
          if (!legsByTicket[l.ticket_id]) legsByTicket[l.ticket_id] = [];
          legsByTicket[l.ticket_id].push(l);
        });
      } catch(_le) {
        console.warn('[host/dashboard] ticket_legs join failed:', _le.message);
      }
    }

    // Roster source of truth: club_memberships (active/approved players).
    // club_members is balance-only and must not be the only membership gate —
    // a failed users lookup used to 400 the whole handler when actor "16"
    // was mixed into a uuid .in() list, leaving the UI on one local demo player.
    var memberMap = {};
    var membershipCount = 0;
    var playerMemberCount = 0;
    var skippedHostIds = {};
    try {
      var memQ = sb.from('club_memberships').select('actor_id,role,status');
      if (clubId) memQ = memQ.eq('club_id', clubId);
      const { data: memRows, error: memErr } = await memQ;
      if (memErr) throw memErr;
      membershipCount = (memRows||[]).length;
      (memRows||[]).forEach(function(r) {
        if (!r || r.actor_id == null) return;
        var st = String(r.status||'').toLowerCase();
        var role = String(r.role||'player').toLowerCase();
        if (st !== 'active' && st !== 'approved') return;
        if (role === 'host' || role === 'admin' || role === 'owner' || role === 'full_admin') {
          skippedHostIds[String(r.actor_id)] = true;
          return;
        }
        memberMap[String(r.actor_id)] = {
          balance_start: null,
          role: r.role || 'player',
          status: r.status
        };
      });
      playerMemberCount = Object.keys(memberMap).length;
    } catch(_e) {
      console.warn('[host/dashboard] club_memberships fetch error:', _e.message);
    }

    // Starting balances from club_members (canonical balance table).
    try {
      let plq = sb.from('club_members').select('player_id,balance_start,status');
      if (clubId) plq = plq.eq('club_id', clubId);
      const { data: plRows, error: mErr } = await plq;
      if (mErr) throw mErr;
      (plRows||[]).forEach(function(r) {
        if (r.player_id == null) return;
        var pid = String(r.player_id);
        var start = r.balance_start != null ? parseFloat(r.balance_start) : null;
        if (skippedHostIds[pid]) return;
        if (memberMap[pid]) {
          memberMap[pid].balance_start = start;
          return;
        }
        // Approved club_members row without a membership still belongs on the roster.
        if (String(r.status||'').toLowerCase() === 'approved') {
          memberMap[pid] = { balance_start: start, role: 'player', status: r.status };
        }
      });
      playerMemberCount = Object.keys(memberMap).length;
    } catch(_e) { console.warn('[host/dashboard] club_members fetch error:', _e.message); }

    // Username lookup. users.id is uuid — never pass Railway numeric actor ids.
    var nameById = {};
    var displayNameById = {};
    var playerIds = [];
    var seenPid = {};
    Object.keys(memberMap).forEach(function(pid) {
      if (!seenPid[pid]) { seenPid[pid] = true; playerIds.push(pid); }
    });
    (tickets||[]).forEach(function(t) {
      var pid = t.player_id != null ? String(t.player_id) : '';
      if (!pid || seenPid[pid]) return;
      seenPid[pid] = true;
      playerIds.push(pid);
    });
    var uuidPlayerIds = playerIds.filter(function(pid){ return !!_uuidOrNull(String(pid)); });
    var usersResolved = 0;
    if (uuidPlayerIds.length) {
      try {
        const { data: userRows, error: uErr } = await sb.from('users')
          .select('id,username,display_name')
          .in('id', uuidPlayerIds);
        if (uErr) {
          console.warn('[host/dashboard] users lookup failed:', uErr.message,
            'asked='+uuidPlayerIds.length);
        } else {
          (userRows||[]).forEach(function(u) {
            if (!u || u.id == null) return;
            var id = String(u.id);
            nameById[id] = u.username || u.display_name || '';
            displayNameById[id] = u.display_name || u.username || '';
            usersResolved++;
          });
        }
      } catch(_ue) {
        console.warn('[host/dashboard] users lookup threw:', _ue && _ue.message);
      }
    }
    console.log('[host/dashboard] roster club='+(clubId||'(none)')
      + ' memberships='+membershipCount
      + ' playerMembers='+playerMemberCount
      + ' uuidLookups='+uuidPlayerIds.length
      + ' usersResolved='+usersResolved);

    function _uuidLike(s) {
      return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    }
    function _playerLabel(pid, ticketUsername) {
      var fromUsers = nameById[String(pid)] || '';
      if (fromUsers) return fromUsers;
      var tu = ticketUsername || '';
      if (tu && tu !== String(pid) && !_uuidLike(tu)) return tu;
      return displayNameById[String(pid)] || '';
    }

    function rnd(v) { return Math.round((isNaN(v)?0:v)*100)/100; }

    // Derive stats from tickets only (source of truth)
    var handle=0, activeRisk=0, hostAtRisk=0, settledGain=0, settledLoss=0;
    var activeBetCount=0, gradedCount=0, canceledCount=0;
    const active=[], graded=[];
    var byPlayer = {};

    function getOrCreatePlayer(pid, username) {
      var key = String(pid || 'unknown');
      if (!byPlayer[key]) {
        var meta = memberMap[key] || {};
        var uname = username || nameById[key] || displayNameById[key] || key;
        byPlayer[key] = {
          playerId:          key,
          username:          uname,
          playerName:        displayNameById[key] || uname,
          startingBalance:   meta.balance_start != null ? rnd(meta.balance_start) : null,
          availableBalance:  null,
          openRisk:          0,
          settledGains:      0,
          settledLosses:     0,
          activeBetCount:    0
        };
      } else if (username && byPlayer[key].username === key) {
        byPlayer[key].username = username;
        byPlayer[key].playerName = username;
      }
      return byPlayer[key];
    }

    Object.keys(memberMap).forEach(function(pid) { getOrCreatePlayer(pid, nameById[pid]); });

    (tickets||[]).forEach(function(t) {
      var s      = (t.status||'').toLowerCase();
      var risk   = parseFloat(t.risk_amount)||0;
      var profit = parseFloat(t.potential_profit)||0;
      var pid    = t.player_id != null ? String(t.player_id) : 'unknown';
      var uname  = _playerLabel(pid, t.player_username);
      var p      = getOrCreatePlayer(pid, uname);
      if (uname) { p.username = uname; p.playerName = displayNameById[pid] || uname; }
      var enriched = _enrichHostTicket(Object.assign({}, t, { player_username: uname || t.player_username }), legsByTicket[t.id] || []);

      // Include void/canceled in gradedTickets so Host Bets can show history.
      // Stats still exclude them from handle / active risk (unchanged accounting).
      if (s==='canceled'||s==='voided'||s==='deleted'||s==='cancelled') {
        canceledCount++;
        graded.push(enriched);
        return;
      }
      if (s==='active'||s==='open') {
        handle+=risk; activeRisk+=risk; hostAtRisk+=profit; activeBetCount++;
        p.openRisk += risk; p.activeBetCount++;
        active.push(enriched);
      } else if (s==='won') {
        handle+=risk; settledLoss+=profit; gradedCount++;
        p.settledGains += profit;
        graded.push(enriched);
      } else if (s==='lost') {
        handle+=risk; settledGain+=risk; gradedCount++;
        p.settledLosses += risk;
        graded.push(enriched);
      } else if (s==='push'||s==='pushed') {
        handle+=risk; gradedCount++;
        graded.push(enriched);
      }
    });

    // Ledger is source of truth for available balance (matches /api/player/dashboard).
    // Ticket formula is fallback only when a player has no ledger rows.
    var ledgerBalByPid = {};
    var ledgerCountByPid = {};
    try {
      var balPids = Object.keys(byPlayer);
      if (balPids.length && clubId) {
        const { data: ledRows, error: ledErr } = await sb.from('ledger_entries')
          .select('player_id,amount,balance_after,created_at,type')
          .eq('club_id', clubId)
          .in('player_id', balPids)
          .order('created_at', { ascending: true });
        if (ledErr) throw ledErr;
        var byLed = {};
        (ledRows||[]).forEach(function(r){
          var pid = String(r.player_id||'');
          if (!pid) return;
          if (!byLed[pid]) byLed[pid] = [];
          byLed[pid].push(r);
        });
        balPids.forEach(function(pid){
          var rows = byLed[pid] || [];
          ledgerCountByPid[pid] = rows.length;
          if (!rows.length) return;
          var start = (memberMap[pid] && memberMap[pid].balance_start != null)
            ? memberMap[pid].balance_start : null;
          ledgerBalByPid[pid] = _deriveBalanceFromLedgerEntries(start, rows);
        });
      }
    } catch(_lb) {
      console.warn('[host/dashboard] ledger balance error:', _lb.message||_lb);
    }

    const players = Object.keys(byPlayer).map(function(k) {
      var p = byPlayer[k];
      p.openRisk = rnd(p.openRisk);
      p.settledGains = rnd(p.settledGains);
      p.settledLosses = rnd(p.settledLosses);
      var ticketAvailable = p.startingBalance != null
        ? rnd(p.startingBalance - p.openRisk - p.settledLosses + p.settledGains)
        : null;
      if (ledgerBalByPid[k] != null) {
        p.availableBalance = rnd(ledgerBalByPid[k]);
        p.balanceSource = 'ledger';
      } else {
        p.availableBalance = ticketAvailable;
        p.balanceSource = ticketAvailable != null ? 'tickets' : null;
      }
      p.ticketAvailable = ticketAvailable;
      p.ledgerEntryCount = ledgerCountByPid[k] || 0;
      return p;
    }).sort(function(a,b){ return (b.openRisk||0) - (a.openRisk||0); });

    console.log('[host/dashboard] playersOut='+players.length
      + ' names='+players.map(function(p){ return p.username; }).join(',')
      + ' balSrc='+players.map(function(p){ return (p.username||p.playerId)+':'+(p.balanceSource||'none')+'='+p.availableBalance; }).join('|'));

    // Players Owe You = lost stakes (settledGain); You Owe Players = won profits (settledLoss)
    const playersOweAll = rnd(settledGain);
    const hostOwesAll   = rnd(settledLoss);
    const handleAll     = rnd(handle);                 // active + settled risk (excl. void/canceled)
    const settledHandle = rnd(handle - activeRisk);    // won/lost/push only
    const profit        = rnd(playersOweAll - hostOwesAll);
    // Settled Hold % = profit / settledHandle * 100
    const holdPct       = settledHandle>0 ? rnd(profit/settledHandle*100) : null;

    // Weekly window (ISO Mon 00:00 UTC Monday) — graded_at preferred, else placed_at
    var _wStart = new Date(); _wStart.setUTCHours(0,0,0,0);
    _wStart.setUTCDate(_wStart.getUTCDate() - ((_wStart.getUTCDay()+6)%7));
    var _wStartMs = _wStart.getTime();
    var weekPlayersOwe=0, weekHostOwes=0, weekHandle=0, weekSettledCount=0;
    (tickets||[]).forEach(function(t){
      var s=(t.status||'').toLowerCase();
      if (s!=='won' && s!=='lost') return;
      var ts=new Date(t.graded_at||t.placed_at||0).getTime();
      if (!ts || !(ts>=_wStartMs)) return;
      var risk=parseFloat(t.risk_amount)||0;
      var profitAmt=parseFloat(t.potential_profit)||0;
      weekHandle+=risk; weekSettledCount++;
      if (s==='lost') weekPlayersOwe+=risk;
      else weekHostOwes+=profitAmt;
    });
    weekPlayersOwe=rnd(weekPlayersOwe); weekHostOwes=rnd(weekHostOwes);
    weekHandle=rnd(weekHandle);
    var weekNet=rnd(weekPlayersOwe-weekHostOwes);
    var weekHoldPct=weekHandle>0?rnd(weekNet/weekHandle*100):null;
    var weeklyStats = {
      weekStart: _wStart.toISOString(),
      playersOwe: weekPlayersOwe,
      hostOwes: weekHostOwes,
      net: weekNet,
      handle: weekHandle,
      settledCount: weekSettledCount,
      holdPct: weekHoldPct
    };

    const stats = {
      // Handle = all-time risk wagered (active + settled). settledHandle kept for Hold %.
      handle:         handleAll,
      handleAll:      handleAll,
      settledHandle:  settledHandle,
      activeRisk:     rnd(activeRisk),   // At Risk = sum of active risk_amount
      hostAtRisk:     rnd(hostAtRisk),   // potential_profit exposure if all active win
      settledGain:    rnd(settledGain),
      settledLoss:    rnd(settledLoss),
      playersOwe:     playersOweAll,
      hostOwes:       hostOwesAll,
      profit:         profit,
      net:            profit,
      holdPct:        holdPct,
      activeBetCount: activeBetCount,
      gradedCount:    gradedCount,
      canceledCount:  canceledCount,
      weekly: weeklyStats,
      allTime: {
        playersOwe: playersOweAll,
        hostOwes: hostOwesAll,
        net: profit,
        handle: handleAll,
        settledHandle: settledHandle,
        settledCount: gradedCount,
        holdPct: holdPct
      }
    };

    // Warnings
    const warnings = [];
    if (isNaN(stats.handle))     warnings.push('handle_NaN');
    if (stats.activeRisk < 0)   warnings.push('activeRisk_negative');
    if (stats.activeBetCount !== active.length) warnings.push('activeBetCount_mismatch');

    // Recently settled (won/lost/push) for Host Bets — last 7 days only.
    // gradedTickets still carries full graded+canceled history for other UI.
    var settledCutoffMs = Date.now() - 7 * 86400000;
    var settledTickets = graded.filter(function(t) {
      var st = String(t.status || '').toLowerCase();
      if (st !== 'won' && st !== 'lost' && st !== 'push' && st !== 'pushed') return false;
      var ts = Date.parse(t.gradedAt || t.graded_at || t.placedAt || t.placed_at || '') || 0;
      return ts >= settledCutoffMs;
    });

    res.json({
      ok: true, source: 'db', clubId: clubId||null,
      players:        players,
      activeTickets:  active,
      gradedTickets:  graded,
      settledTickets: settledTickets,
      ledgerEntries:  ledger||[],
      stats,
      // Canonical overview numbers for the host home cards (prefer these over localStorage).
      summary: {
        activeBetCount: stats.activeBetCount,
        atRisk:         stats.activeRisk,      // sum of risk_amount on active tickets
        activeRisk:     stats.activeRisk,
        hostAtRisk:     stats.hostAtRisk,
        handle:         stats.handle,          // all-time risk (active + settled)
        settledHandle:  stats.settledHandle,
        holdPct:        stats.holdPct,
        profit:         stats.profit,
        playersOwe:     stats.playersOwe,
        hostOwes:       stats.hostOwes,
        weekly:         weeklyStats,
        allTime:        stats.allTime
      },
      warnings
    });
  } catch(e) {
    console.error('[host/dashboard] error:', e.message);
    res.status(500).json({ ok:false, source:'db_error', error:e.message, stats:null });
  }
});
// ────────────────────────────────────────────────────────────────────────────


// Last SETTLEMENT_APPLIED / settlement / weekly rollover marker per player (cutoff for weekly nets)
async function _loadSettlementCutoffs(sb, clubId, playerIds) {
  const map = {}; // playerId -> ISO timestamp ms
  if (!sb || !(playerIds||[]).length) return map;
  try {
    const { data: rows } = await sb.from('ledger_entries')
      .select('player_id,type,created_at')
      .eq('club_id', clubId)
      .in('player_id', playerIds)
      .in('type', ['settlement','SETTLEMENT_APPLIED','weekly_rollover','WEEKLY_ROLLOVER']);
    (rows||[]).forEach(function(r){
      const pid = String(r.player_id||'');
      const ms = new Date(r.created_at||0).getTime();
      if (!pid || !ms) return;
      if (!map[pid] || ms > map[pid]) map[pid] = ms;
    });
  } catch(_e) {
    console.warn('[settlement-cutoff] ledger_entries read failed:', _e.message||_e);
  }
  try {
    const { data: rolls } = await sb.from('weekly_rollovers')
      .select('performed_at').eq('club_id', clubId)
      .order('performed_at', { ascending:false }).limit(1);
    if (rolls && rolls[0] && rolls[0].performed_at) {
      const rms = new Date(rolls[0].performed_at).getTime();
      playerIds.forEach(function(pid){
        const k = String(pid);
        if (!map[k] || rms > map[k]) map[k] = rms;
      });
    }
  } catch(_e2) {}
  return map;
}

// GET /api/host/settlements-preview?clubId= — read-only settlement preview from DB
app.get('/api/host/settlements-preview', requireCanonicalClubId, requirePermissionScoped('view_settlement_history'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, source:'supabase_not_configured', players:[], totals:{playersOwe:0,hostOwes:0,net:0} });
  if (req._clubId) req.query = Object.assign({}, req.query, { clubId: req._clubId });
  const { clubId } = req.query;
  try {
    // Load all tickets for this club
    let tq = sb.from('tickets')
      .select('id,status,risk_amount,potential_profit,player_id,player_username,placed_at,graded_at,type');
    if (clubId) tq = tq.eq('club_id', clubId);
    const { data: tickets, error: tErr } = await tq;
    if (tErr) throw tErr;

    // Load balance_start from club_members — canonical balance table (PL-3 fix).
    // player_limits holds risk controls only; it has no balance_start column.
    var memberMap = {};
    try {
      let plq = sb.from('club_members').select('player_id,balance_start');
      if (clubId) plq = plq.eq('club_id', clubId);
      const { data: plRows } = await plq;
      (plRows||[]).forEach(function(r) {
        if (r.player_id != null) memberMap[String(r.player_id)] = { balance_start: r.balance_start != null ? parseFloat(r.balance_start) : null };
      });
    } catch(_e) { console.warn('[settlements-preview] club_members balance fetch error:', _e.message); }

    // Derive per-player settlement from tickets
    var byPlayer = {};
    function getOrCreate(pid, username) {
      if (!byPlayer[pid]) {
        var meta = memberMap[pid] || {};
        byPlayer[pid] = {
          playerId:     pid,
          username:     username || pid,
          balance:      meta.balance_start != null ? parseFloat(meta.balance_start) : null,
          openRisk:     0,
          settledNet:   0,
          weekWagered:  0,
          weekWon:      0,
          weekLost:     0,
          weekNet:      0,
          owesHost:     0,
          hostOwes:     0,
          lastTicketAt: null
        };
      }
      return byPlayer[pid];
    }

    function rnd(v){ return Math.round((isNaN(v)?0:v)*100)/100; }

    // Ensure roster players appear even with zero tickets
    Object.keys(memberMap).forEach(function(pid){ getOrCreate(pid, pid); });

    var cutoffMap = await _loadSettlementCutoffs(sb, clubId, Object.keys(byPlayer).concat(Object.keys(memberMap)));

    (tickets||[]).forEach(function(t) {
      var pid  = String(t.player_id || 'unknown');
      var s    = (t.status||'').toLowerCase();
      var risk = parseFloat(t.risk_amount)||0;
      var prof = parseFloat(t.potential_profit)||0;
      var p    = getOrCreate(pid, t.player_username);
      var pMs  = t.placed_at ? new Date(t.placed_at).getTime() : 0;
      if (pMs && (!p.lastTicketAt || pMs > new Date(p.lastTicketAt).getTime())) p.lastTicketAt = t.placed_at;
      if (s==='canceled'||s==='voided'||s==='deleted'||s==='push'||s==='pushed') return;
      if (s==='active'||s==='open')  { p.openRisk += risk; p.weekWagered += risk; return; }
      // Settled nets / week stats only count AFTER last SETTLEMENT_APPLIED cutoff (no double-count)
      var cut = cutoffMap[pid] || 0;
      var gradeMs = new Date(t.graded_at || t.placed_at || 0).getTime();
      if (cut && gradeMs && gradeMs <= cut) return;
      if (s==='won')             { p.settledNet += prof; p.weekWon += prof; p.weekWagered += risk; }
      else if (s==='lost')       { p.settledNet -= risk; p.weekLost += risk; p.weekWagered += risk; }
    });

    // Ledger-derived current balances
    var ledgerBalByPid = {};
    try {
      var allPids = Object.keys(byPlayer);
      if (allPids.length) {
        const { data: ledRows } = await sb.from('ledger_entries')
          .select('player_id,amount,balance_after,created_at,type')
          .eq('club_id', clubId).in('player_id', allPids)
          .order('created_at', { ascending:true });
        var byLed = {};
        (ledRows||[]).forEach(function(r){
          var pid=String(r.player_id||'');
          if (!byLed[pid]) byLed[pid]=[];
          byLed[pid].push(r);
        });
        allPids.forEach(function(pid){
          var start = (memberMap[pid]&&memberMap[pid].balance_start!=null) ? memberMap[pid].balance_start : 0;
          ledgerBalByPid[pid] = _deriveBalanceFromLedgerEntries(start, byLed[pid]||[]);
        });
      }
    } catch(_lb) { console.warn('[settlements-preview] ledger balance error:', _lb.message); }

    Object.values(byPlayer).forEach(function(p) {
      p.settledNet  = rnd(p.settledNet);
      p.openRisk    = rnd(p.openRisk);
      p.weekWagered = rnd(p.weekWagered);
      p.weekWon     = rnd(p.weekWon);
      p.weekLost    = rnd(p.weekLost);
      p.weekNet     = rnd(p.settledNet); // player POV: + = player won / host owes
      if (p.settledNet < 0) { p.owesHost = rnd(Math.abs(p.settledNet)); p.hostOwes = 0; }
      else                  { p.hostOwes = rnd(p.settledNet); p.owesHost = 0; }
      var start = (memberMap[p.playerId]&&memberMap[p.playerId].balance_start!=null)
        ? rnd(memberMap[p.playerId].balance_start) : null;
      p.startingBalance = start;
      p.balance_start   = start; // alias for clients expecting snake_case
      p.currentBalance = ledgerBalByPid[p.playerId] != null ? rnd(ledgerBalByPid[p.playerId]) : start;
      // Next week starts from current available balance (open risk already held in ledger)
      p.startingBalanceNextWeek = p.currentBalance;
      p.settlementCutoffAt = cutoffMap[p.playerId] ? new Date(cutoffMap[p.playerId]).toISOString() : null;
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

// POST /api/host/player-credit — update club_members.balance_start (credit limit)
app.post('/api/host/player-credit', requireCanonicalClubId, requirePermissionScoped('settle_player'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });

  const actor = req._actor || {};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole !== 'platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role', required:'host/admin' });

  const { clubId, playerId, balanceStart } = req.body || {};
  const errors = [];
  if (!clubId)   errors.push('missing_clubId');
  if (!playerId) errors.push('missing_playerId');
  const newStart = typeof balanceStart === 'number' ? balanceStart : parseFloat(balanceStart);
  if (!Number.isFinite(newStart)) errors.push('invalid_balanceStart');
  if (errors.length) return res.status(400).json({ ok:false, errors });

  const rnd = function(v){ return Math.round((isNaN(v)?0:v)*100)/100; };
  const newBalanceStart = rnd(newStart);

  try {
    const { data: memRows, error: memErr } = await sb.from('club_members')
      .select('player_id,balance_start')
      .eq('club_id', clubId).eq('player_id', playerId).limit(1);
    if (memErr) throw memErr;
    if (!memRows || !memRows.length)
      return res.status(404).json({ ok:false, error:'member_not_found' });

    const previousBalanceStart = memRows[0].balance_start != null
      ? rnd(parseFloat(memRows[0].balance_start)) : null;
    if (previousBalanceStart != null && Math.abs(previousBalanceStart - newBalanceStart) < 0.005)
      return res.json({ ok:true, playerId, newBalanceStart, previousBalanceStart, unchanged:true });

    const { error: updErr } = await sb.from('club_members')
      .update({ balance_start: newBalanceStart })
      .eq('club_id', clubId).eq('player_id', playerId);
    if (updErr) throw updErr;

    // Current derived balance so HOST_ADJUSTMENT keeps ledger balance_after correct
    var balanceBefore = previousBalanceStart != null ? previousBalanceStart : newBalanceStart;
    try {
      const { data: ledRows } = await sb.from('ledger_entries')
        .select('amount,balance_after,created_at,type')
        .eq('club_id', clubId).eq('player_id', playerId)
        .order('created_at', { ascending:true });
      if (ledRows && ledRows.length)
        balanceBefore = _deriveBalanceFromLedgerEntries(previousBalanceStart, ledRows);
    } catch(_lb) { console.warn('[player-credit] ledger read error:', _lb.message); }

    const delta = rnd(newBalanceStart - (previousBalanceStart != null ? previousBalanceStart : newBalanceStart));
    const balanceAfter = rnd((balanceBefore != null ? balanceBefore : 0) + delta);
    const ledgerId = 'HOST_ADJ_'+clubId+'_'+playerId+'_'+Date.now()+'_'+_crypto.randomBytes(3).toString('hex');
    const actorId = actor.actorId || 'host';

    await sb.from('ledger_entries').upsert({
      id: ledgerId,
      club_id: clubId,
      player_id: playerId,
      type: 'HOST_ADJUSTMENT',
      amount: delta,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      reason: 'player_credit: '+
        (previousBalanceStart != null ? previousBalanceStart.toFixed(2) : 'null')+
        ' → '+newBalanceStart.toFixed(2),
      created_at: new Date().toISOString(),
      created_by: actorId
    }, { onConflict: 'id' });

    try {
      await sb.from('audit_events').insert({
        event_type: 'player_credit_updated',
        club_id: clubId, player_id: playerId,
        payload: {
          previousBalanceStart, newBalanceStart, delta,
          ledgerId, actorId
        }
      });
    } catch(_ae) { console.warn('[player-credit] audit error:', _ae.message); }

    console.log('[player-credit] player='+playerId+' '+previousBalanceStart+' → '+newBalanceStart);
    res.json({ ok:true, playerId, newBalanceStart, previousBalanceStart });
  } catch(e) {
    console.error('[player-credit] error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
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
      .select('id,status,risk_amount,potential_profit,player_id,player_username,placed_at,graded_at')
      .eq('club_id', clubId);

    // 2b. Load player starting balances from club_members (PL-3 fix).
    // player_limits = risk controls only; club_members = membership + balance_start.
    var balMap = {};
    try {
      const { data: _plRows } = await sb.from('club_members').select('player_id,balance_start')
        .eq('club_id', clubId);
      (_plRows||[]).forEach(function(r) {
        if (r.player_id != null && r.balance_start != null)
          balMap[String(r.player_id)] = parseFloat(r.balance_start);
      });
    } catch(_balErr) { console.warn('[weekly-rollover] club_members balance fetch error:', _balErr.message); }

    // 3. Derive per-player snapshot
    var byPlayer = {};
    function goc(pid, uname) {
      if (!byPlayer[pid]) byPlayer[pid] = { playerId:pid, username:uname||pid,
        owesHost:0, hostOwes:0, openRisk:0, settledNet:0, activeBetCount:0 };
      return byPlayer[pid];
    }
    var rnd = function(v){ return Math.round((isNaN(v)?0:v)*100)/100; };
    var _rollCutoffs = await _loadSettlementCutoffs(sb, clubId,
      Array.from(new Set((tickets||[]).map(function(t){ return String(t.player_id||''); }).filter(Boolean)
        .concat(Object.keys(balMap)))));
    (tickets||[]).forEach(function(t) {
      var s=t.status.toLowerCase(), r=parseFloat(t.risk_amount)||0, p=parseFloat(t.potential_profit)||0;
      var pl = goc(t.player_id, t.player_username);
      if (s==='canceled'||s==='voided'||s==='push'||s==='pushed') return;
      if (s==='active'||s==='open')  { pl.openRisk+=r; pl.activeBetCount++; return; }
      var cut = _rollCutoffs[String(t.player_id)] || 0;
      var gradeMs = new Date(t.graded_at || t.placed_at || 0).getTime();
      if (cut && gradeMs && gradeMs <= cut) return;
      if (s==='lost')            { pl.settledNet-=r; }
      else if (s==='won')        { pl.settledNet+=p; }
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
            p_starting_balance: balMap[String(p.playerId)] ?? null, // null if no club_members row — RPC rejects rather than using phantom $1k
            p_created_by:       performedBy||'host'
          });
        } catch(_e) { /* non-fatal: snapshot already exists */ }
      }));

      // Mirror SETTLEMENT_APPLIED into ledger_entries (cutoff marker; never double-count next week)
      await Promise.all(players.map(async function(p) {
        try {
          var netAmt = rnd((p.hostOwes||0) - (p.owesHost||0)); // + host owes player
          var entryId = 'SETTLEMENT_APPLIED_'+clubId+'_'+week+'_'+p.playerId;
          var startBal = balMap[String(p.playerId)];
          var balBefore = startBal != null ? startBal : null;
          // Settlement records cash settlement of weekly net; available bankroll unchanged
          // until cash moves — amount is signed net for audit/cutoff, balance_after unchanged.
          await sb.from('ledger_entries').upsert({
            id: entryId,
            club_id: clubId,
            player_id: p.playerId,
            type: 'SETTLEMENT_APPLIED',
            amount: netAmt,
            balance_before: balBefore,
            balance_after: balBefore,
            reason: 'weekly_rollover:'+week,
            created_at: performedAt,
            created_by: performedBy||'host'
          }, { onConflict: 'id' });
        } catch(_se) {
          console.warn('[weekly-rollover] SETTLEMENT_APPLIED write failed player='+p.playerId+':', _se.message||_se);
        }
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
app.post('/api/bets/place', requireCanonicalClubId, requirePermissionScoped('place_bet', function(req) {
  const actor = requireActor(req);
  return (req.body && req.body.playerId) || (actor && actor.actorId) || null;
}), requireIdempotency({required:true}), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const _bodyRaw = req.body || {};
  // If no playerId in body, use the token's actorId (owner/host placing own test bet)
  const _actor = requireActor(req);
  const _resolvedPlayerId = _bodyRaw.playerId || (_actor && _actor.actorId) || null;
  const { clubId, betType, stake, legs, payout, potentialProfit,
          idempotencyKey, playerUsername, rrStakes } = _bodyRaw;
  const insuranceEnabled = !!(_bodyRaw.insuranceEnabled || _bodyRaw.insurance_enabled)
    && betType === 'Parlay' && Array.isArray(legs) && legs.length >= 3;
  const playerId = _resolvedPlayerId;
  if (_actor && !_bodyRaw.playerId && _actor.actorId) {
    console.log('TOKEN_SCOPE role='+(_actor.role||'?')+' playerCapable=true (resolved from token)');
  }
  const rnd = function(v){ return Math.round((isNaN(v)?0:v)*100)/100; };
  const now = new Date().toISOString();

  // Validate required fields
  const VALID_TYPES = new Set(['Single','Parlay','RoundRobin','Teaser','SGP']);
  const errors = [];
  if (!playerId)          errors.push('missing_playerId');
  if (!idempotencyKey)    errors.push('missing_idempotencyKey');
  if (!VALID_TYPES.has(betType)) errors.push('invalid_betType:'+betType);
  const stakeAmt = parseFloat(stake);
  if (isNaN(stakeAmt)||stakeAmt<=0) errors.push('invalid_stake');
  let legsArr = Array.isArray(legs) ? legs.map(_ingestPlaceBetLeg) : [];
  if (!legsArr.length) errors.push('no_legs');
  legsArr.forEach(function(leg,i) {
    _validatePlaceBetLegContract(leg, i, errors);
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

    // Starting balance: read from club_members (the balance table for this schema).
    // club_members.balance_start is the authoritative starting balance, scoped by
    // club_id + player_id. player_limits holds risk limits (max_bet, max_payout),
    // not balance. IMPORTANT: a missing club_members row is an EXPLICIT REJECTION —
    // there is no silent $1,000 fallback. The RPC re-checks atomically; this precheck
    // is the fast early-exit before the atomic write.
    let startBal = null;
    try {
      const { data:mem } = await sb.from('club_members').select('balance_start')
        .eq('club_id',clubId).eq('player_id',playerId).limit(1);
      if (mem&&mem[0]) {
        const _parsed = parseFloat(mem[0].balance_start);
        if (!isNaN(_parsed)) startBal = _parsed;
      }
    } catch(_limitsErr) {
      // DB error reading balance — fail-open here (RPC is the authoritative gate).
      // Log and allow the RPC to make the final call.
      console.warn('[bets/place] club_members read error (RPC will enforce):', _limitsErr.message);
      startBal = 0; // conservative: 0 means only ledger gains can cover the stake
    }

    if (startBal === null) {
      return res.status(400).json({
        ok: false,
        error: 'no_club_member_balance_found',
        hint: 'No balance record found for this player at this club. A club_members row must exist before bets can be placed.'
      });
    }

    var openRisk=0, settledGains=0, settledLosses=0;
    (playerTix||[]).forEach(function(t){
      var s=t.status.toLowerCase(), r=parseFloat(t.risk_amount)||0, p=parseFloat(t.potential_profit)||0;
      if (s==='canceled'||s==='voided'||s==='push'||s==='pushed') return;
      if (s==='active'||s==='open') openRisk+=r;
      else if (s==='won')  settledGains+=p;
      else if (s==='lost') settledLosses+=r;
    });
    // Prefer ledger_entries as source of truth (signed amounts / balance_after).
    // Ticket formula is fallback when no ledger rows exist yet.
    var ticketAvailable = rnd(startBal - openRisk - settledLosses + settledGains);
    var available = ticketAvailable;
    try {
      var { data: _preLedger } = await sb.from('ledger_entries')
        .select('amount,balance_after,created_at')
        .eq('club_id', clubId).eq('player_id', playerId)
        .order('created_at', { ascending:true });
      if (_preLedger && _preLedger.length) {
        var ledAvail = _deriveBalanceFromLedgerEntries(startBal, _preLedger);
        if (ledAvail != null) available = ledAvail;
      }
    } catch(_preLedErr) {
      console.warn('[bets/place] ledger precheck fallback to tickets:', _preLedErr.message);
    }
    // The RPC re-checks atomically; this precheck is informational early rejection only.
    if (stakeAmt > available + 0.005)
      return res.status(400).json({ ok:false, error:'insufficient_balance', available, stake:stakeAmt, ticketAvailable });

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
          ||payoutResult.code==='line_changed'
          ||payoutResult.code==='market_unavailable'
          ||payoutResult.code==='market_closed'
          ||payoutResult.code==='odds_stale')?409 : 422;
      console.log('[bets/place] snapshot validation failed:', payoutResult.code,
        payoutResult.reason||'-', payoutResult.leg, '('+httpStatus+')');
      _recordLivePlacementRejection(payoutResult.code, _liveRejectionContextFromLegs(legsArr, payoutResult, {
        phase:'initial_snapshot',
        clubId,
        playerId
      }));
      // Surface a clean user-facing message for Live tab placement.
      // Only fire when the market is actually suspended or the game is final/canceled.
      if (!payoutResult.userMessage) {
        if (payoutResult.code === 'market_unavailable') {
          payoutResult.userMessage =
            payoutResult.reason === 'game_final'    ? 'game is final' :
            payoutResult.reason === 'game_canceled' ? 'Market unavailable: game canceled.' :
            payoutResult.reason === 'suspended'     ? 'Market unavailable: temporarily suspended.' :
                                                      'Market unavailable.';
        } else if (payoutResult.code === 'live_betting_disabled') {
          payoutResult.userMessage = 'live betting disabled';
        } else if (payoutResult.code === 'odds_changed') {
          payoutResult.userMessage = 'Odds changed — please review and confirm.';
        } else if (payoutResult.code === 'line_changed') {
          payoutResult.userMessage = 'Line changed — please review and confirm.';
        } else if (payoutResult.code === 'odds_stale') {
          payoutResult.userMessage = 'Odds refreshing — please try again.';
        } else if (payoutResult.code === 'odds_service_unavailable') {
          payoutResult.userMessage = 'Odds service unavailable — please try again shortly.';
        }
      }
      // Emit risk alert for snapshot rejection
      var _snapRaType = { odds_changed:'odds_change_rejections',
        line_changed:'odds_change_rejections',
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

    // 3b. Risk limits check — runs after snapshot verification so legs carry
    //     server_is_live (authoritative). Postgres RPC also enforces; this gives
    //     early JS-side rejection before the atomic write.
    try {
      const riskCheck = await _checkRiskLimitsJs(sb, clubId, playerId, {
        stake: stakeAmt, potentialPayout: serverPayout != null ? serverPayout : (parseFloat(payout)||0),
        betType, legs: legsArr
      });
      if (!riskCheck.ok) {
        const httpStatus = RISK_CODE_STATUS[riskCheck.code] || 422;
        console.log('[bets/place] risk limit rejected:', riskCheck.code, 'actor='+playerId);
        _recordLivePlacementRejection(riskCheck.code, _liveRejectionContextFromLegs(legsArr, riskCheck, {
          phase:'risk_check',
          clubId,
          playerId
        }));
        // Emit risk alert based on rejection code
        var _raType = {
          payout_above_max:'large_payout_attempt', player_open_risk_exceeded:'over_limit_attempt',
          club_open_risk_exceeded:'over_limit_attempt', event_risk_exceeded:'over_limit_attempt',
          market_risk_exceeded:'over_limit_attempt', stake_above_max:'over_limit_attempt'
        }[riskCheck.code];
        if (_raType) emitRiskAlert(_raType, clubId, playerId,
          { code:riskCheck.code, stake:stakeAmt, payout:serverPayout != null ? serverPayout : (parseFloat(payout)||0) });
        return res.status(httpStatus).json({ ok:false, code:riskCheck.code, ...riskCheck });
      }
    } catch(riskErr) {
      // PL-6: fail-CLOSED — a broken risk check must not allow unchecked bets through
      console.error('[bets/place] risk check exception — failing closed. actor='+playerId+
        ' club='+clubId+' err='+riskErr.message);
      return res.status(503).json({ ok:false, error:'risk_check_unavailable',
        message:'Risk checks temporarily unavailable. Please retry.' });
    }

    // 3c. Conflict check: active legs on same game+market
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
        .eq('player_id', playerId).eq('club_id', clubId).in('status',['active','open']);
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

    // 3d. Final just-in-time snapshot recheck. This intentionally runs after
    // balance/risk/conflict gates and immediately before place_bet_tx so a
    // live market move/suspension between the first check and the money RPC
    // still rejects without ticket, ledger, or HAB mutation.
    const finalPayoutResult = await _recalcPayoutFromSnapshots(sb, stakeAmt, legsArr, Date.now(), oddsChangePolicy);
    if (finalPayoutResult && !finalPayoutResult.ok) {
      const httpStatus = finalPayoutResult.code==='odds_service_unavailable'?503
        : (finalPayoutResult.code==='odds_changed'
          ||finalPayoutResult.code==='line_changed'
          ||finalPayoutResult.code==='market_unavailable'
          ||finalPayoutResult.code==='market_closed'
          ||finalPayoutResult.code==='odds_stale')?409 : 422;
      console.log('[bets/place] final snapshot recheck failed:', finalPayoutResult.code,
        finalPayoutResult.reason||'-', finalPayoutResult.leg, '('+httpStatus+')');
      _recordLivePlacementRejection(finalPayoutResult.code, _liveRejectionContextFromLegs(legsArr, finalPayoutResult, {
        phase:'final_snapshot',
        clubId,
        playerId
      }));
      return res.status(httpStatus).json(Object.assign({ ok:false, finalRecheck:true }, finalPayoutResult));
    }
    if (finalPayoutResult && finalPayoutResult.ok) {
      legsArr = finalPayoutResult.legs;
      serverPayout = finalPayoutResult.payout;
      serverProfit = rnd(serverPayout - stakeAmt);
    }

    // ── RR placement path ─────────────────────────────────────────────────────
    // Reached only after the containment block is removed (Phase 3).
    // By this point: all legs validated twice, enriched with accepted_odds_*,
    // risk limits checked, conflict check done.
    // This block generates N Parlay combo tickets under a shared rr_group_id,
    // calls place_rr_tx for atomic balance debit + ticket inserts, then inserts
    // ticket_legs for all combos. HAB is charged once.
    if (betType === 'RoundRobin') {
      // Validate rrStakes — must be a non-empty object with at least one active size.
      // Note: serverPayout is the product of ALL legs × totalStake (wrong for RR);
      // it was used for risk limit checks above with the client payout as fallback.
      // We compute correct per-combo payouts from server-accepted odds below.
      const rrStakesMap = (typeof rrStakes === 'object' && rrStakes !== null) ? rrStakes : {};
      const activeSizes = Object.keys(rrStakesMap).filter(function(k) {
        return (parseFloat(rrStakesMap[k]) || 0) > 0;
      });
      if (!activeSizes.length) {
        return res.status(400).json({ ok:false, error:'missing_rrStakes',
          message:'rrStakes must contain at least one active combo size with a positive stake.' });
      }

      // Generate group ID — shared across all combo tickets in this slip.
      const groupId = 'RRG_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);

      // Build combo payloads using server-accepted odds (authoritative).
      // legsArr at this point is enriched with accepted_odds_american / accepted_odds_decimal
      // from both snapshot validation passes.
      const rrCombos = [];
      let rrTotalVerifiedPayout = 0;

      for (const _sz of activeSizes) {
        const sz = parseInt(_sz);
        if (isNaN(sz) || sz < 2) continue;
        const stakePerCombo = rnd(parseFloat(rrStakesMap[_sz]) || 0);
        if (!stakePerCombo) continue;

        const combos = _getRrCombos(legsArr, sz);
        for (let ci = 0; ci < combos.length; ci++) {
          const comboLegs = combos[ci];
          // Product of per-leg decimal odds using server-accepted values.
          // Falls back to submitted odds if accepted_odds_american is missing.
          const decProduct = comboLegs.reduce(function(acc, leg) {
            return acc * _sgAmToDecimal(leg.accepted_odds_american || leg.odds || 0);
          }, 1.0);
          const comboPayout = rnd(stakePerCombo * decProduct);
          const comboProfit = rnd(comboPayout - stakePerCombo);

          const comboId = groupId + '_c' + rrCombos.length;
          rrCombos.push({
            id:               comboId,
            stake:            stakePerCombo,
            potential_profit: comboProfit,
            estimated_payout: comboPayout,
            legs:             comboLegs   // enriched legs for this combo (leg insert step below)
          });
          rrTotalVerifiedPayout += comboPayout;
        }
      }

      if (!rrCombos.length) {
        return res.status(400).json({ ok:false, error:'rr_no_combos_generated',
          message:'No valid combo sizes found in rrStakes.' });
      }

      // Sanity: sum of combo stakes must match total stakeAmt (within $0.01).
      const rrVerifiedStake = rnd(rrCombos.reduce(function(s,c){ return s+c.stake; }, 0));
      if (Math.abs(rrVerifiedStake - stakeAmt) > 0.01) {
        console.error('[bets/place] RR stake mismatch groupId='+groupId+
          ' verifiedStake='+rrVerifiedStake+' submitted='+stakeAmt);
        return res.status(400).json({ ok:false, error:'rr_stake_mismatch',
          computed:rrVerifiedStake, submitted:stakeAmt });
      }

      // Call place_rr_tx: atomic balance debit + N ticket row inserts.
      // Ticket legs are inserted AFTER the RPC succeeds (same pattern as place_bet_tx).
      const rpcCombos = rrCombos.map(function(c) {
        return { id:c.id, stake:c.stake,
                 potential_profit:c.potential_profit,
                 estimated_payout:c.estimated_payout };
      });
      const rrRpcResult = await _callMoneyRpc('place_rr_tx', {
        p_group_id:        groupId,
        p_club_id:         clubId||'',
        p_player_id:       playerId,
        p_player_username: playerUsername||null,
        p_total_stake:     rnd(stakeAmt),
        p_idempotency_key: idempotencyKey,
        p_created_by:      playerId,
        p_combos:          rpcCombos
      });

      if (!rrRpcResult.ok && !rrRpcResult.idempotent) {
        if (rrRpcResult.error === 'insufficient_balance') {
          return res.status(400).json({ ok:false, error:'insufficient_balance',
            available:rrRpcResult.available, stake:stakeAmt });
        }
        return res.status(400).json({ ok:false, error:rrRpcResult.error||'rr_placement_failed' });
      }

      // Insert ticket_legs for all combo tickets.
      // Each combo's legs are a subset of legsArr — enriched with accepted odds.
      // Same column set and fallback-strip logic as the standard path.
      const rrAllLegRows = [];
      rrCombos.forEach(function(combo) {
        combo.legs.forEach(function(leg, legIdx) {
          const ident = _normalizeLegIdentity(leg) || {};
          rrAllLegRows.push({
            id:                    crypto.randomUUID(),
            ticket_id:             combo.id,
            leg_index:             legIdx,
            provider_name:         leg.providerName||'odds-api',
            provider_game_id:      leg.providerGameId||leg.gameId||null,
            canonical_game_key:    leg.canonicalGameKey,
            sport:                 leg.sport||null,
            home_team:             leg.homeTeam||null,
            away_team:             leg.awayTeam||null,
            scheduled_start:       leg.scheduledStart||leg.commenceTime||null,
            market:                leg.market,
            pick:                  leg.pick,
            odds:                  leg.accepted_odds_american || leg.odds,
            line:                  leg.accepted_point_line != null ? leg.accepted_point_line
                                    : (leg.line != null ? parseFloat(leg.line) : null),
            side:                  leg.side||null,
            accepted_odds_american: leg.accepted_odds_american||null,
            accepted_odds_decimal:  leg.accepted_odds_decimal||null,
            accepted_point_line:    leg.accepted_point_line||null,
            odds_snapshot_id:       _uuidOrNull(leg.odds_snapshot_id),
            accepted_at:            leg.accepted_at||null,
            market_type:              ident.marketType || _coerceMarketType(leg.market) || leg.market,
            canonical_market_key:     ident.canonicalMarketKey || null,
            canonical_selection_key:  ident.canonicalSelectionKey || null,
            player_name_normalized:   ident.playerName ? _normalizePlayerName(ident.playerName) : null,
            prop_type_normalized:     ident.propType ? _normalizePropType(ident.propType) : null,
            prop_side:                ident.marketType === MARKET_TYPES.PLAYER_PROP ? (ident.side||null) : null
          });
        });
      });

      try {
        try {
          const rrLegIns = await sb.from('ticket_legs').insert(rrAllLegRows);
          if (rrLegIns.error) throw rrLegIns.error;
        } catch(e1) {
          const _msg = (e1 && e1.message) || '';
          const _missingCanon = /market_type|canonical_market_key|canonical_selection_key|player_name_normalized|prop_type_normalized|prop_side/.test(_msg);
          const _missingPhK   = /accepted_at|accepted_odds_american|accepted_odds_decimal|accepted_point_line|odds_snapshot_id/.test(_msg);
          if (_missingCanon || _missingPhK) {
            console.warn('[bets/place] RR ticket_legs: missing columns ('+
              [_missingCanon?'canonical':'',_missingPhK?'phaseK':''].filter(Boolean).join('+')+
              '), stripping — run migration in Supabase');
            const legacyRows = rrAllLegRows.map(function(r) {
              const copy = Object.assign({}, r);
              if (_missingCanon) {
                delete copy.market_type; delete copy.canonical_market_key;
                delete copy.canonical_selection_key; delete copy.player_name_normalized;
                delete copy.prop_type_normalized; delete copy.prop_side;
              }
              if (_missingPhK) {
                delete copy.accepted_odds_american; delete copy.accepted_odds_decimal;
                delete copy.accepted_point_line; delete copy.odds_snapshot_id;
                delete copy.accepted_at;
              }
              return copy;
            });
            const rrLegIns2 = await sb.from('ticket_legs').insert(legacyRows);
            if (rrLegIns2.error) throw rrLegIns2.error;
          } else { throw e1; }
        }
      } catch(rrLegErr) {
        // Compensation: cancel every combo ticket so balance reservation is freed.
        console.error('[bets/place] RR ticket_legs insert failed — compensating '
          +rrCombos.length+' combos:', rrLegErr.message, 'groupId='+groupId);
        const _rrOrphanPayload = { category:'rr_leg_insert_failed', groupId, clubId:clubId||null,
          playerId, idempotencyKey, legInsertError:rrLegErr.message,
          timestamp:new Date().toISOString() };
        console.error('CRITICAL_RR_LEG_INSERT_FAILED', JSON.stringify(_rrOrphanPayload));
        for (let ci = 0; ci < rrCombos.length; ci++) {
          try {
            await _callMoneyRpc('cancel_bet_tx', {
              p_ticket_id:       rrCombos[ci].id,
              p_club_id:         clubId||'',
              p_player_id:       playerId,
              p_idempotency_key: idempotencyKey+':rr_compensate:'+ci,
              p_reason:          'rr_ticket_legs_insert_failed',
              p_created_by:      playerId
            });
          } catch(cErr) {
            console.error('CRITICAL_RR_COMPENSATION_FAILED comboId='+rrCombos[ci].id, cErr.message);
          }
        }
        return res.status(500).json({ ok:false, error:'rr_ticket_legs_insert_failed',
          detail:rrLegErr.message, groupId });
      }

      // HAB charge — once for the whole RR slip, not per combo.
      // groupId passed as the ticket reference (HAB uses it for logging only).
      const _rrHabResult = await _processActiveBettorCharge(sb, clubId, playerId, groupId, Date.now());
      if (!_rrHabResult.ok) {
        console.error('[bets/place] RR HAB charge failed — compensating groupId='+groupId+
          ' error='+(_rrHabResult.error||'unknown'));
        for (let ci = 0; ci < rrCombos.length; ci++) {
          try {
            await _callMoneyRpc('cancel_bet_tx', {
              p_ticket_id:       rrCombos[ci].id,
              p_club_id:         clubId||'',
              p_player_id:       playerId,
              p_idempotency_key: idempotencyKey+':rr_hab_compensate:'+ci,
              p_reason:          'rr_active_bettor_charge_failed',
              p_created_by:      playerId
            });
          } catch(cErr) {
            console.error('CRITICAL_RR_HAB_COMPENSATION_FAILED comboId='+rrCombos[ci].id, cErr.message);
          }
        }
        if (_rrHabResult.httpStatus === 402) {
          return res.status(402).json({ ok:false, error:_rrHabResult.error,
            message:_rrHabResult.message, balance:_rrHabResult.balance,
            required:_rrHabResult.required, groupId, compensated:true });
        }
        return res.status(503).json({ ok:false, error:'rr_active_bettor_charge_failed',
          detail:_rrHabResult.error, groupId, compensated:true });
      }

      // Audit event (fire-and-forget)
      try {
        await sb.from('audit_events').insert({
          event_type: 'rr_placed', player_id:playerId, club_id:clubId||null, ticket_id:null,
          payload: { betType:'RoundRobin', groupId, comboCount:rrCombos.length,
                     totalStake:stakeAmt, activeSizes, txResult:rrRpcResult }
        });
      } catch(_auditErr) {
        console.warn('[bets/place] RR audit_events write failed (non-fatal):', _auditErr.message,
          'groupId='+groupId);
      }

      console.log('[bets/place] RR ok groupId='+groupId+' combos='+rrCombos.length+
        ' stake='+stakeAmt+' balanceAfter='+(rrRpcResult.balance_after||'?'));
      emitEvent('ticket_placed', { groupId, comboCount:rrCombos.length, stake:stakeAmt,
        betType:'RoundRobin', balanceAfter:rrRpcResult.balance_after },
        { clubId, actorId:playerId, playerId }, req.requestId);
      emitEvent('balance_changed', { playerId, balanceAfter:rrRpcResult.balance_after },
        { clubId, playerId }, req.requestId);
      emitRiskAlert('rapid_bet_velocity', clubId, playerId, { groupId, stake:stakeAmt });

      return res.json({ ok:true, groupId, comboCount:rrCombos.length,
        balanceAfter:rrRpcResult.balance_after, ledgerEntryId:idempotencyKey });
    }
    // ── End RR placement path ─────────────────────────────────────────────────

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
        id: crypto.randomUUID(), ticket_id: ticketId, leg_index: i,
        provider_name: leg.providerName||'odds-api', provider_game_id: leg.providerGameId||leg.gameId||null,
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
        odds_snapshot_id:       _uuidOrNull(leg.odds_snapshot_id),
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
      p_is_live:          legsArr.some(function(l){ return !!l.server_is_live; })
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

      // Helper: write a durable orphan-ticket event and emit Railway critical log.
      // Fire-and-forget — must never throw or block the error response.
      const _reportOrphanTicket = function(compensationError) {
        const _orphanPayload = {
          category:         'orphan_ticket_compensation_failed',
          ticketId:         ticketId,
          clubId:           clubId||null,
          playerId:         playerId,
          idempotencyKey:   idempotencyKey,
          legInsertError:   legErr.message,
          compensationError: compensationError,
          timestamp:        new Date().toISOString()
        };
        // Railway-visible critical log — searchable by ops/alerting rules.
        console.error('CRITICAL_ORPHAN_TICKET_COMPENSATION_FAILED', JSON.stringify(_orphanPayload));
        // Durable write — fire-and-forget so this path can never itself throw.
        try {
          sb.from('audit_events').insert({
            event_type: 'orphan_ticket_compensation_failed',
            player_id:  playerId,
            club_id:    clubId||null,
            ticket_id:  ticketId,
            payload:    _orphanPayload
          }).then(function(){}, function(writeErr){
            console.error('[bets/place] orphan audit write failed (secondary):', writeErr && writeErr.message);
          });
        } catch(_e) {
          console.error('[bets/place] orphan audit write threw (secondary):', _e && _e.message);
        }
      };

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
          _reportOrphanTicket('cancel_bet_tx returned not-ok: '+(cancelResult&&cancelResult.error||'unknown'));
        }
        // cancelResult.ok or idempotent → compensation succeeded, no orphan event needed.
      } catch(cancelErr) {
        _reportOrphanTicket('cancel_bet_tx threw: '+cancelErr.message);
      }
      return res.status(500).json({ ok:false, error:'ticket_legs_insert_failed',
        detail: legErr.message, ticketId });
    }

    // 7. Phase AA: active-bettor charge happens only after every pre-ticket
    // rejection gate and after the canonical ticket + legs are durable. If the
    // charge cannot be applied, compensate the just-created ticket so failed
    // placement attempts never consume active-bettor capacity.
    const _habResult = await _processActiveBettorCharge(sb, clubId, playerId, ticketId, Date.now());
    if (!_habResult.ok) {
      console.error('[bets/place] active-bettor charge failed AFTER placement — compensating ticketId='+ticketId+
        ' error='+(_habResult.error||'unknown'));
      try {
        const habCancelResult = await _callMoneyRpc('cancel_bet_tx', {
          p_ticket_id:       ticketId,
          p_club_id:         clubId||'',
          p_player_id:       playerId,
          p_idempotency_key: idempotencyKey+':hab_compensate',
          p_reason:          'active_bettor_charge_failed',
          p_created_by:      playerId
        });
        if (!habCancelResult || (!habCancelResult.ok && !habCancelResult.idempotent)) {
          console.error('CRITICAL_HAB_COMPENSATION_FAILED', JSON.stringify({
            ticketId, clubId, playerId, idempotencyKey,
            habError:_habResult.error||'unknown',
            compensationError:habCancelResult&&habCancelResult.error||'unknown',
            timestamp:new Date().toISOString()
          }));
        }
      } catch(habCancelErr) {
        console.error('CRITICAL_HAB_COMPENSATION_FAILED', JSON.stringify({
          ticketId, clubId, playerId, idempotencyKey,
          habError:_habResult.error||'unknown',
          compensationError:habCancelErr.message,
          timestamp:new Date().toISOString()
        }));
      }
      if (_habResult.httpStatus === 402) {
        return res.status(402).json({ ok:false, error:_habResult.error,
          message:_habResult.message, balance:_habResult.balance, required:_habResult.required,
          ticketId, compensated:true });
      }
      return res.status(503).json({ ok:false, error:'active_bettor_charge_failed',
        detail:_habResult.error, ticketId, compensated:true });
    }

    // 8. Legacy ledger_entries mirror (Phase A compat — fire-and-forget)
    // NOTE: Supabase v2 query builders are thenables but not real Promises
    // until awaited or .then()'d — calling .catch() directly throws
    // "upsert(...).catch is not a function". Use .then(noop, noop) instead.
    sb.from('ledger_entries').upsert({
      id: idempotencyKey, club_id: clubId||null, player_id: playerId,
      ticket_id: ticketId, type: 'bet_placed',
      amount: rnd(-stakeAmt), reason: 'bet_placed:'+betType,
      created_at: now, created_by: playerId
    }, { onConflict:'id' }).then(()=>{},()=>{});

    // 9. Audit event — fire-and-forget after RPC commit.
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

    if (insuranceEnabled) {
      try {
        await sb.from('tickets').update({ insurance_enabled: true }).eq('id', ticketId);
      } catch(_insUpd) {
        console.warn('[bets/place] insurance_enabled update failed:', _insUpd.message);
      }
    }

    const ticketRow = { id:ticketId, club_id:clubId, player_id:playerId, type:betType,
      status:'active', risk_amount:rnd(stakeAmt), placed_at:now,
      insurance_enabled: !!insuranceEnabled };
    console.log('[bets/place] RPC ok ticketId='+ticketId+' stake='+stakeAmt+' balanceAfter='+(rpcResult.balance_after||'?')+(insuranceEnabled?' insured=1':''));
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
  const { clubId, playerId, ticketId, idempotencyKey, reason, force } = req.body || {};
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

    // 3. Game started check via ticket_legs.
    // Players cannot cancel after kickoff. Privileged force=true skips this so
    // stale smoke/QA tickets can be voided through cancel_bet_tx instead of
    // being deleted or left active forever.
    const _forceCancel = _isPrivilegedCancel && (force === true || force === 'true');
    if (!_forceCancel) {
      const { data: legs } = await sb.from('ticket_legs').select('scheduled_start').eq('ticket_id', ticketId);
      const nowMs = Date.now();
      for (const leg of (legs||[])) {
        if (!leg.scheduled_start) continue;
        const ctMs = new Date(leg.scheduled_start).getTime();
        if (!isNaN(ctMs) && nowMs >= ctMs)
          return res.status(400).json({ ok:false, error:'game_already_started:'+leg.scheduled_start });
      }
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

function _cashoutPickLabel(ticket, legs) {
  var first = (legs && legs[0]) || {};
  return ticket.player_username || first.pick || first.home_team || ticket.id || 'bet';
}

// POST /api/host/offer-cashout — host offers a cash-out amount on an active ticket
app.post('/api/host/offer-cashout', requireCanonicalClubId, requirePermissionScoped('view_host_dashboard'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  if (req._clubId) req.body = Object.assign({}, req.body, { clubId: req._clubId });
  const actor = req._actor || {};
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole !== 'platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role', required:'host/admin' });
  const ticketId = req.body && req.body.ticketId;
  const playerId = req.body && req.body.playerId;
  const amount = Math.round((parseFloat(req.body && req.body.amount)||0)*100)/100;
  if (!ticketId) return res.status(400).json({ ok:false, error:'missing_ticketId' });
  if (!(amount > 0)) return res.status(400).json({ ok:false, error:'invalid_amount' });
  try {
    const { data: tix, error: tErr } = await sb.from('tickets')
      .select('id,status,player_id,club_id,player_username,risk_amount,estimated_payout,type')
      .eq('id', ticketId).limit(1);
    if (tErr) throw tErr;
    const ticket = tix && tix[0];
    if (!ticket) return res.status(404).json({ ok:false, error:'ticket_not_found' });
    const st = String(ticket.status||'').toLowerCase();
    if (st !== 'active' && st !== 'open')
      return res.status(400).json({ ok:false, error:'ticket_not_active' });
    if (playerId && ticket.player_id && String(ticket.player_id) !== String(playerId))
      return res.status(400).json({ ok:false, error:'player_mismatch' });
    const { data: legs } = await sb.from('ticket_legs').select('pick,home_team,away_team')
      .eq('ticket_id', ticketId).order('leg_index').limit(3);
    const pickLbl = _cashoutPickLabel(ticket, legs);
    await sb.from('tickets').update({
      cashout_offer_amount: amount,
      cashout_offer_status: 'offered'
    }).eq('id', ticketId);
    const notifId = await _notifyPlayer({
      playerId: ticket.player_id,
      type: 'cashout_offer',
      title: 'Cash out offer',
      message: 'Cash out offer: $'+amount.toFixed(2)+' on your '+pickLbl+' bet — accept or decline [ticket:'+ticketId+']',
      metadata: { ticketId: ticketId, amount: amount, type: 'cashout_offer' }
    });
    try {
      await sb.from('audit_events').insert({
        event_type: 'cashout_offered', ticket_id: ticketId,
        player_id: ticket.player_id, club_id: ticket.club_id,
        payload: { amount: amount, offeredBy: actor.actorId, notificationId: notifId }
      });
    } catch(_ae) {}
    res.json({ ok:true, ticketId, amount, notificationId: notifId, playerId: ticket.player_id });
  } catch(e) {
    console.error('[host/offer-cashout]', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// POST /api/bets/accept-cashout — player accepts host cash-out offer
app.post('/api/bets/accept-cashout', requireCanonicalClubId, requirePermissionScoped('place_bet', function(req) {
  const actor = requireActor(req);
  return (req.body && req.body.playerId) || (actor && actor.actorId) || null;
}), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const actor = req._actor || requireActor(req) || {};
  const ticketId = req.body && req.body.ticketId;
  const notificationId = req.body && req.body.notificationId;
  if (!ticketId) return res.status(400).json({ ok:false, error:'missing_ticketId' });
  try {
    const { data: tix, error: tErr } = await sb.from('tickets')
      .select('id,status,player_id,club_id,risk_amount,cashout_offer_amount,cashout_offer_status')
      .eq('id', ticketId).limit(1);
    if (tErr) throw tErr;
    const ticket = tix && tix[0];
    if (!ticket) return res.status(404).json({ ok:false, error:'ticket_not_found' });
    if (actor.actorId && String(actor.actorId) !== String(ticket.player_id)
        && (ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole !== 'platform_admin')
      return res.status(403).json({ ok:false, error:'not_owner' });
    const st = String(ticket.status||'').toLowerCase();
    if (st === 'cashed_out') return res.json({ ok:true, idempotent:true, ticketId, status:'cashed_out' });
    if (st !== 'active' && st !== 'open')
      return res.status(400).json({ ok:false, error:'ticket_not_active' });
    if (String(ticket.cashout_offer_status||'') !== 'offered')
      return res.status(400).json({ ok:false, error:'no_cashout_offer' });
    const amount = Math.round((parseFloat(ticket.cashout_offer_amount)||0)*100)/100;
    if (!(amount > 0)) return res.status(400).json({ ok:false, error:'invalid_offer_amount' });
    const iKey = 'CASHOUT_'+ticketId;
    const credit = await _creditPlayerAccount({
      clubId: ticket.club_id||'', playerId: ticket.player_id, ticketId: ticketId,
      eventType: 'CASHOUT_SETTLEMENT', ledgerEntriesType: 'CASHOUT_SETTLEMENT',
      amount: amount, idempotencyKey: iKey,
      createdBy: actor.actorId || ticket.player_id,
      reason: 'cashout_accepted:'+amount
    });
    await sb.from('tickets').update({
      status: 'cashed_out',
      cashout_offer_status: 'accepted',
      graded_at: new Date().toISOString()
    }).eq('id', ticketId);
    if (notificationId) {
      try {
        await sb.from('player_notifications').update({ read: true }).eq('id', notificationId);
      } catch(_n) {}
    }
    try {
      await sb.from('audit_events').insert({
        event_type: 'cashout_accepted', ticket_id: ticketId,
        player_id: ticket.player_id, club_id: ticket.club_id,
        payload: { amount: amount, notificationId: notificationId, ledgerEntryId: credit.ledgerEntryId }
      });
    } catch(_ae) {}
    emitEvent('balance_changed', { playerId: ticket.player_id, balanceAfter: credit.balanceAfter },
      { clubId: ticket.club_id, playerId: ticket.player_id }, req.requestId);
    res.json({ ok:true, ticketId, status:'cashed_out', amount: amount,
      balanceAfter: credit.balanceAfter, ledgerEntryId: credit.ledgerEntryId });
  } catch(e) {
    console.error('[bets/accept-cashout]', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// POST /api/bets/decline-cashout — player declines; bet stays active
app.post('/api/bets/decline-cashout', requireCanonicalClubId, requirePermissionScoped('place_bet', function(req) {
  const actor = requireActor(req);
  return (req.body && req.body.playerId) || (actor && actor.actorId) || null;
}), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const actor = req._actor || requireActor(req) || {};
  const ticketId = req.body && req.body.ticketId;
  const notificationId = req.body && req.body.notificationId;
  if (!ticketId) return res.status(400).json({ ok:false, error:'missing_ticketId' });
  try {
    const { data: tix, error: tErr } = await sb.from('tickets')
      .select('id,status,player_id,club_id,cashout_offer_status')
      .eq('id', ticketId).limit(1);
    if (tErr) throw tErr;
    const ticket = tix && tix[0];
    if (!ticket) return res.status(404).json({ ok:false, error:'ticket_not_found' });
    if (actor.actorId && String(actor.actorId) !== String(ticket.player_id)
        && (ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole !== 'platform_admin')
      return res.status(403).json({ ok:false, error:'not_owner' });
    await sb.from('tickets').update({ cashout_offer_status: 'declined' }).eq('id', ticketId);
    if (notificationId) {
      try {
        await sb.from('player_notifications').update({ read: true }).eq('id', notificationId);
      } catch(_n) {}
    }
    res.json({ ok:true, ticketId, status: ticket.status, declined: true });
  } catch(e) {
    console.error('[bets/decline-cashout]', e.message);
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
      'id,status,type,risk_amount,potential_profit,estimated_payout,placed_at,graded_at,grading_source,odds,rr_group_id,insurance_enabled,cashout_offer_amount,cashout_offer_status'
    ).eq('player_id', playerId);
    if (clubId) tq = tq.eq('club_id', clubId);
    tq = tq.order('placed_at', { ascending:false });
    const { data: tickets, error: tErr } = await tq;
    if (tErr) throw tErr;

    // Starting balance from club_members — canonical balance table (PL-3 fix).
    // player_limits = risk controls only; club_members = membership + balance_start.
    var startingBalance = null;
    try {
      const { data: mem } = await sb.from('club_members')
        .select('balance_start').eq('club_id', clubId).eq('player_id', playerId)
        .limit(1);
      if (mem && mem[0] && mem[0].balance_start != null) startingBalance = parseFloat(mem[0].balance_start);
    } catch(_e) { console.warn('[player/summary] club_members balance fetch error:', _e.message); }
    if (startingBalance === null) console.warn('[player/summary] no club_members row for player='+playerId+' club='+clubId+' — balance shown as null');

    // Ticket-derived components (breakdown + fallback)
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
      else if (s==='push'||s==='pushed'||s==='cashed_out'||s==='cashedout') { settled.push(t); }
    });
    var ticketAvailable = startingBalance !== null
      ? rnd(startingBalance - openRisk - settledLosses + settledGains)
      : null;

    // Ledger is source of truth (ledger_entries: risk debited at place).
    var ledgerAvailable = null;
    var ledgerEntryCount = 0;
    try {
      var lq = sb.from('ledger_entries')
        .select('id,type,amount,balance_before,balance_after,created_at,ticket_id')
        .eq('player_id', playerId)
        .order('created_at', { ascending:true });
      if (clubId) lq = lq.eq('club_id', clubId);
      var { data: ledgerRows, error: lErr } = await lq;
      if (lErr) throw lErr;
      ledgerEntryCount = (ledgerRows||[]).length;
      if (ledgerEntryCount > 0) {
        ledgerAvailable = _deriveBalanceFromLedgerEntries(startingBalance, ledgerRows);
      }
    } catch(_le) {
      console.warn('[player/dashboard] ledger_entries fetch error:', _le.message||_le);
      warnings.push('ledger_fetch_error');
    }

    var available = ledgerAvailable != null ? ledgerAvailable : ticketAvailable;
    var balanceSource = ledgerAvailable != null ? 'ledger' : 'tickets';
    if (ledgerAvailable != null && ticketAvailable != null &&
        Math.abs(ledgerAvailable - ticketAvailable) > 0.01) {
      warnings.push('ticket_ledger_mismatch:ticket='+ticketAvailable+',ledger='+ledgerAvailable);
      console.warn('[player/dashboard] MISMATCH player='+playerId+
        ' ticket='+ticketAvailable+' ledger='+ledgerAvailable+' — using ledger');
    }
    if (available !== null && available<0) warnings.push('available_negative:'+available);
    if (startingBalance === null) warnings.push('missing_balance_start');

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
        refunds: 0,  // push handled via openRisk exclusion
        source: balanceSource,
        ticketAvailable: ticketAvailable,
        ledgerAvailable: ledgerAvailable,
        ledgerEntryCount: ledgerEntryCount
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
    const { data:limits } = await sb.from('club_members')
      .select('player_id,balance_start').eq('club_id',clubId);
    const balMap = {}; (limits||[]).forEach(function(l){ if (l.balance_start != null) balMap[l.player_id]=parseFloat(l.balance_start); });
    const { data:allTix } = await sb.from('tickets')
      .select('player_id,status,risk_amount,potential_profit').eq('club_id',clubId);
    const nextRevision = (period.revision||0) + 1;
    const snapRows = [];
    for (const m of (members||[])) {
      const pid = m.actor_id;
      const starting = balMap[pid] ?? null; // null = no club_members row; shown in snapshot as null (no phantom $1k)
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
      const ledBal  = starting !== null ? Math.round((starting+cred-deb)*100)/100 : null;
      const netRes  = Math.round((gains-losses)*100)/100;
      const finBal  = ledBal !== null ? Math.round((ledBal-Math.round(openRisk*100)/100)*100)/100 : null;
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
    const { data: limits }  = await sb.from('club_members')
      .select('player_id,balance_start').eq('club_id',clubId);
    const balanceMap = {};
    (limits||[]).forEach(function(l){ if (l.balance_start != null) balanceMap[l.player_id]=parseFloat(l.balance_start); });

    const players = [];
    for (const m of (members||[])) {
      const pid = m.actor_id;
      const startingLimit = balanceMap[pid] ?? null; // null = missing club_members row; no phantom $1k
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
    res.json({ enabled:true, lastGradedAt: _lastGradedAt || (recent&&recent[0] ? recent[0].created_at : null),
      lastGradeRunAt:_lastGradeRunAt,
      recentGrades: recent||[], activeTicketCount: active ? active.length : 0,
      lastResultSuccessAt:_lastResultSuccessAt, lastGradePollAt:_lastGradePollAt,
      gradePollerStarted:_mlbGradePollerStarted,
      containment, settlementEnabled:GRADING_SETTLEMENT_ENABLED,
      dryRunEnabled:GRADE_RUN_DRY_RUN_ENABLED });
  } catch(e) { res.status(500).json({ enabled:true, error:e.message }); }
});

// GET /api/host/unresolved-grading — monitor only. Never auto-grades or voids.
app.get('/api/host/unresolved-grading', requireCanonicalClubId, requirePermissionScoped('view_host_dashboard'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured', autoGrade:false });
  const clubId = req._clubId || (req.query && req.query.clubId) || '';
  try {
    let tq = sb.from('tickets')
      .select('id,status,type,player_id,player_username,placed_at,graded_at,grading_source')
      .in('status', ['active', 'open'])
      .order('placed_at', { ascending:true })
      .limit(500);
    if (clubId) tq = tq.eq('club_id', clubId);
    const { data: tickets, error: tErr } = await tq;
    if (tErr) throw tErr;

    const ids = (tickets || []).map(function(t) { return t.id; }).filter(Boolean);
    const legsByTicket = {};
    const keys = {};
    if (ids.length) {
      const { data: legs, error: lErr } = await sb.from('ticket_legs')
        .select('ticket_id,leg_index,sport,home_team,away_team,scheduled_start,market,pick,canonical_game_key,provider_game_id,event_name,game_status,leg_result')
        .in('ticket_id', ids);
      if (lErr) throw lErr;
      (legs || []).forEach(function(l) {
        if (!l || !l.ticket_id) return;
        if (!legsByTicket[l.ticket_id]) legsByTicket[l.ticket_id] = [];
        legsByTicket[l.ticket_id].push(l);
        if (l.canonical_game_key) keys[l.canonical_game_key] = true;
      });
    }

    const snapshotsByKey = {};
    const keyList = Object.keys(keys);
    if (keyList.length) {
      const { data: snaps, error: sErr } = await sb.from('result_snapshots')
        .select('canonical_game_key,status,source,home_score,away_score,home_team,away_team,commence_time,fetched_at')
        .in('canonical_game_key', keyList);
      if (sErr) throw sErr;
      (snaps || []).forEach(function(s) {
        if (s && s.canonical_game_key) snapshotsByKey[s.canonical_game_key] = s;
      });
    }

    const lastAttemptByTicket = {};
    if (ids.length) {
      const { data: audits } = await sb.from('audit_events')
        .select('ticket_id,event_type,created_at')
        .in('ticket_id', ids)
        .order('created_at', { ascending:false })
        .limit(200);
      (audits || []).forEach(function(a) {
        if (!a || !a.ticket_id || lastAttemptByTicket[a.ticket_id]) return;
        lastAttemptByTicket[a.ticket_id] = a.created_at;
      });
    }

    const report = unresolvedGradingMonitor.buildReport({
      tickets: tickets || [],
      legsByTicket,
      snapshotsByKey,
      lastAttemptByTicket,
      nowMs: Date.now()
    });
    report.ok = true;
    report.clubId = clubId || null;
    report.lastGradePollAt = _lastGradePollAt || null;
    report.lastGradeRunAt = _lastGradeRunAt || null;
    res.json(report);
  } catch (e) {
    console.error('[unresolved-grading]', e.message);
    res.status(500).json({ ok:false, error:e.message, autoGrade:false });
  }
});
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// SURVIVOR POOL MVP
// ════════════════════════════════════════════════════════════════════════════

const NFL_SURVIVOR_TEAMS = [
  'Arizona Cardinals','Atlanta Falcons','Baltimore Ravens','Buffalo Bills',
  'Carolina Panthers','Chicago Bears','Cincinnati Bengals','Cleveland Browns',
  'Dallas Cowboys','Denver Broncos','Detroit Lions','Green Bay Packers',
  'Houston Texans','Indianapolis Colts','Jacksonville Jaguars','Kansas City Chiefs',
  'Las Vegas Raiders','Los Angeles Chargers','Los Angeles Rams','Miami Dolphins',
  'Minnesota Vikings','New England Patriots','New Orleans Saints','New York Giants',
  'New York Jets','Philadelphia Eagles','Pittsburgh Steelers','San Francisco 49ers',
  'Seattle Seahawks','Tampa Bay Buccaneers','Tennessee Titans','Washington Commanders'
];

const ESPN_ABBREV_TO_TEAM = {
  ARI:'Arizona Cardinals', ATL:'Atlanta Falcons', BAL:'Baltimore Ravens', BUF:'Buffalo Bills',
  CAR:'Carolina Panthers', CHI:'Chicago Bears', CIN:'Cincinnati Bengals', CLE:'Cleveland Browns',
  DAL:'Dallas Cowboys', DEN:'Denver Broncos', DET:'Detroit Lions', GB:'Green Bay Packers',
  HOU:'Houston Texans', IND:'Indianapolis Colts', JAX:'Jacksonville Jaguars', JAC:'Jacksonville Jaguars',
  KC:'Kansas City Chiefs', LV:'Las Vegas Raiders', LAC:'Los Angeles Chargers', LAR:'Los Angeles Rams',
  MIA:'Miami Dolphins', MIN:'Minnesota Vikings', NE:'New England Patriots', NO:'New Orleans Saints',
  NYG:'New York Giants', NYJ:'New York Jets', PHI:'Philadelphia Eagles', PIT:'Pittsburgh Steelers',
  SF:'San Francisco 49ers', SEA:'Seattle Seahawks', TB:'Tampa Bay Buccaneers', TEN:'Tennessee Titans',
  WSH:'Washington Commanders', WAS:'Washington Commanders', WFT:'Washington Commanders'
};

function _survivorNorm(s) {
  return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
}

function _survivorTeamMatches(a, b) {
  const na = _survivorNorm(a), nb = _survivorNorm(b);
  if (!na || !nb) return false;
  return na === nb || na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0;
}

function _survivorPhase(week) {
  return (parseInt(week, 10) || 0) <= 18 ? 'regular' : 'playoffs';
}

async function _survivorUsername(actorId) {
  try {
    const r = await query('SELECT name FROM users WHERE id::text=$1 LIMIT 1', [String(actorId)]);
    if (r.rows[0] && r.rows[0].name) return r.rows[0].name;
  } catch(_e) {}
  return null;
}

function _etParts(ms) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = dtf.formatToParts(new Date(ms||Date.now()));
  const get = function(t){ return (parts.find(function(p){ return p.type===t; })||{}).value; };
  const wd = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  return {
    dow: wd[get('weekday')],
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: hour || 0,
    minute: parseInt(get('minute'), 10) || 0
  };
}

// Convert an America/New_York wall clock to UTC ms.
// 13:00 ET = 18:00 UTC in EST (winter); 17:00 UTC in EDT (summer).
function _nyWallToUtcMs(year, month, day, hour, minute) {
  const candidates = [
    Date.UTC(year, month - 1, day, hour + 4, minute), // EDT
    Date.UTC(year, month - 1, day, hour + 5, minute)  // EST
  ];
  for (let i = 0; i < candidates.length; i++) {
    const et = _etParts(candidates[i]);
    if (et.year === year && et.month === month && et.day === day && et.hour === hour && et.minute === minute)
      return candidates[i];
  }
  return Date.UTC(year, month - 1, day, hour + 5, minute); // EST fallback = 18:00 UTC for 13:00
}

function _etAddDays(year, month, day, delta) {
  const noon = _nyWallToUtcMs(year, month, day, 12, 0);
  const et = _etParts(noon + delta * 86400000);
  return { year: et.year, month: et.month, day: et.day };
}

// Sunday 1:00 PM America/New_York of the current NFL week (Thu–Wed).
// TNF does not move this deadline. Uses pool.pick_deadline_day/time when set
// (defaults Sunday 13:00). Dynamic — no stored deadline column required.
function _survivorPickDeadlineMs(pool, nowMs) {
  const now = nowMs || Date.now();
  const DAY_IDX = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const targetDow = DAY_IDX[String((pool && pool.pick_deadline_day) || 'Sunday').toLowerCase()];
  const dow = (targetDow == null) ? 0 : targetDow;
  const timeParts = String((pool && pool.pick_deadline_time) || '13:00').split(':');
  const hh = isNaN(parseInt(timeParts[0], 10)) ? 13 : parseInt(timeParts[0], 10);
  const mm = parseInt(timeParts[1], 10) || 0;
  const et = _etParts(now);
  // Thu–Sat sit before this week's Sunday; Sun–Wed use this week's Sunday.
  let delta = (et.dow >= 4) ? (7 - et.dow) : -et.dow;
  delta += dow;
  const sun = _etAddDays(et.year, et.month, et.day, delta);
  return _nyWallToUtcMs(sun.year, sun.month, sun.day, hh, mm);
}

function _survivorPickDeadlineIso(pool, nowMs) {
  return new Date(_survivorPickDeadlineMs(pool, nowMs)).toISOString();
}

function _survivorDeadlinePassed(pool, nowMs) {
  const now = nowMs || Date.now();
  return now >= _survivorPickDeadlineMs(pool, now);
}

function _survivorIsHost(actor, pool) {
  if (!actor || !pool) return false;
  if (String(pool.created_by) === String(actor.actorId)) return true;
  if (actor.platformRole === 'platform_admin') return true;
  if ((ROLE_RANK[actor.role]||0) >= ROLE_RANK.full_admin) return true;
  if (actor.role === 'owner') return true;
  return false;
}

function _fetchNflScores(daysFrom) {
  return new Promise(function(resolve) {
    if (!ODDS_KEY) return resolve({ error:'ODDS_API_KEY not configured', games:[] });
    const url = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/scores/?apiKey='+ODDS_KEY+'&daysFrom='+(daysFrom||7);
    const req2 = require('https').get(url, function(r) {
      let d = '';
      r.on('data', function(c){ d += c; });
      r.on('end', function() {
        try {
          const parsed = JSON.parse(d);
          if (parsed && parsed.error_code) return resolve({ error: parsed.message||'odds_api_error', games:[] });
          const games = (Array.isArray(parsed) ? parsed : []).map(function(g) {
            const scores = g.scores || [];
            const hs = parseInt((scores.find(function(s){ return s.name===g.home_team; })||{}).score||0, 10);
            const as = parseInt((scores.find(function(s){ return s.name===g.away_team; })||{}).score||0, 10);
            return {
              id: g.id, home: g.home_team, away: g.away_team,
              completed: !!g.completed, home_score: hs, away_score: as,
              commence_time: g.commence_time
            };
          });
          resolve({ games: games });
        } catch(_e) { resolve({ error:'parse_error', games:[] }); }
      });
    });
    req2.on('error', function(e){ resolve({ error:e.message, games:[] }); });
    req2.setTimeout(8000, function(){ req2.destroy(); resolve({ error:'timeout', games:[] }); });
  });
}


function _httpsGetJson(url, timeoutMs) {
  return new Promise(function(resolve) {
    const req2 = require('https').get(url, {
      // ESPN/Akamai 403s custom UAs (PocketBooksSports/1.0, node, Chrome). curl works.
      headers: { Accept: 'application/json', 'User-Agent': 'curl/8.7.1' }
    }, function(r) {
      let d = '';
      r.on('data', function(c){ d += c; });
      r.on('end', function() {
        if (r.statusCode && r.statusCode >= 400)
          return resolve({ error: 'espn_http_'+r.statusCode, data: null });
        try { resolve({ data: JSON.parse(d) }); }
        catch(_e) { resolve({ error: 'espn_parse_error', data: null }); }
      });
    });
    req2.on('error', function(e){ resolve({ error: e.message, data: null }); });
    req2.setTimeout(timeoutMs || 8000, function(){ req2.destroy(); resolve({ error: 'espn_timeout', data: null }); });
  });
}

function _espnScoreboardToGames(data) {
  return espnScoreboard.espnScoreboardToGames(data);
}

// Regular season = seasontype=2. Empty slate retries without seasontype, then preseason (1).
async function _fetchEspnNflScores(week) {
  const w = Math.max(1, parseInt(week, 10) || 1);
  const urls = [
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week='+w,
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week='+w,
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=1&week='+w
  ];
  let lastErr = null;
  for (let i = 0; i < urls.length; i++) {
    const r = await _httpsGetJson(urls[i], 8000);
    if (r.error) { lastErr = r.error; continue; }
    const games = _espnScoreboardToGames(r.data);
    if (games.length) {
      const source = urls[i].indexOf('seasontype=1') >= 0 ? 'espn_preseason' : 'espn';
      return { games: games, source: source };
    }
    lastErr = 'espn_empty';
  }
  console.warn('[SURVIVOR_GRADE_ESPN_EMPTY] week='+w+' err='+lastErr);
  return { error: lastErr || 'espn_empty', games: [] };
}


function _survivorSideLabels(game, side) {
  const abbrev = side === 'home' ? game.homeAbbrev : game.awayAbbrev;
  return [
    side === 'home' ? game.home : game.away,
    abbrev,
    side === 'home' ? game.homeShort : game.awayShort,
    ESPN_ABBREV_TO_TEAM[String(abbrev || '').toUpperCase()]
  ];
}

function _survivorSideMatches(team, game, side) {
  const labels = _survivorSideLabels(game, side);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] && _survivorTeamMatches(team, labels[i])) return true;
  }
  return false;
}

function _survivorGameForTeam(team, games) {
  const list = games || [];
  for (let i=0;i<list.length;i++) {
    const g = list[i];
    if (_survivorSideMatches(team, g, 'home') || _survivorSideMatches(team, g, 'away')) return g;
  }
  return null;
}

function _survivorTeamWon(team, game) {
  if (!game || !game.completed) return null;
  const homeWon = game.home_score > game.away_score;
  const awayWon = game.away_score > game.home_score;
  if (!homeWon && !awayWon) return false; // tie counts as a loss
  if (_survivorSideMatches(team, game, 'home')) return homeWon;
  if (_survivorSideMatches(team, game, 'away')) return awayWon;
  return null;
}

async function _loadSurvivorPool(sb, poolId) {
  const { data, error } = await sb.from('survivor_pools').select('*').eq('id', poolId).maybeSingle();
  if (error) throw error;
  return data || null;
}

function _survivorEntryLabel(username, n) {
  return (username || 'Entry') + ' #' + n;
}

function _survivorEntryNum(row) {
  const n = parseInt(row && (row.entry_number != null ? row.entry_number : row.entryNumber), 10);
  return n > 0 ? n : 1;
}

function _survivorPublicEntry(e) {
  if (!e) return null;
  const num = _survivorEntryNum(e);
  return {
    id: e.id,
    playerId: e.player_id,
    playerUsername: e.player_username,
    entryNumber: num,
    entryLabel: e.entry_label || _survivorEntryLabel(e.player_username, num),
    status: e.status,
    eliminatedWeek: e.eliminated_week,
    joinedAt: e.joined_at
  };
}

// POST /api/survivor/create
app.post('/api/survivor/create', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const name = String((req.body&&req.body.name)||'').trim();
  const season = parseInt((req.body&&req.body.season)||2026, 10) || 2026;
  if (!name) return res.status(400).json({ ok:false, error:'name_required' });
  try {
    const username = await _survivorUsername(actor.actorId);
    let pool = null, lastErr = null;
    for (let i=0;i<6 && !pool;i++) {
      const joinCode = (typeof genCode==='function' ? genCode() : Math.random().toString(36).substring(2,8).toUpperCase());
      const ins = await sb.from('survivor_pools').insert({
        name, season, join_code: joinCode, created_by: String(actor.actorId),
        status: 'active', current_week: 1
      }).select().single();
      if (ins.error) { lastErr = ins.error; continue; }
      pool = ins.data;
    }
    if (!pool) return res.status(500).json({ ok:false, error:(lastErr&&lastErr.message)||'create_failed' });
    const now = new Date().toISOString();
    const entry = await sb.from('survivor_entries').insert({
      pool_id: pool.id, player_id: String(actor.actorId),
      player_username: username, status: 'alive',
      entry_number: 1, entry_label: _survivorEntryLabel(username, 1),
      approved_by: String(actor.actorId), approved_at: now
    });
    if (entry.error) console.warn('[survivor/create] auto-join failed', entry.error.message);
    res.json({ ok:true, poolId: pool.id, joinCode: pool.join_code });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

async function _survivorRequestJoin(req, res) {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const joinCode = String((req.body&&req.body.joinCode)||'').trim().toUpperCase();
  if (!joinCode) return res.status(400).json({ ok:false, error:'joinCode_required' });
  try {
    const { data: pool, error: pErr } = await sb.from('survivor_pools')
      .select('*').eq('join_code', joinCode).maybeSingle();
    if (pErr) throw pErr;
    if (!pool) return res.status(404).json({ ok:false, error:'pool_not_found' });
    if (pool.status !== 'active') return res.status(409).json({ ok:false, error:'pool_not_active' });
    const playerId = String(actor.actorId);
    const { data: existingEntries, error: memErr } = await sb.from('survivor_entries')
      .select('id').eq('pool_id', pool.id).eq('player_id', playerId).limit(1);
    if (memErr) throw memErr;
    if (existingEntries && existingEntries.length) {
      return res.status(409).json({ ok:false, error:'already_member', poolId:pool.id, poolName:pool.name });
    }
    const username = await _survivorUsername(actor.actorId);
    const { data: existingReq, error: rErr } = await sb.from('survivor_join_requests')
      .select('*').eq('pool_id', pool.id).eq('player_id', playerId).maybeSingle();
    if (rErr) throw rErr;
    if (existingReq && existingReq.status === 'pending') {
      return res.status(409).json({ ok:false, error:'already_requested', poolId:pool.id, poolName:pool.name });
    }
    if (existingReq && existingReq.status === 'approved') {
      return res.status(409).json({ ok:false, error:'already_member', poolId:pool.id, poolName:pool.name });
    }
    if (existingReq && existingReq.status === 'denied') {
      const { error: upErr } = await sb.from('survivor_join_requests').update({
        status: 'pending', player_username: username, entries_granted: null,
        requested_at: new Date().toISOString(), reviewed_at: null, reviewed_by: null
      }).eq('id', existingReq.id);
      if (upErr) throw upErr;
    } else {
      const { error: insErr } = await sb.from('survivor_join_requests').insert({
        pool_id: pool.id, player_id: playerId, player_username: username, status: 'pending'
      });
      if (insErr) {
        if (insErr.code === '23505') return res.status(409).json({ ok:false, error:'already_requested', poolId:pool.id, poolName:pool.name });
        throw insErr;
      }
    }
    res.json({
      ok: true, poolId: pool.id, poolName: pool.name,
      message: 'Request sent — waiting for pool runner approval'
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
}

app.post('/api/survivor/request-join', _survivorRequestJoin);
app.post('/api/survivor/join', _survivorRequestJoin);

const telegramBot = require('./telegram-bot');
app.post('/api/survivor/telegram/webhook', function(req, res) {
  return telegramBot.handleWebhook(req, res);
});
app.get('/api/survivor/telegram/link-status', function(req, res) {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  return telegramBot.handleLinkStatus(req, res, actor);
});

// GET /api/survivor/my-pools  (must be registered before /:poolId)
app.get('/api/survivor/my-pools', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const playerId = String(actor.actorId);
    const { data: entries, error: eErr } = await sb.from('survivor_entries')
      .select('*').eq('player_id', playerId);
    if (eErr) throw eErr;
    const { data: pendingReqs, error: rErr } = await sb.from('survivor_join_requests')
      .select('*').eq('player_id', playerId).eq('status', 'pending');
    if (rErr) throw rErr;
    const list = entries || [];
    const pending = pendingReqs || [];
    const ids = {};
    list.forEach(function(e){ ids[e.pool_id] = true; });
    pending.forEach(function(r){ ids[r.pool_id] = true; });
    const poolIds = Object.keys(ids);
    if (!poolIds.length) return res.json({ ok:true, pools:[] });
    const { data: pools, error: pErr } = await sb.from('survivor_pools').select('*').in('id', poolIds);
    if (pErr) throw pErr;
    const byId = {};
    (pools||[]).forEach(function(p){ byId[p.id]=p; });
    const hostPoolIds = (pools||[]).filter(function(p){ return String(p.created_by)===playerId; }).map(function(p){ return p.id; });
    let pendingCounts = {};
    if (hostPoolIds.length) {
      const { data: hostReqs } = await sb.from('survivor_join_requests')
        .select('pool_id').in('pool_id', hostPoolIds).eq('status', 'pending');
      (hostReqs||[]).forEach(function(r){ pendingCounts[r.pool_id] = (pendingCounts[r.pool_id]||0)+1; });
    }
    const grouped = {};
    list.forEach(function(e) {
      if (!grouped[e.pool_id]) grouped[e.pool_id] = [];
      grouped[e.pool_id].push(_survivorPublicEntry(e));
    });
    const pendingByPool = {};
    pending.forEach(function(r){ pendingByPool[r.pool_id] = r; });
    res.json({
      ok: true,
      pools: poolIds.map(function(id) {
        const p = byId[id] || {};
        const myEntries = (grouped[id]||[]).sort(function(a,b){ return a.entryNumber - b.entryNumber; });
        const aliveN = myEntries.filter(function(e){ return e.status==='alive'; }).length;
        const elimN = myEntries.filter(function(e){ return e.status==='eliminated'; }).length;
        let myStatus = 'pending';
        if (myEntries.length) {
          if (aliveN && elimN) myStatus = 'mixed';
          else if (aliveN) myStatus = 'alive';
          else myStatus = 'eliminated';
        }
        const req = pendingByPool[id];
        return {
          poolId: id,
          name: p.name || null,
          season: p.season,
          joinCode: p.join_code,
          status: p.status,
          currentWeek: p.current_week,
          myStatus: myStatus,
          eliminatedWeek: myEntries.filter(function(e){ return e.status==='eliminated'; }).map(function(e){ return e.eliminatedWeek; })[0] || null,
          isHost: String(p.created_by) === playerId,
          createdAt: p.created_at,
          entries: myEntries,
          pendingRequest: !!req,
          pendingRequestCount: pendingCounts[id] || 0
        };
      })
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/survivor/:poolId
app.get('/api/survivor/:poolId', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const poolId = String(req.params.poolId||'').trim();
  try {
    const pool = await _loadSurvivorPool(sb, poolId);
    if (!pool) return res.status(404).json({ ok:false, error:'pool_not_found' });
    const playerId = String(actor.actorId);
    const { data: entries, error: eErr } = await sb.from('survivor_entries').select('*').eq('pool_id', poolId);
    if (eErr) throw eErr;
    const { data: weekPicks, error: wErr } = await sb.from('survivor_picks')
      .select('*').eq('pool_id', poolId).eq('week', pool.current_week);
    if (wErr) throw wErr;
    const { data: myPicks, error: mErr } = await sb.from('survivor_picks')
      .select('week,team,result,entry_number,game_id').eq('pool_id', poolId).eq('player_id', playerId);
    if (mErr) throw mErr;
    const { data: myReq } = await sb.from('survivor_join_requests')
      .select('*').eq('pool_id', poolId).eq('player_id', playerId).maybeSingle();
    const phase = _survivorPhase(pool.current_week);
    const myEntries = (entries||[]).filter(function(e){ return String(e.player_id)===playerId; })
      .sort(function(a,b){ return _survivorEntryNum(a)-_survivorEntryNum(b); });
    const usedTeamsByEntry = {};
    myEntries.forEach(function(e){
      usedTeamsByEntry[_survivorEntryNum(e)] = [];
    });
    (myPicks||[]).forEach(function(p){
      if (_survivorPhase(p.week) !== phase) return;
      const n = _survivorEntryNum(p);
      if (!usedTeamsByEntry[n]) usedTeamsByEntry[n] = [];
      usedTeamsByEntry[n].push({ team: p.team, week: p.week });
    });
    const usedTeams = usedTeamsByEntry[1] || usedTeamsByEntry[_survivorEntryNum(myEntries[0])] || [];
    const myEntry = myEntries[0] || null;
    const deadlinePassed = _survivorDeadlinePassed(pool);
    const isHost = _survivorIsHost(actor, pool);
    let pendingRequestCount = 0;
    if (isHost) {
      const { data: pend, error: pendErr } = await sb.from('survivor_join_requests')
        .select('id').eq('pool_id', poolId).eq('status', 'pending');
      if (pendErr) throw pendErr;
      pendingRequestCount = (pend||[]).length;
    }
    res.json({
      ok: true,
      pool: {
        id: pool.id, name: pool.name, season: pool.season, joinCode: pool.join_code,
        status: pool.status, currentWeek: pool.current_week,
        phase: phase,
        pickDeadlineDay: pool.pick_deadline_day, pickDeadlineTime: pool.pick_deadline_time,
        pickDeadline: _survivorPickDeadlineIso(pool),
        createdBy: pool.created_by, createdAt: pool.created_at
      },
      entries: (entries||[]).map(_survivorPublicEntry),
      currentWeekPicks: weekPicks||[],
      usedTeams: usedTeams,
      usedTeamsByEntry: usedTeamsByEntry,
      myPicks: (myPicks||[]).map(function(p){
        return { week:p.week, team:p.team, result:p.result, entryNumber:_survivorEntryNum(p), gameId:p.game_id };
      }),
      myEntry: _survivorPublicEntry(myEntry),
      myEntries: myEntries.map(_survivorPublicEntry),
      myJoinRequest: myReq ? {
        status: myReq.status, requestedAt: myReq.requested_at,
        entriesGranted: myReq.entries_granted
      } : null,
      pendingRequestCount: pendingRequestCount,
      isHost: isHost,
      deadlinePassed: deadlinePassed,
      pickDeadline: _survivorPickDeadlineIso(pool),
      teams: NFL_SURVIVOR_TEAMS
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/survivor/:poolId/requests — pool runner only
app.get('/api/survivor/:poolId/requests', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const poolId = String(req.params.poolId||'').trim();
  try {
    const pool = await _loadSurvivorPool(sb, poolId);
    if (!pool) return res.status(404).json({ ok:false, error:'pool_not_found' });
    if (!_survivorIsHost(actor, pool)) return res.status(403).json({ ok:false, error:'host_or_admin_only' });
    const { data: rows, error } = await sb.from('survivor_join_requests')
      .select('*').eq('pool_id', poolId).eq('status', 'pending').order('requested_at', { ascending:true });
    if (error) throw error;
    res.json({
      ok: true,
      requests: (rows||[]).map(function(r){
        return {
          playerId: r.player_id,
          playerUsername: r.player_username,
          requestedAt: r.requested_at,
          status: r.status
        };
      })
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/survivor/:poolId/approve
app.post('/api/survivor/:poolId/approve', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const poolId = String(req.params.poolId||'').trim();
  const playerId = String((req.body&&req.body.playerId)||'').trim();
  const entriesGranted = parseInt(req.body&&req.body.entriesGranted, 10);
  if (!playerId) return res.status(400).json({ ok:false, error:'playerId_required' });
  if ([1,2,3].indexOf(entriesGranted) < 0) return res.status(400).json({ ok:false, error:'entriesGranted_must_be_1_2_or_3' });
  try {
    const pool = await _loadSurvivorPool(sb, poolId);
    if (!pool) return res.status(404).json({ ok:false, error:'pool_not_found' });
    if (!_survivorIsHost(actor, pool)) return res.status(403).json({ ok:false, error:'host_or_admin_only' });
    const { data: reqRow, error: rErr } = await sb.from('survivor_join_requests')
      .select('*').eq('pool_id', poolId).eq('player_id', playerId).maybeSingle();
    if (rErr) throw rErr;
    if (!reqRow) return res.status(404).json({ ok:false, error:'request_not_found' });
    if (reqRow.status === 'approved') return res.status(409).json({ ok:false, error:'already_approved' });
    const username = reqRow.player_username || await _survivorUsername(playerId);
    const now = new Date().toISOString();
    const { error: upErr } = await sb.from('survivor_join_requests').update({
      status: 'approved', entries_granted: entriesGranted,
      reviewed_at: now, reviewed_by: String(actor.actorId)
    }).eq('id', reqRow.id);
    if (upErr) throw upErr;
    const rows = [];
    for (let n=1; n<=entriesGranted; n++) {
      rows.push({
        pool_id: poolId,
        player_id: playerId,
        player_username: username,
        status: 'alive',
        entry_number: n,
        entry_label: _survivorEntryLabel(username, n),
        approved_by: String(actor.actorId),
        approved_at: now
      });
    }
    const { error: insErr } = await sb.from('survivor_entries').insert(rows);
    if (insErr && insErr.code !== '23505') throw insErr;
    try {
      await _notifyPlayer({
        playerId: playerId,
        type: 'survivor_join_approved',
        title: 'Survivor pool approved',
        message: 'You were approved for ' + (pool.name || 'the survivor pool') +
          ' with ' + entriesGranted + ' entr' + (entriesGranted === 1 ? 'y' : 'ies') + '.'
      });
    } catch(_n) {}
    res.json({ ok:true, entriesCreated: entriesGranted });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/survivor/:poolId/deny
app.post('/api/survivor/:poolId/deny', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const poolId = String(req.params.poolId||'').trim();
  const playerId = String((req.body&&req.body.playerId)||'').trim();
  if (!playerId) return res.status(400).json({ ok:false, error:'playerId_required' });
  try {
    const pool = await _loadSurvivorPool(sb, poolId);
    if (!pool) return res.status(404).json({ ok:false, error:'pool_not_found' });
    if (!_survivorIsHost(actor, pool)) return res.status(403).json({ ok:false, error:'host_or_admin_only' });
    const { data: reqRow, error: rErr } = await sb.from('survivor_join_requests')
      .select('*').eq('pool_id', poolId).eq('player_id', playerId).maybeSingle();
    if (rErr) throw rErr;
    if (!reqRow) return res.status(404).json({ ok:false, error:'request_not_found' });
    const { error: upErr } = await sb.from('survivor_join_requests').update({
      status: 'denied', reviewed_at: new Date().toISOString(), reviewed_by: String(actor.actorId)
    }).eq('id', reqRow.id);
    if (upErr) throw upErr;
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/survivor/:poolId/pick
app.post('/api/survivor/:poolId/pick', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const poolId = String(req.params.poolId||'').trim();
  const week = parseInt(req.body&&req.body.week, 10);
  const team = String((req.body&&req.body.team)||'').trim();
  const gameId = (req.body&&req.body.gameId) ? String(req.body.gameId) : null;
  const entryNumber = parseInt(req.body&&(req.body.entryNumber!=null?req.body.entryNumber:req.body.entry_number), 10) || 1;
  if (!week || !team) return res.status(400).json({ ok:false, error:'week_and_team_required' });
  if ([1,2,3].indexOf(entryNumber) < 0) return res.status(400).json({ ok:false, error:'invalid_entryNumber' });
  const known = NFL_SURVIVOR_TEAMS.some(function(t){ return _survivorTeamMatches(t, team); });
  if (!known) return res.status(400).json({ ok:false, error:'unknown_team' });
  const canonical = NFL_SURVIVOR_TEAMS.find(function(t){ return _survivorTeamMatches(t, team); }) || team;
  try {
    const pool = await _loadSurvivorPool(sb, poolId);
    if (!pool) return res.status(404).json({ ok:false, error:'pool_not_found' });
    if (pool.status !== 'active') return res.status(409).json({ ok:false, error:'pool_not_active' });
    if (week !== pool.current_week) return res.status(400).json({ ok:false, error:'week_mismatch', currentWeek: pool.current_week });
    const { data: entry } = await sb.from('survivor_entries').select('*')
      .eq('pool_id', poolId).eq('player_id', String(actor.actorId)).eq('entry_number', entryNumber).maybeSingle();
    if (!entry) return res.status(403).json({ ok:false, error:'not_in_pool' });
    if (entry.status !== 'alive') return res.status(403).json({ ok:false, error:'eliminated' });
    if (_survivorDeadlinePassed(pool)) {
      return res.status(403).json({
        ok: false, error: 'picks_locked', deadline: _survivorPickDeadlineIso(pool)
      });
    }
    const { data: prior } = await sb.from('survivor_picks').select('*')
      .eq('pool_id', poolId).eq('player_id', String(actor.actorId)).eq('entry_number', entryNumber);
    const phase = _survivorPhase(week);
    const reused = (prior||[]).some(function(p){
      return p.week !== week
        && _survivorPhase(p.week) === phase
        && _survivorTeamMatches(p.team, canonical);
    });
    if (reused) return res.status(409).json({ ok:false, error:'team_already_used' });
    const now = new Date().toISOString();
    const existingWeek = (prior||[]).find(function(p){ return p.week === week; });
    let pick, error;
    if (existingWeek) {
      const upd = await sb.from('survivor_picks').update({
        team: canonical, game_id: gameId, result: 'pending', picked_at: now
      }).eq('id', existingWeek.id).select().single();
      pick = upd.data; error = upd.error;
    } else {
      const ins = await sb.from('survivor_picks').insert({
        pool_id: poolId, player_id: String(actor.actorId), entry_number: entryNumber,
        week: week, team: canonical, game_id: gameId, result: 'pending', picked_at: now
      }).select().single();
      pick = ins.data; error = ins.error;
    }
    if (error) {
      if (error.code === '23505') return res.status(409).json({ ok:false, error:'team_already_used' });
      throw error;
    }
    if (pick) { pick.phase = phase; pick.entryNumber = _survivorEntryNum(pick); }
    try {
      telegramBot.notifySurvivorPick({
        playerId: String(actor.actorId), week: week, team: canonical
      });
    } catch(_tg) {}
    try {
      await _notifyPlayer({
        playerId: String(actor.actorId),
        type: 'survivor_pick_submitted',
        title: 'Survivor pick submitted',
        message: 'Week ' + week + ': ' + canonical +
          (entryNumber > 1 ? ' (entry ' + entryNumber + ')' : '') + ' locked in.'
      });
    } catch(_n) {}
    res.json({ ok:true, pick: pick, phase: phase, entryNumber: entryNumber });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

async function _gradeSurvivorPool(sb, pool, week, opts) {
  opts = opts || {};
  const poolId = pool.id;
  const scores = await _fetchEspnNflScores(week);
  if (scores.error) {
    console.error('[SURVIVOR_GRADE_ESPN_FAIL] pool='+poolId+' week='+week+' err='+scores.error);
    return { ok:false, error:'espn_scores_unavailable', scoresError: scores.error, gamesChecked: 0 };
  }
  const games = scores.games || [];
  const now = new Date().toISOString();

  const { data: entries, error: eErr } = await sb.from('survivor_entries').select('*').eq('pool_id', poolId);
  if (eErr) throw eErr;
  const { data: picks, error: pErr } = await sb.from('survivor_picks')
    .select('*').eq('pool_id', poolId).eq('week', week);
  if (pErr) throw pErr;
  const pickByEntry = {};
  (picks||[]).forEach(function(p){
    pickByEntry[String(p.player_id)+':'+_survivorEntryNum(p)] = p;
  });

  const results = [];
  const eliminated = [];
  const survivors = [];
  let pendingRemain = 0;

  for (let i=0;i<(entries||[]).length;i++) {
    const entry = entries[i];
    const entryNumber = _survivorEntryNum(entry);
    const label = entry.entry_label || _survivorEntryLabel(entry.player_username, entryNumber);
    if (entry.status !== 'alive') continue;
    const pick = pickByEntry[String(entry.player_id)+':'+entryNumber];
    if (!pick) {
      await sb.from('survivor_entries').update({ status:'eliminated', eliminated_week: week })
        .eq('id', entry.id);
      eliminated.push({ playerId: entry.player_id, playerUsername: entry.player_username, entryNumber: entryNumber, entryLabel: label, reason:'no_pick' });
      results.push({ playerId: entry.player_id, entryNumber: entryNumber, team: null, result:'lost', reason:'no_pick' });
      try { telegramBot.notifySurvivorGrade({ playerId: entry.player_id, week: week, team: null, won: false }); } catch(_e) {}
      try {
        await _notifyPlayer({
          playerId: entry.player_id,
          type: 'survivor_grade',
          title: 'Survivor Week ' + week + ' result',
          message: 'Eliminated — no pick submitted for Week ' + week +
            (entryNumber > 1 ? ' (entry ' + entryNumber + ')' : '') + '.'
        });
      } catch(_n) {}
      continue;
    }
    if (pick.result === 'won' || pick.result === 'lost') {
      if (pick.result === 'lost') eliminated.push({ playerId: entry.player_id, playerUsername: entry.player_username, entryNumber: entryNumber, entryLabel: label, reason:'already_lost' });
      else survivors.push({ playerId: entry.player_id, playerUsername: entry.player_username, entryNumber: entryNumber, entryLabel: label, team: pick.team });
      results.push({ playerId: entry.player_id, entryNumber: entryNumber, team: pick.team, result: pick.result, reason:'already_graded' });
      continue;
    }
    const game = _survivorGameForTeam(pick.team, games);
    if (!game || !game.completed) {
      pendingRemain++;
      results.push({ playerId: entry.player_id, entryNumber: entryNumber, team: pick.team, result:'pending', reason: game ? 'game_not_final' : 'game_not_found' });
      survivors.push({ playerId: entry.player_id, playerUsername: entry.player_username, entryNumber: entryNumber, entryLabel: label, team: pick.team });
      continue;
    }
    const won = _survivorTeamWon(pick.team, game);
    const result = won ? 'won' : 'lost';
    await sb.from('survivor_picks').update({
      result: result, graded_at: now, game_id: pick.game_id || game.id
    }).eq('id', pick.id);
    if (won) {
      survivors.push({ playerId: entry.player_id, playerUsername: entry.player_username, entryNumber: entryNumber, entryLabel: label, team: pick.team });
    } else {
      await sb.from('survivor_entries').update({ status:'eliminated', eliminated_week: week })
        .eq('id', entry.id);
      eliminated.push({ playerId: entry.player_id, playerUsername: entry.player_username, entryNumber: entryNumber, entryLabel: label, reason:'lost' });
    }
    results.push({ playerId: entry.player_id, entryNumber: entryNumber, team: pick.team, result: result, reason:'graded', gameId: game.id });
    try { telegramBot.notifySurvivorGrade({ playerId: entry.player_id, week: week, team: pick.team, won: !!won }); } catch(_e) {}
    try {
      await _notifyPlayer({
        playerId: entry.player_id,
        type: 'survivor_grade',
        title: won ? 'Survivor Week ' + week + ' survived' : 'Survivor Week ' + week + ' eliminated',
        message: (won ? 'Survived' : 'Eliminated') + ' with ' + pick.team +
          (entryNumber > 1 ? ' (entry ' + entryNumber + ')' : '') + '.'
      });
    } catch(_n) {}
  }

  let weekAdvanced = false;
  let currentWeek = pool.current_week;
  let status = pool.status;
  if (pendingRemain === 0) {
    const elimIds = {};
    eliminated.forEach(function(x){ elimIds[x.playerId+':'+x.entryNumber] = true; });
    const stillAlive = (entries||[]).filter(function(e){
      return e.status === 'alive' && !elimIds[e.player_id+':'+_survivorEntryNum(e)];
    });
    if (stillAlive.length <= 1) {
      status = 'completed';
      await sb.from('survivor_pools').update({ status: status }).eq('id', poolId);
    } else {
      currentWeek = pool.current_week + 1;
      weekAdvanced = true;
      await sb.from('survivor_pools').update({ current_week: currentWeek }).eq('id', poolId);
    }
  }

  console.log('[SURVIVOR_GRADE_OK] pool='+poolId+' week='+week+' source='+(opts.source||'manual')+
    ' graded='+results.filter(function(r){ return r.reason==='graded'; }).length+
    ' pending='+pendingRemain+' elim='+eliminated.length+' advanced='+weekAdvanced);
  return {
    ok: true, results: results, eliminated: eliminated, survivors: survivors,
    weekAdvanced: weekAdvanced, currentWeek: currentWeek, status: status,
    pendingRemain: pendingRemain, scoresError: null, gamesChecked: games.length,
    source: scores.source || 'espn'
  };
}

const SURVIVOR_GRADE_INTERVAL_MS = 30 * 60 * 1000;

function _isSurvivorGameDayEt(nowMs) {
  const et = _etParts(nowMs || Date.now());
  return et.dow === 0 || et.dow === 1 || et.dow === 4; // Sun, Mon, Thu ET
}

async function _survivorAutoGradeTick() {
  if (!_isSurvivorGameDayEt()) {
    console.log('[SURVIVOR_GRADE_SKIP] not_game_day');
    return;
  }
  const sb = getSupabase();
  if (!sb) {
    console.warn('[SURVIVOR_GRADE_SKIP] supabase_not_configured');
    return;
  }
  const { data: pools, error } = await sb.from('survivor_pools').select('*').eq('status', 'active');
  if (error) {
    console.error('[SURVIVOR_GRADE_LIST_FAIL]', error.message);
    return;
  }
  for (let i = 0; i < (pools || []).length; i++) {
    const pool = pools[i];
    try {
      const r = await _gradeSurvivorPool(sb, pool, pool.current_week, { source: 'auto' });
      if (!r.ok) console.error('[SURVIVOR_GRADE_FAIL] pool='+pool.id+' err='+r.error+' '+ (r.scoresError||''));
    } catch (e) {
      console.error('[SURVIVOR_GRADE_FAIL] pool='+pool.id, e.message);
    }
  }
}

function _startSurvivorAutoGrade() {
  console.log('[SURVIVOR_GRADE_SCHED] every 30m on Sun/Mon/Thu America/New_York');
  setInterval(function() {
    _survivorAutoGradeTick().catch(function(e){ console.error('[SURVIVOR_GRADE_TICK_FAIL]', e.message); });
  }, SURVIVOR_GRADE_INTERVAL_MS);
  setTimeout(function() {
    _survivorAutoGradeTick().catch(function(e){ console.error('[SURVIVOR_GRADE_TICK_FAIL]', e.message); });
  }, 20000);
}

// POST /api/survivor/:poolId/grade  — host/admin only
app.post('/api/survivor/:poolId/grade', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const poolId = String(req.params.poolId||'').trim();
  const week = parseInt(req.body&&req.body.week, 10);
  if (!week) return res.status(400).json({ ok:false, error:'week_required' });
  try {
    const pool = await _loadSurvivorPool(sb, poolId);
    if (!pool) return res.status(404).json({ ok:false, error:'pool_not_found' });
    if (!_survivorIsHost(actor, pool)) return res.status(403).json({ ok:false, error:'host_or_admin_only' });
    if (week !== pool.current_week) return res.status(400).json({ ok:false, error:'week_mismatch', currentWeek: pool.current_week });

    const graded = await _gradeSurvivorPool(sb, pool, week, { source: 'manual' });
    if (!graded.ok) {
      console.error('[SURVIVOR_GRADE_FAIL] pool='+poolId+' err='+graded.error+' '+(graded.scoresError||''));
      return res.status(503).json({
        ok: false, error: graded.error || 'espn_scores_unavailable',
        scoresError: graded.scoresError || null
      });
    }
    res.json(graded);
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/survivor/:poolId/standings — no auth required
app.get('/api/survivor/:poolId/standings', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const poolId = String(req.params.poolId||'').trim();
  try {
    const pool = await _loadSurvivorPool(sb, poolId);
    if (!pool) return res.status(404).json({ ok:false, error:'pool_not_found' });
    const { data: entries, error: eErr } = await sb.from('survivor_entries').select('*').eq('pool_id', poolId);
    if (eErr) throw eErr;
    const { data: weekPicks, error: wErr } = await sb.from('survivor_picks')
      .select('player_id,team,result,week,entry_number').eq('pool_id', poolId).eq('week', pool.current_week);
    if (wErr) throw wErr;
    const anyGraded = (weekPicks||[]).some(function(p){ return p.result === 'won' || p.result === 'lost'; });
    const picksRevealed = anyGraded || _survivorDeadlinePassed(pool);
    const nameByKey = {};
    (entries||[]).forEach(function(e){
      const n = _survivorEntryNum(e);
      nameByKey[String(e.player_id)+':'+n] = e.entry_label || _survivorEntryLabel(e.player_username, n);
    });
    const publicEntries = (entries||[]).map(_survivorPublicEntry)
      .sort(function(a,b){
        const an = (a.playerUsername||'').toLowerCase();
        const bn = (b.playerUsername||'').toLowerCase();
        if (an < bn) return -1;
        if (an > bn) return 1;
        return a.entryNumber - b.entryNumber;
      });
    res.json({
      ok: true,
      pool: {
        id: pool.id, name: pool.name, season: pool.season,
        status: pool.status, currentWeek: pool.current_week
      },
      alive: publicEntries.filter(function(e){ return e.status==='alive'; }),
      eliminated: publicEntries.filter(function(e){ return e.status==='eliminated'; }),
      thisWeekPicks: (weekPicks||[]).map(function(p){
        const n = _survivorEntryNum(p);
        return {
          playerId: p.player_id,
          playerUsername: nameByKey[String(p.player_id)+':'+n] || null,
          entryNumber: n,
          entryLabel: nameByKey[String(p.player_id)+':'+n] || null,
          team: picksRevealed ? p.team : null,
          hasPick: true,
          result: picksRevealed ? p.result : 'hidden'
        };
      }),
      picksRevealed: picksRevealed
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

const dailyAudit = require('./lib/daily-audit');

// GET /api/admin/audit/history — last 30 daily/manual integrity runs (not diamonds/audit)
app.get('/api/admin/audit/history', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const { data, error } = await sb.from('audit_log')
      .select('id,run_at,audit_type,checks_run,issues_found,critical_count,warning_count,triggered_by')
      .order('run_at', { ascending:false }).limit(30);
    if (error) throw error;
    res.json({ ok:true, runs: data||[] });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/admin/audit/run — manual read-only run; persist; never auto-fix
app.post('/api/admin/audit/run', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const out = await dailyAudit.runAndPersist(sb, {
      auditType: 'manual',
      triggeredBy: actor.actorId || 'admin'
    });
    res.json(out.summary);
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/admin/audit/:id — full results of one integrity audit
app.get('/api/admin/audit/:id', async (req, res) => {
  const actor = requireActor(req);
  if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
  if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole!=='platform_admin')
    return res.status(403).json({ ok:false, error:'insufficient_role' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  try {
    const { data, error } = await sb.from('audit_log').select('*').eq('id', req.params.id).limit(1);
    if (error) throw error;
    if (!data || !data[0]) return res.status(404).json({ ok:false, error:'audit_not_found' });
    res.json({ ok:true, run: data[0] });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});


// ══ LEDGER INTEGRITY CHECK (hourly, read-only — never auto-fix) ═══════════════
async function _runLedgerBalanceCheck(opts) {
  opts = opts || {};
  const sb = getSupabase();
  if (!sb) return { ok:false, error:'supabase_not_configured', results:[] };
  const clubFilter = opts.clubId || null;
  let mq = sb.from('club_members').select('club_id,player_id,balance_start,status');
  if (clubFilter) mq = mq.eq('club_id', clubFilter);
  const { data: members, error: mErr } = await mq;
  if (mErr) throw mErr;
  const results = [];
  let mismatchCount = 0, okCount = 0;
  for (const m of (members||[])) {
    const clubId = m.club_id;
    const playerId = m.player_id;
    if (!clubId || !playerId) continue;
    const start = m.balance_start != null ? parseFloat(m.balance_start) : 0;
    const { data: ledgerRows } = await sb.from('ledger_entries')
      .select('type,amount,balance_after,created_at')
      .eq('club_id', clubId).eq('player_id', playerId)
      .order('created_at', { ascending:true });
    let placed = 0, won = 0, canceled = 0, other = 0;
    (ledgerRows||[]).forEach(function(r){
      const typ = String(r.type||'').toLowerCase();
      const amt = parseFloat(r.amount)||0;
      if (typ === 'bet_placed') placed += Math.abs(amt);
      else if (typ === 'bet_won') won += Math.abs(amt);
      else if (typ === 'bet_canceled' || typ === 'bet_cancelled') canceled += Math.abs(amt);
      else other += amt; // signed
    });
    // Prompt formula: balance_start + bet_won + bet_canceled - bet_placed
    // (bet_placed stored negative in ledger_entries; we use abs above)
    const expectedLedger = Math.round((start + won + canceled - placed + other)*100)/100;
    const ledgerAvail = _deriveBalanceFromLedgerEntries(start, ledgerRows||[]);

    const { data: tix } = await sb.from('tickets')
      .select('status,risk_amount,potential_profit')
      .eq('club_id', clubId).eq('player_id', playerId);
    let openRisk=0, settledGains=0, settledLosses=0;
    (tix||[]).forEach(function(t){
      const s=String(t.status||'').toLowerCase();
      const r=parseFloat(t.risk_amount)||0;
      const p=parseFloat(t.potential_profit)||0;
      if (s==='canceled'||s==='voided'||s==='deleted'||s==='push'||s==='pushed') return;
      if (s==='active'||s==='open') openRisk+=r;
      else if (s==='won') settledGains+=p;
      else if (s==='lost') settledLosses+=r;
    });
    const derivedTickets = Math.round((start - openRisk - settledLosses + settledGains)*100)/100;
    const compareTo = ledgerAvail != null ? ledgerAvail : expectedLedger;
    const diff = Math.round((compareTo - derivedTickets)*100)/100;
    const status = Math.abs(diff) > 0.01 ? 'MISMATCH' : 'OK';
    if (status === 'MISMATCH') mismatchCount++; else okCount++;
    console.log('[balance-check] player='+playerId
      +' expected_ledger='+compareTo.toFixed(2)
      +' derived_tickets='+derivedTickets.toFixed(2)
      +' diff='+diff.toFixed(2)
      +' STATUS='+status);
    results.push({
      clubId, playerId, balanceStart: start,
      expectedLedger: compareTo, ledgerFromEntries: ledgerAvail,
      derivedTickets, diff, status,
      components: { placed, won, canceled, other, openRisk, settledGains, settledLosses },
      ledgerEntryCount: (ledgerRows||[]).length
    });
  }
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    playerCount: results.length,
    okCount, mismatchCount,
    results
  };
}

async function _balanceCheckTick() {
  try {
    const r = await _runLedgerBalanceCheck();
    console.log('[balance-check] hourly complete players='+(r.playerCount||0)
      +' ok='+(r.okCount||0)+' mismatch='+(r.mismatchCount||0));
  } catch(e) {
    console.error('[balance-check] hourly failed:', e.message||e);
  }
}

function _startHourlyBalanceCheck() {
  const HOUR_MS = 60 * 60 * 1000;
  console.log('[balance-check] scheduling hourly ledger integrity check');
  setInterval(function(){ _balanceCheckTick(); }, HOUR_MS);
  // First run ~90s after boot so boot traffic settles
  setTimeout(function(){ _balanceCheckTick(); }, 90000);
}

// GET /api/admin/balance-check — on-demand read-only integrity check
app.get('/api/admin/balance-check', async (req, res) => {
  try {
    const clubId = (req.query && req.query.clubId) || null;
    const report = await _runLedgerBalanceCheck({ clubId });
    res.json(report);
  } catch(e) {
    console.error('[balance-check] on-demand error:', e.message||e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

try {
  require('./admin-diamonds-routes')({
    app, requireActor, ROLE_RANK, getSupabase, _getWeekStart,
    _verifyCryptoTx, _persistCryptoScan, _creditHostDiamondPurchase,
    _writeHostDiamondLedger, emitEvent, _writeAuthAudit
  });
} catch (e) { console.warn('[admin-diamonds] register failed:', e.message); }

// ── Player in-app notifications (survivor + general) ─────────────────────────
async function _notifyPlayer(opts) {
  var sb = getSupabase();
  if (!sb || !opts || !opts.playerId || !opts.title) return null;
  try {
    var row = {
      player_id: String(opts.playerId),
      type: String(opts.type || 'general'),
      title: String(opts.title),
      message: String(opts.message || opts.body || ''),
      read: false,
      created_at: new Date().toISOString()
    };
    if (opts.metadata != null || opts.metadata_json != null) {
      row.metadata_json = opts.metadata || opts.metadata_json;
    }
    var r = await sb.from('player_notifications').insert(row).select('id').maybeSingle();
    if (r && r.error && row.metadata_json) {
      delete row.metadata_json;
      r = await sb.from('player_notifications').insert(row).select('id').maybeSingle();
    }
    if (r && r.error) {
      console.warn('[notify] insert failed:', r.error.message);
      return null;
    }
    return r && r.data ? r.data.id : null;
  } catch (e) {
    console.warn('[notify] insert failed:', e && e.message);
    return null;
  }
}

app.get('/api/notifications', auth, async (req, res) => {
  try {
    var actor = req._actor || requireActor(req) || {};
    var playerId = String((req.query && req.query.playerId) || actor.actorId || (req.user && req.user.id) || '');
    if (!playerId) return res.status(400).json({ ok:false, error:'missing_playerId' });
    // Players may only read their own notifications unless host/admin.
    if (actor.actorId && String(actor.actorId) !== playerId && actor.role !== 'host' && actor.role !== 'admin' && actor.role !== 'owner') {
      playerId = String(actor.actorId);
    }
    var sb = getSupabase();
    if (!sb) return res.json({ ok:true, notifications: [], unread: 0 });
    var { data, error } = await sb.from('player_notifications')
      .select('*')
      .eq('player_id', playerId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    var list = data || [];
    var unread = list.filter(function(n){ return !n.read; }).length;
    res.json({ ok:true, notifications: list, unread: unread });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/notifications/read', auth, async (req, res) => {
  try {
    var actor = req._actor || requireActor(req) || {};
    var playerId = String((req.body && req.body.playerId) || actor.actorId || (req.user && req.user.id) || '');
    if (!playerId) return res.status(400).json({ ok:false, error:'missing_playerId' });
    if (actor.actorId && String(actor.actorId) !== playerId) playerId = String(actor.actorId);
    var ids = (req.body && req.body.ids) || null;
    var sb = getSupabase();
    if (!sb) return res.json({ ok:true });
    var q = sb.from('player_notifications').update({ read: true })
      .eq('player_id', playerId).eq('read', false);
    if (Array.isArray(ids) && ids.length) q = q.in('id', ids);
    var { error } = await q;
    if (error) throw error;
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

const SURVIVOR_WED_REMINDER_MS = 60 * 60 * 1000; // hourly check; fires once on Wed ET
var _lastWedReminderDayKey = '';

async function _survivorWedReminderTick() {
  try {
    var et = _etParts(Date.now());
    if (et.dow !== 3) return; // Wednesday ET
    var dayKey = et.y + '-' + et.m + '-' + et.d;
    if (_lastWedReminderDayKey === dayKey) return;
    var sb = getSupabase();
    if (!sb) return;
    var { data: pools, error } = await sb.from('survivor_pools').select('*').eq('status', 'active');
    if (error) throw error;
    var sent = 0;
    for (var i = 0; i < (pools || []).length; i++) {
      var pool = pools[i];
      var week = pool.current_week;
      var { data: entries } = await sb.from('survivor_entries').select('*')
        .eq('pool_id', pool.id).eq('status', 'alive');
      var { data: picks } = await sb.from('survivor_picks').select('player_id,entry_number')
        .eq('pool_id', pool.id).eq('week', week);
      var picked = {};
      (picks || []).forEach(function(p){
        picked[String(p.player_id) + ':' + _survivorEntryNum(p)] = true;
      });
      for (var j = 0; j < (entries || []).length; j++) {
        var e = entries[j];
        var key = String(e.player_id) + ':' + _survivorEntryNum(e);
        if (picked[key]) continue;
        // Dedup: skip if we already sent a Wed reminder today for this entry.
        var since = new Date(Date.UTC(et.y, et.m - 1, et.d)).toISOString();
        var { data: existing } = await sb.from('player_notifications')
          .select('id')
          .eq('player_id', String(e.player_id))
          .eq('type', 'survivor_wed_reminder')
          .gte('created_at', since)
          .limit(1);
        if (existing && existing.length) continue;
        await _notifyPlayer({
          playerId: e.player_id,
          type: 'survivor_wed_reminder',
          title: 'Survivor pick reminder',
          message: 'Week ' + week + ' picks are due soon for ' + (pool.name || 'your survivor pool') + '. Lock in your team.'
        });
        sent++;
      }
    }
    _lastWedReminderDayKey = dayKey;
    console.log('[SURVIVOR_WED_REMINDER] day=' + dayKey + ' sent=' + sent);
  } catch (e) {
    console.warn('[SURVIVOR_WED_REMINDER] failed:', e && e.message);
  }
}

// ── Player photo database (Owls names → ESPN IDs → verified headshots) ─────
const _ESPN_HEADSHOT_SLUG = {
  tennis: 'tennis', tennis_atp: 'tennis', tennis_wta: 'tennis',
  nfl: 'nfl', nba: 'nba', mlb: 'mlb', nhl: 'nhl', soccer: 'soccer', mls: 'soccer',
  wnba: 'wnba', ncaaf: 'college-football', ncaab: 'mens-college-basketball', mma: 'mma'
};
const _ESPN_SEARCH_SPORT = {
  tennis: 'tennis', nfl: 'football', nba: 'basketball', mlb: 'baseball',
  nhl: 'hockey', soccer: 'soccer', wnba: 'basketball', ncaaf: 'football',
  ncaab: 'basketball', mma: 'mma'
};
const _PHOTO_INDIVIDUAL_SPORTS = { tennis:1, mma:1, boxing:1, golf:1 };

function _photoNormName(n) {
  return String(n || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function _photoSportKey(s) {
  var k = String(s || 'tennis').toLowerCase().trim();
  if (k === 'tennis_atp' || k === 'tennis_wta' || k === 'atp' || k === 'wta') return 'tennis';
  if (k === 'mls') return 'soccer';
  return k;
}
function _espnHeadshotUrl(sport, id) {
  var slug = _ESPN_HEADSHOT_SLUG[_photoSportKey(sport)] || _photoSportKey(sport) || 'tennis';
  return 'https://a.espncdn.com/i/headshots/' + slug + '/players/full/' + id + '.png';
}

function _httpsJson(url, timeoutMs) {
  return new Promise(function(resolve) {
    var { execFile } = require('child_process');
    execFile('curl', ['-sS', '-L', '--max-time', String(Math.ceil((timeoutMs || 8000) / 1000)),
      '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      '-H', 'Accept: application/json', url],
      { timeout: (timeoutMs || 8000) + 1000, maxBuffer: 2 * 1024 * 1024 },
      function(err, stdout) {
        if (err || !stdout) return resolve(null);
        try { resolve(JSON.parse(String(stdout))); }
        catch (_e) { resolve(null); }
      });
  });
}

function _verifyImageUrl(url) {
  return new Promise(function(resolve) {
    var { execFile } = require('child_process');
    execFile('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code} %{content_type}',
      '-I', '-L', '--max-time', '8',
      '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      url],
      { timeout: 10000 },
      function(err, stdout) {
        var parts = String(stdout || '').trim().split(/\s+/);
        var code = parts[0];
        var ct = (parts.slice(1).join(' ') || '').toLowerCase();
        resolve(code === '200' && (!ct || ct.indexOf('image') >= 0 || ct.indexOf('octet') >= 0));
      });
  });
}

async function _espnSearchPlayerPhoto(playerName, sport) {
  var s = _photoSportKey(sport);
  var searchSport = _ESPN_SEARCH_SPORT[s] || s;
  var parts = String(playerName || '').trim().split(/\s+/).filter(Boolean);
  var firstLast = parts.length >= 2 ? (parts[0] + ' ' + parts[parts.length - 1]) : String(playerName || '').trim();
  var queries = s === 'tennis'
    ? [firstLast, String(playerName || '').trim(), firstLast + ' tennis']
    : s === 'mma'
      ? [String(playerName || '').trim(), firstLast, String(playerName || '').trim() + ' ufc', firstLast + ' mma']
      : [String(playerName || '').trim(), String(playerName || '').trim() + ' ' + s];
  var want = _photoNormName(playerName);
  for (var qi = 0; qi < queries.length; qi++) {
    var q = queries[qi];
    if (!q) continue;
    // ESPN returns empty items when `sport=` is set for tennis/MMA. Query by
    // name + type=player, then filter the result's sport field.
    var url = 'https://site.api.espn.com/apis/common/v3/search?query=' +
      encodeURIComponent(q) + '&type=player&limit=5';
    var data = await _httpsJson(url, 8000);
    var items = (data && data.items) || [];
    var exactHits = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.id) continue;
      var itemSport = String(it.sport || '').toLowerCase();
      if (itemSport && itemSport !== searchSport && itemSport !== s) continue;
      var dn = _photoNormName(it.displayName || it.name || '');
      if (want && dn && dn === want) exactHits.push(it);
      else if (s !== 'mma' && want && dn && (dn.indexOf(want) >= 0 || want.indexOf(dn) >= 0)) {
        // Non-MMA: keep legacy soft match for tennis/team sports
        exactHits.push(it);
      }
    }
    if (s === 'mma' && exactHits.length !== 1) continue;
    var chosen = exactHits[0];
    if (!chosen) continue;
    var espnId = String(chosen.id);
    var photoUrl = _espnHeadshotUrl(s, espnId);
    var verified = await _verifyImageUrl(photoUrl);
    if (!verified) continue;
    return { espnId: espnId, photoUrl: photoUrl, verified: true, displayName: chosen.displayName || playerName };
  }
  return null;
}

async function _lookupPlayerPhotoRow(sport, name) {
  var sb = getSupabase();
  if (!sb || !name) return null;
  var s = _photoSportKey(sport);
  var { data, error } = await sb.from('player_photos')
    .select('player_name,sport,espn_id,photo_url,verified')
    .eq('sport', s)
    .ilike('player_name', String(name).trim())
    .limit(1);
  if (error) throw error;
  if (data && data[0]) return data[0];
  var want = _photoNormName(name);
  if (!want) return null;
  var { data: rows } = await sb.from('player_photos')
    .select('player_name,sport,espn_id,photo_url,verified')
    .eq('sport', s)
    .limit(4000);
  return (rows || []).find(function(r) { return _photoNormName(r.player_name) === want; }) || null;
}

async function _upsertPlayerPhoto(row) {
  var sb = getSupabase();
  if (!sb) return { ok:false, error:'supabase_not_configured' };
  var existing = await _lookupPlayerPhotoRow(row.sport, row.player_name);
  var now = new Date().toISOString();
  if (existing) {
    var { error } = await sb.from('player_photos').update({
      espn_id: row.espn_id || existing.espn_id,
      photo_url: row.photo_url || existing.photo_url,
      verified: row.verified != null ? row.verified : existing.verified,
      updated_at: now
    }).eq('sport', existing.sport).ilike('player_name', existing.player_name);
    if (error) throw error;
    return { ok:true, updated:true };
  }
  var { error: iErr } = await sb.from('player_photos').insert({
    player_name: row.player_name,
    sport: row.sport,
    espn_id: row.espn_id || null,
    photo_url: row.photo_url || null,
    verified: !!row.verified,
    created_at: now,
    updated_at: now
  });
  if (iErr) throw iErr;
  return { ok:true, inserted:true };
}

function _addPhotoName(set, name) {
  var n = String(name || '').trim();
  if (!n || n.length < 2) return;
  if (/^[0-9.+-]+$/.test(n)) return;
  if (/[\/,]/.test(n)) return;
  set[n] = true;
}

function _collectCachedPlayerNames(sport) {
  var s = _photoSportKey(sport);
  var names = {};
  var cache = (typeof LIVE_MARKET_CACHE !== 'undefined') ? LIVE_MARKET_CACHE : null;
  var full = (typeof _CACHE_SPORT_KEY_BY_SHORT !== 'undefined' && _CACHE_SPORT_KEY_BY_SHORT[s]) || s;
  if (cache && Array.isArray(cache.games)) {
    cache.games.forEach(function(g) {
      if (!g) return;
      var match = (s === 'soccer')
        ? (typeof _isSoccerCacheSportKey === 'function' && _isSoccerCacheSportKey(g.sport_key))
        : (s === 'tennis')
          ? (typeof _isTennisCacheSportKey === 'function' && _isTennisCacheSportKey(g.sport_key))
          : (typeof _isMatchingSport === 'function' && _isMatchingSport(g.sport_key, s, full));
      if (!match) return;
      if (_PHOTO_INDIVIDUAL_SPORTS[s]) {
        _addPhotoName(names, g.home_team || g.home);
        _addPhotoName(names, g.away_team || g.away);
      }
      (g.markets || []).forEach(function(m) {
        if (m && m.playerName) _addPhotoName(names, m.playerName);
      });
      (g.props || []).forEach(function(p) {
        if (p && p.playerName) _addPhotoName(names, p.playerName);
      });
    });
  }
  var propsCached = (typeof _PROPS_RESPONSE_CACHE !== 'undefined') ? _PROPS_RESPONSE_CACHE[s] : null;
  var propsList = propsCached && propsCached.data && propsCached.data.props;
  if (Array.isArray(propsList)) {
    propsList.forEach(function(p) {
      if (p && (p.playerName || p.player)) _addPhotoName(names, p.playerName || p.player);
    });
  }
  return Object.keys(names);
}

async function _collectOwlsPlayerNames(sport) {
  var s = _photoSportKey(sport);
  var names = {};
  _collectCachedPlayerNames(s).forEach(function(n) { names[n] = true; });
  try {
    var fetched = await fetchOddsFromOwlsInsight(s);
    var games = (fetched && fetched.games) || [];
    games.forEach(function(g) {
      if (_PHOTO_INDIVIDUAL_SPORTS[s]) {
        _addPhotoName(names, g.home_team || g.home);
        _addPhotoName(names, g.away_team || g.away);
      }
      (g.markets || []).forEach(function(m) {
        if (m && m.playerName) _addPhotoName(names, m.playerName);
      });
    });
  } catch (_e) {}
  if (!_PHOTO_INDIVIDUAL_SPORTS[s] && typeof fetchPropsFromOwlsInsight === 'function') {
    try {
      var props = await fetchPropsFromOwlsInsight(s);
      ((props && props.props) || []).forEach(function(p) {
        if (p && (p.playerName || p.player)) _addPhotoName(names, p.playerName || p.player);
      });
    } catch (_e2) {}
  }
  return Object.keys(names);
}

async function _resolveAndStorePlayerPhoto(name, sport) {
  var s = _photoSportKey(sport);
  var existing = await _lookupPlayerPhotoRow(s, name);
  if (existing && existing.verified && existing.photo_url) {
    return { ok:true, cached:true, photoUrl: existing.photo_url, espnId: existing.espn_id };
  }
  var hit = await _espnSearchPlayerPhoto(name, s);
  if (!hit) {
    if (!existing) {
      try {
        await _upsertPlayerPhoto({ player_name: name, sport: s, verified: false });
      } catch (_e) {}
    }
    return { ok:false };
  }
  await _upsertPlayerPhoto({
    player_name: hit.displayName || name,
    sport: s,
    espn_id: hit.espnId,
    photo_url: hit.photoUrl,
    verified: true
  });
  return { ok:true, photoUrl: hit.photoUrl, espnId: hit.espnId, verified: true };
}

async function _syncPlayerPhotosForSport(sport) {
  var s = _photoSportKey(sport);
  var names = await _collectOwlsPlayerNames(s);
  var inserted = 0, updated = 0, skipped = 0, failed = 0;
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    try {
      var existing = await _lookupPlayerPhotoRow(s, name);
      if (existing && existing.verified && existing.photo_url) { skipped++; continue; }
      var hit = await _espnSearchPlayerPhoto(name, s);
      if (!hit) { failed++; continue; }
      var r = await _upsertPlayerPhoto({
        player_name: hit.displayName || name,
        sport: s,
        espn_id: hit.espnId,
        photo_url: hit.photoUrl,
        verified: true
      });
      if (r.inserted) inserted++;
      else updated++;
    } catch (_e) { failed++; }
    await new Promise(function(res) { setTimeout(res, 120); });
  }
  return { ok:true, sport:s, scanned: names.length, inserted: inserted, updated: updated, skipped: skipped, failed: failed };
}

app.get('/api/player-photo/:sport/:name', async (req, res) => {
  try {
    var sport = _photoSportKey(req.params.sport);
    var name = decodeURIComponent(String(req.params.name || '')).trim();
    if (!name) return res.status(400).json({ ok:false, error:'missing_name' });
    var row = await _lookupPlayerPhotoRow(sport, name);
    if (row && row.photo_url) {
      return res.json({ ok:true, photoUrl: row.photo_url, espnId: row.espn_id || null, verified: !!row.verified, cached: true });
    }
    var resolved = await _resolveAndStorePlayerPhoto(name, sport);
    if (resolved && resolved.ok && resolved.photoUrl) {
      return res.json({ ok:true, photoUrl: resolved.photoUrl, espnId: resolved.espnId || null, verified: true, cached: false });
    }
    res.json({ ok:false });
  } catch (e) {
    console.warn('[player-photo] get failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/api/player-photo/sync/:sport', async (req, res) => {
  try {
    var actor = req._actor || requireActor(req) || {};
    if (actor.error) return res.status(actor.status||401).json({ ok:false, error:actor.error });
    if ((ROLE_RANK[actor.role]||0) < ROLE_RANK.full_admin && actor.platformRole !== 'platform_admin')
      return res.status(403).json({ ok:false, error:'insufficient_role', required:'host/admin' });
    var sport = _photoSportKey(req.params.sport);
    var result = await _syncPlayerPhotosForSport(sport);
    res.json(result);
  } catch (e) {
    console.error('[player-photo/sync]', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── Team logos (NCAAF + Soccer ESPN mappings) — presentation enrichment only ─
var _ncaafLogoIndex = null;
var _ncaafLogoIndexAt = 0;
var _soccerLogoIndex = null;
var _soccerLogoIndexAt = 0;
var _TEAM_LOGO_INDEX_TTL_MS = 10 * 60 * 1000;

function _isNcaafSportKey(sport) {
  var s = String(sport || '').toLowerCase();
  return s === 'ncaaf' || s === 'ncaafb' || s === 'americanfootball_ncaaf' ||
    s.indexOf('ncaaf') >= 0;
}

function _isSoccerSportKey(sport) {
  var s = String(sport || '').toLowerCase();
  return s === 'soccer' || s.indexOf('soccer') === 0 ||
    s === 'epl' || s === 'mls' || s === 'ucl' || s === 'laliga' ||
    s === 'seriea' || s === 'bundesliga' || s === 'ligue1' ||
    s === 'worldcup' || s === 'euros';
}

async function _getNcaafLogoIndex(force) {
  var now = Date.now();
  if (!force && _ncaafLogoIndex && (now - _ncaafLogoIndexAt) < _TEAM_LOGO_INDEX_TTL_MS) {
    return _ncaafLogoIndex;
  }
  try {
    var sb = getSupabase();
    var rows = await ncaafTeamLogos.loadTeamLogoRows(sb, 'ncaaf');
    _ncaafLogoIndex = ncaafTeamLogos.buildResolverIndex(rows || []);
    _ncaafLogoIndexAt = now;
  } catch (e) {
    console.warn('[team-logos] ncaaf index load failed:', e && e.message);
    if (!_ncaafLogoIndex) _ncaafLogoIndex = ncaafTeamLogos.buildResolverIndex([]);
  }
  return _ncaafLogoIndex;
}

async function _getSoccerLogoIndex(force) {
  var now = Date.now();
  if (!force && _soccerLogoIndex && (now - _soccerLogoIndexAt) < _TEAM_LOGO_INDEX_TTL_MS) {
    return _soccerLogoIndex;
  }
  try {
    var sb = getSupabase();
    var rows = await soccerTeamLogos.loadTeamLogoRows(sb, 'soccer');
    _soccerLogoIndex = soccerTeamLogos.buildResolverIndex(rows || []);
    _soccerLogoIndexAt = now;
  } catch (e) {
    console.warn('[team-logos] soccer index load failed:', e && e.message);
    if (!_soccerLogoIndex) _soccerLogoIndex = soccerTeamLogos.buildResolverIndex([]);
  }
  return _soccerLogoIndex;
}

// Warm indexes shortly after boot (non-blocking).
setTimeout(function () {
  _getNcaafLogoIndex(true).catch(function () {});
  _getSoccerLogoIndex(true).catch(function () {});
}, 2500);

function _attachNcaafTeamLogos(projected, sportShort, rawGame) {
  if (!projected || !_isNcaafSportKey(sportShort || projected.sport)) return projected;
  var index = _ncaafLogoIndex;
  if (!index) return projected;
  try {
    var homeName = projected.home || (rawGame && (rawGame.home_team || rawGame.home)) || '';
    var awayName = projected.away || (rawGame && (rawGame.away_team || rawGame.away)) || '';
    var home = ncaafTeamLogos.resolveTeamLogo(homeName, index);
    var away = ncaafTeamLogos.resolveTeamLogo(awayName, index);
    if (home && home.logoUrl) {
      projected.homeLogoUrl = home.logoUrl;
      projected.homeTeamId = home.row && home.row.provider_team_id;
    }
    if (away && away.logoUrl) {
      projected.awayLogoUrl = away.logoUrl;
      projected.awayTeamId = away.row && away.row.provider_team_id;
    }
  } catch (_e) {}
  return projected;
}

function _attachSoccerTeamLogos(projected, sportShort, rawGame) {
  if (!projected || !_isSoccerSportKey(sportShort || projected.sport)) return projected;
  var index = _soccerLogoIndex;
  if (!index) return projected;
  try {
    var homeName = projected.home || (rawGame && (rawGame.home_team || rawGame.home)) || '';
    var awayName = projected.away || (rawGame && (rawGame.away_team || rawGame.away)) || '';
    var home = soccerTeamLogos.resolveTeamLogo(homeName, index);
    var away = soccerTeamLogos.resolveTeamLogo(awayName, index);
    if (home && home.logoUrl) {
      projected.homeLogoUrl = home.logoUrl;
      projected.homeTeamId = home.row && home.row.provider_team_id;
    }
    if (away && away.logoUrl) {
      projected.awayLogoUrl = away.logoUrl;
      projected.awayTeamId = away.row && away.row.provider_team_id;
    }
  } catch (_e) {}
  return projected;
}

app.get('/api/team-logos/:sport', async (req, res) => {
  try {
    var sport = String(req.params.sport || '').toLowerCase();
    var isNcaaf = _isNcaafSportKey(sport) || sport === 'ncaaf';
    var isSoccer = _isSoccerSportKey(sport);
    if (!isNcaaf && !isSoccer) {
      return res.status(400).json({ ok: false, error: 'unsupported_sport', supported: ['ncaaf', 'soccer'] });
    }
    var sb = getSupabase();
    var sportKey = isSoccer ? 'soccer' : 'ncaaf';
    var loader = isSoccer ? soccerTeamLogos : ncaafTeamLogos;
    var rows = await loader.loadTeamLogoRows(sb, sportKey);
    res.json({
      ok: true,
      sport: sportKey,
      count: (rows || []).length,
      teams: (rows || []).map(function (r) {
        return {
          providerTeamId: r.provider_team_id,
          canonicalName: r.canonical_name,
          displayName: r.display_name,
          abbreviation: r.abbreviation,
          mascot: r.mascot,
          location: r.location,
          conference: r.conference,
          classification: r.classification,
          logoUrl: r.logo_url,
          aliases: r.aliases || []
        };
      })
    });
  } catch (e) {
    console.warn('[team-logos] list failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/team-logo/:sport/:name', async (req, res) => {
  try {
    var sport = String(req.params.sport || '').toLowerCase();
    var isNcaaf = _isNcaafSportKey(sport);
    var isSoccer = _isSoccerSportKey(sport);
    if (!isNcaaf && !isSoccer) {
      return res.status(400).json({ ok: false, error: 'unsupported_sport', supported: ['ncaaf', 'soccer'] });
    }
    var name = decodeURIComponent(String(req.params.name || '')).trim();
    if (!name) return res.status(400).json({ ok: false, error: 'missing_name' });
    var index = isSoccer ? await _getSoccerLogoIndex(false) : await _getNcaafLogoIndex(false);
    var resolver = isSoccer ? soccerTeamLogos : ncaafTeamLogos;
    var resolved = resolver.resolveTeamLogo(name, index);
    if (resolved && resolved.logoUrl) {
      return res.json({
        ok: true,
        status: resolved.status,
        logoUrl: resolved.logoUrl,
        providerTeamId: resolved.row && resolved.row.provider_team_id,
        canonicalName: resolved.row && resolved.row.canonical_name,
        classification: resolved.row && resolved.row.classification
      });
    }
    res.json({ ok: false, status: resolved.status || 'unresolved' });
  } catch (e) {
    console.warn('[team-logo] get failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/team-logos/sync/:sport', async (req, res) => {
  try {
    var actor = req._actor || requireActor(req) || {};
    if (actor.error) return res.status(actor.status || 401).json({ ok: false, error: actor.error });
    if ((ROLE_RANK[actor.role] || 0) < ROLE_RANK.full_admin && actor.platformRole !== 'platform_admin')
      return res.status(403).json({ ok: false, error: 'insufficient_role', required: 'host/admin' });
    var sport = String(req.params.sport || '').toLowerCase();
    var isNcaaf = _isNcaafSportKey(sport);
    var isSoccer = _isSoccerSportKey(sport);
    if (!isNcaaf && !isSoccer) {
      return res.status(400).json({ ok: false, error: 'unsupported_sport', supported: ['ncaaf', 'soccer'] });
    }
    var sb = getSupabase();
    if (!sb) return res.status(503).json({ ok: false, error: 'supabase_not_configured' });
    var result;
    if (isSoccer) {
      var board = !!(req.query && (req.query.board === '1' || req.query.board === 'true'));
      var extraNames = [];
      if (board) {
        var extra = {};
        var cacheSync = (typeof LIVE_MARKET_CACHE !== 'undefined') ? LIVE_MARKET_CACHE : null;
        if (cacheSync && Array.isArray(cacheSync.games)) {
          cacheSync.games.forEach(function (g) {
            if (!g) return;
            if (!_isSoccerSportKey(g.sport_key) && String(g.sport || '').toUpperCase() !== 'SOCCER') return;
            if (g.home_team) extra[String(g.home_team).trim()] = true;
            if (g.away_team) extra[String(g.away_team).trim()] = true;
            if (g.home) extra[String(g.home).trim()] = true;
            if (g.away) extra[String(g.away).trim()] = true;
          });
        }
        extraNames = Object.keys(extra).filter(Boolean);
      }
      result = await soccerTeamLogos.syncSoccerTeamLogos(sb, {
        extraProviderNames: extraNames
      });
      await _getSoccerLogoIndex(true);
    } else {
      var includeFcs = !!(req.query && (req.query.fcs === '1' || req.query.fcs === 'true'));
      result = await ncaafTeamLogos.syncNcaafTeamLogos(sb, { includeFcs: includeFcs });
      await _getNcaafLogoIndex(true);
    }
    res.json(result);
  } catch (e) {
    console.error('[team-logos/sync]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/team-logos/audit/:sport', async (req, res) => {
  try {
    var sport = String(req.params.sport || '').toLowerCase();
    var isNcaaf = _isNcaafSportKey(sport);
    var isSoccer = _isSoccerSportKey(sport);
    if (!isNcaaf && !isSoccer) {
      return res.status(400).json({ ok: false, error: 'unsupported_sport', supported: ['ncaaf', 'soccer'] });
    }
    var index = isSoccer ? await _getSoccerLogoIndex(false) : await _getNcaafLogoIndex(false);
    var resolver = isSoccer ? soccerTeamLogos : ncaafTeamLogos;
    var names = {};
    var cache = (typeof LIVE_MARKET_CACHE !== 'undefined') ? LIVE_MARKET_CACHE : null;
    if (cache && Array.isArray(cache.games)) {
      cache.games.forEach(function (g) {
        if (!g) return;
        if (isSoccer) {
          if (!_isSoccerSportKey(g.sport_key) && String(g.sport || '').toUpperCase() !== 'SOCCER') return;
        } else {
          if (!_isNcaafSportKey(g.sport_key) && !_isMatchingSport(g.sport_key, 'ncaaf', 'americanfootball_ncaaf')) return;
        }
        if (g.home_team) names[String(g.home_team).trim()] = true;
        if (g.away_team) names[String(g.away_team).trim()] = true;
        if (g.home) names[String(g.home).trim()] = true;
        if (g.away) names[String(g.away).trim()] = true;
      });
    }
    var list = Object.keys(names).filter(Boolean).sort();
    var report = resolver.auditProviderNames(list, index);
    res.json({
      ok: true,
      sport: isSoccer ? 'soccer' : 'ncaaf',
      total: report.total,
      matched: report.matched,
      exact: report.exact,
      alias: report.alias,
      normalized: report.normalized,
      unresolved: report.unresolved.map(function (x) { return x.name; }),
      ambiguous: report.ambiguous.map(function (x) { return x.name; })
    });
  } catch (e) {
    console.warn('[team-logos/audit]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

function _startSurvivorWedReminder() {
  console.log('[SURVIVOR_WED_REMINDER] hourly check (Wed America/New_York)');
  setInterval(function() {
    _survivorWedReminderTick().catch(function(e){ console.warn('[SURVIVOR_WED_REMINDER]', e.message); });
  }, SURVIVOR_WED_REMINDER_MS);
  setTimeout(function() {
    _survivorWedReminderTick().catch(function(e){ console.warn('[SURVIVOR_WED_REMINDER]', e.message); });
  }, 45000);
}

app.listen(PORT, '0.0.0.0', () => {
  const _startSHA = 'grade-espn-fallback';
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  PocketBooks Sports Backend  sha='+_startSHA+'    ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  PORT='+PORT+'  NODE_ENV='+process.env.NODE_ENV+'  DEV_AUTH_BYPASS='+process.env.DEV_AUTH_BYPASS);
  if (IS_PRODUCTION && DEV_AUTH_BYPASS) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║  CRITICAL: DEV_AUTH_BYPASS=true in NODE_ENV=production       ║');
    console.error('║  Snapshot odds bypass is DISABLED (bypassOk=false enforced)  ║');
    console.error('║  Remove DEV_AUTH_BYPASS from Railway env immediately.        ║');
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('');
  }
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
  _startCryptoScanner();
  _startHourlyBalanceCheck();
  telegramBot.startTelegramBot();
  dailyAudit.startScheduler({ getSupabase: getSupabase });
  _startSurvivorAutoGrade();
  _startSurvivorWedReminder();
  _startMlbGradePoller();
  // Init DB after server is bound
  initDB()
    .then(() => console.log('✅ DB ready'))
    .then(() => _migrateOddsSnapshotsSchema())
    .catch(e => console.error('DB init failed:', e.message));
});
// redeploy trigger 1779788685
