#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const testsDir = path.join(root, 'tests');
const mode = process.argv[2] || 'all';

if (!['all', 'unit', 'harness'].includes(mode)) {
  console.error('Usage: node scripts/run-tests.js [unit|harness]');
  process.exit(2);
}

const files = fs.readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

function isJestSuite(name) {
  const source = fs.readFileSync(path.join(testsDir, name), 'utf8');
  const usesJestGlobals =
    /\bexpect\s*\(|\bjest\.|\b(?:before|after)(?:All|Each)\s*\(/.test(source);
  const usesGlobalTest =
    /\btest\s*\(/.test(source)
    && !/\b(?:async\s+)?function\s+test\s*\(|\b(?:const|let|var)\s+test\s*=/.test(source);
  return usesJestGlobals || usesGlobalTest;
}

const jestSuites = files.filter(isJestSuite);
const harnesses = files.filter((name) => !isJestSuite(name));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

if (mode === 'all' || mode === 'unit') {
  if (!jestSuites.length) {
    console.error('No Jest suites discovered.');
    process.exit(1);
  }
  console.log(`\nRunning ${jestSuites.length} Jest suites (top-level tests only)...`);
  run(process.execPath, [
    path.join(root, 'node_modules', 'jest', 'bin', 'jest.js'),
    '--runInBand',
    '--testTimeout=15000',
    '--runTestsByPath',
    ...jestSuites.map((name) => path.join('tests', name))
  ]);
}

if (mode === 'all' || mode === 'harness') {
  console.log(`\nRunning ${harnesses.length} standalone test harnesses...`);
  harnesses.forEach((name) => {
    console.log(`\n── ${name} ──`);
    run(process.execPath, [path.join('tests', name)]);
  });
}

console.log(`\nAll ${mode} tests passed.`);
