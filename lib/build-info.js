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

// Railway injects RAILWAY_GIT_COMMIT_SHA in the deploy environment.
const _commit = process.env.RAILWAY_GIT_COMMIT_SHA
  ? process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 8)
  : (process.env.GIT_COMMIT || 'local');

module.exports = {
  /** Unix timestamp (ms) when this module was first require()'d. */
  startedAtMs: _startedAtMs,

  /**
   * Returns a plain object suitable for the /api/health response body.
   * Called on every health check — recomputes uptimeSeconds each call.
   */
  toHealthPayload: function () {
    return {
      status:        'ok',
      version:       _version,
      commit:        _commit,
      startedAt:     new Date(_startedAtMs).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - _startedAtMs) / 1000),
      env:           process.env.NODE_ENV || 'production'
    };
  }
};
