require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, initDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'pocketbooks-sports-secret-2026';

// ===== AUTH MIDDLEWARE =====
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ===== HEALTH =====
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Pocketbooks Sports' }));

// ===== AUTH ROUTES =====

// Sign Up
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  
  try {
    const hashed = await bcrypt.hash(password, 10);
    const startDiamonds = role === 'host' ? 500 : 0;
    const result = await pool.query(
      'INSERT INTO users (email, password, name, role, diamonds) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, diamonds',
      [email.toLowerCase(), hashed, name, role || 'host', startDiamonds]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

// Sign In
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Invalid email or password' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid email or password' });
    
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name, role: user.role, diamonds: user.diamonds } });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get current user
app.get('/api/auth/me', auth, async (req, res) => {
  const result = await pool.query('SELECT id, email, name, role, diamonds, created_at FROM users WHERE id = $1', [req.user.id]);
  res.json(result.rows[0]);
});

// ===== PLAYERS =====

// Get all players for host
app.get('/api/players', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT p.*, 
      CASE WHEN p.total_bets > 0 THEN ROUND((p.wins::float/p.total_bets*100)::numeric,1) ELSE 0 END as win_rate
     FROM players p WHERE p.host_id = $1 ORDER BY p.created_at DESC`,
    [req.user.id]
  );
  res.json(result.rows);
});

// Add player
app.post('/api/players', auth, async (req, res) => {
  const { name, phone, credit_limit, max_bet } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = await pool.query(
    'INSERT INTO players (host_id, name, phone, credit_limit, max_bet) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.user.id, name.toUpperCase(), phone || '', credit_limit || 500, max_bet || 100]
  );
  res.json(result.rows[0]);
});

// Update player
app.patch('/api/players/:id', auth, async (req, res) => {
  const { credit_limit, max_bet, telegram_chat_id } = req.body;
  const result = await pool.query(
    'UPDATE players SET credit_limit=$1, max_bet=$2, telegram_chat_id=$3 WHERE id=$4 AND host_id=$5 RETURNING *',
    [credit_limit, max_bet, telegram_chat_id, req.params.id, req.user.id]
  );
  res.json(result.rows[0]);
});

// Delete player
app.delete('/api/players/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM players WHERE id=$1 AND host_id=$2', [req.params.id, req.user.id]);
  res.json({ success: true });
});

// ===== BETS =====

// Get all bets for host
app.get('/api/bets', auth, async (req, res) => {
  const { player_id, result: betResult, sport, limit = 50 } = req.query;
  let q = 'SELECT b.*, p.name as player_name FROM bets b JOIN players p ON b.player_id = p.id WHERE b.host_id = $1';
  const params = [req.user.id];
  if (player_id) { params.push(player_id); q += ` AND b.player_id = $${params.length}`; }
  if (betResult) { params.push(betResult); q += ` AND b.result = $${params.length}`; }
  if (sport) { params.push(sport); q += ` AND b.sport = $${params.length}`; }
  q += ` ORDER BY b.created_at DESC LIMIT ${parseInt(limit)}`;
  const result = await pool.query(q, params);
  res.json(result.rows);
});

// Log bet
app.post('/api/bets', auth, async (req, res) => {
  const { player_id, game, bet_type, sport, risk, win, line, result: betResult } = req.body;
  if (!player_id || !game || !risk) return res.status(400).json({ error: 'Missing fields' });

  const betRes = await pool.query(
    'INSERT INTO bets (host_id, player_id, game, bet_type, sport, risk, win, line, result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [req.user.id, player_id, game, bet_type || 'Spread', sport || 'NFL', risk, win || risk * 0.909, line || '', betResult || 'pending']
  );
  const bet = betRes.rows[0];

  // Update player stats if result is set
  if (betResult && betResult !== 'pending') {
    await settleBet(bet.id, player_id, betResult, risk, win || risk * 0.909);
  }

  res.json(bet);
});

// Settle bet
app.patch('/api/bets/:id/settle', auth, async (req, res) => {
  const { result: betResult } = req.body;
  const betRes = await pool.query('SELECT * FROM bets WHERE id=$1 AND host_id=$2', [req.params.id, req.user.id]);
  const bet = betRes.rows[0];
  if (!bet) return res.status(404).json({ error: 'Bet not found' });

  await settleBet(bet.id, bet.player_id, betResult, bet.risk, bet.win);
  const updated = await pool.query('SELECT b.*, p.name as player_name FROM bets b JOIN players p ON b.player_id=p.id WHERE b.id=$1', [bet.id]);
  res.json(updated.rows[0]);
});

async function settleBet(betId, playerId, result, risk, win) {
  let balanceChange = 0;
  if (result === 'win') balanceChange = parseFloat(win);
  else if (result === 'loss') balanceChange = -parseFloat(risk);

  await pool.query('UPDATE bets SET result=$1, settled_at=NOW() WHERE id=$2', [result, betId]);
  await pool.query(
    `UPDATE players SET 
      balance = balance + $1,
      total_bets = total_bets + 1,
      wins = wins + $2,
      losses = losses + $3
     WHERE id = $4`,
    [balanceChange, result === 'win' ? 1 : 0, result === 'loss' ? 1 : 0, playerId]
  );
}

// ===== STATS =====
app.get('/api/stats/weekly', auth, async (req, res) => {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_bets,
      SUM(risk) as handle,
      SUM(CASE WHEN result='loss' THEN risk ELSE 0 END) - SUM(CASE WHEN result='win' THEN win ELSE 0 END) as profit,
      COUNT(CASE WHEN result='win' THEN 1 END) as wins,
      COUNT(CASE WHEN result='loss' THEN 1 END) as losses,
      COUNT(CASE WHEN result='pending' THEN 1 END) as pending
    FROM bets 
    WHERE host_id=$1 AND created_at >= NOW() - INTERVAL '7 days'
  `, [req.user.id]);
  
  const stats = result.rows[0];
  const handle = parseFloat(stats.handle) || 0;
  const profit = parseFloat(stats.profit) || 0;
  const holdPct = handle > 0 ? ((profit / handle) * 100).toFixed(1) : 0;
  
  res.json({ ...stats, hold_pct: holdPct });
});

