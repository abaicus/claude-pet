'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LogTailer } = require('../src/brain/tailer');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-tail-'));
  return path.join(dir, 'events.jsonl');
}
function line(obj) { return JSON.stringify(obj) + '\n'; }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

test('replays events queued before start (closed-app catch-up)', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, line({ t: 'A' }) + line({ t: 'B' }));
  const tailer = new LogTailer({ file, offset: 0 });
  const got = [];
  let replayFlag = null;
  tailer.on('events', (evs, meta) => { got.push(...evs); replayFlag = meta.replay; });
  tailer.start();
  await wait(50);
  tailer.stop();
  assert.deepEqual(got.map(e => e.t), ['A', 'B']);
  assert.equal(replayFlag, true);
});

test('starts from saved cursor offset — no double feed', async () => {
  const file = tmpFile();
  const first = line({ t: 'A' });
  fs.writeFileSync(file, first + line({ t: 'B' }));
  const tailer = new LogTailer({ file, offset: Buffer.byteLength(first) });
  const got = [];
  tailer.on('events', evs => got.push(...evs));
  tailer.start();
  await wait(50);
  tailer.stop();
  assert.deepEqual(got.map(e => e.t), ['B']);
});

test('picks up appended events and reports cursor', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '');
  const tailer = new LogTailer({ file, offset: 0 });
  const got = [];
  let cursor = 0;
  tailer.on('events', evs => got.push(...evs));
  tailer.on('cursor', c => { cursor = c; });
  tailer.start();
  await wait(30);
  fs.appendFileSync(file, line({ t: 'X' }));
  await wait(200);
  fs.appendFileSync(file, line({ t: 'Y' }) + line({ t: 'Z' }));
  await wait(200);
  tailer.stop();
  assert.deepEqual(got.map(e => e.t), ['X', 'Y', 'Z']);
  assert.equal(cursor, fs.statSync(file).size);
});

test('partial lines are buffered until complete', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '');
  const tailer = new LogTailer({ file, offset: 0 });
  const got = [];
  tailer.on('events', evs => got.push(...evs));
  tailer.start();
  await wait(30);
  const full = JSON.stringify({ t: 'partial', n: 42 });
  fs.appendFileSync(file, full.slice(0, 10)); // incomplete, no newline
  await wait(200);
  assert.equal(got.length, 0, 'no event from a half-written line');
  fs.appendFileSync(file, full.slice(10) + '\n');
  await wait(200);
  tailer.stop();
  assert.equal(got.length, 1);
  assert.equal(got[0].n, 42);
});

test('recovers from truncation', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, line({ t: 'old1' }) + line({ t: 'old2' }));
  const tailer = new LogTailer({ file, offset: 0 });
  const got = [];
  tailer.on('events', evs => got.push(...evs));
  tailer.start();
  await wait(50);
  fs.writeFileSync(file, line({ t: 'fresh' })); // rotated/truncated
  await wait(200);
  tailer.stop();
  assert.deepEqual(got.map(e => e.t), ['old1', 'old2', 'fresh']);
});

test('skips corrupt lines without dying', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, line({ t: 'good' }) + 'not json at all\n' + line({ t: 'alsoGood' }));
  const tailer = new LogTailer({ file, offset: 0 });
  const got = [];
  tailer.on('events', evs => got.push(...evs));
  tailer.start();
  await wait(50);
  tailer.stop();
  assert.deepEqual(got.map(e => e.t), ['good', 'alsoGood']);
});

test('missing file is fine; events appear when it is created', async () => {
  const file = tmpFile();
  const tailer = new LogTailer({ file, offset: 0 });
  const got = [];
  tailer.on('events', evs => got.push(...evs));
  tailer.start();
  await wait(30);
  fs.writeFileSync(file, line({ t: 'born' }));
  await wait(200);
  tailer.stop();
  assert.deepEqual(got.map(e => e.t), ['born']);
});
