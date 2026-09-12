'use strict';

const WRITE_ACK = 'I_UNDERSTAND_THIS_PLACES_REAL_WAGERS';
const REMOTE_ACK = 'I_AUTHORIZE_THIS_DESIGNATED_REMOTE_TEST_ENV';

function isLocalHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isProductionHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host === 'pocketbookssports.com'
    || host.endsWith('.pocketbookssports.com')
    || host.endsWith('.up.railway.app')
    || host.endsWith('.railway.app')
    || host.endsWith('.vercel.app');
}

function resolveHarnessConfig(env) {
  env = env || {};
  const rawBase = String(env.PLACE_BET_BASE || '').trim();
  const writeEnabled = env.PLACE_BET_ENABLE_WRITE_HARNESS === WRITE_ACK;

  // No explicit enablement is a successful no-op, including direct `node`.
  if (!writeEnabled) {
    return { enabled: false, safe: true, reason: 'write_harness_disabled' };
  }
  if (!rawBase) {
    return { enabled: true, safe: false, reason: 'explicit_base_url_required' };
  }

  let parsed;
  try {
    parsed = new URL(rawBase);
  } catch (_) {
    return { enabled: true, safe: false, reason: 'invalid_base_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { enabled: true, safe: false, reason: 'http_or_https_required' };
  }
  if (parsed.username || parsed.password) {
    return { enabled: true, safe: false, reason: 'credentials_in_url_forbidden' };
  }

  const local = isLocalHostname(parsed.hostname);
  if (isProductionHostname(parsed.hostname)) {
    return { enabled: true, safe: false, reason: 'production_hostname_forbidden' };
  }
  if (!local && env.PLACE_BET_ALLOW_REMOTE_WRITE !== REMOTE_ACK) {
    return { enabled: true, safe: false, reason: 'remote_write_authorization_required' };
  }

  const actorId = String(env.PLACE_BET_ACTOR_ID || '').trim();
  const clubId = String(env.PLACE_BET_CLUB_ID || '').trim();
  const runId = String(env.PLACE_BET_RUN_ID || '').trim();
  if (!actorId || !clubId) {
    return { enabled: true, safe: false, reason: 'explicit_actor_and_club_required' };
  }
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(runId)) {
    return { enabled: true, safe: false, reason: 'explicit_safe_run_id_required' };
  }

  return {
    enabled: true,
    safe: true,
    local,
    baseUrl: parsed.origin,
    actorId,
    clubId,
    runId
  };
}

module.exports = {
  WRITE_ACK,
  REMOTE_ACK,
  isLocalHostname,
  isProductionHostname,
  resolveHarnessConfig
};
