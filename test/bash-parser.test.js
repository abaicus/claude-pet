'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifyBash, parseTestOutput } = require('../src/brain/bash-parser');

test('commit detected', () => {
  assert.equal(classifyBash('git commit -m "feat: x"').kind, 'commit');
  assert.equal(classifyBash('git add -A && git commit -m msg').kind, 'commit');
  assert.equal(classifyBash('git commit --amend --no-edit').kind, 'commit');
});

test('failed commit is not a party', () => {
  assert.equal(classifyBash('git commit -m x', 'nothing to commit, working tree clean').kind, 'commit-failed');
  assert.equal(classifyBash('git commit -m x', '', false).kind, 'commit-failed');
});

test('commit beats push in one command (first match wins)', () => {
  assert.equal(classifyBash('git commit -m x && git push').kind, 'commit');
});

test('jest output green/red', () => {
  const green = 'Test Suites: 3 passed, 3 total\nTests:       27 passed, 27 total\nTime: 2s';
  const red = 'Test Suites: 1 failed, 3 total\nTests:       3 failed, 24 passed, 27 total';
  let r = classifyBash('npx jest', green);
  assert.equal(r.kind, 'tests-green');
  assert.equal(r.counts.passed, 27);
  r = classifyBash('npx jest', red, false);
  assert.equal(r.kind, 'tests-red');
  assert.equal(r.counts.failed, 3);
});

test('vitest output', () => {
  let r = classifyBash('vitest run', ' Test Files  2 passed (2)\n      Tests  10 passed (10)');
  assert.equal(r.kind, 'tests-green');
  assert.equal(r.counts.passed, 10);
  r = classifyBash('vitest run', ' Tests  2 failed | 8 passed (10)', false);
  assert.equal(r.kind, 'tests-red');
  assert.equal(r.counts.failed, 2);
});

test('pytest output', () => {
  let r = classifyBash('pytest', '========== 40 passed in 1.24s ==========');
  assert.equal(r.kind, 'tests-green');
  assert.equal(r.counts.passed, 40);
  r = classifyBash('pytest -x', '===== 2 failed, 38 passed in 3.1s =====', false);
  assert.equal(r.kind, 'tests-red');
  assert.equal(r.counts.failed, 2);
});

test('mocha output', () => {
  let r = classifyBash('npm test', '  14 passing (230ms)');
  assert.equal(r.kind, 'tests-green');
  r = classifyBash('npm test', '  12 passing (230ms)\n  2 failing', false);
  assert.equal(r.kind, 'tests-red');
  assert.equal(r.counts.failed, 2);
});

test('cargo test output', () => {
  let r = classifyBash('cargo test', 'test result: ok. 31 passed; 0 failed; 0 ignored');
  assert.equal(r.kind, 'tests-green');
  assert.equal(r.counts.passed, 31);
  r = classifyBash('cargo test', 'test result: FAILED. 29 passed; 2 failed; 0 ignored', false);
  assert.equal(r.kind, 'tests-red');
});

test('go test output', () => {
  let r = classifyBash('go test ./...', 'ok  \tgithub.com/x/pkg\t0.32s');
  assert.equal(r.kind, 'tests-green');
  r = classifyBash('go test ./...', '--- FAIL: TestThing (0.00s)\nFAIL\nexit status 1', false);
  assert.equal(r.kind, 'tests-red');
});

test('node:test TAP output', () => {
  let r = classifyBash('node --test', '# tests 12\n# pass 12\n# fail 0');
  assert.equal(r.kind, 'tests-green');
  assert.equal(r.counts.passed, 12);
  r = classifyBash('node --test', '# tests 12\n# pass 10\n# fail 2', false);
  assert.equal(r.kind, 'tests-red');
});

test('test runner with no parseable summary trusts exit status', () => {
  assert.equal(classifyBash('npm test', 'something weird', false).kind, 'tests-red');
  assert.equal(classifyBash('npm test', 'something weird', true).kind, 'tests-unknown');
});

test('pr create and merge', () => {
  assert.equal(classifyBash('gh pr create --title x').kind, 'pr-create');
  assert.equal(classifyBash('gh pr merge 12 --squash').kind, 'pr-merge');
});

test('deploys', () => {
  assert.equal(classifyBash('vercel --prod').kind, 'deploy');
  assert.equal(classifyBash('wrangler deploy').kind, 'deploy');
  assert.equal(classifyBash('npm run deploy').kind, 'deploy');
  assert.equal(classifyBash('kubectl apply -f k8s/').kind, 'deploy');
});

test('push / merge / rebase / install / branch / stash / build', () => {
  assert.equal(classifyBash('git push origin main').kind, 'push');
  assert.equal(classifyBash('git merge feature/x').kind, 'merge');
  assert.equal(classifyBash('git rebase main').kind, 'merge');
  assert.equal(classifyBash('npm install lodash').kind, 'install');
  assert.equal(classifyBash('pip install requests').kind, 'install');
  assert.equal(classifyBash('git checkout -b feat/new').kind, 'branch');
  assert.equal(classifyBash('git switch -c feat/new').kind, 'branch');
  assert.equal(classifyBash('git stash').kind, 'stash');
  assert.equal(classifyBash('npm run build').kind, 'build');
  assert.equal(classifyBash('cargo build --release').kind, 'build');
});

test('rm -rf flinch', () => {
  assert.equal(classifyBash('rm -rf node_modules').kind, 'rm-rf');
  assert.equal(classifyBash('rm -fr build/').kind, 'rm-rf');
  assert.equal(classifyBash('rm -r -f dist').kind, 'rm-rf');
});

test('plain commands are null', () => {
  assert.equal(classifyBash('ls -la'), null);
  assert.equal(classifyBash('cat foo.txt'), null);
  assert.equal(classifyBash('git status'), null);
  assert.equal(classifyBash('rm file.txt'), null);
});

test('parseTestOutput returns null on garbage', () => {
  assert.equal(parseTestOutput('hello world'), null);
  assert.equal(parseTestOutput(''), null);
});
