/**
 * Unit tests for NCAAF team logo strict resolution (no betting logic).
 */
'use strict';

const {
  buildResolverIndex,
  resolveTeamLogo,
  VERIFIED_ALIASES,
  normKey,
  isSchoolTeam
} = require('../lib/ncaaf-team-logos');

function row(id, name, aliases, extras) {
  return Object.assign({
    sport: 'ncaaf',
    provider: 'espn',
    provider_team_id: String(id),
    canonical_name: name,
    display_name: name,
    abbreviation: extras && extras.abbreviation,
    location: extras && extras.location,
    logo_url: 'https://a.espncdn.com/i/teamlogos/ncaa/500/' + id + '.png',
    aliases: aliases || [],
    active: true
  }, extras || {});
}

const SAMPLE = [
  row(333, 'Alabama Crimson Tide', ['Alabama', 'ALA'], { abbreviation: 'ALA', location: 'Alabama' }),
  row(61, 'Georgia Bulldogs', ['Georgia', 'UGA'], { abbreviation: 'UGA', location: 'Georgia' }),
  row(2247, 'Georgia State Panthers', ['Georgia State', 'Georgia St'], { abbreviation: 'GAST', location: 'Georgia State' }),
  row(130, 'Michigan Wolverines', ['Michigan', 'MICH'], { abbreviation: 'MICH', location: 'Michigan' }),
  row(127, 'Michigan State Spartans', ['Michigan State', 'Michigan St', 'MSU'], { abbreviation: 'MSU', location: 'Michigan State' }),
  row(201, 'Oklahoma Sooners', ['Oklahoma', 'OU'], { abbreviation: 'OU', location: 'Oklahoma' }),
  row(197, 'Oklahoma State Cowboys', ['Oklahoma State', 'OKST'], { abbreviation: 'OKST', location: 'Oklahoma State' }),
  row(2390, 'Miami Hurricanes', ['Miami', 'Miami (FL)', 'MIA'], { abbreviation: 'MIA', location: 'Miami' }),
  row(193, 'Miami (OH) RedHawks', ['Miami (OH)', 'Miami OH', 'M-OH'], { abbreviation: 'M-OH', location: 'Miami (OH)' }),
  row(30, 'USC Trojans', ['USC', 'Southern California'], { abbreviation: 'USC', location: 'USC' }),
  row(2579, 'South Carolina Gamecocks', ['South Carolina'], { abbreviation: 'SC', location: 'South Carolina' }),
  row(264, 'Washington Huskies', ['Washington'], { abbreviation: 'WASH', location: 'Washington' }),
  row(265, 'Washington State Cougars', ['Washington State', 'WSU'], { abbreviation: 'WSU', location: 'Washington State' }),
  row(248, 'Houston Cougars', ['Houston'], { abbreviation: 'HOU', location: 'Houston' }),
  row(145, 'Ole Miss Rebels', ['Ole Miss', 'Mississippi'], { abbreviation: 'MISS', location: 'Ole Miss' }),
  row(2116, 'UCF Knights', ['UCF', 'Central Florida'], { abbreviation: 'UCF', location: 'UCF' }),
  row(2439, 'UNLV Rebels', ['UNLV'], { abbreviation: 'UNLV', location: 'UNLV' }),
  row(2638, 'UTEP Miners', ['UTEP'], { abbreviation: 'UTEP', location: 'UTEP' }),
  row(252, 'BYU Cougars', ['BYU'], { abbreviation: 'BYU', location: 'BYU' }),
  row(194, 'Ohio State Buckeyes', ['Ohio State', 'OSU'], { abbreviation: 'OSU', location: 'Ohio State' }),
  row(195, 'Ohio Bobcats', ['Ohio'], { abbreviation: 'OHIO', location: 'Ohio' })
];

describe('ncaaf-team-logos resolve', () => {
  const index = buildResolverIndex(SAMPLE);

  test('exact canonical match', () => {
    const r = resolveTeamLogo('Alabama Crimson Tide', index);
    expect(r.status).toBe('exact');
    expect(r.row.provider_team_id).toBe('333');
  });

  test('verified alias Miami → Hurricanes not Miami OH', () => {
    const r = resolveTeamLogo('Miami', index);
    expect(r.row.canonical_name).toBe('Miami Hurricanes');
    expect(r.row.provider_team_id).toBe('2390');
  });

  test('Miami (OH) stays RedHawks', () => {
    const r = resolveTeamLogo('Miami (OH)', index);
    expect(r.row.provider_team_id).toBe('193');
  });

  test('USC → Trojans not South Carolina', () => {
    expect(resolveTeamLogo('USC', index).row.provider_team_id).toBe('30');
    expect(resolveTeamLogo('South Carolina', index).row.provider_team_id).toBe('2579');
  });

  test('Washington pair does not cross-map', () => {
    expect(resolveTeamLogo('Washington', index).row.provider_team_id).toBe('264');
    expect(resolveTeamLogo('Washington State', index).row.provider_team_id).toBe('265');
  });

  test('Georgia pair does not cross-map', () => {
    expect(resolveTeamLogo('Georgia', index).row.provider_team_id).toBe('61');
    expect(resolveTeamLogo('Georgia State', index).row.provider_team_id).toBe('2247');
  });

  test('Michigan pair does not cross-map', () => {
    expect(resolveTeamLogo('Michigan', index).row.provider_team_id).toBe('130');
    expect(resolveTeamLogo('Michigan State', index).row.provider_team_id).toBe('127');
  });

  test('Oklahoma pair does not cross-map', () => {
    expect(resolveTeamLogo('Oklahoma', index).row.provider_team_id).toBe('201');
    expect(resolveTeamLogo('Oklahoma State', index).row.provider_team_id).toBe('197');
  });

  test('Ohio State vs Ohio', () => {
    expect(resolveTeamLogo('Ohio State', index).row.provider_team_id).toBe('194');
    expect(resolveTeamLogo('Ohio', index).row.provider_team_id).toBe('195');
  });

  test('unresolved unknown school stays unresolved', () => {
    const r = resolveTeamLogo('Totally Fake University', index);
    expect(r.status).toBe('unresolved');
    expect(r.row).toBeFalsy();
  });

  test('provider id mapping', () => {
    const r = resolveTeamLogo('ignored', index, '68');
    // id 68 not in sample
    expect(r.status).toBe('unresolved');
    const r2 = resolveTeamLogo('ignored', index, '333');
    expect(r2.status).toBe('provider_id');
    expect(r2.logoUrl).toContain('/333.png');
  });

  test('normKey folds punctuation', () => {
    expect(normKey("Hawai'i")).toBe(normKey('Hawaii'));
    expect(normKey('Texas A&M')).toBe('texasam');
  });

  test('isSchoolTeam filters all-stars', () => {
    expect(isSchoolTeam({ id: '333', displayName: 'Alabama Crimson Tide' })).toBe(true);
    expect(isSchoolTeam({ id: '3144', displayName: 'SOUTH All-Stars' })).toBe(false);
  });

  test('VERIFIED_ALIASES covers key abbrevs', () => {
    expect(VERIFIED_ALIASES.UCF).toBe('UCF Knights');
    expect(VERIFIED_ALIASES['Ole Miss']).toBe('Ole Miss Rebels');
    expect(VERIFIED_ALIASES.UNLV).toBe('UNLV Rebels');
  });
});
