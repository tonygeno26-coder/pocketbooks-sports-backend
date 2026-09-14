'use strict';

/**
 * Feedback / report-issue persistence helpers.
 * Pure validation + identity derivation — isolated from money paths.
 */

const CATEGORIES = Object.freeze(['bug', 'ux', 'odds', 'ticket', 'other']);
const STATUSES = Object.freeze(['new', 'reviewed', 'resolved']);

const MAX_MESSAGE = 1200;
const MAX_PAGE = 120;
const MAX_VIEWPORT = 40;
const MAX_APP_VERSION = 64;
const MAX_TICKET_ID = 128;

/** Persistent actor quota: shared across Railway instances via feedback_reports. */
const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 15 * 60 * 1000;

const SENSITIVE_BODY_KEYS = Object.freeze([
  'token', 'jwt', 'authorization', 'password', 'secret', 'session',
  'accessToken', 'refreshToken', 'cookie', 'cookies', 'Authorization',
  'pb-sports-token', 'pb-session-token'
]);

function isAllowedCategory(category) {
  return CATEGORIES.indexOf(String(category || '')) !== -1;
}

function isAllowedStatus(status) {
  return STATUSES.indexOf(String(status || '')) !== -1;
}

/**
 * Host status triage only — new | reviewed | resolved.
 * Rejects deletes, message edits, and unknown fields.
 */
function validateStatusPatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const allowedKeys = {
    status: 1,
    Status: 1,
    // Scope hints only — ignored for writes; club comes from token.
    clubId: 1,
    club_id: 1
  };
  const keys = Object.keys(b);
  for (let i = 0; i < keys.length; i++) {
    if (!allowedKeys[keys[i]]) {
      return { ok: false, http: 400, error: 'status_only' };
    }
  }
  const status = String(b.status != null ? b.status : '').trim().toLowerCase();
  if (!isAllowedStatus(status)) {
    return { ok: false, http: 400, error: 'invalid_status' };
  }
  return { ok: true, status: status };
}

/**
 * Parse host inbox filters from query. No invented metrics — status/category only.
 */
function parseHostFeedbackQuery(query) {
  const q = query && typeof query === 'object' ? query : {};
  const statusRaw = String(q.status || q.filter || '').trim().toLowerCase();
  let status = null;
  if (statusRaw && statusRaw !== 'all') {
    if (!isAllowedStatus(statusRaw)) {
      return { ok: false, http: 400, error: 'invalid_status' };
    }
    status = statusRaw;
  }

  const categoryRaw = String(q.category || '').trim().toLowerCase();
  let category = null;
  if (categoryRaw && categoryRaw !== 'all') {
    if (!isAllowedCategory(categoryRaw)) {
      return { ok: false, http: 400, error: 'invalid_category' };
    }
    category = categoryRaw;
  }

  const betIssuesRaw = q.betIssues != null ? q.betIssues : q.bet_issues;
  const betIssuesOnly = betIssuesRaw === true
    || betIssuesRaw === 1
    || String(betIssuesRaw || '').toLowerCase() === '1'
    || String(betIssuesRaw || '').toLowerCase() === 'true';

  const search = clip(q.q || q.search || q.query || '', 120) || '';

  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  if (limit > 200) limit = 200;

  return {
    ok: true,
    status: status,
    category: category,
    betIssuesOnly: betIssuesOnly,
    search: search,
    limit: limit
  };
}

/**
 * Public host-facing feedback fields only (no secrets, no financial mutation hooks).
 */
function toHostFeedbackItem(row, extras) {
  const r = row && typeof row === 'object' ? row : {};
  const ticketId = r.ticket_id != null && String(r.ticket_id).trim() !== ''
    ? String(r.ticket_id)
    : null;
  const item = {
    id: r.id != null ? String(r.id) : null,
    playerId: r.player_id != null ? String(r.player_id) : null,
    category: r.category != null ? String(r.category) : null,
    message: r.message != null ? String(r.message) : '',
    ticketId: ticketId,
    page: r.page != null ? String(r.page) : null,
    status: r.status != null ? String(r.status) : 'new',
    createdAt: r.created_at != null ? r.created_at : null,
    isBetIssue: !!ticketId
  };
  if (extras && extras.playerLabel) item.playerLabel = String(extras.playerLabel);
  if (extras && extras.ticket) item.ticket = extras.ticket;
  return item;
}

/**
 * Read-only ticket context for bet-issue reports. Never mutates tickets or money paths.
 */
