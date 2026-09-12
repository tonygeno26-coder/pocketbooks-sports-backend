'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildAuthAuditRow,
  persistRequiredAuthAudit
} = require('../lib/auth-audit');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const approvalStart = src.indexOf("app.post('/api/club/members/approve'");
const approvalEnd = src.indexOf("app.post('/api/club/members/deny'", approvalStart);
const approval = src.slice(approvalStart, approvalEnd);
const limitsStart = src.indexOf("app.post('/api/club/player-limits'");
const limitsEnd = src.indexOf("app.get('/api/club/exposure'", limitsStart);
const limits = src.slice(limitsStart, limitsEnd);

function successfulAuditDb(capture) {
  return {
    from(table) {
      capture.table = table;
      return {
        async insert(row) {
          capture.row = row;
          return { error: null };
        }
      };
    }
  };
}

describe('Host player-limit audit persistence', () => {
  test('production insert shape uses host actor_id and target metadata', () => {
    expect(buildAuthAuditRow({
      eventType: 'player_limits_update_requested',
      actorId: 'HOST_1',
      clubId: 'CLUB_A',
      endpoint: '/club/player-limits',
      targetPlayerId: 'PLAYER_9',
      metadata: { fields: ['max_single_bet'] }
    })).toEqual({
      event_type: 'player_limits_update_requested',
      actor_id: 'HOST_1',
      club_id: 'CLUB_A',
      ticket_id: null,
      payload: {
        endpoint: '/club/player-limits',
        eventType: 'player_limits_update_requested',
        fields: ['max_single_bet'],
        target_player_id: 'PLAYER_9'
      }
    });
  });

  test('required event persists through audit_events', async () => {
    const capture = {};
    await expect(persistRequiredAuthAudit(successfulAuditDb(capture), {
      eventType: 'member_approval_requested',
      actorId: 'HOST_1',
      clubId: 'CLUB_A',
      endpoint: '/club/members/approve',
      targetPlayerId: 'PLAYER_9'
    })).resolves.toEqual({ ok: true });
    expect(capture.table).toBe('audit_events');
    expect(capture.row.actor_id).toBe('HOST_1');
    expect(capture.row.payload.target_player_id).toBe('PLAYER_9');
    expect(capture.row).not.toHaveProperty('player_id');
  });

  test('database audit error is surfaced and prevents following mutation', async () => {
    let mutationCalls = 0;
    const db = {
      from() {
        return { async insert() { return { error: { message: 'schema rejection' } }; } };
      }
    };
    async function guardedMutation() {
      await persistRequiredAuthAudit(db, {
        eventType: 'player_limits_update_requested',
        actorId: 'HOST_1',
        clubId: 'CLUB_A',
        targetPlayerId: 'PLAYER_9'
      });
      mutationCalls++;
    }
    await expect(guardedMutation()).rejects.toMatchObject({
      code: 'required_audit_persistence_failed'
    });
    expect(mutationCalls).toBe(0);
  });

  test('thrown audit failure is normalized and prevents following mutation', async () => {
    const db = {
      from() {
        return { async insert() { throw new Error('network unavailable'); } };
      }
    };
    await expect(persistRequiredAuthAudit(db, {
      eventType: 'member_approval_requested',
      actorId: 'HOST_1',
      clubId: 'CLUB_A',
      targetPlayerId: 'PLAYER_9'
    })).rejects.toMatchObject({
      code: 'required_audit_persistence_failed'
    });
  });

  test('approval audit is required before limits or membership mutation', () => {
    const auditAt = approval.indexOf('persistRequiredAuthAudit');
    expect(auditAt).toBeGreaterThan(-1);
    expect(approval).toContain("eventType:'member_approval_requested'");
    expect(approval).toContain('targetPlayerId:targetActorId');
    expect(auditAt).toBeLessThan(approval.indexOf('_persistAndVerifyPlayerLimits('));
    expect(auditAt).toBeLessThan(
      approval.indexOf("_membershipSetPendingStatus(targetActorId, clubId, 'approved'")
    );
  });

  test('limit-change audit is required before player_limits upsert', () => {
    const auditAt = limits.indexOf('persistRequiredAuthAudit');
    const upsertAt = limits.indexOf("from('player_limits')");
    expect(auditAt).toBeGreaterThan(-1);
    expect(limits).toContain("eventType:'player_settings_update_requested'");
    expect(limits).toContain('targetPlayerId:playerId');
    expect(auditAt).toBeLessThan(upsertAt);
  });

  test('host authorization and canonical club scope precede both mutations', () => {
    expect(approval).toContain("requirePermissionScoped('settle_player')");
    expect(approval).toContain('_requireMemberAdmin(actor)');
    expect(approval).toContain('req._clubId');
    expect(limits).toContain("requirePermissionScoped('settle_player')");
    expect(limits).toContain('ROLE_RANK.full_admin');
    expect(limits).toContain('req._clubId');
  });

  test('player self-edit remains blocked by full-admin requirement', () => {
    expect(limits).toMatch(
      /ROLE_RANK\[actor\.role\]\s*<\s*ROLE_RANK\.full_admin/
    );
    expect(limits).toContain("error:'insufficient_role'");
  });
});
