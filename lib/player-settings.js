'use strict';

const CANONICAL_SPORT_IDS = Object.freeze([
  'nfl', 'mlb', 'nba', 'nhl', 'ncaaf', 'ncaab', 'soccer',
  'tennis', 'golf', 'boxing', 'mma', 'nascar', 'rugby'
]);
const CANONICAL_SPORT_SET = new Set(CANONICAL_SPORT_IDS);
const HOST_NOTES_MAX_LENGTH = 2000;
const SPORT_ALIASES = Object.freeze({
  americanfootball_nfl: 'nfl',
  americanfootball_ncaaf: 'ncaaf',
  baseball_mlb: 'mlb',
  basketball_nba: 'nba',
  basketball_ncaab: 'ncaab',
  icehockey_nhl: 'nhl',
  mma_mixed_martial_arts: 'mma',
  rugbyunion_six_nations: 'rugby',
  rugby_union: 'rugby',
  rugbyleague: 'rugby',
  rugby_league: 'rugby'
});

function canonicalSportId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (CANONICAL_SPORT_SET.has(raw)) return raw;
  if (SPORT_ALIASES[raw]) return SPORT_ALIASES[raw];
  if (raw.indexOf('soccer') === 0) return 'soccer';
  if (raw.indexOf('tennis') === 0) return 'tennis';
  if (raw.indexOf('golf') === 0) return 'golf';
  if (raw.indexOf('nascar') === 0) return 'nascar';
  return null;
}

function canonicalSportFromSnapshot(snapshot) {
  if (!snapshot) return null;
  const key = snapshot.canonical_game_key || snapshot.canonicalGameKey || '';
  const prefix = String(key).split('|')[0];
  return canonicalSportId(snapshot.sport || snapshot.sport_key || prefix);
}

function validateDisabledSports(value) {
  if (value == null) return { value: [] };
  if (!Array.isArray(value)) return { error: 'invalid_disabled_sports' };
  if (value.length > CANONICAL_SPORT_IDS.length) return { error: 'too_many_disabled_sports' };
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    const raw = String(item || '').trim().toLowerCase();
    if (!CANONICAL_SPORT_SET.has(raw)) return { error: 'unknown_disabled_sport', sport: raw };
    if (!seen.has(raw)) {
      seen.add(raw);
      normalized.push(raw);
    }
  }
  return { value: normalized };
}

function validateHostNotes(value) {
  if (value == null) return { value: '' };
  if (typeof value !== 'string') return { error: 'invalid_host_notes' };
  if (value.length > HOST_NOTES_MAX_LENGTH) {
    return { error: 'host_notes_too_long', maxLength: HOST_NOTES_MAX_LENGTH };
  }
  return { value };
}

function checkPlayerSportAccess(blockedSports, legs) {
  const blocked = new Set(Array.isArray(blockedSports) ? blockedSports : []);
  if (!blocked.size) return { ok: true };
  for (let i = 0; i < (legs || []).length; i++) {
    const sport = canonicalSportId(legs[i] && legs[i].canonicalSportId);
    if (!sport) return { ok: false, code: 'player_sport_identity_unavailable', legIndex: i };
    if (blocked.has(sport)) {
      return {
        ok: false,
        code: 'player_sport_disabled',
        sport,
        legIndex: i,
        message: 'Betting on ' + sport.toUpperCase() + ' is disabled for this account.'
      };
    }
  }
  return { ok: true };
}

module.exports = {
  CANONICAL_SPORT_IDS,
  HOST_NOTES_MAX_LENGTH,
  canonicalSportId,
  canonicalSportFromSnapshot,
  validateDisabledSports,
  validateHostNotes,
  checkPlayerSportAccess
};
