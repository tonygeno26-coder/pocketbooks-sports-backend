'use strict';
/**
 * Bet-placement idempotency engine — scoped (club_id, player_id, client_key).
 *
 * LEDGER ID SCOPING DECISION (documented for owner apply gate):
 *   New money writes use scoped ledger id:
 *     IK_<sha256(club_id|player_id|client_key).hex[0:40]>
 *   Dual-read on expire/replay: scoped id first, then bare client_key (legacy)
 *   with club_id+player_id match required on bare hit.
 *   Rationale: closes cross-club bare-key collision on ledger_entries.id UNIQUE
 *   without requiring an immediate ledger rewrite migration. FE sticky key remains
 *   the client_key at the HTTP layer; RPC p_idempotency_key becomes the scoped id.
 *
 * Dual-mode store:
 *   - Detects legacy (idempotency_key PK) vs scoped (club,player,client_key PK)
 *     vs dual (both column sets during migration) vs missing (no table yet).
 *   - Money paths: durable store REQUIRED. Missing table → 503 fail-closed.
 *     Application mutex / process-local mem is NOT sufficient for money
 *     (multi-instance split-brain). Mem is tests + non-money optional only.
 *   - Non-money optional: mem fallback allowed.
 *
 * Reservation: INSERT … ON CONFLICT equivalent (insert-if-absent; loser re-reads).
 * Status: processing | completed | failed (legacy pending ≡ processing).
 * Expired: ledger replay else 400 idempotency_key_expired (never silent re-place).
 * Stale processing: ledger replay else reclaim same scope (no second ticket).
 */

const crypto = require('crypto');

const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const RETENTION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Stale in-flight reclaim window — crash/restart without second ticket. */
const STALE_PROCESSING_MS = 30 * 1000;
const LEDGER_ID_SCOPING = 'scoped_hash_v1';

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce(function (acc, k) {
      acc[k] = sortKeys(obj[k]);
      return acc;
    }, {});
  }
  return obj;
}

