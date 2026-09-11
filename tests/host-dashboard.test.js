'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const dashIdx = src.indexOf("app.get('/api/host/dashboard'");
const dashEnd = src.indexOf('// GET /api/host/settlements-preview', dashIdx);
const dash = dashIdx === -1 ? '' : src.slice(dashIdx, dashEnd === -1 ? src.length : dashEnd);
const identityStart = src.indexOf('async function _lookupUserIdentities');
const identityEnd = src.indexOf("app.get('/api/clubs/:id/requests'", identityStart);
const identityHelper = identityStart === -1 ? '' : src.slice(identityStart, identityEnd);

function _uuidLike(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
function playerLabel(pid, ticketUsername, nameById) {
  var fromUsers = nameById[String(pid)] || '';
  if (fromUsers) return fromUsers;
  var tu = ticketUsername || '';
  if (tu && tu !== String(pid) && !_uuidLike(tu)) return tu;
  return '';
}

describe('GET /api/host/dashboard', () => {
  test('route exists', () => {
    expect(dashIdx).toBeGreaterThan(-1);
    expect(dash.length).toBeGreaterThan(100);
  });

  test('tolerant users lookup prefers display_name and matches IDs as text', () => {
    expect(identityHelper).toContain("'id,display_name,username,email'");
    expect(identityHelper).toContain('id::text = ANY($1::text[])');
    expect(dash).toContain('_lookupUserIdentities(sb, playerIds)');
  });

  test('both pending request routes use real user identities', () => {
    const pendingRoutes = src.slice(
      src.indexOf("app.get('/api/clubs/:id/requests'"),
      src.indexOf("app.patch('/api/clubs/:id/requests/:memberId'")
    );
    expect((pendingRoutes.match(/await _lookupUserIdentities\(sb, actorIds\)/g) || [])).toHaveLength(2);
    expect((pendingRoutes.match(/await _lookupUserIdentities\(null,/g) || [])).toHaveLength(2);
    expect(pendingRoutes).toContain('playerName: u.display_name || u.username || _shortActorId');
    expect(pendingRoutes).toContain('username: u.username || null');
  });

  test('club_members is the only approved roster source and is club-scoped', () => {
    expect(dash).toContain("from('club_members')");
    expect(dash).not.toContain("from('club_memberships')");
    // Hard club scope (authz): never soft-fallback when clubId missing —
    // requireCanonicalClubId + missing_clubId fail-closed precede this query.
    expect(dash).toContain(".eq('club_id', clubId)");
    expect(dash).not.toContain("if (clubId) plq = plq.eq('club_id', clubId)");
    expect(dash).toContain("st !== 'active' && st !== 'approved'");
    expect(dash).toContain("if (playerId) plq = plq.eq('player_id', playerId)");
  });

  test('tickets query does not cap at 1', () => {
    const ticketsChunk = dash.split("from('tickets')")[1] || '';
    expect(ticketsChunk.slice(0, 500)).not.toMatch(/\.limit\(\s*1\s*\)/);
    expect(dash).toContain('.limit(1000)');
    expect(dash).not.toContain('.single()');
  });

  test('all active tickets are pushed, not just the latest', () => {
    expect(dash).toContain('active.push(enriched)');
    expect(dash).toContain('activeTickets:  active');
  });

  test('overview summary uses all-time handle and active risk_amount', () => {
    expect(dash).toContain('handleAll');
    expect(dash).toContain('settledHandle');
    expect(dash).toMatch(/atRisk:\s*stats\.activeRisk/);
    expect(dash).toMatch(/handle:\s*stats\.handle/);
    expect(dash).toContain('playersOwe:');
    expect(dash).toContain('hostOwes:');
  });

  test('availableBalance prefers ledger over ticket formula', () => {
    expect(dash).toContain("_ledgerAvailableForPlayer");
    expect(src).toContain("_deriveBalanceFromLedgerEntries");
    expect(dash).toContain("p.balanceSource = 'ledger'");
    expect(dash).toContain('ticketAvailable');
    expect(dash).toContain('weekly:         weeklyStats');
  });

  test('host dashboard loads ledger per player like player/dashboard', () => {
    expect(dash).toContain('_ledgerAvailableForPlayer(sb, clubId, pid, start)');
    expect(dash).not.toMatch(/\.in\('player_id',\s*balPids\)/);
  });

  test('weekly stats are computed from graded won/lost tickets', () => {
    expect(dash).toContain('weekSettledCount');
    expect(dash).toContain('graded_at||t.placed_at');
    expect(dash).toContain('weeklyStats');
  });

  test('players array is built from club_members and tickets cannot add actors', () => {
    expect(dash).toContain('Object.keys(memberMap).forEach');
    expect(dash).toContain('var p      = memberMap[pid] ? getOrCreatePlayer(pid, uname) : null');
    expect(dash).toContain('players:        players');
  });

  test('legacy/test ticket actors cannot inflate Host Players', () => {
    ['21', '22', '23', '25', '27'].forEach((actorId) => {
      expect(playerLabel(actorId, actorId, {})).toBe('');
    });
    expect(dash).not.toMatch(/getOrCreatePlayer\(pid,\s*uname\);\s*if \(uname\)/);
  });

  test('playerLabel prefers users.username over UUID ticket username', () => {
    const pid = '12bb68f1-bcca-4e63-8ae4-7065dbb19172';
    const names = {};
    names[pid] = 'testplayer2';
    expect(playerLabel(pid, pid, names)).toBe('testplayer2');
    expect(playerLabel('2a3e6819-be2f-4df3-8112-54ce19d0929e', null, {
      '2a3e6819-be2f-4df3-8112-54ce19d0929e': 'testplayer1'
    })).toBe('testplayer1');
    expect(playerLabel(pid, 'smoketest', {})).toBe('smoketest');
  });

  test('player limit writes resolve canonical member by club and player', () => {
    const limitsIdx = src.indexOf("app.post('/api/club/player-limits'");
    const limitsEnd = src.indexOf("app.get('/api/club/exposure'", limitsIdx);
    const limitsRoute = src.slice(limitsIdx, limitsEnd);
    expect(limitsRoute).toContain("from('club_members')");
    expect(limitsRoute).toContain(".eq('club_id', clubId)");
    expect(limitsRoute).toContain(".eq('player_id', playerId)");
    expect(limitsRoute).toContain("onConflict:'club_id,player_id'");
  });
});
