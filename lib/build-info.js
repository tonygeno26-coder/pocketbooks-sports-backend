'use strict';

// ────────────────────────────────────────────────────────────────────────────
// lib/build-info.js
//
// Captures build-time + startup metadata for the /api/health endpoint and
// server-side uptime tracking.
//
// Used by index.js as:
//   const buildInfo = require('./lib/build-info');
//   const _SERVER_START = buildInfo.startedAtMs;
//   const payload = buildInfo.toHealthPayload();
// ────────────────────────────────────────────────────────────────────────────

const _startedAtMs = Date.now();

// Read package.json once at startup — safe, no circular deps.
let _version = 'unknown';
try {
  _version = require('../package.json').version || 'unknown';
} catch (_e) { /* package.json missing — harmless, version stays unknown */ }

function _firstEnv() {
  for (var i = 0; i < arguments.length; i++) {
    var v = process.env[arguments[i]];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

// Railway injects RAILWAY_GIT_COMMIT_SHA at deploy time. Fall back to common
// CI/build keys. Never hard-code a SHA; never read secret-bearing env vars.
const _gitSha = _firstEnv(
  'RAILWAY_GIT_COMMIT_SHA',
  'RAILWAY_GIT_COMMIT',
  'COMMIT_SHA',
  'SOURCE_COMMIT',
  'GIT_COMMIT',
  'GIT_SHA'
);

module.exports = {
  /** Unix timestamp (ms) when this module was first require()'d. */
  startedAtMs: _startedAtMs,

  gitSha: _gitSha,

  /**
   * Returns a plain object suitable for the /api/health response body.
   * Called on every health check — recomputes uptimeSeconds each call.
   */
  toHealthPayload: function () {
    return {
      status:        'ok',
      version:       _version,
      gitSha:        _gitSha || 'local',
      commit:        _gitSha ? _gitSha.slice(0, 7) : 'local',
      startedAt:     new Date(_startedAtMs).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - _startedAtMs) / 1000),
      env:           process.env.NODE_ENV || 'production'
    };
  }
};
