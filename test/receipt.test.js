'use strict';
// The receipt is the one thing this app prints that somebody might paste into
// a channel, so the numbers on it have to be defensible: the column has to add
// up, the day has to end at midnight, and nothing may appear on the roll that
// the ledger cannot account for.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dayKey, emptyDay, note, rollover } = require('../src/brain/ledger');
const { receiptLines, receiptTeaser, W } = require('../src/brain/receipt');
const { reduce } = require('../src/brain/reducer');
const { defaultState } = require('../src/brain/state');
const { TUNING } = require('../src/shared/constants');
const { Brain } = require('../src/brain/brain');

const T0 = new Date(2026, 7, 14, 10, 30).getTime();   // local noon-ish, 14 Aug
const ctx = (now = T0) => ({ now, rng: () => 0.99, live: true });
const ev = (t, extra = {}, ts = T0) => Object.assign({ t, ts, sid: 's1' }, extra);
function fresh() { const s = defaultState(T0); s.lastTickAt = T0; rollover(s, T0); return s; }

// ---------------------------------------------------------------- the ledger
test('the day turns over at local midnight, not after 24 hours', () => {
  const s = fresh();
  note(s, 'commits', 3);
  assert.equal(s.day.commits, 3);
  // 23:59 the same evening is still the same day…
  rollover(s, new Date(2026, 7, 14, 23, 59).getTime());
  assert.equal(s.day.commits, 3, 'the day ended early');
  // …and one minute later it is not
  rollover(s, new Date(2026, 7, 15, 0, 1).getTime());
  assert.equal(s.day.commits, 0, 'yesterday leaked into today');
  assert.equal(s.day.key, dayKey(new Date(2026, 7, 15, 0, 1).getTime()));
});

test('a typo cannot invent a line item', () => {
  const s = fresh();
  note(s, 'flurbles', 5);
  assert.equal(s.day.flurbles, undefined);
  note(s, 'key', 1);
  assert.equal(s.day.key, dayKey(T0), 'the date got incremented as if it were a counter');
});

test('the reducer fills the till roll as the day happens', () => {
  const s = fresh();
  reduce(s, ev('UserPromptSubmit'), ctx());
  reduce(s, ev('PostToolUse', { tool: 'Edit', file: 'a.js', add: 3, del: 1 }), ctx());
  reduce(s, ev('PostToolUse', { tool: 'Edit', file: 'b.js', add: 90, del: 4 }), ctx());
  reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'git commit -m x' }), ctx());
  reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'npx jest', out: 'Tests: 9 passed, 9 total' }), ctx());
  assert.equal(s.day.prompts, 1);
  assert.equal(s.day.edits, 2);
  assert.equal(s.day.feasts, 1, 'a 94-line diff is a feast');
  assert.equal(s.day.commits, 1);
  assert.equal(s.day.testsGreen, 1);
  assert.ok(s.day.xp > 0, 'xp went unrecorded');
});

test('the longest green run of the day is kept, not the current one', () => {
  const s = fresh();
  const green = { tool: 'Bash', cmd: 'npx jest', out: 'Tests: 9 passed, 9 total' };
  for (let i = 0; i < 4; i++) reduce(s, ev('PostToolUse', green, T0 + i), ctx());
  reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'npx jest', out: 'Tests: 1 failed, 8 passed, 9 total', ok: false }), ctx());
  assert.equal(s.greenStreak, 0, 'the streak survived a red run');
  assert.equal(s.day.bestStreak, 4, 'the day forgot its best run');
});

// ---------------------------------------------------------------- the paper
test('the receipt balances: items + bonuses = total', () => {
  const day = Object.assign(emptyDay(T0), {
    edits: 10, commits: 2, testsGreen: 1, prompts: 4, xp: 0
  });
  // …exactly what those items are worth, plus 40 of something else
  day.xp = 10 * TUNING.xpPerEdit + 2 * TUNING.commit.xp + TUNING.testsGreenXp + 40;
  const lines = receiptLines(day, { name: 'Gogu', level: 3, now: T0 });
  const num = (label) => {
    const row = lines.find(l => l.startsWith(label));
    assert.ok(row, `no ${label} line`);
    return Number(row.replace(label, '').trim());
  };
  assert.equal(num('SUBTOTAL') + num('BONUSES & PATS'), num('TOTAL XP'));
  assert.equal(num('BONUSES & PATS'), 40);
  assert.equal(num('TOTAL XP'), day.xp);
});