// Sharp detection
app.get('/api/stats/sharp', auth, async (req, res) => {
  const result = await pool.query(`
    SELECT 
      p.id, p.name, p.total_bets, p.wins, p.losses, p.balance,
      CASE WHEN p.total_bets > 0 THEN ROUND((p.wins::float/p.total_bets*100)::numeric,1) ELSE 0 END as win_rate
    FROM players p
    WHERE p.host_id = $1 AND p.total_bets >= 10
    ORDER BY win_rate DESC
  `, [req.user.id]);
  
  const players = result.rows.map(p => ({
    ...p,
    sharp_status: p.win_rate >= 60 ? 'sharp' : p.win_rate >= 52 ? 'watch' : 'square'
  }));
  
  res.json(players);
});

// ===== DIAMONDS =====
app.get('/api/diamonds', auth, async (req, res) => {
  const user = await pool.query('SELECT diamonds FROM users WHERE id=$1', [req.user.id]);
  const txns = await pool.query('SELECT * FROM diamond_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.user.id]);
  res.json({ balance: user.rows[0].diamonds, transactions: txns.rows });
});

// ===== CLUBS =====

function genCode() {
  return Math.random().toString(36).substring(2,8).toUpperCase();
}

// Create club
app.post('/api/clubs', auth, async (req, res) => {
  const { name, description, max_bet, max_parlay } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  let code, attempts = 0;
  while (attempts < 10) {
    code = genCode();
    const exists = await pool.query('SELECT id FROM clubs WHERE code=$1', [code]);
    if (!exists.rows.length) break;
    attempts++;
  }
  const r = await pool.query(
    'INSERT INTO clubs (host_id,name,code,description,max_bet,max_parlay) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.user.id, name, code, description||'', max_bet||500, max_parlay||1000]
  );
  res.json(r.rows[0]);
});

// Get host's clubs
app.get('/api/clubs', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT c.*, COUNT(m.id) as member_count 
     FROM clubs c LEFT JOIN club_memberships m ON c.id=m.club_id 
     WHERE c.host_id=$1 GROUP BY c.id ORDER BY c.created_at DESC`,
    [req.user.id]
  );
  res.json(r.rows);
});

// Get single club
app.get('/api/clubs/:id', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM clubs WHERE id=$1 AND host_id=$2', [req.params.id, req.user.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Club not found' });
  res.json(r.rows[0]);
});

// Update club
app.patch('/api/clubs/:id', auth, async (req, res) => {
  const { name, description, max_bet, max_parlay, is_active } = req.body;
  const r = await pool.query(
    'UPDATE clubs SET name=COALESCE($1,name),description=COALESCE($2,description),max_bet=COALESCE($3,max_bet),max_parlay=COALESCE($4,max_parlay),is_active=COALESCE($5,is_active) WHERE id=$6 AND host_id=$7 RETURNING *',
    [name, description, max_bet, max_parlay, is_active, req.params.id, req.user.id]
  );
  res.json(r.rows[0]);
});

// Delete club
app.delete('/api/clubs/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM clubs WHERE id=$1 AND host_id=$2', [req.params.id, req.user.id]);
  res.json({ success: true });
});

// Get club members
app.get('/api/clubs/:id/members', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT m.*, u.name, u.email,
      CASE WHEN m.total_bets>0 THEN ROUND((m.wins::float/m.total_bets*100)::numeric,1) ELSE 0 END as win_rate
     FROM club_memberships m JOIN users u ON m.player_id=u.id 
     WHERE m.club_id=$1 AND m.host_id=$2 ORDER BY m.joined_at DESC`,
    [req.params.id, req.user.id]
  );
  res.json(r.rows);
});

