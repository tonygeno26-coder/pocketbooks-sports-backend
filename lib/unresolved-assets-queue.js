/**
 * Durable unresolved-asset queue for soccer logos + tennis photos.
 * Presentation-only — never assigns images via fuzzy matching.
 *
 * Dedupes by sport + normalized entity name. Safe to append repeatedly.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'unresolved-assets.json');

const REASON_CODES = {
  A: 'asset_exists_alias_mismatch',
  B: 'asset_exists_resolver_failure',
  C: 'db_mapping_missing',
  D: 'source_has_no_asset',
  E: 'broken_url',
  F: 'wrong_entity_matched',
  G: 'normalization_problem',
  H: 'provider_naming_mismatch',
  I: 'other'
};

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function emptyQueue() {
  return {
    version: 1,
    updatedAt: null,
    items: []
  };
}

function loadQueue(filePath) {
  var p = filePath || DEFAULT_PATH;
  try {
    if (!fs.existsSync(p)) return emptyQueue();
    var raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || !Array.isArray(raw.items)) return emptyQueue();
    return raw;
  } catch (_e) {
    return emptyQueue();
  }
}

function saveQueue(queue, filePath) {
  var p = filePath || DEFAULT_PATH;
  var dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  queue.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(queue, null, 2) + '\n', 'utf8');
  return queue;
}

/**
 * Upsert unresolved records. Never auto-assigns an image.
 * @param {Array<{sport, entityName, reason, provider?, providerId?, competition?, candidate?, notes?}>} entries
 */
function recordUnresolved(entries, opts) {
  opts = opts || {};
  var queue = loadQueue(opts.filePath);
  var byKey = Object.create(null);
  queue.items.forEach(function (it) {
    byKey[it.sport + '|' + normKey(it.entityName)] = it;
  });

  (entries || []).forEach(function (e) {
    if (!e || !e.sport || !e.entityName) return;
    var sport = String(e.sport).toLowerCase();
    var name = String(e.entityName).trim();
    if (!name) return;
    var key = sport + '|' + normKey(name);
    var reason = String(e.reason || 'I').toUpperCase().charAt(0);
    if (!REASON_CODES[reason]) reason = 'I';
    var now = new Date().toISOString();
    var existing = byKey[key];
    if (existing) {
      existing.lastSeen = now;
      existing.seenCount = (existing.seenCount || 1) + 1;
      existing.reason = reason;
      existing.reasonLabel = REASON_CODES[reason];
      if (e.provider) existing.provider = e.provider;
      if (e.providerId) existing.providerId = e.providerId;
      if (e.competition) existing.competition = e.competition;
      if (e.candidate) existing.candidate = e.candidate;
      if (e.notes) existing.notes = e.notes;
      return;
    }
    var item = {
      sport: sport,
      entityName: name,
      provider: e.provider || 'owls',
      providerId: e.providerId || null,
      competition: e.competition || null,
      reason: reason,
      reasonLabel: REASON_CODES[reason],
      candidate: e.candidate || null,
      notes: e.notes || null,
      firstSeen: now,
      lastSeen: now,
      seenCount: 1
    };
    queue.items.push(item);
    byKey[key] = item;
  });

  queue.items.sort(function (a, b) {
    if (a.sport !== b.sport) return a.sport < b.sport ? -1 : 1;
    return a.entityName < b.entityName ? -1 : 1;
  });
  return saveQueue(queue, opts.filePath);
}

function classifySoccerMiss(name, meta) {
  meta = meta || {};
  if (meta.broken) return 'E';
  if (meta.ambiguous) return 'F';
  if (meta.aliasCandidate) return 'A';
  if (/U\d{2}|\bII\b|\bB\b|Reserves?/i.test(name)) return 'H';
  if (meta.inDb === false) return 'C';
  if (meta.sourceMissing) return 'D';
  return 'I';
}

function classifyTennisMiss(name, meta) {
  meta = meta || {};
  if (meta.broken) return 'E';
  if (meta.ambiguous) return 'F';
  if (meta.espnId && meta.headshot404) return 'D';
  if (meta.aliasCandidate) return 'A';
  if (meta.sourceMissing) return 'D';
  return 'C';
}

module.exports = {
  DEFAULT_PATH,
  REASON_CODES,
  normKey,
  loadQueue,
  saveQueue,
  recordUnresolved,
  classifySoccerMiss,
  classifyTennisMiss
};
