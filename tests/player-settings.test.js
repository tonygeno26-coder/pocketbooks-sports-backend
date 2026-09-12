'use strict';

const fs = require('fs');
const path = require('path');
const settings = require('../lib/player-settings');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

describe('player host notes and sport access', () => {
  test('uses the canonical sportsbook competition identifiers', () => {
    expect(settings.CANONICAL_SPORT_IDS).toEqual([
      'nfl', 'mlb', 'nba', 'nhl', 'ncaaf', 'ncaab', 'soccer',
      'tennis', 'golf', 'boxing', 'mma', 'nascar', 'rugby'
    ]);
    expect(settings.canonicalSportFromSnapshot({
      canonical_game_key:'americanfootball_nfl|Away|Home|2026-09-11'
    })).toBe('nfl');
  });

  test('missing restrictions default open and re-enable works', () => {
    const nfl = [{ canonicalSportId:'nfl' }];
    expect(settings.checkPlayerSportAccess(null, nfl)).toEqual({ ok:true });
    expect(settings.checkPlayerSportAccess([], nfl)).toEqual({ ok:true });
  });

  test.each(['moneyline', 'spread', 'total', 'player_prop', 'live'])(
    'NFL disabled rejects %s before placement mutation',
    market => {
      const result = settings.checkPlayerSportAccess(['nfl'], [
        { canonicalSportId:'nfl', market }
      ]);
      expect(result).toMatchObject({
        ok:false, code:'player_sport_disabled', sport:'nfl', legIndex:0
      });
      expect(result.message).toBe('Betting on NFL is disabled for this account.');
    }
  );

  test('NBA remains allowed and a mixed parlay rejects entirely', () => {
    expect(settings.checkPlayerSportAccess(['nfl'], [
      { canonicalSportId:'nba' }
    ])).toEqual({ ok:true });
    expect(settings.checkPlayerSportAccess(['nfl'], [
      { canonicalSportId:'nba' }, { canonicalSportId:'nfl' }
    ])).toMatchObject({ ok:false, code:'player_sport_disabled', legIndex:1 });
  });

  test('restricted players fail closed on unknown authoritative identity', () => {
    expect(settings.checkPlayerSportAccess(['nfl'], [
      { canonicalSportId:null }
    ])).toMatchObject({ ok:false, code:'player_sport_identity_unavailable' });
  });

  test('validates notes and disabled ID payload growth', () => {
    expect(settings.validateHostNotes('x'.repeat(2000)).error).toBeUndefined();
    expect(settings.validateHostNotes('x'.repeat(2001))).toMatchObject({
      error:'host_notes_too_long', maxLength:2000
    });
    expect(settings.validateDisabledSports(['nfl','nfl','nba']).value).toEqual(['nfl','nba']);
    expect(settings.validateDisabledSports(['made_up'])).toMatchObject({
      error:'unknown_disabled_sport'
    });
    expect(settings.validateDisabledSports(new Array(14).fill('nfl'))).toMatchObject({
      error:'too_many_disabled_sports'
    });
  });

  test('placement uses server snapshot identity before money RPC', () => {
    const enrichAt = src.indexOf('canonicalSportId:       vr.canonicalSportId');
    const gateAt = src.indexOf('playerSettings.checkPlayerSportAccess');
    const rpcAt = src.indexOf("_callMoneyRpc('place_bet_tx'");
    const rrAt = src.indexOf("_callMoneyRpc('place_rr_tx'");
    expect(enrichAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(enrichAt);
    expect(gateAt).toBeLessThan(rrAt);
    expect(gateAt).toBeLessThan(rpcAt);
  });

  test('player API never selects or returns host notes', () => {
    const start = src.indexOf("app.get('/api/player/dashboard'");
    const end = src.indexOf('// ══ RISK SETTINGS ENDPOINTS', start);
    const route = src.slice(start, end);
    expect(route).not.toMatch(/select\([^)]*notes/);
    expect(route).not.toContain('hostNotes');
    expect(route).toContain('bettingAccess');
  });

  test('host audit carries actor and target separately without note text', () => {
    const start = src.indexOf("app.post('/api/club/player-limits'");
    const end = src.indexOf("app.get('/api/club/exposure'", start);
    const route = src.slice(start, end);
    expect(route).toContain("eventType:'player_settings_update_requested'");
    expect(route).toContain('actorId:actor.actorId');
    expect(route).toContain('targetPlayerId:playerId');
    expect(route).toContain('host_notes_length');
    expect(route).not.toContain('metadata:{ hostNotes');
    expect(route.indexOf('persistRequiredAuthAudit')).toBeLessThan(route.indexOf("from('player_limits')"));
  });
});
