'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf("app.get('/api/grade/status'");
const end = source.indexOf("app.get('/api/host/unresolved-grading'", start);
const route = source.slice(start, end);

assert.ok(start >= 0 && end > start, 'grade status route missing');
assert.ok(route.includes(".select('created_at')"), 'status may only read grade timestamp');
assert.ok(route.includes("head:true"), 'active count must not load ticket rows');
assert.ok(!route.includes('recentGrades'), 'public response must not expose grade rows');
assert.ok(!route.includes('ticket_id'), 'public route must not select ticket IDs');
assert.ok(!route.includes('player_id'), 'public route must not select player IDs');
assert.ok(!route.includes('payload'), 'public route must not select audit payloads');

console.log('grade-status redaction: PASS');