// Add player to club (by host)
app.post('/api/clubs/:id/members', auth, async (req, res) => {
  const { name, phone, credit_limit, max_bet } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  // Create user account if doesn't exist
  let playerRes = await pool.query('SELECT id FROM users WHERE email=$1', [phone?.toLowerCase() || name.toLowerCase()+'@club.pb']);
  let playerId;
  if (!playerRes.rows.length) {
    const pw = await require('bcryptjs').hash('pb-player-'+Date.now(), 8);
    const newUser = await pool.query(
      'INSERT INTO users (email,password,name,role,diamonds) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [(phone?.toLowerCase()||name.toLowerCase()+'@club.pb'), pw, name.toUpperCase(), 'player', 0]
    );
    playerId = newUser.rows[0].id;
  } else {
    playerId = playerRes.rows[0].id;
  }
  const existing = await pool.query('SELECT id FROM club_memberships WHERE club_id=$1 AND player_id=$2', [req.params.id, playerId]);
  if (existing.rows.length) return res.status(400).json({ error: 'Player already in club' });
  const r = await pool.query(
    'INSERT INTO club_memberships (club_id,player_id,host_id,credit_limit,max_bet) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.params.id, playerId, req.user.id, credit_limit||500, max_bet||100]
  );
  res.json({ ...r.rows[0], name: name.toUpperCase() });
});

// Remove member
app.delete('/api/clubs/:id/members/:memberId', auth, async (req, res) => {
  await pool.query('DELETE FROM club_memberships WHERE id=$1 AND host_id=$2', [req.params.memberId, req.user.id]);
  res.json({ success: true });
});


// Join request (player requests to join by code)
app.post('/api/clubs/request', auth, async (req, res) => {
  const { code } = req.body;
  const club = await pool.query('SELECT * FROM clubs WHERE code=$1 AND is_active=true', [code.toUpperCase()]);
  if (!club.rows.length) return res.status(404).json({ error: 'Club not found' });
  const c = club.rows[0];
  const exists = await pool.query('SELECT id,status FROM club_memberships WHERE club_id=$1 AND player_id=$2', [c.id, req.user.id]);
  if (exists.rows.length) return res.status(400).json({ error: 'Already a member or request pending', status: exists.rows[0].status });
  await pool.query('INSERT INTO club_memberships (club_id,player_id,host_id,status,role) VALUES ($1,$2,$3,$4,$5)',
    [c.id, req.user.id, c.host_id, 'pending', 'player']);
  res.json({ success: true, club: { id: c.id, name: c.name, code: c.code } });
});