function hashRequest(endpoint, actorId, clubId, body) {
  const canonical = JSON.stringify({
    endpoint: endpoint,
    actorId: actorId,
    clubId: clubId || '',
    body: sortKeys(body || {})
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function _scopeDigest(clubId, playerId, clientKey) {
  return crypto
    .createHash('sha256')
    .update(String(clubId || '') + '|' + String(playerId || '') + '|' + String(clientKey || ''))
    .digest('hex');
}

/** Deterministic ticket id — same scope always yields same ticket_id. */
function deterministicTicketId(clubId, playerId, clientKey) {
  return 'T_' + _scopeDigest(clubId, playerId, clientKey).slice(0, 24);
}

/** Deterministic Round Robin group id. */
function deterministicRrGroupId(clubId, playerId, clientKey) {
  return 'RRG_' + _scopeDigest(clubId, playerId, clientKey).slice(0, 24);
}

/**
 * Scoped ledger entry id for money RPCs (place_bet_tx / place_rr_tx).
 * Distinct from HTTP Idempotency-Key (client_key).
 */
function scopedLedgerId(clubId, playerId, clientKey) {
  return 'IK_' + _scopeDigest(clubId, playerId, clientKey).slice(0, 40);
}

function memStoreKey(clubId, playerId, clientKey) {
  return String(clubId || '') + '\0' + String(playerId || '') + '\0' + String(clientKey || '');
}

function isInProgressStatus(status) {
  return status === 'processing' || status === 'pending';
}

function normalizeRow(row, clientKey, clubId, playerId) {
  if (!row) return null;
  return {
    idempotency_key: row.idempotency_key || row.client_key || clientKey,
    client_key: row.client_key || row.idempotency_key || clientKey,
    actor_id: row.actor_id || row.player_id || playerId || '',
    player_id: row.player_id || row.actor_id || playerId || '',
    club_id: row.club_id != null ? row.club_id : (clubId || ''),
    endpoint: row.endpoint,
    request_hash: row.request_hash,
    status: row.status,
    response_status: row.response_status,
    response_body: row.response_body,
    ticket_id: row.ticket_id || null,
    created_at: row.created_at,
    completed_at: row.completed_at,
    expires_at: row.expires_at
  };
}

function buildPendingRow(scope, endpoint, reqHash, nowMs) {
  const expires = new Date(nowMs + KEY_TTL_MS).toISOString();
  const created = new Date(nowMs).toISOString();
  return {
    idempotency_key: scope.clientKey,
    client_key: scope.clientKey,
    actor_id: scope.playerId || scope.actorId || '',
    player_id: scope.playerId || scope.actorId || '',
    club_id: scope.clubId || '',
    endpoint: endpoint,
    request_hash: reqHash,
    status: 'processing',
    response_status: null,
    response_body: null,
    ticket_id: null,
    created_at: created,
    completed_at: null,
    expires_at: expires
  };
}

/**
 * Evaluate an existing row (pure). ledgerExists: boolean from caller.
 * Returns action object.
 */
function evaluateExisting(existing, opts) {
  const actorId = opts.actorId;
  const clubId = opts.clubId || '';
  const playerId = opts.playerId || actorId || '';
  const reqHash = opts.reqHash;
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const ledgerExists = !!opts.ledgerExists;
  const staleMs = opts.staleProcessingMs != null ? opts.staleProcessingMs : STALE_PROCESSING_MS;

  if (!existing) return { action: 'reserve' };

  const expired = existing.expires_at && nowMs > new Date(existing.expires_at).getTime();
  if (expired) {
    if (ledgerExists) {
      return {
        action: 'replay',
        reason: 'expired_ledger_replay',
        existingRow: existing,
        fromLedger: true
      };
    }
    return {
      action: 'expired',
      status: 400,
      error: 'idempotency_key_expired',
      hint: 'Key TTL elapsed with no ledger; mint a new Idempotency-Key deliberately.'
    };
  }

  const rowPlayer = existing.player_id || existing.actor_id || '';
  const rowActor = existing.actor_id || existing.player_id || '';
  if (rowPlayer && playerId && rowPlayer !== playerId && rowActor !== actorId) {
    return { action: 'conflict', reason: 'actor_mismatch', status: 409 };
  }
  if (existing.actor_id && actorId && existing.actor_id !== actorId &&
      existing.player_id && existing.player_id !== playerId) {
    return { action: 'conflict', reason: 'actor_mismatch', status: 409 };
  }
  if ((existing.club_id || '') !== clubId) {
    return { action: 'conflict', reason: 'club_mismatch', status: 409 };
  }
  if (existing.request_hash !== reqHash) {
    return { action: 'conflict', reason: 'body_mismatch', status: 409 };
  }
  if (isInProgressStatus(existing.status)) {
    const createdMs = existing.created_at ? new Date(existing.created_at).getTime() : 0;
    const isStale = createdMs > 0 && (nowMs - createdMs) > staleMs;
    if (isStale) {
      if (ledgerExists) {
        return {
          action: 'replay',
          reason: 'stale_processing_ledger_replay',
          existingRow: existing,
          fromLedger: true
        };
      }
      // Reclaim same reserved scope — deterministic ticket + ledger UNIQUE
      // prevent a second money write if the first attempt actually posted.
      return { action: 'reclaim', reason: 'stale_processing', existingRow: existing };
    }
    return { action: 'in_progress', status: 409, existingRow: existing };
  }
  return { action: 'replay', existingRow: existing };
}

/**
 * In-memory store used for unit tests and non-money optional fallback.
 * Supports insert-if-absent with a mutex map for concurrent simulation.
 * NOT durable primary for money across instances.
 */
function createMemStore() {
  const map = new Map();
  const locks = new Map();

  async function withLock(key, fn) {
    while (locks.get(key)) {
      await locks.get(key);
    }
    let release;
    const p = new Promise(function (r) { release = r; });
    locks.set(key, p);
    try {
      return await fn();
    } finally {
      locks.delete(key);
      release();
    }
  }

  return {
    kind: 'mem',
    async load(scope) {
      return map.get(memStoreKey(scope.clubId, scope.playerId, scope.clientKey)) || null;
    },
    async insertIfAbsent(scope, row) {
      const k = memStoreKey(scope.clubId, scope.playerId, scope.clientKey);
      return withLock(k, async function () {
        if (map.has(k)) return { won: false, row: map.get(k) };
        map.set(k, row);
        return { won: true, row: row };
      });
    },
    async save(scope, row) {
      map.set(memStoreKey(scope.clubId, scope.playerId, scope.clientKey), row);
    },
    async deleteExpired(cutoffIso) {
      let n = 0;
      for (const [k, row] of map.entries()) {
        if (row.expires_at && row.expires_at < cutoffIso) {
          map.delete(k);
          n++;
        }
      }
      return n;
    },
    _map: map
  };
}

/**
 * Shared unique-constraint store for concurrent / multi-instance sims.
 * Emulates PRIMARY KEY (club_id, player_id, client_key) with optional latency.
 * Application mutex alone is insufficient — this models DB uniqueness.
 */
function createUniqueDbSimStore(opts) {
  opts = opts || {};
  const shared = opts.sharedMap || new Map();
  const latencyMs = opts.latencyMs || 0;
  const instanceId = opts.instanceId || 'inst';

  async function delay() {
    if (!latencyMs) return;
    await new Promise(function (r) {
      setTimeout(r, typeof latencyMs === 'function' ? latencyMs() : latencyMs);
    });
  }

  return {
    kind: 'db_sim',
    instanceId: instanceId,
    _map: shared,
    async ensureSchema() {
      return 'scoped';
    },
    async load(scope) {
      await delay();
      const row = shared.get(memStoreKey(scope.clubId, scope.playerId, scope.clientKey));
      return row ? normalizeRow(row, scope.clientKey, scope.clubId, scope.playerId) : null;
    },
    async insertIfAbsent(scope, row) {
      await delay();
      const k = memStoreKey(scope.clubId, scope.playerId, scope.clientKey);
      // Atomic check-and-set on shared map (single-threaded JS event loop =
      // serialized uniqueness like a DB unique index under one connection pool;
      // concurrent awaits around delay still race into this critical section).
      if (shared.has(k)) {
        return { won: false, row: shared.get(k) };
      }
      shared.set(k, Object.assign({}, row));
      return { won: true, row: row };
    },
    async save(scope, row) {
      await delay();
      shared.set(memStoreKey(scope.clubId, scope.playerId, scope.clientKey), Object.assign({}, row));
    },
    async deleteExpired(cutoffIso) {
      let n = 0;
      for (const [k, row] of shared.entries()) {
        if (row.expires_at && row.expires_at < cutoffIso) {
          shared.delete(k);
          n++;
        }
      }
      return n;
    }
  };
}

function isUniqueViolation(err) {
  if (!err) return false;
  const code = err.code || (err.details && err.details.code);
  if (code === '23505') return true;
  const msg = String(err.message || err.error_description || '');
  return /duplicate key|unique constraint|already exists/i.test(msg);
}

function isMissingRelation(err) {
  if (!err) return false;
  const code = err.code;
  if (code === '42P01') return true;
  const msg = String(err.message || '');
  return /relation .* does not exist|Could not find the table/i.test(msg);
}

function isMissingColumn(err, col) {
  if (!err) return false;
  const msg = String(err.message || '');
  if (col) return new RegExp(col, 'i').test(msg) && /column|schema cache/i.test(msg);
  return /column .* does not exist|schema cache/i.test(msg);
}

/**
 * Create a Supabase-backed dual-read/write store.
 * schemaMode: 'legacy' | 'scoped' | 'dual' | 'missing' | null (auto-detect)
 */
function createSupabaseStore(getSupabase, opts) {
  opts = opts || {};
  let schemaMode = opts.schemaMode || null; // cached after probe
  const memShadow = opts.memShadow || createMemStore(); // secondary cache only — never money primary

  async function probeSchema(sb) {
    if (schemaMode) return schemaMode;
    const r = await sb.from('idempotency_keys').select('client_key,player_id,idempotency_key').limit(1);
    if (r.error) {
      if (isMissingRelation(r.error)) {
        schemaMode = 'missing';
        return schemaMode;
      }
      // Column probe: try narrower selects
      const legacy = await sb.from('idempotency_keys').select('idempotency_key').limit(1);
      if (!legacy.error) {
        schemaMode = 'legacy';
        return schemaMode;
      }
      if (isMissingRelation(legacy.error)) {
        schemaMode = 'missing';
        return schemaMode;
      }
      const scoped = await sb.from('idempotency_keys').select('client_key,player_id,club_id').limit(1);
      if (!scoped.error) {
        schemaMode = 'scoped';
        return schemaMode;
      }
      schemaMode = 'missing';
      return schemaMode;
    }
    // Both column families present in select → dual or scoped-with-legacy-col
    const hasLegacy = r.data && r.data[0] && Object.prototype.hasOwnProperty.call(r.data[0], 'idempotency_key');
    // Empty table: check by attempting to infer from error-free select of both
    const bothOk = await sb.from('idempotency_keys').select('idempotency_key,client_key').limit(1);
    if (!bothOk.error) {
      schemaMode = 'dual';
    } else if (isMissingColumn(bothOk.error, 'idempotency_key')) {
      schemaMode = 'scoped';
    } else if (isMissingColumn(bothOk.error, 'client_key')) {
      schemaMode = 'legacy';
    } else {
      schemaMode = hasLegacy ? 'dual' : 'scoped';
    }
    return schemaMode;
  }

  function rowForWrite(mode, row) {
    if (mode === 'scoped') {
      return {
        club_id: row.club_id,
        player_id: row.player_id,
        client_key: row.client_key || row.idempotency_key,
        endpoint: row.endpoint,
        request_hash: row.request_hash,
        status: row.status,
        response_status: row.response_status,
        response_body: row.response_body,
        ticket_id: row.ticket_id || null,
        created_at: row.created_at,
        completed_at: row.completed_at,
        expires_at: row.expires_at
      };
    }
    // legacy or dual — include bare PK + scoped columns when dual
    const out = {
      idempotency_key: row.idempotency_key || row.client_key,
      actor_id: row.actor_id || row.player_id || '',
      club_id: row.club_id || '',
      endpoint: row.endpoint,
      request_hash: row.request_hash,
      status: row.status,
      response_status: row.response_status,
      response_body: row.response_body,
      created_at: row.created_at,
      completed_at: row.completed_at,
      expires_at: row.expires_at
    };
    if (mode === 'dual') {
      out.player_id = row.player_id || row.actor_id || '';
      out.client_key = row.client_key || row.idempotency_key;
      out.ticket_id = row.ticket_id || null;
    }
    return out;
  }

  return {
    kind: 'supabase',
    getSchemaMode: function () { return schemaMode; },
    async ensureSchema() {
      const sb = getSupabase && getSupabase();
      if (!sb) return 'missing';
      return probeSchema(sb);
    },
    async load(scope) {
      const sb = getSupabase && getSupabase();
      if (!sb) return null; // money fail-closed via ensureSchema; non-money callers tolerate null
      const mode = await probeSchema(sb);
      if (mode === 'missing') return null;

      try {
        if (mode === 'scoped' || mode === 'dual') {
          const { data, error } = await sb.from('idempotency_keys').select('*')
            .eq('club_id', scope.clubId || '')
            .eq('player_id', scope.playerId || '')
            .eq('client_key', scope.clientKey)
            .limit(1);
          if (!error && data && data[0]) {
            return normalizeRow(data[0], scope.clientKey, scope.clubId, scope.playerId);
          }
        }
        if (mode === 'legacy' || mode === 'dual') {
          const { data, error } = await sb.from('idempotency_keys').select('*')
            .eq('idempotency_key', scope.clientKey)
            .limit(1);
          if (!error && data && data[0]) {
            const row = normalizeRow(data[0], scope.clientKey, scope.clubId, scope.playerId);
            // Soft scope check on legacy bare-key load
            if (row.club_id && scope.clubId && row.club_id !== scope.clubId) return null;
            if (row.player_id && scope.playerId && row.player_id !== scope.playerId &&
                row.actor_id && row.actor_id !== scope.playerId) return null;
            return row;
          }
        }
      } catch (_e) { /* fall through */ }
      return null;
    },
    async insertIfAbsent(scope, row) {
      const sb = getSupabase && getSupabase();
      if (!sb) {
        return { won: false, row: null, storeMissing: true };
      }
      const mode = await probeSchema(sb);
      if (mode === 'missing') {
        // Fail closed for durable uniqueness — mem is NOT sufficient.
        return { won: false, row: null, storeMissing: true };
      }
      const payload = rowForWrite(mode, row);
      try {
        const { error } = await sb.from('idempotency_keys').insert(payload);
        if (!error) {
          // shadow mem for same-process fast path (not authoritative)
          await memShadow.save(scope, normalizeRow(row, scope.clientKey, scope.clubId, scope.playerId));
          return { won: true, row: row };
        }
        if (isUniqueViolation(error)) {
          const existing = await this.load(scope);
          return { won: false, row: existing };
        }
        // dual-write: if scoped cols missing, retry legacy shape
        if (mode === 'dual' && isMissingColumn(error)) {
          const legacyPayload = rowForWrite('legacy', row);
          const r2 = await sb.from('idempotency_keys').insert(legacyPayload);
          if (!r2.error) return { won: true, row: row };
          if (isUniqueViolation(r2.error)) {
            return { won: false, row: await this.load(scope) };
          }
        }
        console.warn('[idem] insert failed:', error.message || error);
        return { won: false, row: null, error: error };
      } catch (e) {
        if (isUniqueViolation(e)) {
          return { won: false, row: await this.load(scope) };
        }
        return { won: false, row: null, error: e };
      }
    },
    async save(scope, row) {
      const sb = getSupabase && getSupabase();
      await memShadow.save(scope, row);
      if (!sb) return;
      const mode = await probeSchema(sb);
      if (mode === 'missing') return;
      const payload = rowForWrite(mode, row);
      try {
        if (mode === 'scoped') {
          await sb.from('idempotency_keys').upsert(payload, {
            onConflict: 'club_id,player_id,client_key'
          });
        } else if (mode === 'dual') {
          // Prefer scoped conflict target; fall back to bare key
          const r = await sb.from('idempotency_keys').upsert(payload, {
            onConflict: 'club_id,player_id,client_key'
          });
          if (r.error) {
            await sb.from('idempotency_keys').upsert(rowForWrite('legacy', row), {
              onConflict: 'idempotency_key'
            });
          }
        } else {
          await sb.from('idempotency_keys').upsert(payload, { onConflict: 'idempotency_key' });
        }
      } catch (_e) { /* best-effort complete */ }
    },
    async deleteExpired(cutoffIso) {
      const sb = getSupabase && getSupabase();
      let n = await memShadow.deleteExpired(cutoffIso);
      if (!sb) return n;
      const mode = await probeSchema(sb);
      if (mode === 'missing') return n;
      try {
        // Prefer SQL function if present
        const rpc = await sb.rpc('purge_expired_idempotency_keys');
        if (!rpc.error && typeof rpc.data === 'number') return rpc.data;
      } catch (_e) { /* fall through to delete */ }
      try {
        const { error, count } = await sb.from('idempotency_keys')
          .delete({ count: 'exact' })
          .lt('expires_at', cutoffIso);
        if (!error && typeof count === 'number') return count;
      } catch (_e2) {}
      return n;
    }
  };
}

/**
 * Lookup ledger for expire/replay. Dual-read scoped then bare.
 */
async function lookupLedgerForKey(getSupabase, clubId, playerId, clientKey) {
  const sb = getSupabase && getSupabase();
  if (!sb) return null;
  const scoped = scopedLedgerId(clubId, playerId, clientKey);
  try {
    let { data, error } = await sb.from('ledger_entries').select('id,ticket_id,club_id,player_id,type,amount,balance_after')
      .eq('id', scoped).limit(1);
    if (!error && data && data[0]) return data[0];
    ({ data, error } = await sb.from('ledger_entries').select('id,ticket_id,club_id,player_id,type,amount,balance_after')
      .eq('id', clientKey).limit(1));
    if (!error && data && data[0]) {
      const row = data[0];
      if ((row.club_id || '') === (clubId || '') && (row.player_id || '') === (playerId || '')) {
        return row;
      }
      return null; // bare key exists but wrong scope — treat as no ledger
    }
  } catch (_e) {}
  return null;
}

/**
 * Resolve which ledger id to use for a money place.
 * Prefer existing bare client_key ledger (pre-scoped_hash_v1 sticky retry),
 * else existing scoped id, else mint scoped id for new writes.
 */
async function resolvePlaceLedgerId(getSupabase, clubId, playerId, clientKey) {
  const scoped = scopedLedgerId(clubId, playerId, clientKey);
  const existing = await lookupLedgerForKey(getSupabase, clubId, playerId, clientKey);
  if (existing) {
    return { ledgerId: existing.id, existing: existing, ticketId: existing.ticket_id || null };
  }
  return { ledgerId: scoped, existing: null, ticketId: null };
}

function synthesizeReplayFromLedger(ledger, existing) {
  const ticketId = ledger.ticket_id || (existing && existing.ticket_id) || null;
  const body = (existing && existing.response_body) || {
    ok: true,
    idempotent: true,
    ticketId: ticketId,
    ledgerEntryId: ledger.id,
    balanceAfter: ledger.balance_after,
    replayedFrom: 'ledger'
  };
  return {
    status: (existing && existing.status) || 'completed',
    response_status: (existing && existing.response_status) || 200,
    response_body: body,
    ticket_id: ticketId,
    expires_at: existing && existing.expires_at,
    request_hash: existing && existing.request_hash,
    actor_id: existing && existing.actor_id,
    player_id: existing && existing.player_id,
    club_id: existing && existing.club_id,
    client_key: existing && existing.client_key,
    idempotency_key: existing && existing.idempotency_key
  };
}

/**
 * Core check + reserve. store must implement load/insertIfAbsent/save.
 */
async function idemCheck(store, scope, endpoint, body, opts) {
  opts = opts || {};
  const clientKey = scope.clientKey;
  if (!clientKey) return { action: 'execute', warn: 'no_idempotency_key' };

  const actorId = scope.actorId || scope.playerId || 'anon';
  const clubId = scope.clubId || '';
  const playerId = scope.playerId || actorId;
  const reqHash = hashRequest(endpoint, actorId, clubId, body);
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const money = !!opts.money;
  const staleProcessingMs = opts.staleProcessingMs;

  const requirePlayer = opts.requirePlayer !== false;
  if (money && !clubId) {
    return {
      action: 'reject',
      status: 400,
      error: 'missing_club_or_player_for_idempotency',
      hint: 'Money idempotency requires club_id (fail-closed).'
    };
  }
  if (money && requirePlayer && (!playerId || playerId === 'anon')) {
    return {
      action: 'reject',
      status: 400,
      error: 'missing_club_or_player_for_idempotency',
      hint: 'Money idempotency requires club_id and player_id (fail-closed).'
    };
  }

  // Money requires durable scoped store. App mutex / mem is NOT sufficient.
  if (money && store.ensureSchema) {
    const mode = await store.ensureSchema();
    if (mode === 'missing') {
      return {
        action: 'reject',
        status: 503,
        error: 'idempotency_store_unavailable',
        hint: 'Persistent idempotency_keys required for money paths; mem-primary disabled.'
      };
    }
  }

  const existing = await store.load(scope);
  let ledgerExists = false;
  let ledgerRow = null;

  async function maybeLookupLedger() {
    if (!opts.lookupLedger) return null;
    return opts.lookupLedger(clubId, playerId, clientKey);
  }

  if (existing && existing.expires_at && nowMs > new Date(existing.expires_at).getTime()) {
    ledgerRow = await maybeLookupLedger();
    ledgerExists = !!ledgerRow;
    if (ledgerExists) {
      const synth = synthesizeReplayFromLedger(ledgerRow, existing);
      return { action: 'replay', reason: 'expired_ledger_replay', existingRow: synth, fromLedger: true };
    }
  } else if (!existing && opts.lookupLedger && money) {
    // No row but ledger may exist (crash after money before complete) — response loss
    ledgerRow = await maybeLookupLedger();
    if (ledgerRow) {
      const synth = synthesizeReplayFromLedger(ledgerRow, null);
      return { action: 'replay', reason: 'ledger_only_replay', existingRow: synth, fromLedger: true };
    }
  } else if (existing && isInProgressStatus(existing.status) && opts.lookupLedger) {
    // Pre-check ledger for stale-processing path
    ledgerRow = await maybeLookupLedger();
    ledgerExists = !!ledgerRow;
  }

  const decision = evaluateExisting(existing, {
    actorId: actorId,
    clubId: clubId,
    playerId: playerId,
    reqHash: reqHash,
    nowMs: nowMs,
    ledgerExists: ledgerExists,
    staleProcessingMs: staleProcessingMs
  });

  if (decision.action === 'expired') return decision;
  if (decision.action === 'conflict') return decision;
  if (decision.action === 'in_progress') return decision;
  if (decision.action === 'replay') {
    if (decision.fromLedger && ledgerRow) {
      decision.existingRow = synthesizeReplayFromLedger(ledgerRow, existing);
    }
    return decision;
  }
  if (decision.action === 'reclaim') {
    // Refresh created_at so concurrent reclaimers see fresh processing window
    const row = Object.assign({}, decision.existingRow, {
      status: 'processing',
      created_at: new Date(nowMs).toISOString()
    });
    await store.save(scope, row);
    return {
      action: 'execute',
      row: row,
      reqHash: reqHash,
      reclaimed: true,
      reason: decision.reason
    };
  }

  // Reserve via insert-if-absent (ON CONFLICT DO NOTHING semantics)
  const pending = buildPendingRow({
    clientKey: clientKey,
    clubId: clubId,
    playerId: playerId,
    actorId: actorId
  }, endpoint, reqHash, nowMs);

  const reserved = await store.insertIfAbsent(scope, pending);
  if (reserved.storeMissing && money) {
    return {
      action: 'reject',
      status: 503,
      error: 'idempotency_store_unavailable',
      hint: 'Persistent idempotency_keys required for money paths; mem-primary disabled.'
    };
  }
  if (reserved.won) {
    return { action: 'execute', row: pending, reqHash: reqHash };
  }

  // Lost race — re-read and evaluate
  const again = reserved.row || await store.load(scope);
  if (!again) {
    // Insert failed for non-conflict reason; money fail closed, else execute cautiously
    if (money) {
      return {
        action: 'reject',
        status: 503,
        error: 'idempotency_reserve_failed',
        hint: reserved.error && (reserved.error.message || String(reserved.error))
      };
    }
    return { action: 'execute', warn: 'reserve_failed_non_money', row: pending };
  }

  // If loser sees processing that already completed mid-flight, re-evaluate with ledger
  let againLedger = false;
  if (opts.lookupLedger && isInProgressStatus(again.status)) {
    const lr = await maybeLookupLedger();
    againLedger = !!lr;
    if (lr && !isInProgressStatus(again.status)) {
      // no-op
    }
  }

  const second = evaluateExisting(again, {
    actorId: actorId,
    clubId: clubId,
    playerId: playerId,
    reqHash: reqHash,
    nowMs: nowMs,
    ledgerExists: againLedger,
    staleProcessingMs: staleProcessingMs
  });
  if (second.action === 'reserve') {
    return { action: 'in_progress', status: 409, existingRow: again };
  }
  if (second.action === 'reclaim') {
    const row = Object.assign({}, second.existingRow, {
      status: 'processing',
      created_at: new Date(nowMs).toISOString()
    });
    await store.save(scope, row);
    return { action: 'execute', row: row, reqHash: reqHash, reclaimed: true };
  }
  if (second.action === 'replay' || second.action === 'in_progress' || second.action === 'conflict' || second.action === 'expired') {
    return second;
  }
  return { action: 'in_progress', status: 409, existingRow: again };
}

async function idemComplete(store, scope, responseStatus, responseBody, ticketId) {
  const existing = await store.load(scope);
  if (!existing) return;
  const row = Object.assign({}, existing, {
    status: (responseStatus >= 200 && responseStatus < 300) ? 'completed' : 'failed',
    response_status: responseStatus,
    response_body: responseBody,
    ticket_id: ticketId || existing.ticket_id ||
      (responseBody && (responseBody.ticketId || responseBody.groupId)) || null,
    completed_at: new Date().toISOString()
  });
  await store.save(scope, row);
}

/**
 * Retention purge — code-only safe helper. Do NOT auto-schedule against prod.
 * Grace: rows with expires_at older than now - 7d.
 */
async function purgeExpiredKeys(store, nowMs) {
  nowMs = nowMs != null ? nowMs : Date.now();
  const cutoff = new Date(nowMs - RETENTION_GRACE_MS).toISOString();
  return store.deleteExpired(cutoff);
}

/**
 * Express middleware factory.
 * opts.required — require key
 * opts.money — fail-closed club/player + durable store; no mem-primary
 */
function createRequireIdempotency(deps) {
  const store = deps.store;
  const lookupLedger = deps.lookupLedger || null;

  return function requireIdempotency(opts) {
    opts = opts || {};
    return async function (req, res, next) {
      const key = (req.headers['idempotency-key'] || '').trim() ||
        (req.body && req.body.idempotencyKey) || null;
      if (!key && opts.required) {
        return res.status(400).json({
          ok: false,
          error: 'missing_idempotency_key',
          hint: 'Include Idempotency-Key header or idempotencyKey in body'
        });
      }
      if (!key) return next();

      const actor = req._actor || {};
      const clubId = req._clubId || (req.body && req.body.clubId) || '';
      const requirePlayer = opts.requirePlayer !== false;
      let playerId = (req.body && req.body.playerId) || actor.actorId || '';
      // Club-level money ops (e.g. weekly-rollover): scope player as host actor or sentinel
      if (opts.money && !requirePlayer && !playerId) {
        playerId = actor.actorId || ('club:' + clubId);
      }
      const scope = {
        clientKey: key,
        clubId: clubId,
        playerId: playerId,
        actorId: actor.actorId || playerId || 'anon'
      };

      const result = await idemCheck(store, scope, req.path, req.body, {
        money: !!opts.money,
        requirePlayer: requirePlayer,
        lookupLedger: lookupLedger
          ? function (c, p, k) { return lookupLedger(c, p, k); }
          : null
      });

      if (result.action === 'reject') {
        return res.status(result.status || 400).json({
          ok: false,
          error: result.error,
          hint: result.hint
        });
      }
      if (result.action === 'expired') {
        return res.status(400).json({
          ok: false,
          error: 'idempotency_key_expired',
          hint: result.hint
        });
      }
      if (result.action === 'replay') {
        const stored = result.existingRow;
        console.log('[idem] REPLAY key=' + key.slice(0, 12) + '… endpoint=' + req.path +
          (result.fromLedger ? ' from=ledger' : ''));
        return res.status(stored.response_status || 200).json(stored.response_body);
      }
      if (result.action === 'conflict') {
        console.log('[idem] CONFLICT key=' + key.slice(0, 12) + '… reason=' + result.reason);
        return res.status(409).json({ ok: false, error: 'idempotency_conflict', reason: result.reason });
      }
      if (result.action === 'in_progress') {
        return res.status(409).json({
          ok: false,
          error: 'request_in_progress',
          hint: 'Identical request is being processed. Retry after 2s.'
        });
      }

      req._idemKey = key;
      req._idemScope = scope;
      req._idemLedgerId = scopedLedgerId(clubId, playerId, key);
      req._idemTicketId = deterministicTicketId(clubId, playerId, key);
      if (result.reclaimed) req._idemReclaimed = true;

      const _origJson = res.json.bind(res);
      res.json = function (body) {
        const tid = (body && (body.ticketId || body.groupId)) || req._idemTicketId || null;
        idemComplete(store, scope, res.statusCode || 200, body, tid).catch(function () {});
        return _origJson(body);
      };
      next();
    };
  };
}

/** Reference DDL — scoped target (matches PROPOSED migration). */
const IDEMPOTENCY_TABLE_DDL_SCOPED = `
CREATE TABLE IF NOT EXISTS idempotency_keys (
  club_id          TEXT NOT NULL,
  player_id        TEXT NOT NULL,
  client_key       TEXT NOT NULL,
  endpoint         TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'processing'
                   CHECK (status IN ('pending','processing','completed','failed')),
  response_status  INTEGER,
  response_body    JSONB,
  ticket_id        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (club_id, player_id, client_key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx ON idempotency_keys(expires_at);
`;

/** Legacy DDL kept for dual-mode reference. */
const IDEMPOTENCY_TABLE_DDL_LEGACY = `
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

module.exports = {
  KEY_TTL_MS: KEY_TTL_MS,
  RETENTION_GRACE_MS: RETENTION_GRACE_MS,
  STALE_PROCESSING_MS: STALE_PROCESSING_MS,
  LEDGER_ID_SCOPING: LEDGER_ID_SCOPING,
  sortKeys: sortKeys,
  hashRequest: hashRequest,
  deterministicTicketId: deterministicTicketId,
  deterministicRrGroupId: deterministicRrGroupId,
  scopedLedgerId: scopedLedgerId,
  memStoreKey: memStoreKey,
  isInProgressStatus: isInProgressStatus,
  normalizeRow: normalizeRow,
  buildPendingRow: buildPendingRow,
  evaluateExisting: evaluateExisting,
  createMemStore: createMemStore,
  createUniqueDbSimStore: createUniqueDbSimStore,
  createSupabaseStore: createSupabaseStore,
  lookupLedgerForKey: lookupLedgerForKey,
  resolvePlaceLedgerId: resolvePlaceLedgerId,
  synthesizeReplayFromLedger: synthesizeReplayFromLedger,
  idemCheck: idemCheck,
  idemComplete: idemComplete,
  purgeExpiredKeys: purgeExpiredKeys,
  createRequireIdempotency: createRequireIdempotency,
  IDEMPOTENCY_TABLE_DDL_SCOPED: IDEMPOTENCY_TABLE_DDL_SCOPED,
  IDEMPOTENCY_TABLE_DDL_LEGACY: IDEMPOTENCY_TABLE_DDL_LEGACY,
  // Back-compat alias used by docs/index wiring
  IDEMPOTENCY_TABLE_DDL: IDEMPOTENCY_TABLE_DDL_SCOPED
};
