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

app.post('/api/grade/run', async (req, res) => {
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
