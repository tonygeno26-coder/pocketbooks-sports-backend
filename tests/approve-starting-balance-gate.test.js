'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const approvalStart = src.indexOf("app.post('/api/club/members/approve'");
const approvalEnd = src.indexOf("app.post('/api/club/members/deny'", approvalStart);
const approval = src.slice(approvalStart, approvalEnd);

describe('Starting betting balance approval gate', () => {
  test('rejects missing/invalid starting balance fail-closed', () => {
    expect(approval).toContain("error:'invalid_starting_balance'");
    expect(approval).toContain('startRaw == null || startRaw === \'\'');
    expect(approval).toContain('!Number.isFinite(startBal) || startBal < 0');
  });

  test('allows explicit zero but not missing null', () => {
    // startBal < 0 denied; 0 is finite and >= 0 so allowed when explicitly provided
    expect(approval).toMatch(/startBal < 0/);
    expect(approval).not.toMatch(/startBal <= 0/);
    expect(approval).toContain('Explicit $0 allowed');
  });

  test('self-approval is denied', () => {
    expect(approval).toContain("error:'self_approval_denied'");
    expect(approval).toContain('String(targetActorId) === String(actor.actorId)');
  });

  test('host admin gate and scoped permission protect approve', () => {
    expect(approval).toContain("requirePermissionScoped('settle_player')");
    expect(approval).toContain('_requireMemberAdmin(actor)');
  });

  test('balance_start is staged and verified before success', () => {
    expect(approval).toContain('balance_start:startBal');
    expect(approval).toContain('approval_balance_init_failed');
    expect(approval).toContain('approval_verification_failed');
    expect(approval.indexOf('approval_balance_init_failed'))
      .toBeLessThan(approval.indexOf("_membershipSetPendingStatus(targetActorId, clubId, 'approved'"));
  });

  test('failed activation rolls membership back from approved', () => {
    expect(approval).toContain('membershipActivated = true');
    expect(approval).toContain("status:'pending'");
    expect(approval).toContain('rollback after failed activation');
  });

  test('response includes host username identity fields', () => {
    expect(approval).toContain('_hostPublicPlayerIdentity');
    expect(approval).toContain('username: pub.username');
    expect(approval).toContain('playerIdLabel: pub.playerIdLabel');
  });
});

describe('Host public player identity helpers', () => {
  test('canonical username prefers users.username / legacy name', () => {
    expect(src).toContain('function _canonicalHostUsername');
    expect(src).toContain('function _hostPublicPlayerIdentity');
    expect(src).toContain('function _hostPlayerIdLabel');
    expect(src).toContain("'Player #'");
  });

  test('pending requests map username primary without email PII', () => {
    const reqStart = src.indexOf("app.get('/api/clubs/:id/requests'");
    const reqSlice = src.slice(reqStart, reqStart + 3500);
    expect(reqSlice).toContain('_hostPublicPlayerIdentity');
    expect(reqSlice).toContain('playerIdLabel: pub.playerIdLabel');
    // New mapping should not attach email for host join queue
    expect(reqSlice).not.toMatch(/email:\s*u\.email/);
  });
});