// Get pending join requests for host
app.get('/api/clubs/:id/requests', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT m.*, u.name, u.email FROM club_memberships m JOIN users u ON m.player_id=u.id
     WHERE m.club_id=$1 AND m.host_id=$2 AND m.status='pending' ORDER BY m.joined_at DESC`,
    [req.params.id, req.user.id]);
  res.json(r.rows);
});

// Approve/reject request
app.patch('/api/clubs/:id/requests/:memberId', auth, async (req, res) => {
  const { action } = req.body; // 'approve' or 'reject'
  const status = action === 'approve' ? 'approved' : 'rejected';
  const r = await pool.query(
    `UPDATE club_memberships SET status=$1, approved_at=${action==='approve'?'NOW()':'NULL'}
     WHERE id=$2 AND host_id=$3 RETURNING *`,
    [status, req.params.memberId, req.user.id]);
  if (action === 'approve') {
    const m = r.rows[0];
    await pool.query(
      'INSERT INTO player_limits (club_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, m.player_id]);
  }
  res.json(r.rows[0]);
});

// Get/set player limits per club
app.get('/api/clubs/:id/limits/:userId', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM player_limits WHERE club_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
  res.json(r.rows[0] || {});
});

app.put('/api/clubs/:id/limits/:userId', auth, async (req, res) => {
  const { max_bet, max_daily_risk, max_payout, allowed_sports } = req.body;
  const r = await pool.query(
    `INSERT INTO player_limits (club_id,user_id,max_bet,max_daily_risk,max_payout,allowed_sports,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (club_id,user_id) DO UPDATE SET max_bet=$3,max_daily_risk=$4,max_payout=$5,allowed_sports=$6,updated_at=NOW()
     RETURNING *`,
    [req.params.id, req.params.userId, max_bet||100, max_daily_risk||500, max_payout||2000, allowed_sports||['MLB','NBA','NFL','NHL']]);
  res.json(r.rows[0]);
});

// Search club by code (public)
app.get('/api/clubs/search/:code', async (req, res) => {
  const r = await pool.query('SELECT id,name,code,description FROM clubs WHERE code=$1 AND is_active=true', [req.params.code.toUpperCase()]);
  if (!r.rows.length) return res.status(404).json({ error: 'Club not found' });
  res.json(r.rows[0]);
});

// Check bet eligibility (player must be approved in club)
app.get('/api/clubs/:id/eligibility', auth, async (req, res) => {
  const r = await pool.query('SELECT status FROM club_memberships WHERE club_id=$1 AND player_id=$2', [req.params.id, req.user.id]);
  if (!r.rows.length) return res.json({ eligible: false, reason: 'Not a member' });
  if (r.rows[0].status !== 'approved') return res.json({ eligible: false, reason: r.rows[0].status === 'pending' ? 'Pending approval' : 'Access denied' });
  res.json({ eligible: true });
});

// Join club by code (player)
app.post('/api/clubs/join', auth, async (req, res) => {
  const { code } = req.body;
  const club = await pool.query('SELECT * FROM clubs WHERE code=$1 AND is_active=true', [code.toUpperCase()]);
  if (!club.rows.length) return res.status(404).json({ error: 'Club not found or inactive' });
  const c = club.rows[0];
  const exists = await pool.query('SELECT id FROM club_memberships WHERE club_id=$1 AND player_id=$2', [c.id, req.user.id]);
  if (exists.rows.length) return res.status(400).json({ error: 'Already a member' });
  await pool.query(
    'INSERT INTO club_memberships (club_id,player_id,host_id) VALUES ($1,$2,$3)',
    [c.id, req.user.id, c.host_id]
  );
  res.json({ success: true, club: c });
});

// Get player's clubs
app.get('/api/my-clubs', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT c.*, m.balance, m.credit_limit, m.max_bet, m.total_bets, m.wins, m.losses, m.id as membership_id
     FROM club_memberships m JOIN clubs c ON m.club_id=c.id 
     WHERE m.player_id=$1 ORDER BY m.joined_at DESC`,
    [req.user.id]
  );
  res.json(r.rows);
});

