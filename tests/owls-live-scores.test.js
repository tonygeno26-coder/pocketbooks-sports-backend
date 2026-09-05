'use strict';

const owlsLiveScores = require('../lib/owls-live-scores');

describe('owls-live-scores', function() {
  test('parse MLB live score event', function() {
    const ev = {
      id: 'mlb:Chicago Cubs@Miami Marlins-20260905',
      sourceMatchId: '697SyzSk',
      startTime: '2026-09-05T20:10:00.000Z',
      status: { state: 'in', detail: 'Top 4th', displayClock: null, period: 4 },
      home: { team: { displayName: 'Miami Marlins' }, score: 0 },
      away: { team: { displayName: 'Chicago Cubs' }, score: 3 },
      baseballDetail: { inning: 4, half: 'top' }
    };
    const p = owlsLiveScores.parseOwlsLiveScoreEvent(ev, 'mlb');
    expect(p.id).toBe(ev.id);
    expect(p.homeScore).toBe(0);
    expect(p.awayScore).toBe(3);
    expect(p.status).toBe('live');
    expect(p.inning).toBe(4);
    expect(p.inningHalf).toBe('top');
    expect(p.statusDetail).toBe('Top 4th');
  });

  test('parse tennis sets/game', function() {
    const ev = {
      id: 'tennis:A@B-20260905',
      startTime: '2026-09-05T19:05:00.000Z',
      status: { state: 'in', detail: 'Set 1', period: null },
      home: { team: { displayName: 'Bonzi B.' }, score: 0 },
      away: { team: { displayName: 'Khachanov K.' }, score: 2 },
      tennisDetail: {
        currentSet: 1,
        sets: [{ home: 3, away: 6 }, { home: 2, away: 6 }, { home: 4, away: 5 }],
        currentGameScore: { home: '0', away: '15' }
      }
    };
    const p = owlsLiveScores.parseOwlsLiveScoreEvent(ev, 'tennis');
    expect(p.setScore).toBe('2-0');
    expect(p.gameScore).toBe('15-0');
    expect(p.period).toBe(1);
  });

  test('parse soccer minute from incidents', function() {
    const ev = {
      id: 'soccer:A@B-20260905',
      startTime: '2026-09-05T20:00:00.000Z',
      status: { state: 'in', detail: 'Live', displayClock: null },
      home: { team: { displayName: 'Home FC' }, score: 1 },
      away: { team: { displayName: 'Away FC' }, score: 0 },
      incidents: [{ minute: 12, type: 'goal' }, { minute: 58, type: 'yellowCard' }]
    };
    const p = owlsLiveScores.parseOwlsLiveScoreEvent(ev, 'soccer');
    expect(p.clock).toBe("58'");
  });

  test('match prefers shared Owls eventId', function() {
    const idx = owlsLiveScores.indexOwlsLiveScores([{
      id: 'mlb:San Francisco Giants@New York Mets-20260905',
      startTime: '2026-09-05T20:10:00.000Z',
      status: { state: 'in', detail: 'Top 5th', period: 5 },
      home: { team: { displayName: 'New York Mets' }, score: 2 },
      away: { team: { displayName: 'San Francisco Giants' }, score: 3 }
    }], 'mlb');
    const game = {
      id: '1635864907',
      eventId: 'mlb:San Francisco Giants@New York Mets-20260905',
      home_team: 'New York Mets',
      away_team: 'San Francisco Giants',
      commence_time: '2026-09-05T20:10:00Z',
      status: 'live'
    };
    const m = owlsLiveScores.matchScoreToGame(game, idx);
    expect(m).toBeTruthy();
    expect(m.homeScore).toBe(2);
    expect(m.awayScore).toBe(3);
  });

  test('match exact team identity + start window (no fuzzy)', function() {
    const idx = owlsLiveScores.indexOwlsLiveScores([{
      id: 'soccer:Le Mans@Nice-20260905',
      startTime: '2026-09-05T18:00:00.000Z',
      status: { state: 'in', detail: 'Live' },
      home: { team: { displayName: 'Nice' }, score: 2 },
      away: { team: { displayName: 'Le Mans' }, score: 1 }
    }], 'soccer');
    expect(owlsLiveScores.matchScoreToGame({
      home_team: 'Nice',
      away_team: 'Le Mans',
      commence_time: '2026-09-05T18:00:00Z'
    }, idx)).toBeTruthy();
    expect(owlsLiveScores.matchScoreToGame({
      home_team: 'Nice United',
      away_team: 'Le Mans',
      commence_time: '2026-09-05T18:00:00Z'
    }, idx)).toBeNull();
    expect(owlsLiveScores.matchScoreToGame({
      home_team: 'Nice',
      away_team: 'Le Mans',
      commence_time: '2026-09-06T18:00:00Z'
    }, idx)).toBeNull();
  });

  test('match exact pair with home/away swapped (soccer)', function() {
    const idx = owlsLiveScores.indexOwlsLiveScores([{
      id: 'soccer:Gimnasia Mendoza@Boca Juniors-20260905',
      startTime: '2026-09-05T20:00:00.000Z',
      status: { state: 'in', detail: 'Live' },
      home: { team: { displayName: 'Boca Juniors' }, score: 1 },
      away: { team: { displayName: 'Gimnasia Mendoza' }, score: 0 }
    }], 'soccer');
    // Odds board has sides flipped vs scores feed, same kickoff.
    const m = owlsLiveScores.matchScoreToGame({
      home_team: 'Gimnasia Mendoza',
      away_team: 'Boca Juniors',
      commence_time: '2026-09-05T20:00:00Z'
    }, idx);
    expect(m).toBeTruthy();
    expect(m.orientationSwapped).toBe(true);
    // Remapped to odds orientation: Boca away scored 1, Gimnasia home scored 0
    expect(m.awayScore).toBe(1);
    expect(m.homeScore).toBe(0);
  });

  test('hydrate stamps scoreboard without touching markets', function() {
    const games = [{
      id: '1',
      eventId: 'mlb:A@B-20260905',
      sport_key: 'mlb',
      home_team: 'B',
      away_team: 'A',
      commence_time: '2026-09-05T20:10:00Z',
      status: 'live',
      isLive: true,
      markets: [{ marketType: 'moneyline', odds: -110 }]
    }];
    const idx = owlsLiveScores.indexOwlsLiveScores([{
      id: 'mlb:A@B-20260905',
      startTime: '2026-09-05T20:10:00.000Z',
      status: { state: 'in', detail: 'Bot 3rd', period: 3 },
      home: { team: { displayName: 'B' }, score: 4 },
      away: { team: { displayName: 'A' }, score: 1 },
      baseballDetail: { inning: 3, half: 'bottom' }
    }], 'mlb');
    const r = owlsLiveScores.hydrateGamesWithOwlsScores(games, { mlb: idx }, function() {
      return '▼ 3rd';
    });
    expect(r.matched).toBe(1);
    expect(games[0].homeScore).toBe(4);
    expect(games[0].awayScore).toBe(1);
    expect(games[0].markets[0].odds).toBe(-110);
    expect(games[0].gameStateText).toBe('▼ 3rd');
  });
});
