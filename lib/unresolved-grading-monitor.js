'use strict';

const HOUR_MS = 3600000;

function ageHours(placedAt, nowMs) {
  const ms = new Date(placedAt).getTime();
  if (!Number.isFinite(ms)) return null;
  return (nowMs - ms) / HOUR_MS;
}

function ageBucket(hours) {
  if (hours == null || hours < 24) return 'under24';
  if (hours < 48) return 'over24';
  if (hours < 72) return 'over48';
  return 'over72';
}

function classifyUnresolvedReason(leg, snapshot) {
  if (!leg) return 'EVENT_MAPPING_FAILED';
  const key = leg.canonical_game_key || leg.canonicalGameKey;
  if (!key) return 'EVENT_MAPPING_FAILED';
  if (!snapshot) return 'EVENT_NOT_FOUND';
  const status = String(snapshot.status || '').toLowerCase();
  if (status === 'postponed') return 'POSTPONED';
  if (status === 'canceled' || status === 'cancelled' || status === 'abandoned' || status === 'forfeit')
    return 'CANCELED';
  if (status === 'final') {
    if (snapshot.home_score == null || snapshot.away_score == null) return 'AMBIGUOUS_RESULT';
    return 'PROVIDER_MISMATCH';
  }
  return 'NO_FINAL_SCORE';
}

function pickPrimaryReason(reasons) {
  const order = [
    'AMBIGUOUS_RESULT', 'PROVIDER_MISMATCH', 'EVENT_MAPPING_FAILED',
    'EVENT_NOT_FOUND', 'CANCELED', 'POSTPONED', 'NO_FINAL_SCORE'
  ];
  for (let i = 0; i < order.length; i++) {
    if (reasons.indexOf(order[i]) >= 0) return order[i];
  }
  return reasons[0] || 'NO_FINAL_SCORE';
}

function owlsEspnStatus(snapshot) {
  if (!snapshot) return { owls: 'not_found', espn: 'not_found' };
  const src = String(snapshot.source || '').toLowerCase();
  const st = snapshot.status || 'unknown';
  const hasOdds = src.indexOf('odds') >= 0;
  const hasEspn = src.indexOf('espn') >= 0;
  return {
    owls: hasOdds ? st : (hasEspn ? 'dropped_or_absent' : st),
    espn: hasEspn ? st : (hasOdds ? 'not_in_snapshot' : 'not_found')
  };
}

function eventLabel(leg) {
  if (!leg) return null;
  const away = leg.away_team || leg.team_away || '';
  const home = leg.home_team || leg.team_home || '';
  if (away && home) return away + ' @ ' + home;
  return leg.event_name || leg.pick || null;
}

function buildReport(opts) {
  const nowMs = opts.nowMs || Date.now();
  const tickets = opts.tickets || [];
  const legsByTicket = opts.legsByTicket || {};
  const snapshotsByKey = opts.snapshotsByKey || {};
  const lastAttemptByTicket = opts.lastAttemptByTicket || {};
  const items = [];

  tickets.forEach(function(t) {
    const status = String(t.status || '').toLowerCase();
    if (status !== 'active' && status !== 'open') return;
    const hours = ageHours(t.placed_at || t.placedAt, nowMs);
    const legs = legsByTicket[t.id] || [];
    const reasons = [];
    const events = [];
    let sport = null;
    let scheduledStart = null;
    let owls = 'not_found';
    let espn = 'not_found';

    legs.forEach(function(leg) {
      const key = leg.canonical_game_key || leg.canonicalGameKey;
      const snap = key ? snapshotsByKey[key] : null;
      reasons.push(classifyUnresolvedReason(leg, snap));
      sport = sport || leg.sport || (key && String(key).split('|')[0]) || null;
      scheduledStart = scheduledStart || leg.scheduled_start || leg.scheduledStart;
      const ev = eventLabel(leg);
      if (ev) events.push(ev);
      const st = owlsEspnStatus(snap);
      if (st.owls && st.owls !== 'not_found') owls = st.owls;
      if (st.espn && st.espn !== 'not_found' && st.espn !== 'not_in_snapshot') espn = st.espn;
      else if (espn === 'not_found') espn = st.espn;
    });
    if (!legs.length) reasons.push('EVENT_MAPPING_FAILED');

    items.push({
      ticketId: t.id,
      player: t.player_username || t.playerUsername || t.player_id || t.playerId || null,
      playerId: t.player_id || t.playerId || null,
      sport: sport || null,
      event: events.join(' | ') || null,
      scheduledStart: scheduledStart || null,
      currentStatus: t.status,
      owlsMatchStatus: owls,
      espnMatchStatus: espn,
      lastGradingAttempt: lastAttemptByTicket[t.id] || null,
      reasonUnresolved: pickPrimaryReason(reasons),
      ageHours: hours == null ? null : Math.round(hours * 10) / 10,
      placedAt: t.placed_at || t.placedAt || null,
      bucket: ageBucket(hours)
    });
  });

  function inBucket(name) {
    return items.filter(function(i) { return i.bucket === name; });
  }
  const over24 = items.filter(function(i) { return i.ageHours != null && i.ageHours >= 24; });
  const over48 = items.filter(function(i) { return i.ageHours != null && i.ageHours >= 48; });
  const over72 = items.filter(function(i) { return i.ageHours != null && i.ageHours >= 72; });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    autoGrade: false,
    counts: {
      unresolved: items.length,
      under24: inBucket('under24').length,
      over24: over24.length,
      over48: over48.length,
      over72: over72.length
    },
    buckets: {
      'UNRESOLVED > 24 HOURS': over24,
      'UNRESOLVED > 48 HOURS': over48,
      'UNRESOLVED > 72 HOURS': over72
    },
    tickets: items
  };
}

module.exports = {
  ageHours,
  ageBucket,
  classifyUnresolvedReason,
  pickPrimaryReason,
  owlsEspnStatus,
  buildReport
};