// Get club bets
app.get('/api/clubs/:id/bets', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT b.*, u.name as player_name FROM bets b 
     LEFT JOIN users u ON b.player_id=u.id
     WHERE b.club_id=$1 AND b.host_id=$2 ORDER BY b.created_at DESC LIMIT 50`,
    [req.params.id, req.user.id]
  );
  res.json(r.rows);
});

// ===== ODDS =====
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const https = require('https');

function fetchOdds(sport) {
  return new Promise((resolve, reject) => {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=spreads,totals,h2h&oddsFormat=american&bookmakers=draftkings`;
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve([]); }
      });
    }).on('error', reject);
  });
}

app.get('/api/odds/:sport', async (req, res) => {
  const sportMap = {
    'nfl': 'americanfootball_nfl',
    'nba': 'basketball_nba',
    'mlb': 'baseball_mlb',
    'nhl': 'icehockey_nhl',
    'soccer': 'soccer_usa_mls',
    'ncaaf': 'americanfootball_ncaaf',
    'ufl': 'americanfootball_ufl',
  };
  const sport = sportMap[req.params.sport] || req.params.sport;
  try {
    const games = await fetchOdds(sport);
    const formatted = games.slice(0, 20).map(g => {
      const bm = g.bookmakers?.[0];
      const spreads = bm?.markets?.find(m => m.key === 'spreads')?.outcomes || [];
      const totals = bm?.markets?.find(m => m.key === 'totals')?.outcomes || [];
      const h2h = bm?.markets?.find(m => m.key === 'h2h')?.outcomes || [];
      return {
        id: g.id,
        sport: req.params.sport.toUpperCase(),
        home: g.home_team,
        away: g.away_team,
        time: g.commence_time,
        spreads: spreads.map(o => ({ team: o.name, line: o.point, odds: o.price })),
        totals: totals.map(o => ({ name: o.name, line: o.point, odds: o.price })),
        moneyline: h2h.map(o => ({ team: o.name, odds: o.price }))
      };
    });
    res.json(formatted);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/odds', async (req, res) => {
  // Get games from all active sports
  const sports = ['baseball_mlb', 'basketball_nba', 'icehockey_nhl', 'americanfootball_ufl'];
  try {
    const results = await Promise.all(sports.map(s => fetchOdds(s).catch(() => [])));
    const all = results.flat().slice(0, 30).map(g => {
      const bm = g.bookmakers?.[0];
      const spreads = bm?.markets?.find(m => m.key === 'spreads')?.outcomes || [];
      const totals = bm?.markets?.find(m => m.key === 'totals')?.outcomes || [];
      const h2h = bm?.markets?.find(m => m.key === 'h2h')?.outcomes || [];
      return {
        id: g.id, sport: g.sport_title || g.sport_key,
        home: g.home_team, away: g.away_team, time: g.commence_time,
        spreads: spreads.map(o => ({ team: o.name, line: o.point, odds: o.price })),
        totals: totals.map(o => ({ name: o.name, line: o.point, odds: o.price })),
        moneyline: h2h.map(o => ({ team: o.name, odds: o.price }))
      };
    });
    res.json(all);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== START =====
const PORT = process.env.PORT || 3001;
(async () => {
  // Start server first, then try DB
  app.listen(PORT, () => console.log(`💎 Pocketbooks Sports Backend running on port ${PORT}`));
  try {
    await initDB();
    console.log('✅ Ready!');
  } catch(e) {
    console.error('DB init error (server still running):', e.message);
    console.error('DATABASE_URL set:', !!process.env.DATABASE_URL);
    console.error('DATABASE_URL starts with:', process.env.DATABASE_URL?.slice(0,30));
  }
})();
