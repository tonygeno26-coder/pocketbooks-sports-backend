/**
 * Phase-3 soccer board aliases from global asset recovery.
 */
const soccer = require('../lib/soccer-team-logos');

describe('soccer asset recovery aliases', () => {
  test('Fortuna Dusseldorf maps to Fortuna Düsseldorf', () => {
    expect(soccer.VERIFIED_ALIASES['Fortuna Dusseldorf']).toBe('Fortuna Düsseldorf');
  });
  test('Alaves maps to Alavés', () => {
    expect(soccer.VERIFIED_ALIASES['Alaves']).toBe('Alavés');
  });
  test('Malmo maps to Malmö FF or Malmö', () => {
    const t = soccer.VERIFIED_ALIASES['Malmo'];
    expect(t).toBeTruthy();
    expect(String(t).toLowerCase()).toMatch(/malm/);
  });
});