function toHostTicketContext(ticketRow) {
  if (!ticketRow || ticketRow.id == null) return null;
  return {
    id: String(ticketRow.id),
    status: ticketRow.status != null ? String(ticketRow.status) : null,
    type: ticketRow.type != null ? String(ticketRow.type) : null,
    odds: ticketRow.odds != null ? ticketRow.odds : null,
    riskAmount: ticketRow.risk_amount != null ? Number(ticketRow.risk_amount) : null,
    potentialProfit: ticketRow.potential_profit != null
      ? Number(ticketRow.potential_profit) : null,
    playerId: ticketRow.player_id != null ? String(ticketRow.player_id) : null,
    playerUsername: ticketRow.player_username != null
      ? String(ticketRow.player_username) : null,
    placedAt: ticketRow.placed_at != null ? ticketRow.placed_at : null
  };
}

function matchesHostFeedbackSearch(item, search) {
  const s = String(search || '').trim().toLowerCase();
  if (!s) return true;
  const hay = [
    item.playerId,
    item.playerLabel,
    item.ticketId,
    item.message,
    item.category,
    item.id
  ].map(function (v) { return String(v || '').toLowerCase(); }).join(' ');
  return hay.indexOf(s) !== -1;
}

function summarizeHostFeedbackCounts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = { all: list.length, new: 0, reviewed: 0, resolved: 0, betIssues: 0 };
  for (let i = 0; i < list.length; i++) {
    const st = String((list[i] && list[i].status) || '').toLowerCase();
    if (st === 'new') counts.new++;
    else if (st === 'reviewed') counts.reviewed++;
    else if (st === 'resolved') counts.resolved++;
    if (list[i] && list[i].ticket_id) counts.betIssues++;
  }
  return counts;
}

function clip(str, max) {
  const s = String(str == null ? '' : str).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Derive club/player from authenticated actor only.
 * Client player_id / club_id / role are never trusted for writes.
 */
function deriveIdentity(actor, body) {
  const clientClub = body && (body.clubId || body.club_id);
  const clientPlayer = body && (body.playerId || body.player_id);

  if (!actor || actor.error || !actor.actorId) {
    return {
      ok: false,
      http: (actor && actor.status) || 401,
      error: (actor && actor.error) || 'unauthenticated'
    };
  }

  const playerId = String(actor.actorId);
  const clubId = actor.clubId ? String(actor.clubId) : '';

  if (!clubId) {
    return { ok: false, http: 403, error: 'missing_clubId' };
  }

  // Top-level club spoof only — context.clubId is diagnostic and ignored for writes.
  if (clientClub && String(clientClub) !== clubId) {
    return { ok: false, http: 403, error: 'club_scope_mismatch' };
  }

  return {
    ok: true,
    playerId,
    clubId,
    // Spoofed player ids are ignored (server-derived wins).
    ignoredClientPlayerId: clientPlayer && String(clientPlayer) !== playerId
      ? String(clientPlayer)
      : null
  };
}

/**
 * Validate create payload. Returns { ok, http, error } or normalized row fields.
 */
function validateCreatePayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const ctx = b.context && typeof b.context === 'object' ? b.context : {};

  for (let i = 0; i < SENSITIVE_BODY_KEYS.length; i++) {
    const k = SENSITIVE_BODY_KEYS[i];
    if (b[k] != null || ctx[k] != null) {
      return { ok: false, http: 400, error: 'sensitive_field_rejected' };
    }
  }

  const category = String(b.category || ctx.category || '').trim();
  if (!isAllowedCategory(category)) {
    return { ok: false, http: 400, error: 'invalid_category' };
  }

  const message = String(b.message == null ? '' : b.message).trim();
  if (!message) {
    return { ok: false, http: 400, error: 'message_required' };
  }
  if (message.length > MAX_MESSAGE) {
    return { ok: false, http: 400, error: 'message_too_long' };
  }

  const ticketRaw = b.ticketId || b.ticket_id || ctx.ticketId || ctx.ticket_id || null;
  let ticketId = null;
  if (ticketRaw != null && String(ticketRaw).trim() !== '') {
    ticketId = clip(ticketRaw, MAX_TICKET_ID);
    if (!ticketId || String(ticketRaw).trim().length > MAX_TICKET_ID) {
      return { ok: false, http: 400, error: 'ticket_id_invalid' };
    }
  }

  const page = clip(b.page || ctx.page || ctx.path || '', MAX_PAGE);
  const viewport = clip(b.viewport || ctx.viewport || '', MAX_VIEWPORT);
  const appVersion = clip(b.appVersion || b.app_version || ctx.appVersion || ctx.app_version || '', MAX_APP_VERSION);

  return {
    ok: true,
    category,
    message,
    ticketId,
    page,
    viewport,
    appVersion,
    status: 'new'
  };
}

