'use strict';

const {
  espnRootKeys,
  espnEventsFromPayload,
  espnScoreboardToGames,
  espnGamesToOddsScores,
  toPublicScore
} = require('../lib/espn-scoreboard');

const BOS_NYY_FIXTURE = {
  leagues: [{ id: '10', name: 'Major League Baseball' }],
  events: [{
    id: '401816732',
    date: '2026-08-30T17:35Z',
    name: 'Boston Red Sox at New York Yankees',
    shortName: 'BOS @ NYY',
    status: {
      type: { id: '3', name: 'STATUS_FINAL', state: 'post', completed: true }
    },
    competitions: [{
      id: '401816732',
      date: '2026-08-30T17:35Z',
      competitors: [
        {
          homeAway: 'home',
          score: '16',
          team: {
            displayName: 'New York Yankees',
            shortDisplayName: 'Yankees',
            name: 'Yankees',
            abbreviation: 'NYY'
          }
        },
        {
          homeAway: 'away',
          score: '1',
          team: {
            displayName: 'Boston Red Sox',
            shortDisplayName: 'Red Sox',
            name: 'Red Sox',
            abbreviation: 'BOS'
          }
        }
      ],
      status: {
        type: { id: '3', name: 'STATUS_FINAL', state: 'post', completed: true }
      }
    }]
  }],
  provider: { id: '100', name: 'Draft Kings' }
};

describe('ESPN scoreboard parser', () => {
  test('reads events at the JSON root (not leagues[0].events)', () => {
    expect(espnRootKeys(BOS_NYY_FIXTURE)).toEqual(['leagues', 'events', 'provider']);
    expect(espnEventsFromPayload(BOS_NYY_FIXTURE)).toHaveLength(1);
    expect(espnEventsFromPayload({ leagues: [{ name: 'MLB' }], provider: {} })).toHaveLength(0);
  });

  test('parses one ESPN event into a completed game', () => {
    const games = espnScoreboardToGames(BOS_NYY_FIXTURE);
    expect(games).toHaveLength(1);
    const g = games[0];
    expect(g.id).toBe('401816732');
    expect(g.home).toBe('New York Yankees');
    expect(g.away).toBe('Boston Red Sox');
    expect(g.home_score).toBe(16);
    expect(g.away_score).toBe(1);
    expect(g.completed).toBe(true);
    expect(g.status).toBe('final');
    expect(g.commence_time).toBe('2026-08-30T17:35Z');
  });

  test('maps post/in/pre status.type.state to final/live/upcoming', () => {
    function eventWithState(state, completed, name) {
      return {
        events: [{
          id: '1',
          competitions: [{
            competitors: [
              { homeAway: 'home', score: '2', team: { displayName: 'New York Yankees' } },
              { homeAway: 'away', score: '1', team: { displayName: 'Boston Red Sox' } }
            ],
            status: { type: { name: name, state: state, completed: completed } }
          }]
        }]
      };
    }
    expect(espnScoreboardToGames(eventWithState('post', true, 'STATUS_FINAL'))[0].status).toBe('final');
    expect(espnScoreboardToGames(eventWithState('in', false, 'STATUS_IN_PROGRESS'))[0].status).toBe('live');
    expect(espnScoreboardToGames(eventWithState('pre', false, 'STATUS_SCHEDULED'))[0].status).toBe('upcoming');
  });

  test('public /api/scores shape uses camelCase + completed', () => {
    const converted = espnGamesToOddsScores(espnScoreboardToGames(BOS_NYY_FIXTURE), 'baseball_mlb');
    const pub = toPublicScore(converted[0], 'baseball_mlb', 'espn');
    expect(pub).toMatchObject({
      id: '401816732',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      homeScore: 16,
      awayScore: 1,
      status: 'final',
      completed: true,
      source: 'espn'
    });
  });

  test('odds-shaped game produces ticket canonical key', () => {
    const converted = espnGamesToOddsScores(espnScoreboardToGames(BOS_NYY_FIXTURE), 'baseball_mlb');
    const g = converted[0];
    const date = String(g.commence_time || '').slice(0, 10);
    const key = g.sport_key + '|' + g.away_team + '|' + g.home_team + '|' + date;
    expect(key).toBe('baseball_mlb|Boston Red Sox|New York Yankees|2026-08-30');
  });
});
