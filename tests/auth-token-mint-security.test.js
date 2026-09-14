'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf("app.post('/api/auth/token'");
const end = source.indexOf("app.post('/api/dev/host-token'", start);
const route = source.slice(start, end);

assert.ok(start >= 0 && end > start, 'auth/token route missing');
assert.ok(route.includes('if (IS_PRODUCTION)'), 'production token mint must have an auth gate');
assert.ok(route.includes('const requester = requireActor(req)'), 'token mint must require an actor');
assert.ok(route.includes('jwt.verify(loginToken, JWT_SECRET)'),
  'legacy login token must be signature-verified before minting');
assert.ok(route.includes("error:'invalid_login_token'"), 'invalid login token must fail closed');
assert.ok(route.includes("error:'token_subject_mismatch'"),
  'requester cannot mint a different actor subject');
assert.ok(
  route.indexOf('requireActor(req)') < route.indexOf('_resolveTokenRole('),
  'authentication must happen before membership/role resolution'
);
assert.ok(
  route.indexOf('_resolveTokenRole(') < route.indexOf('issueSessionToken('),
  'membership must still be resolved before issuance'
);

console.log('auth-token mint security: PASS');