/**
 * Ticket reference gate: auth user may only reference own ticket in own club.
 * Missing / foreign / cross-club → deny (no enumeration of other clubs' tickets).
 */
function ticketReferenceAllowed(ticketRow, playerId, clubId) {
  if (!ticketRow || !ticketRow.id) {
    return { ok: false, error: 'ticket_not_allowed' };
  }
  if (String(ticketRow.player_id) !== String(playerId)) {
    return { ok: false, error: 'ticket_not_allowed' };
  }
  if (!ticketRow.club_id || String(ticketRow.club_id) !== String(clubId)) {
    return { ok: false, error: 'ticket_not_allowed' };
  }
  return { ok: true };
}

function buildInsertRow(identity, validated, id) {
  return {
    id: id || undefined,
    club_id: identity.clubId,
    player_id: identity.playerId,
    category: validated.category,
    message: validated.message,
    ticket_id: validated.ticketId,
    page: validated.page,
    viewport: validated.viewport,
    app_version: validated.appVersion,
    status: validated.status || 'new'
  };
}

/**
 * Server-derived rate-limit key. Actor id only — never client player/club/IP.
 */
function rateLimitActorKey(playerId) {
  return 'feedback:actor:' + String(playerId || '');
}

function rateLimitWindowStartIso(nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  return new Date(now - RATE_WINDOW_MS).toISOString();
}

function _rowsInWindow(rows, nowMs, windowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const win = typeof windowMs === 'number' ? windowMs : RATE_WINDOW_MS;
  const list = Array.isArray(rows) ? rows : [];
  return list
    .filter(function (r) {
      if (!r || r.created_at == null) return false;
      const t = new Date(r.created_at).getTime();
      return !isNaN(t) && t >= now - win;
    })
    .sort(function (a, b) {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      if (ta !== tb) return ta - tb;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
}

/**
 * Sliding-window decision from existing feedback_reports rows for one actor.
 * rows: [{ id, created_at }, ...] — typically player_id-filtered from DB.
 */
function evaluateActorRateLimit(rows, nowMs, opts) {
  const limit = opts && opts.limit != null ? opts.limit : RATE_LIMIT;
  const windowMs = opts && opts.windowMs != null ? opts.windowMs : RATE_WINDOW_MS;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const inWindow = _rowsInWindow(rows, now, windowMs);
  const count = inWindow.length;
  if (count < limit) {
    return {
      allowed: true,
      count: count,
      remaining: limit - count,
      retryAfterSec: 0,
      limit: limit
    };
  }
  const oldestMs = new Date(inWindow[0].created_at).getTime();
  const retryAfterSec = Math.max(1, Math.ceil((oldestMs + windowMs - now) / 1000));
  return {
    allowed: false,
    count: count,
    remaining: 0,
    retryAfterSec: retryAfterSec,
    limit: limit
  };
}

/**
 * Concurrent burst guard: keep the oldest `limit` rows; accept insert only if kept.
 */
function acceptInsertedUnderLimit(rowsAfter, insertedId, limit) {
  const cap = limit != null ? limit : RATE_LIMIT;
  const list = (Array.isArray(rowsAfter) ? rowsAfter.slice() : []).sort(function (a, b) {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    if (ta !== tb) return ta - tb;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  const keep = list.slice(0, cap);
  const id = String(insertedId);
  for (let i = 0; i < keep.length; i++) {
    if (String(keep[i].id) === id) return true;
  }
  return false;
}

module.exports = {
  CATEGORIES,
  STATUSES,
  MAX_MESSAGE,
  MAX_PAGE,
  MAX_VIEWPORT,
  MAX_APP_VERSION,
  MAX_TICKET_ID,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  isAllowedCategory,
  isAllowedStatus,
  deriveIdentity,
  validateCreatePayload,
  validateStatusPatch,
  parseHostFeedbackQuery,
  toHostFeedbackItem,
  toHostTicketContext,
  matchesHostFeedbackSearch,
  summarizeHostFeedbackCounts,
  ticketReferenceAllowed,
  buildInsertRow,
  rateLimitActorKey,
  rateLimitWindowStartIso,
  evaluateActorRateLimit,
  acceptInsertedUnderLimit
};
