'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function idx(needle) {
  const i = src.indexOf(needle);
  if (i < 0) throw new Error('not found: ' + needle);
  return i;
}

test('express.json is registered before create-intent', function() {
  expect(idx("app.use(express.json({ limit:'100kb' }))"))
    .toBeLessThan(idx("app.post('/api/crypto/deposits/create-intent'"));
});

test('core middleware is registered before any app.get/post', function() {
  const firstRoute = Math.min(
    idx("app.post('/api/crypto/deposits/create-intent'"),
    idx("app.get('/api/health'")
  );
  expect(idx('app.use(requestIdMiddleware)')).toBeLessThan(firstRoute);
  expect(idx('app.use(_hardenedCors)')).toBeLessThan(firstRoute);
  expect(idx("app.use(express.json({ limit:'100kb' }))")).toBeLessThan(firstRoute);
  expect(idx('app.use(securityHeadersMiddleware)')).toBeLessThan(firstRoute);
  expect(idx('app.use(payloadSizeMiddleware)')).toBeLessThan(firstRoute);
  expect(idx('app.use(rateLimitMiddleware)')).toBeLessThan(firstRoute);
});

test('express.json is registered only once', function() {
  const re = /app\.use\(express\.json\(\{ limit:'100kb' \}\)\);/g;
  const matches = src.match(re) || [];
  expect(matches.length).toBe(1);
});
