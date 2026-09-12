'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const {
  WRITE_ACK,
  REMOTE_ACK,
  isProductionHostname,
  resolveHarnessConfig
} = require('../lib/place-bet-harness-safety');

const HARNESS = path.join(__dirname, '..', 'scripts', 'place-bet-contract-harness.js');
const DENY_NETWORK = path.join(__dirname, 'helpers', 'deny-network.js');
const EXPLICIT_IDS = {
  PLACE_BET_ACTOR_ID: 'designated-player',
  PLACE_BET_CLUB_ID: 'designated-club',
  PLACE_BET_RUN_ID: 'incident-safe-run'
};

function enabledEnv(extra) {
  return Object.assign({
    PLACE_BET_ENABLE_WRITE_HARNESS: WRITE_ACK
  }, EXPLICIT_IDS, extra || {});
}

describe('place-bet harness fail-closed configuration', () => {
  test('no explicit configuration is a disabled no-op', () => {
    expect(resolveHarnessConfig({})).toEqual({
      enabled: false,
      safe: true,
      reason: 'write_harness_disabled'
    });
  });

  test('enabling writes without a URL fails before network', () => {
    expect(resolveHarnessConfig(enabledEnv({}))).toMatchObject({
      enabled: true,
      safe: false,
      reason: 'explicit_base_url_required'
    });
  });

  test.each([
    'pocketbooks-sports-backend-production.up.railway.app',
    'alias.up.railway.app',
    'pocketbookssports.com',
    'api.pocketbookssports.com',
    'preview.vercel.app'
  ])('production-like hostname %s is forbidden', (hostname) => {
    expect(isProductionHostname(hostname)).toBe(true);
    expect(resolveHarnessConfig(enabledEnv({
      PLACE_BET_BASE: 'https://' + hostname,
      PLACE_BET_ALLOW_REMOTE_WRITE: REMOTE_ACK
    }))).toMatchObject({
      enabled: true,
      safe: false,
      reason: 'production_hostname_forbidden'
    });
  });

  test('remote designated environment needs a separate acknowledgement', () => {
    expect(resolveHarnessConfig(enabledEnv({
      PLACE_BET_BASE: 'https://bets.qa.example.net'
    }))).toMatchObject({
      safe: false,
      reason: 'remote_write_authorization_required'
    });
    expect(resolveHarnessConfig(enabledEnv({
      PLACE_BET_BASE: 'https://bets.qa.example.net',
      PLACE_BET_ALLOW_REMOTE_WRITE: REMOTE_ACK
    }))).toMatchObject({
      enabled: true,
      safe: true,
      local: false,
      baseUrl: 'https://bets.qa.example.net'
    });
  });

  test('localhost runs only with explicit write, identity, and run inputs', () => {
    expect(resolveHarnessConfig({
      PLACE_BET_ENABLE_WRITE_HARNESS: WRITE_ACK,
      PLACE_BET_BASE: 'http://127.0.0.1:3000'
    })).toMatchObject({
      safe: false,
      reason: 'explicit_actor_and_club_required'
    });
    expect(resolveHarnessConfig(enabledEnv({
      PLACE_BET_BASE: 'http://127.0.0.1:3000'
    }))).toMatchObject({
      enabled: true,
      safe: true,
      local: true,
      baseUrl: 'http://127.0.0.1:3000'
    });
  });

  test('direct node execution with no config exits zero without network', () => {
    const env = {
      PATH: process.env.PATH,
      NODE_OPTIONS: '--require=' + DENY_NETWORK
    };
    const result = spawnSync(process.execPath, [HARNESS], {
      env,
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('write harness disabled; no network requests made');
    expect(result.stderr).not.toContain('NETWORK_ACCESS_FORBIDDEN');
  });

  test('production URL exits before session mint or network access', () => {
    const env = Object.assign({
      PATH: process.env.PATH,
      NODE_OPTIONS: '--require=' + DENY_NETWORK
    }, enabledEnv({
      PLACE_BET_BASE: 'https://pocketbooks-sports-backend-production.up.railway.app',
      PLACE_BET_ALLOW_REMOTE_WRITE: REMOTE_ACK
    }));
    const result = spawnSync(process.execPath, [HARNESS], {
      env,
      encoding: 'utf8'
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('production_hostname_forbidden');
    expect(result.stderr).not.toContain('NETWORK_ACCESS_FORBIDDEN');
  });
});
