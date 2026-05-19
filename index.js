require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

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

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'pocketbooks-sports-secret-2026';

app.use(cors());
app.use(express.json());

// ===== HEALTH (first route) =====
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
function requirePermission(action) {
  return function(req, res, next) {
    // Phase A compat: if no role header, treat existing JWT users as owner
    const staffRole = req.headers['x-staff-role'] || 'owner';
    const actorId   = req.headers['x-staff-id']   || (req.user && req.user.id) || 'unknown';
    const clubId    = req.query.clubId || (req.body && req.body.clubId) || null;
    const check = _canDo(staffRole, action);
    // Audit log every permission check
    console.log('[permission check] actor='+actorId+' role='+staffRole+' action='+action+
      ' clubId='+(clubId||'?')+' allowed='+check.allowed+
      (check.allowed ? '' : ' reason='+check.reason));
    if (!check.allowed) {
      // Write audit event to Supabase if available (fire-and-forget)
      const sb = getSupabase();
      if (sb) sb.from('audit_events').insert({
        event_type:'permission_denied', actor_id:actorId, club_id:clubId,
        payload:{ action, role:staffRole, reason:check.reason }
      }).then(function(){}).catch(function(){});
      return res.status(403).json({ ok:false, error:'permission_denied',
        action, role:staffRole, reason:check.reason });
    }
    req.staffRole = staffRole;
    req.actorId   = actorId;
    next();
  };
}

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


