/**
 * Unresolved asset queue — durable, deduped, no fuzzy image assign.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  recordUnresolved,
  loadQueue,
  classifySoccerMiss,
  classifyTennisMiss,
  REASON_CODES
} = require('../lib/unresolved-assets-queue');

describe('unresolved-assets-queue', () => {
  var tmp;

  beforeEach(() => {
    tmp = path.join(os.tmpdir(), 'pb-unresolved-' + Date.now() + '.json');
  });

  afterEach(() => {
    try { fs.unlinkSync(tmp); } catch (_e) {}
  });

  test('records and dedupes by sport+name', () => {
    recordUnresolved([
      { sport: 'soccer', entityName: 'Fake FC', reason: 'C' },
      { sport: 'soccer', entityName: 'Fake FC', reason: 'A' }
    ], { filePath: tmp });
    var q = loadQueue(tmp);
    expect(q.items.length).toBe(1);
    expect(q.items[0].seenCount).toBe(2);
    expect(q.items[0].reason).toBe('A');
    expect(q.items[0].reasonLabel).toBe(REASON_CODES.A);
  });

  test('classifiers map miss types', () => {
    expect(classifySoccerMiss('Arsenal U21', {})).toBe('H');
    expect(classifySoccerMiss('X', { broken: true })).toBe('E');
    expect(classifyTennisMiss('P', { espnId: '1', headshot404: true })).toBe('D');
  });

  test('never invents image URLs on unresolved records', () => {
    var q = recordUnresolved([
      { sport: 'tennis', entityName: 'Unknown Player', reason: 'D' }
    ], { filePath: tmp });
    expect(q.items[0].photoUrl).toBeFalsy();
    expect(q.items[0].logoUrl).toBeFalsy();
  });
});
