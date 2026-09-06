/**
 * Unit tests for MMA fighter photo sync helpers (no network / no DB).
 */
'use strict';

const {
  normName,
  headshotUrl,
  buildSearchUrls,
  collectFighterNamesFromGames
} = require('../lib/mma-fighter-photos');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

console.log('\n🥊 MMA fighter photos\n');

(function testNorm() {
  assert(normName("Sean O'Malley") === 'sean o malley', 'norm apostrophe');
  assert(normName('Jiří Procházka') === 'jiri prochazka', 'norm accents');
  console.log('  ✅ name normalization');
})();

(function testHeadshot() {
  assert(headshotUrl('2335639') === 'https://a.espncdn.com/i/headshots/mma/players/full/2335639.png');
  console.log('  ✅ headshot URL');
})();

(function testSearchUrls() {
  var urls = buildSearchUrls('Jon Jones');
  assert(urls.some(function (u) {
    return u.indexOf('query=Jon%20Jones%20mma') >= 0 && u.indexOf('sport=mma') >= 0 && u.indexOf('type=athlete') >= 0;
  }), 'task-style athlete URL missing');
  assert(urls.some(function (u) {
    return u.indexOf('type=player') >= 0 && u.indexOf('site.web.api.espn.com') >= 0;
  }), 'web player search URL missing');
  console.log('  ✅ ESPN search URL builders');
})();

(function testCollect() {
  var names = collectFighterNamesFromGames([
    { home: 'Jon Jones', away: 'Stipe Miocic' },
    { home_team: 'Islam Makhachev', away_team: 'Arman Tsarukyan' },
    { home: '12.5', away: 'Jamahal Hill' }
  ]);
  assert(names.indexOf('Jon Jones') >= 0);
  assert(names.indexOf('Islam Makhachev') >= 0);
  assert(names.indexOf('Jamahal Hill') >= 0);
  assert(names.indexOf('12.5') < 0, 'numeric junk should be filtered');
  assert(names.filter(function (n) { return n === 'Jamahal Hill'; }).length === 1, 'dedupe Jamahal');
  console.log('  ✅ collect fighter names from games');
})();

console.log('\nAll MMA fighter photo unit tests passed\n');
