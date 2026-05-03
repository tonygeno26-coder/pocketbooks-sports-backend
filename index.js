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

// ===== START =====
const PORT = process.env.PORT || 3001;
(async () => {
  try {
    await initDB();
    app.listen(PORT, () => console.log(`💎 Pocketbooks Sports Backend running on port ${PORT}`));
  } catch(e) {
    console.error('Startup error:', e);
    process.exit(1);
  }
})();
