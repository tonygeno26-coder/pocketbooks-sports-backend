'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const approvalStart = src.indexOf("app.post('/api/club/members/approve'");
const approvalEnd = src.indexOf("app.post('/api/club/members/deny'", approvalStart);
const approval = src.slice(approvalStart, approvalEnd);
const limitsGetStart = src.indexOf("app.get('/api/club/player-limits'");
const limitsPostStart = src.indexOf("app.post('/api/club/player-limits'");
const limitsEnd = src.indexOf("app.get('/api/club/exposure'", limitsPostStart);
const limitsGet = src.slice(limitsGetStart, limitsPostStart);
const limitsPost = src.slice(limitsPostStart, limitsEnd);

describe('Host player limit management', () => {
  test('exposes only server-enforced numeric player limit fields', () => {
    expect(src).toContain(
      "const PLAYER_LIMIT_FIELDS = ['max_single_bet', 'max_payout', 'max_open_risk']"
    );
    expect(limitsPost).not.toContain('max_daily_risk');
    expect(limitsPost).not.toContain('max_parlay');
  });

  test('approval validates and persists limits before membership activation', () => {
    const validateAt = approval.indexOf('_validatedPlayerLimitPatch(body)');
    const persistAt = approval.indexOf('_persistAndVerifyPlayerLimits(');
    const approveAt = approval.indexOf("_membershipSetPendingStatus(targetActorId, clubId, 'approved'");
    const verifyAt = approval.indexOf('approval_verification_failed');
    expect(validateAt).toBeGreaterThan(-1);
    expect(persistAt).toBeGreaterThan(validateAt);
    expect(approveAt).toBeGreaterThan(persistAt);
    expect(verifyAt).toBeGreaterThan(approveAt);
  });

  test('approval failure cannot be reported as success', () => {
    expect(approval).toContain("throw new Error('approval_verification_failed')");
    expect(approval.indexOf('res.json({')).toBeGreaterThan(
      approval.indexOf('approval_verification_failed')
    );
    expect(approval).not.toContain('catch(_e)');
  });

  test('limit save failure occurs before approval begins', () => {
    const persistStart = src.indexOf('async function _persistAndVerifyPlayerLimits');
    const persistEnd = src.indexOf('// GET /api/club/members', persistStart);
    const persist = src.slice(persistStart, persistEnd);
    expect(persist).toContain('if (error) throw error;');
    expect(persist).toContain("throw new Error('player_limits_verification_failed')");
    expect(approval.indexOf('_persistAndVerifyPlayerLimits(')).toBeLessThan(
      approval.indexOf("_membershipSetPendingStatus(targetActorId, clubId, 'approved'")
    );
  });

  test('approval stages canonical roster pending before activation', () => {
    expect(approval).toContain("status:'pending'");
    expect(approval).toContain(".update({ status:'approved'");
    expect(approval).toContain('balance_start:startBal');
  });

  test('GET resolves stored, effective, and club-default values', () => {
    expect(limitsGet).toContain('_loadScopedPlayerLimitContext(sb, clubId, playerId, true)');
    expect(limitsGet).toContain('_playerLimitDefaults(sb, clubId)');
    expect(limitsGet).toContain("source:stored ? 'player_override' : 'club_default'");
  });

  test('post-approval writes require canonical active roster membership', () => {
    expect(limitsPost).toContain("from('club_members')");
    expect(limitsPost).toContain(".eq('club_id', clubId)");
    expect(limitsPost).toContain(".eq('player_id', playerId)");
    expect(limitsPost).toContain("['active','approved'].includes");
    expect(limitsPost).toContain("return res.status(404).json({ ok:false, error:'member_not_found' })");
    expect(limitsPost).toContain("onConflict:'club_id,player_id'");
  });

  test('host authorization and token club scope protect reads and writes', () => {
    expect(limitsGet).toContain("requirePermissionScoped('view_host_dashboard')");
    expect(limitsGet).toContain('_requireMemberAdmin(actor)');
    expect(limitsPost).toContain("requirePermissionScoped('settle_player')");
    expect(limitsPost).toContain('ROLE_RANK.full_admin');
  });

  test('numeric parser rejects negatives, booleans, and non-finite values', () => {
    const parserStart = src.indexOf('function _parsePlayerLimitValue');
    const parserEnd = src.indexOf('function _validatedPlayerLimitPatch', parserStart);
    const parser = src.slice(parserStart, parserEnd);
    expect(parser).toContain("typeof value === 'boolean'");
    expect(parser).toContain('!Number.isFinite(number) || number < 0');
  });

  test('placement fails closed if player limits cannot be read', () => {
    const riskStart = src.indexOf('async function _checkRiskLimitsJs');
    const riskEnd = src.indexOf('// Player suspended', riskStart);
    const riskLoad = src.slice(riskStart, riskEnd);
    expect(riskLoad).toContain('if (plError) throw plError');
    expect(riskLoad).toContain("code:'risk_limits_unavailable'");
    expect(src).toMatch(/risk_limits_unavailable:\s+503/);
  });

  test('player max is inclusive and applies to every bet type', () => {
    const stakeRule = "if (pl.max_single_bet && s > parseFloat(pl.max_single_bet))";
    expect(src).toContain(stakeRule);
    expect(src.indexOf(stakeRule)).toBeLessThan(src.indexOf('// Bet type gates'));
  });
});