test('nothing is priced at more than the brain actually pays', () => {
  const day = Object.assign(emptyDay(T0), { commits: 3, xp: 3 * TUNING.commit.xp });
  const line = receiptLines(day, { level: 1, now: T0 }).find(l => l.includes('COMMIT'));
  assert.match(line, new RegExp(`${3 * TUNING.commit.xp}$`), `commit row reads "${line}"`);
});

test('an item with no xp prints -- rather than a zero', () => {
  const day = Object.assign(emptyDay(T0), { prompts: 5, testsRed: 2, xp: 0 });
  const lines = receiptLines(day, { level: 1, now: T0 });
  assert.match(lines.find(l => l.includes('PROMPT FED')), /--$/);
  assert.match(lines.find(l => l.includes('TESTS RED')), /--$/);
});

test('an item that did not happen does not get a line', () => {
  const lines = receiptLines(Object.assign(emptyDay(T0), { commits: 1, xp: 25 }), { level: 1, now: T0 }).join('\n');
  assert.ok(!lines.includes('DEPLOY'), 'printed a deploy that never happened');
  assert.ok(lines.includes('COMMIT'));
});

test('an empty day still prints a receipt, and says it is empty', () => {
  const lines = receiptLines(emptyDay(T0), { name: 'Gogu', level: 0, now: T0 });
  assert.ok(lines.join('\n').includes('NOTHING YET TODAY'));
  assert.ok(lines.length > 10, 'an empty day printed a stub');
});

test('every line fits the paper, and none has a ragged edge', () => {
  const day = Object.assign(emptyDay(T0), {
    prompts: 999, edits: 999, commits: 999, testsGreen: 99, testsRed: 9,
    deploys: 9, prs: 9, treats: 9, pets: 99, todos: 99, releases: 9, feasts: 99,
    sick: 9, levels: 9, tokens: 12_345_678, bestStreak: 42, xp: 99_999
  });
  for (const line of receiptLines(day, { name: 'Bartholomew', level: 25, now: T0 })) {
    assert.ok(line.length <= W, `"${line}" is ${line.length} wide, paper is ${W}`);
    assert.equal(line, line.replace(/\s+$/, ''), `"${line}" has trailing space`);
  }
});

test('the same day always prints the same barcode', () => {
  const day = Object.assign(emptyDay(T0), { commits: 4, edits: 9, xp: 300 });
  const bar = (d) => receiptLines(d, { level: 2, now: T0 }).find(l => /[█▌│]/.test(l));
  assert.equal(bar(day), bar(day));
  assert.notEqual(bar(day), bar(Object.assign(emptyDay(T0), { commits: 5, edits: 9, xp: 300 })));
});

test('the teaser says the most interesting true thing, or admits there is none', () => {
  assert.equal(receiptTeaser(emptyDay(T0)), 'nothing yet today');
  assert.equal(receiptTeaser(null), 'nothing yet today');
  assert.match(receiptTeaser(Object.assign(emptyDay(T0), { commits: 1, xp: 25 })), /1 commit · 25 xp/);
  assert.match(receiptTeaser(Object.assign(emptyDay(T0), { prompts: 3, xp: 0 })), /3 prompts/);
});

// ---------------------------------------------------------------- the brain
test('the brain prints today, on demand, from its own state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-receipt-'));
  let now = T0;
  const brain = new Brain({ dir, settingsPath: path.join(dir, 's.json'), now: () => now, rng: () => 0.99 });
  brain.command({ type: 'setName', name: 'Rex' });
  brain.command({ type: 'treat' });
  const roll = brain.receipt().join('\n');
  assert.ok(roll.includes('CASHIER: REX'), roll.slice(0, 200));
  assert.ok(roll.includes('TREAT'));
  // …and tomorrow it is a fresh sheet
  now = new Date(2026, 7, 15, 9, 0).getTime();
  assert.ok(brain.receipt().join('\n').includes('NOTHING YET TODAY'), 'yesterday printed as today');
});
