/**
 * Unit tests for soccer crest strict resolution (no betting logic).
 */
'use strict';

const {
  buildResolverIndex,
  resolveTeamLogo,
  VERIFIED_ALIASES,
  AMBIGUOUS_BARE,
  normKey,
  pickLogoUrl
} = require('../lib/soccer-team-logos');

function row(id, name, aliases, extras) {
  return Object.assign({
    sport: 'soccer',
    provider: 'espn',
    provider_team_id: String(id),
    canonical_name: name,
    display_name: name,
    abbreviation: extras && extras.abbreviation,
    location: extras && extras.location,
    conference: extras && extras.conference,
    classification: (extras && extras.classification) || 'club',
    logo_url: 'https://a.espncdn.com/i/teamlogos/soccer/500/' + id + '.png',
    aliases: aliases || [],
    active: true
  }, extras || {});
}

const SAMPLE = [
  row(360, 'Manchester United', ['Man United', 'Man Utd', 'Manchester Utd'], { abbreviation: 'MAN' }),
  row(382, 'Manchester City', ['Man City'], { abbreviation: 'MCI' }),
  row(110, 'Internazionale', ['Inter Milan', 'Inter'], { abbreviation: 'INT' }),
  row(21987, 'Inter Miami CF', ['Inter Miami'], { abbreviation: 'MIA' }),
  row(3726, 'FC Inter Turku', [], { abbreviation: 'INT' }),
  row(103, 'AC Milan', ['Milan'], { abbreviation: 'MIL' }),
  row(86, 'Real Madrid', [], { abbreviation: 'RMA' }),
  row(89, 'Real Sociedad', [], { abbreviation: 'RSO' }),
  row(95, 'Real Valladolid', ['Valladolid'], { abbreviation: 'VLL' }),
  row(2250, 'Sporting CP', ['Sporting Lisbon', 'Sporting'], { abbreviation: 'SPO' }),
  row(191, 'Sporting Kansas City', ['Sporting KC', 'SKC'], { abbreviation: 'SKC' }),
  row(160, 'Paris Saint-Germain', ['PSG', 'Paris SG'], { abbreviation: 'PSG' }),
  row(132, 'Bayern München', ['Bayern Munich', 'Bayern'], { abbreviation: 'BAY' }),
  row(124, 'Borussia Dortmund', ['Dortmund'], { abbreviation: 'DOR' }),
  row(1068, 'Atlético Madrid', ['Atletico Madrid', 'Atleti'], { abbreviation: 'ATM' }),
  row(367, 'Tottenham Hotspur', ['Spurs', 'Tottenham'], { abbreviation: 'TOT' }),
  row(101, 'Rayo Vallecano', ['Vallecano', 'Rayo'], { abbreviation: 'RAY' }),
  row(153, 'FC Utrecht', ['Utrecht'], { abbreviation: 'UTR' }),
  row(133, 'Schalke 04', ['Schalke'], { abbreviation: 'SCH' }),
  row(164, 'Spain', [], {
    abbreviation: 'ESP',
    classification: 'national',
    logo_url: 'https://a.espncdn.com/i/teamlogos/countries/500/esp.png'
  })
];

describe('soccer-team-logos resolve', () => {
  const index = buildResolverIndex(SAMPLE);

  test('exact canonical match', () => {
    const r = resolveTeamLogo('Manchester United', index);
    expect(r.status).toBe('exact');
    expect(r.row.provider_team_id).toBe('360');
  });

  test('Man United alias does not hit Man City', () => {
    expect(resolveTeamLogo('Man United', index).row.provider_team_id).toBe('360');
    expect(resolveTeamLogo('Man City', index).row.provider_team_id).toBe('382');
  });

  test('Inter Milan vs Inter Miami never cross', () => {
    expect(resolveTeamLogo('Inter Milan', index).row.provider_team_id).toBe('110');
    expect(resolveTeamLogo('Inter Miami', index).row.provider_team_id).toBe('21987');
  });

  test('bare Inter is verified to Internazionale when alias present', () => {
    expect(resolveTeamLogo('Inter', index).row.provider_team_id).toBe('110');
  });

  test('Real Madrid vs Real Sociedad vs Real Valladolid', () => {
    expect(resolveTeamLogo('Real Madrid', index).row.provider_team_id).toBe('86');
    expect(resolveTeamLogo('Real Sociedad', index).row.provider_team_id).toBe('89');
    expect(resolveTeamLogo('Real Valladolid', index).row.provider_team_id).toBe('95');
  });

  test('Sporting CP vs Sporting KC', () => {
    expect(resolveTeamLogo('Sporting Lisbon', index).row.provider_team_id).toBe('2250');
    expect(resolveTeamLogo('Sporting KC', index).row.provider_team_id).toBe('191');
  });

  test('PSG / Bayern / Spurs / Dortmund aliases', () => {
    expect(resolveTeamLogo('PSG', index).row.provider_team_id).toBe('160');
    expect(resolveTeamLogo('Bayern Munich', index).row.provider_team_id).toBe('132');
    expect(resolveTeamLogo('Spurs', index).row.provider_team_id).toBe('367');
    expect(resolveTeamLogo('Dortmund', index).row.provider_team_id).toBe('124');
  });

  test('Vallecano alias → Rayo Vallecano', () => {
    expect(resolveTeamLogo('Vallecano', index).row.provider_team_id).toBe('101');
  });

  test('Utrecht → FC Utrecht', () => {
    expect(resolveTeamLogo('Utrecht', index).row.provider_team_id).toBe('153');
  });

  test('Draw stays unresolved (not a club)', () => {
    expect(resolveTeamLogo('Draw', index).status).toBe('unresolved');
  });

  test('national team crest preserved', () => {
    const r = resolveTeamLogo('Spain', index);
    expect(r.status).toBe('exact');
    expect(r.logoUrl).toContain('/countries/');
    expect(r.row.classification).toBe('national');
  });

  test('unknown club stays unresolved', () => {
    const r = resolveTeamLogo('Totally Fake FC', index);
    expect(r.status).toBe('unresolved');
    expect(r.row).toBeFalsy();
  });

  test('provider id mapping', () => {
    const r = resolveTeamLogo('ignored', index, '360');
    expect(r.status).toBe('provider_id');
    expect(r.logoUrl).toContain('/360.png');
  });

  test('normKey folds accents', () => {
    expect(normKey('Bayern München')).toBe(normKey('Bayern Munchen'));
    expect(normKey('Atlético Madrid')).toBe(normKey('Atletico Madrid'));
  });

  test('verified aliases table includes critical pairs', () => {
    expect(VERIFIED_ALIASES['Man United']).toBe('Manchester United');
    expect(VERIFIED_ALIASES['Man City']).toBe('Manchester City');
    expect(VERIFIED_ALIASES['Inter Milan']).toBe('Internazionale');
    expect(VERIFIED_ALIASES['Inter Miami']).toBe('Inter Miami CF');
    expect(VERIFIED_ALIASES['Sporting KC']).toBe('Sporting Kansas City');
    expect(AMBIGUOUS_BARE.inter.length).toBeGreaterThan(1);
  });

  test('pickLogoUrl prefers soccer crest for clubs', () => {
    const url = pickLogoUrl({
      id: '360',
      isNational: false,
      logos: [
        { href: 'https://a.espncdn.com/i/teamlogos/soccer/500-dark/360.png' },
        { href: 'https://a.espncdn.com/i/teamlogos/soccer/500/360.png' }
      ]
    });
    expect(url).toContain('/soccer/500/360.png');
  });
});
