'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const dashIdx = src.indexOf("app.get('/api/host/dashboard'");
const dashEnd = src.indexOf('// GET /api/host/settlements-preview', dashIdx);
const dash = dashIdx === -1 ? '' : src.slice(dashIdx, dashEnd === -1 ? src.length : dashEnd);

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

  test('users lookup does not select missing name column', () => {
    expect(dash).toContain(".select('id,username,display_name')");
    expect(dash).not.toContain(".select('id,name,username,display_name')");
  });

  test('club_members query is club-scoped; approved rows merged in JS', () => {
    expect(dash).toContain("from('club_members')");
    expect(dash).toContain("if (clubId) plq = plq.eq('club_id', clubId)");
    expect(dash).toContain("String(r.status||'').toLowerCase() === 'approved'");
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

  test('players array is built from club_members plus tickets', () => {
    expect(dash).toContain('Object.keys(memberMap).forEach');
    expect(dash).toContain('players:        players');
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
});