// ── ODDS VALIDATION HELPERS ───────────────────────────────────────────────────────────────────────────
const ODDS_TOLERANCE_PTS = 3; // ±3 American-odds-points drift allowed

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
function validateLegOdds(leg, liveMap, nowMs) {
  nowMs = nowMs || Date.now();
  // Game started?
  if (leg.scheduledStart) {
    const ct = new Date(leg.scheduledStart).getTime();
    if (!isNaN(ct) && nowMs >= ct) return { ok:false, code:'game_started', leg:leg.pick };
  }
  // Find live market: try providerGameId first (P1), then cKey (P2)
  const mLabel = (leg.market||'moneyline').toLowerCase().replace('run line','spread').replace('puck line','spread');
  const liveMarket =
    (leg.providerGameId && liveMap[leg.providerGameId+'|'+mLabel]) ||
    (leg.canonicalGameKey && liveMap[leg.canonicalGameKey+'|'+mLabel]);

  if (!liveMarket) return { ok:false, code:'market_closed', leg:leg.pick, reason:'not_found' };
  if (liveMarket.suspended) return { ok:false, code:'market_closed', leg:leg.pick, reason:'suspended' };
  if (liveMarket.closed)    return { ok:false, code:'market_closed', leg:leg.pick, reason:'closed' };

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

// Validate all legs — first failure blocks ticket
function validateAllLegsOdds(legs, liveMap, nowMs) {
  for (let i=0; i<legs.length; i++) {
    const r = validateLegOdds(legs[i], liveMap, nowMs);
    if (!r.ok) return Object.assign(r, { legIndex:i });
  }
  return { ok:true };
}

// Build updated odds snapshot (for accept-new-odds resubmit)
function buildAcceptedOddsSnapshot(legs, liveMap) {
  const now = new Date().toISOString();
  return legs.map(function(leg) {
    const mLabel = (leg.market||'moneyline').toLowerCase().replace('run line','spread').replace('puck line','spread');
    const liveMarket = (leg.providerGameId && liveMap[leg.providerGameId+'|'+mLabel]) ||
                       (leg.canonicalGameKey && liveMap[leg.canonicalGameKey+'|'+mLabel]);
    const outcome = liveMarket && (liveMarket.outcomes||[]).find(o =>
      o.name && o.name.toLowerCase() === (leg.pick||'').toLowerCase());
    return Object.assign({}, leg, {
      odds: outcome ? outcome.price : leg.odds,
      oddsAcceptedAt: now
    });
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
  res.json({ queued: true }); // respond immediately
  const { ticket, ledgerEntry } = req.body.ticket ? req.body : { ticket: req.body, ledgerEntry: null };
  const t = ticket || req.body;
  if (!t || !t.id) return;
  mirrorTicketToSupabase(t).catch(function(e){ console.warn('[mirror/ticket] error:', e.message); });
  // Also mirror ledger entry if provided in same call
  if (ledgerEntry && ledgerEntry.id) {
    mirrorLedgerEntry(ledgerEntry).catch(function(e){ console.warn('[mirror/ledger] error:', e.message); });
  }
});

// POST /api/mirror/ledger — mirror a single ledger entry (append-only, idempotent)
app.post('/api/mirror/ledger', async (req, res) => {
  res.json({ queued: true }); // respond immediately
  const entry = req.body;
  if (!entry || !entry.id) return;
  mirrorLedgerEntry(entry).catch(function(e){ console.warn('[mirror/ledger] error:', e.message); });
});

// POST /api/mirror/ledger-bulk — mirror array of ledger entries in one batch (for replay)
app.post('/api/mirror/ledger-bulk', async (req, res) => {
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

app.get('/api/odds/:sport', async (req, res) => {
  const sportMap = { nfl:'americanfootball_nfl', nba:'basketball_nba', mlb:'baseball_mlb', nhl:'icehockey_nhl', soccer:'soccer_usa_mls', ufl:'americanfootball_ufl' };
  const sport = sportMap[req.params.sport] || req.params.sport;
  console.log('[odds] source=backend-proxy sport='+req.params.sport+' key_fingerprint='+(ODDS_KEY?ODDS_KEY.slice(0,4)+'...'+ODDS_KEY.slice(-4):'MISSING'));
  try {
    const games = await fetchOdds(sport);
    if (games === null) { return res.status(503).json({ error: 'ODDS_API_KEY not configured on server.' }); }
    if (games && games._error) { return res.status(402).json({ error: games._message, error_code: games._error }); }
    const formatted = (Array.isArray(games) ? games : []).slice(0,20).map(g => ({
      id: g.id, sport: g.sport_title||req.params.sport.toUpperCase(),
      home: g.home_team, away: g.away_team, time: g.commence_time,
      spreads: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='spreads')?.outcomes||[]).map(o=>({team:o.name,line:o.point,odds:o.price})),
      totals: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='totals')?.outcomes||[]).map(o=>({name:o.name,line:o.point,odds:o.price})),
      moneyline: (g.bookmakers?.[0]?.markets?.find(m=>m.key==='h2h')?.outcomes||[]).map(o=>({team:o.name,odds:o.price}))
    }));
    res.json(formatted);
  } catch(e) { console.error('Odds endpoint error:', e.message); res.json([]); }
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

app.post('/api/grade/run', requirePermission('grade_trigger'), async (req, res) => {
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

    // 2. Fetch completed scores
    const completedGames = await _sgFetchCompletedGames(daysBack);
    console.log('[server grade] checked='+tickets.length+' completedGames='+completedGames.length);

    const results = [];
    let graded = 0, skipped = 0;
    const errors = [];

    for (const ticket of tickets) {
      const ticketLegs = (allLegs||[]).filter(function(l){ return l.ticket_id===ticket.id; })
        .sort(function(a,b){ return (a.leg_index||0)-(b.leg_index||0); });

      const row = { ticketId:ticket.id, statusBefore:ticket.status, statusAfter:null,
        result:null, matchMethod:null, payoutDelta:0, ledgerEntryId:null, auditEventId:null, reason:null };

      try {
        // Skip already settled (idempotency)
        if (ticket.graded_at) { row.reason='already_graded'; skipped++; results.push(row); continue; }

        // Future gate + grade
        for (const leg of ticketLegs) {
          const ctMs = leg.scheduled_start ? new Date(leg.scheduled_start).getTime() : 0;
          if (ctMs>0 && ctMs>nowMs) { row.reason='future_game_not_gradeable'; break; }
        }
        if (row.reason) { skipped++; results.push(row); continue; }

        // Match and grade each leg
        const legResults = [];
        let skipReason = null;
        for (const leg of ticketLegs) {
          const match = _sgFindGame(leg, completedGames);
          row.matchMethod = match.method;
          if (!match.game) { skipReason = match.reason||'no_match'; break; }
          if (!_sgIsGameFinal(match.game.status)) { skipReason = 'game_not_final'; break; }
          const lr = _sgGradeLeg(leg, match.game);
          if (!lr) { skipReason = 'leg_unable_to_grade'; break; }
          legResults.push(lr);
        }

        if (skipReason) { row.reason=skipReason; skipped++; results.push(row); continue; }
        if (!legResults.length) { row.reason='no_legs'; skipped++; results.push(row); continue; }

        const combined = legResults.some(function(r){return r==='lost';})?'lost':
                         legResults.every(function(r){return r==='push';})?'push':
                         legResults.some(function(r){return r==='push';})?'push':'won';

        const risk    = parseFloat(ticket.risk_amount)||0;
        const profit  = parseFloat(ticket.potential_profit)||0;
        const payout  = combined==='won' ? Math.round((risk+profit)*100)/100
                      : combined==='push' ? risk : 0;
        const delta   = combined==='won' ? profit : combined==='push' ? 0 : -risk;

        // Write ticket update
        const { error: uErr } = await sb.from('tickets').update({
          status: combined, graded_at: gradedAt, grading_source: 'server-api'
        }).eq('id', ticket.id).eq('status','active'); // eq guard prevents double-grade
        if (uErr) throw uErr;

        // Write ledger entry (idempotency via deterministic id)
        const ledgerId = 'SG_'+combined+'_'+ticket.id+'_'+gradedAt;
        const ledgerType = combined==='won'?'bet_won':combined==='push'?'bet_push':'bet_lost';
        await sb.from('ledger_entries').upsert({
          id: ledgerId, ticket_id: ticket.id,
          player_id: ticket.player_id, club_id: ticket.club_id,
          type: ledgerType, amount: combined==='won' ? profit : combined==='push' ? 0 : 0,
          reason: 'server_grade_'+combined, created_at: gradedAt, created_by: 'server-grade-api'
        }, { onConflict:'id' });

        // Write audit event
        const { data: auditData } = await sb.from('audit_events').insert({
          event_type: 'ticket_graded_server',
          ticket_id: ticket.id, player_id: ticket.player_id, club_id: ticket.club_id,
          payload: { result:combined, matchMethod:row.matchMethod, legResults, payout, delta,
                     legCount: ticketLegs.length }
        }).select('id');

        row.statusAfter    = combined;
        row.result         = combined;
        row.payoutDelta    = delta;
        row.ledgerEntryId  = ledgerId;
        row.auditEventId   = auditData&&auditData[0] ? auditData[0].id : null;
        graded++;
        console.log('[server grade] graded ticketId='+ticket.id+' result='+combined+' method='+row.matchMethod);

      } catch(ticketErr) {
        row.reason = 'error:'+ticketErr.message;
        errors.push({ ticketId:ticket.id, error:ticketErr.message });
        console.error('[server grade] error on ticket', ticket.id, ticketErr.message);
      }

      results.push(row);
    }

    res.json({ ok:true, checked:tickets.length, graded, skipped, errors, results });
  } catch(e) {
    console.error('[server grade] fatal:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── HOST DASHBOARD DB READ (Phase C Step 2) ────────────────────────────────────────────────────────
// GET /api/host/dashboard?clubId=...
app.get('/api/host/dashboard', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, source:'supabase_not_configured', stats:null });
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
app.get('/api/host/settlements-preview', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, source:'supabase_not_configured', players:[], totals:{playersOwe:0,hostOwes:0,net:0} });
  const { clubId } = req.query;
  try {
    // Load all tickets for this club
    let tq = sb.from('tickets')
      .select('id,status,risk_amount,potential_profit,player_id,player_username,placed_at,type');
    if (clubId) tq = tq.eq('club_id', clubId);
    const { data: tickets, error: tErr } = await tq;
    if (tErr) throw tErr;

    // Load club members for balance/username
    var memberMap = {};
    try {
      let mq = sb.from('club_members').select('player_id,balance_start');
      if (clubId) mq = mq.eq('club_id', clubId);
      const { data: members } = await mq;
      (members||[]).forEach(function(m){ memberMap[m.player_id] = m; });
    } catch(_e) {}

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
app.post('/api/host/settle-player', requirePermission('settle_player'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
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

    // Direction / overpay validation
    if (direction==='player_paid_host' && owesHost<=0)
      return res.status(400).json({ ok:false, error:'player_does_not_owe_host', owesHost, hostOwes });
    if (direction==='host_paid_player' && hostOwes<=0)
      return res.status(400).json({ ok:false, error:'host_does_not_owe_player', owesHost, hostOwes });
    var maxAmt = direction==='player_paid_host' ? owesHost : hostOwes;
    if (amt > maxAmt + 0.01)
      return res.status(400).json({ ok:false, error:'overpay_blocked', amount:amt, maxAmount:maxAmt });

    // 2. Write ledger entry (idempotent via idempotencyKey)
    var ledgerAmt = direction==='host_paid_player' ? amt : -amt;
    var executedAt = new Date().toISOString();
    const { error: lErr } = await sb.from('ledger_entries').upsert({
      id:              idempotencyKey,
      club_id:         clubId,
      player_id:       playerId,
      ticket_id:       null,
      type:            'settlement',
      amount:          Math.round(ledgerAmt*100)/100,
      balance_before:  null,
      balance_after:   null,
      reason:          direction + (note ? ': '+note : ''),
      created_at:      executedAt,
      created_by:      'host',
      settlement_week: settlementWeek||null,
      preview_snapshot: JSON.stringify({ owesHost, hostOwes, net, maxAmt, direction, amount:amt })
    }, { onConflict:'id' });
    if (lErr) throw lErr;

    // 3. Write audit event
    await sb.from('audit_events').insert({
      event_type: 'settlement_executed',
      club_id: clubId, player_id: playerId,
      payload: { direction, amount:amt, maxAmount:maxAmt, settlementWeek, idempotencyKey, note: note||null }
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
app.post('/api/host/weekly-rollover', requirePermission('weekly_rollover'), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
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

    // 5. Write per-player snapshots (insert-only, UNIQUE constraint prevents duplicates)
    if (players.length) {
      const snapRows = players.map(function(p) { return {
        rollover_week: week, club_id: clubId, player_id: p.playerId, username: p.username,
        owes_host: p.owesHost, host_owes: p.hostOwes, open_risk: p.openRisk,
        settled_net: p.settledNet, active_ticket_count: p.activeBetCount,
        snapshotted_at: performedAt
      }; });
      const { error: snapErr } = await sb.from('weekly_player_snapshots').insert(snapRows);
      if (snapErr) throw snapErr;
    }

    // 6. Audit event
    await sb.from('audit_events').insert({
      event_type: 'weekly_rollover_executed', club_id: clubId,
      payload: { rolloverWeek:week, playersCount:players.length, totals, performedBy:performedBy||'host' }
    });

    console.log('[weekly-rollover] week='+week+' club='+clubId+' players='+players.length);
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
app.post('/api/bets/place', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
  const { clubId, playerId, betType, stake, legs, payout, potentialProfit,
          idempotencyKey, playerUsername } = req.body || {};
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
  const legsArr = Array.isArray(legs) ? legs : [];
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
    // 1. Idempotency: check if this exact bet was already placed
    const { data: existLedger } = await sb.from('ledger_entries')
      .select('id,ticket_id').eq('id', idempotencyKey).limit(1);
    if (existLedger && existLedger[0]) {
      // Already placed — return the existing ticket
      const { data: existTicket } = await sb.from('tickets').select('*').eq('id', existLedger[0].ticket_id).limit(1);
      return res.json({ ok:true, idempotent:true, ticket: existTicket&&existTicket[0], ledgerEntryId:idempotencyKey });
    }

    // 2. Derive DB balance for player
    const { data: playerTix } = await sb.from('tickets')
      .select('status,risk_amount,potential_profit').eq('player_id', playerId);
    var startBal = 1000;
    try {
      const { data:mem } = await sb.from('club_members').select('balance_start')
        .eq('player_id',playerId).limit(1);
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

    // 3. Odds validation — re-fetch live odds and verify each leg
    // Skip if player explicitly accepted updated odds (oddsAccepted:true on body)
    if (!body.oddsAccepted) {
      try {
        // Determine unique sports from legs
        const sports = [...new Set(legsArr.map(l => (l.sport||'mlb').toLowerCase()))];
        const marketsByKey = {};
        await Promise.all(sports.map(async function(sport) {
          const games = await fetchOdds(sport);
          if (Array.isArray(games)) {
            Object.assign(marketsByKey, buildLiveMarketMap(games, sport));
          }
        }));
        const nowMs = Date.now();
        const oddsCheck = validateAllLegsOdds(legsArr, marketsByKey, nowMs);
        if (!oddsCheck.ok) {
          console.log('[bets/place] odds validation failed:', oddsCheck.code, oddsCheck.leg);
          if (oddsCheck.code === 'odds_changed') {
            // Build updated snapshot so frontend can offer "accept new odds"
            const updatedLegs = buildAcceptedOddsSnapshot(legsArr, marketsByKey);
            return res.status(409).json({
              ok: false, code: 'odds_changed',
              leg: oddsCheck.leg, legIndex: oddsCheck.legIndex,
              oldOdds: oddsCheck.oldOdds, newOdds: oddsCheck.newOdds,
              drift: oddsCheck.drift, updatedLegs
            });
          }
          return res.status(409).json({ ok:false, code: oddsCheck.code, leg: oddsCheck.leg,
                                        legIndex: oddsCheck.legIndex, reason: oddsCheck.reason });
        }
        // Stamp legs with live odds (lock in what the server verified)
        legsArr.forEach(function(leg, i) { leg.odds = oddsCheck.liveOdds || leg.odds; });
        console.log('[bets/place] odds validation ok for', legsArr.length, 'legs');
      } catch(oddsErr) {
        // Odds API unavailable — log but do NOT block placement (fail open)
        console.warn('[bets/place] odds validation skipped (API unavailable):', oddsErr.message);
      }
    } else {
      console.log('[bets/place] oddsAccepted=true — skipping re-validation, using submitted odds');
    }

    // 3b. Conflict check: active legs on same game+market
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

    // 4. Generate ticket ID
    const ticketId = 'T_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);

    // 5. Write ticket
    const ticketRow = {
      id: ticketId, club_id: clubId||null, player_id: playerId,
      player_username: playerUsername||null, type: betType, status: 'active',
      risk_amount: rnd(stakeAmt), potential_profit: rnd(parseFloat(potentialProfit)||0),
      estimated_payout: rnd(parseFloat(payout)||0),
      placed_at: now, mirrored_at: now
    };
    const { error: tErr } = await sb.from('tickets').insert(ticketRow);
    if (tErr) throw tErr;

    // 6. Write ticket_legs
    const legRows = legsArr.map(function(leg,i) { return {
      id: leg.legId || (ticketId+'_leg'+i), ticket_id: ticketId, leg_index: i,
      provider_name: leg.providerName||'odds-api', provider_game_id: leg.providerGameId||null,
      canonical_game_key: leg.canonicalGameKey, sport: leg.sport||null,
      home_team: leg.homeTeam||null, away_team: leg.awayTeam||null,
      scheduled_start: leg.scheduledStart, market: leg.market, pick: leg.pick,
      odds: leg.odds, line: leg.line!=null?parseFloat(leg.line):null, side: leg.side||null
    }; });
    const { error: lErr } = await sb.from('ticket_legs').insert(legRows);
    if (lErr) throw lErr;

    // 7. Write ledger entry (idempotencyKey as id)
    const { error: leErr } = await sb.from('ledger_entries').upsert({
      id: idempotencyKey, club_id: clubId||null, player_id: playerId,
      ticket_id: ticketId, type: 'bet_placed',
      amount: rnd(-stakeAmt),  // negative = player debit
      reason: 'bet_placed:'+betType, created_at: now, created_by: playerId
    }, { onConflict:'id' });
    if (leErr) throw leErr;

    // 8. Audit event
    await sb.from('audit_events').insert({
      event_type: 'ticket_placed', player_id: playerId, club_id: clubId||null, ticket_id: ticketId,
      payload: { betType, stake:stakeAmt, legs:legsArr.length, payout: parseFloat(payout)||0 }
    });

    console.log('[bets/place] ticketId='+ticketId+' playerId='+playerId+' stake='+stakeAmt+' legs='+legsArr.length);
    res.json({ ok:true, ticketId, ticket:ticketRow, legs:legRows, ledgerEntryId:idempotencyKey });
  } catch(e) {
    console.error('[bets/place] error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});
// ───────────────────────────────────────────────────────────────────────═

// POST /api/bets/cancel — DB-authoritative ticket cancellation
app.post('/api/bets/cancel', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok:false, error:'supabase_not_configured' });
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
    if (ticket.player_id !== playerId) return res.status(403).json({ ok:false, error:'not_owner' });
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

    // 4. Update ticket to canceled (status=active guard prevents double-cancel race)
    const { error: uErr } = await sb.from('tickets')
      .update({ status:'canceled', canceled_at:now, canceled_by:playerId,
                cancellation_reason:reason||'player_request' })
      .eq('id', ticketId).eq('status','active');
    if (uErr) throw uErr;

    // 5. Write refund ledger entry (idempotent)
    const riskAmt = parseFloat(ticket.risk_amount)||0;
    const { error: leErr } = await sb.from('ledger_entries').upsert({
      id: idempotencyKey, club_id: clubId||ticket.club_id||null,
      player_id: playerId, ticket_id: ticketId,
      type: 'bet_canceled', amount: riskAmt,  // positive = refund to player
      reason: 'cancel:'+(reason||'player_request'), created_at: now, created_by: playerId
    }, { onConflict:'id' });
    if (leErr) throw leErr;

    // 6. Audit event
    await sb.from('audit_events').insert({
      event_type: 'ticket_canceled', player_id: playerId, club_id: clubId||null, ticket_id: ticketId,
      payload: { reason: reason||'player_request', refundAmount: riskAmt, idempotencyKey }
    });

    console.log('[bets/cancel] ticketId='+ticketId+' playerId='+playerId+' refund=$'+riskAmt);
    res.json({ ok:true, ticketId, status:'canceled', refundAmount:riskAmt, ledgerEntryId:idempotencyKey });
  } catch(e) {
    console.error('[bets/cancel] error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// GET /api/player/dashboard?clubId=&playerId= — DB-derived player dashboard
app.get('/api/player/dashboard', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, source:'supabase_not_configured', balance:null });
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

    // Starting balance from club_members
    var startingBalance = 1000;
    try {
      const { data: mem } = await sb.from('club_members')
        .select('balance_start').eq('player_id', playerId)
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

// GET /api/host/settlement-reconciliation — read-only balance proof
app.get('/api/host/settlement-reconciliation', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok:false, status:'supabase_not_configured' });
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

    // 5. Mismatches
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

    res.json({ ok:true, clubId:clubId||null, ticketTotals, ledgerTotals,
      settlementPreviewTotals:previewTotals, latestRollover,
      mismatches, status:mismatches.length===0?'balanced':'mismatch' });
  } catch(e) {
    console.error('[reconciliation] error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// GET /api/grade/status — returns last-graded timestamp + recent results
app.get('/api/grade/status', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ enabled:false, reason:'supabase_not_configured' });
  try {
    const { data: recent } = await sb.from('audit_events')
      .select('id,event_type,ticket_id,payload,created_at')
      .eq('event_type','ticket_graded_server')
      .order('created_at',{ ascending:false }).limit(10);
    const { data: active } = await sb.from('tickets')
      .select('id',{ count:'exact' }).in('status',['active','open']);
    res.json({ enabled:true, lastGradedAt: recent&&recent[0] ? recent[0].created_at : null,
      recentGrades: recent||[], activeTicketCount: active ? active.length : 0 });
  } catch(e) { res.status(500).json({ enabled:true, error:e.message }); }
});
// ════════════════════════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  // Init DB after server is bound
  initDB().then(() => console.log('✅ DB ready')).catch(e => console.error('DB init failed:', e.message));
});
