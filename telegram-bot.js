'use strict';

const crypto = require('crypto');

const TZ = 'America/New_York';
const WEBHOOK_PATH = '/api/survivor/telegram/webhook';
const DEFAULT_PUBLIC_BASE = 'https://pocketbooks-sports-backend-production.up.railway.app';
const PICK_URL = 'pocketbookssports.com/survivor.html';
const WED_DOW = 3;
const SUN_DOW = 0;

let _sb = null;
const pendingConfirm = new Map(); // chatId -> { playerId, username } | { choices }
const linkCodes = new Map(); // code -> { playerId, username, expires }
const _firedKeys = new Set();

function botToken() {
  return String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

function webhookSecret() {
  return String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
}

function publicBaseUrl() {
  const raw = String(
    process.env.TELEGRAM_PUBLIC_URL ||
    process.env.PUBLIC_URL ||
    DEFAULT_PUBLIC_BASE
  ).trim();
  return raw.replace(/\/$/, '');
}

function getSb() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    _sb = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  } catch (e) {
    console.warn('[telegram] supabase init failed:', e.message);
    return null;
  }
  return _sb;
}

function escapeIlike(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function maskChatId(chatId) {
  const s = String(chatId || '');
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

function randomCode() {
  return crypto.randomBytes(4).toString('hex');
}

function entryNum(row) {
  const n = parseInt(row && (row.entry_number != null ? row.entry_number : row.entryNumber), 10);
  return n > 0 ? n : 1;
}

async function tgApi(method, body) {
  const token = botToken();
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN missing' };
  const url = 'https://api.telegram.org/bot' + token + '/' + method;
  let json = { ok: false };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    json = await res.json();
  } catch (e) {
    console.warn('[telegram] ' + method + ' network error:', e.message);
    return { ok: false, description: 'network_error' };
  }
  if (!json.ok) {
    console.warn('[telegram] ' + method + ' failed:', json.description || 'unknown');
  }
  return json;
}

function sendMessage(chatId, text) {
  return tgApi('sendMessage', {
    chat_id: chatId,
    text: String(text),
    disable_web_page_preview: true
  });
}

function etParts(ms) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = dtf.formatToParts(new Date(ms));
  const get = function(t) {
    return (parts.find(function(p) { return p.type === t; }) || {}).value;
  };
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  return {
    dow: wd[get('weekday')],
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: hour || 0,
    minute: parseInt(get('minute'), 10) || 0,
    second: parseInt(get('second'), 10) || 0
  };
}

function zonedToUtc(year, month, day, hour, minute) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 5; i++) {
    const p = etParts(utc);
    const asIf = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
    utc += wanted - asIf;
  }
  return utc;
}

function addCalendarDays(year, month, day, days) {
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

function nextOccurrenceMs(targetDow, targetHour, targetMinute, nowMs) {
  const now = nowMs || Date.now();
  const p = etParts(now);
  let days = (targetDow - p.dow + 7) % 7;
  if (days === 0 && (p.hour > targetHour || (p.hour === targetHour && p.minute >= targetMinute))) {
    days = 7;
  }
  const cal = addCalendarDays(p.year, p.month, p.day, days);
  return zonedToUtc(cal.year, cal.month, cal.day, targetHour, targetMinute);
}

function scheduleWeekly(name, dow, hour, minute, fn) {
  function arm() {
    const next = nextOccurrenceMs(dow, hour, minute);
    const delay = Math.max(1000, next - Date.now());
    console.log('[telegram] next ' + name + ' in ' + Math.round(delay / 60000) + ' min (' + TZ + ')');
    setTimeout(function() {
      const key = name + ':' + etParts(Date.now()).year + '-' + etParts(Date.now()).month + '-' + etParts(Date.now()).day;
      if (!_firedKeys.has(key)) {
        _firedKeys.add(key);
        Promise.resolve(fn()).catch(function(e) {
          console.warn('[telegram] ' + name + ' failed:', e && e.message);
        });
      }
      arm();
    }, delay);
  }
  arm();
}

async function findAccountsByUsername(sb, raw) {
  const uname = String(raw || '').trim();
  if (!uname || uname.length > 64) return [];
  const seen = Object.create(null);
  const out = [];
  function add(id, username) {
    if (!id) return;
    const key = String(id);
    if (seen[key]) return;
    seen[key] = true;
    out.push({ playerId: key, username: username || uname });
  }
  const needle = escapeIlike(uname);
  const { data: users, error: uErr } = await sb.from('users')
    .select('id,username')
    .ilike('username', needle);
  if (uErr) throw uErr;
  (users || []).forEach(function(u) { add(u.id, u.username); });
  const { data: entries, error: eErr } = await sb.from('survivor_entries')
    .select('player_id,player_username')
    .ilike('player_username', needle);
  if (eErr) throw eErr;
  (entries || []).forEach(function(e) { add(e.player_id, e.player_username); });
  return out;
}

async function linkChat(sb, playerId, username, chatId) {
  const pid = String(playerId);
  const cid = String(chatId);
  await sb.from('telegram_links').delete().eq('chat_id', cid).neq('player_id', pid);
  const { error } = await sb.from('telegram_links').upsert({
    player_id: pid,
    username: String(username || ''),
    chat_id: cid,
    linked_at: new Date().toISOString()
  }, { onConflict: 'player_id' });
  if (error) throw error;
}

function consumeLinkCode(payload) {
  const key = String(payload || '').trim().toLowerCase();
  if (!key) return null;
  const row = linkCodes.get(key);
  if (!row || row.expires < Date.now()) {
    if (row) linkCodes.delete(key);
    return null;
  }
  linkCodes.delete(key);
  return row;
}

async function handleStart(sb, chatId, payload) {
  const help =
    'Link your Pocketbooks Sports account by sending:\n' +
    '/start YourUsername\n\n' +
    'Or send /start with the one-time code shown on the survivor page.';
  if (!payload) {
    await sendMessage(chatId, help);
    return;
  }
  const codeHit = consumeLinkCode(payload);
  if (codeHit) {
    await linkChat(sb, codeHit.playerId, codeHit.username, chatId);
    await sendMessage(chatId, 'Linked to ' + (codeHit.username || 'your account') + '. You will get survivor pick reminders here.');
    return;
  }
  const matches = await findAccountsByUsername(sb, payload);
  if (!matches.length) {
    await sendMessage(chatId, 'No account found for "' + payload + '". Send /start YourUsername exactly as it appears on Pocketbooks Sports.');
    return;
  }
  if (matches.length === 1) {
    await linkChat(sb, matches[0].playerId, matches[0].username, chatId);
    await sendMessage(chatId, 'Linked to ' + matches[0].username + '. You will get survivor pick reminders here.');
    return;
  }
  pendingConfirm.set(String(chatId), {
    choices: matches.slice(0, 8),
    expires: Date.now() + 10 * 60 * 1000
  });
  const lines = matches.slice(0, 8).map(function(m, i) {
    return (i + 1) + '. ' + m.username;
  });
  await sendMessage(chatId,
    'Multiple accounts matched "' + payload + '". Reply /confirm 1 (or the matching number):\n' +
    lines.join('\n'));
}

async function handleConfirm(sb, chatId, arg) {
  const p = pendingConfirm.get(String(chatId));
  if (!p || p.expires < Date.now()) {
    pendingConfirm.delete(String(chatId));
    await sendMessage(chatId, 'Nothing to confirm. Send /start YourUsername first.');
    return;
  }
  if (!p.choices || !p.choices.length) {
    pendingConfirm.delete(String(chatId));
    await sendMessage(chatId, 'Nothing to confirm. Send /start YourUsername first.');
    return;
  }
  const n = parseInt(arg, 10);
  if (!n || n < 1 || n > p.choices.length) {
    await sendMessage(chatId, 'Reply /confirm with a number from the list.');
    return;
  }
  const chosen = p.choices[n - 1];
  pendingConfirm.delete(String(chatId));
  await linkChat(sb, chosen.playerId, chosen.username, chatId);
  await sendMessage(chatId, 'Linked to ' + chosen.username + '. You will get survivor pick reminders here.');
}

async function processUpdate(update) {
  const msg = update && (update.message || update.edited_message);
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();
  const sb = getSb();
  if (!sb) {
    await sendMessage(chatId, 'Bot is not fully configured. Try again later.');
    return;
  }
  const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  if (startMatch) {
    await handleStart(sb, chatId, (startMatch[1] || '').trim());
    return;
  }
  const confirmMatch = text.match(/^\/confirm(?:@\w+)?(?:\s+(.+))?$/i);
  if (confirmMatch) {
    await handleConfirm(sb, chatId, (confirmMatch[1] || '').trim());
    return;
  }
  if (/^\/help(?:@\w+)?$/i.test(text)) {
    await sendMessage(chatId, 'Send /start YourUsername to link your account for survivor pick reminders.');
  }
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyWebhook(req) {
  const secret = webhookSecret();
  const header = req.headers && (req.headers['x-telegram-bot-api-secret-token'] || '');
  if (secret) return timingSafeEqualStr(header, secret);
  const u = req.body;
  if (!u || typeof u !== 'object' || typeof u.update_id !== 'number') return false;
  if (!u.message && !u.edited_message && !u.callback_query && !u.my_chat_member) return false;
  return true;
}

function handleWebhook(req, res) {
  if (!verifyWebhook(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  res.status(200).json({ ok: true });
  Promise.resolve(processUpdate(req.body)).catch(function(e) {
    console.warn('[telegram] update failed:', e && e.message);
  });
}

async function handleLinkStatus(req, res, actor) {
  const sb = getSb();
  if (!sb) return res.status(503).json({ ok: false, error: 'supabase_not_configured' });
  const playerId = String(actor.actorId);
  try {
    const { data, error } = await sb.from('telegram_links')
      .select('chat_id,username')
      .eq('player_id', playerId)
      .maybeSingle();
    if (error) throw error;
    if (data && data.chat_id) {
      return res.json({ ok: true, linked: true, chatIdMasked: maskChatId(data.chat_id) });
    }
    let username = '';
    try {
      const u = await sb.from('users').select('username').eq('id', playerId).maybeSingle();
      username = (u.data && u.data.username) || '';
    } catch (_e) {}
    const code = randomCode();
    linkCodes.set(code, {
      playerId: playerId,
      username: username,
      expires: Date.now() + 30 * 60 * 1000
    });
    return res.json({
      ok: true,
      linked: false,
      linkCode: code,
      startCommand: '/start ' + code
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

async function playersMissingPicks() {
  const sb = getSb();
  if (!sb) return [];
  const { data: pools, error } = await sb.from('survivor_pools')
    .select('id,current_week,status')
    .eq('status', 'active');
  if (error) throw error;
  const out = [];
  const seen = Object.create(null);
  for (let i = 0; i < (pools || []).length; i++) {
    const pool = pools[i];
    const week = pool.current_week;
    const { data: entries, error: eErr } = await sb.from('survivor_entries')
      .select('player_id,entry_number')
      .eq('pool_id', pool.id)
      .eq('status', 'alive');
    if (eErr) throw eErr;
    if (!entries || !entries.length) continue;
    const { data: picks, error: pErr } = await sb.from('survivor_picks')
      .select('player_id,entry_number')
      .eq('pool_id', pool.id)
      .eq('week', week);
    if (pErr) throw pErr;
    const picked = Object.create(null);
    (picks || []).forEach(function(p) {
      picked[String(p.player_id) + ':' + entryNum(p)] = true;
    });
    const missingIds = [];
    const missingSet = Object.create(null);
    (entries || []).forEach(function(e) {
      const pid = String(e.player_id);
      if (picked[pid + ':' + entryNum(e)]) return;
      if (missingSet[pid]) return;
      missingSet[pid] = true;
      missingIds.push(pid);
    });
    if (!missingIds.length) continue;
    const { data: links, error: lErr } = await sb.from('telegram_links')
      .select('player_id,chat_id')
      .in('player_id', missingIds);
    if (lErr) throw lErr;
    (links || []).forEach(function(l) {
      const key = String(l.chat_id) + ':' + week;
      if (seen[key]) return;
      seen[key] = true;
      out.push({ chatId: l.chat_id, week: week });
    });
  }
  return out;
}

async function sendPickReminders(isFinal) {
  const targets = await playersMissingPicks();
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const text = isFinal
      ? ('⚠️ Week ' + t.week + ' picks close in 2 hours (1PM ET) — make your pick at ' + PICK_URL)
      : ('⚠️ Week ' + t.week + ' picks are open — make your pick before Sunday 1PM ET at ' + PICK_URL);
    await sendMessage(t.chatId, text);
  }
  console.log('[telegram] sent ' + targets.length + (isFinal ? ' final' : ' open') + ' reminders');
}

async function notifySurvivorGrade(args) {
  const playerId = args && args.playerId;
  const week = args && args.week;
  const team = args && args.team;
  const won = !!(args && args.won);
  if (!playerId) return;
  try {
    const sb = getSb();
    if (!sb) return;
    const { data, error } = await sb.from('telegram_links')
      .select('chat_id')
      .eq('player_id', String(playerId))
      .maybeSingle();
    if (error || !data || !data.chat_id) return;
    let text;
    if (!team && !won) {
      text = '❌ Week ' + week + ': no pick — you have been eliminated.';
    } else if (won) {
      text = '✅ Week ' + week + ': ' + team + ' won — you are still alive.';
    } else {
      text = '❌ Week ' + week + ': ' + team + ' lost — you have been eliminated.';
    }
    await sendMessage(data.chat_id, text);
  } catch (e) {
    console.warn('[telegram] grade notify failed:', e && e.message);
  }
}

async function maybeSetWebhook() {
  const token = botToken();
  if (!token) return;
  const url = publicBaseUrl() + WEBHOOK_PATH;
  const body = { url: url };
  const secret = webhookSecret();
  if (secret) body.secret_token = secret;
  const r = await tgApi('setWebhook', body);
  if (r && r.ok) console.log('[telegram] webhook registered');
  else console.warn('[telegram] setWebhook did not succeed — set TELEGRAM_BOT_TOKEN and call setWebhook (see startup notes)');
}

function logMissingTokenHelp() {
  console.warn('[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled.');
  console.warn('[telegram] Create a bot with @BotFather, then set Railway var TELEGRAM_BOT_TOKEN on service pocketbooks-sports-backend (perceptive-youthfulness). Optional: TELEGRAM_WEBHOOK_SECRET.');
  console.warn('[telegram] Then set the webhook (replace TOKEN and SECRET, do not commit them):');
  console.warn('[telegram]   curl -sS -X POST "https://api.telegram.org/botTOKEN/setWebhook" -H "Content-Type: application/json" -d \'{"url":"https://pocketbooks-sports-backend-production.up.railway.app/api/survivor/telegram/webhook","secret_token":"SECRET"}\'');
}

function startTelegramBot() {
  if (!botToken()) {
    logMissingTokenHelp();
    return;
  }
  console.log('[telegram] token present — starting schedulers (' + TZ + ')');
  scheduleWeekly('wed-open', WED_DOW, 10, 0, function() { return sendPickReminders(false); });
  scheduleWeekly('sun-final', SUN_DOW, 11, 0, function() { return sendPickReminders(true); });
  maybeSetWebhook().catch(function(e) {
    console.warn('[telegram] setWebhook error:', e && e.message);
  });
}

module.exports = {
  startTelegramBot,
  handleWebhook,
  handleLinkStatus,
  notifySurvivorGrade
};
