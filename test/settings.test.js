'use strict';
// The settings window is markup on one side and a script on the other, and
// nothing checks that they still agree: a section moved into the wrong tab
// still renders, and an id that lost its element throws once, at load, into a
// devtools console nobody has open — after which every control in the window
// is dead. So the seam is checked here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'settings');
const html = fs.readFileSync(path.join(DIR, 'settings.html'), 'utf8');
const js = fs.readFileSync(path.join(DIR, 'settings.js'), 'utf8');

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

test('every element the script reaches for exists in the page', () => {
  const wanted = [...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
  assert.ok(wanted.length > 20, `only ${wanted.length} lookups — did the parse break?`);
  for (const id of new Set(wanted)) {
    assert.ok(ids.has(id), `settings.js reads #${id}, which the page does not have`);
  }
});

test('no id is used twice', () => {
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const dupes = all.filter((x, i) => all.indexOf(x) !== i);
  assert.deepEqual([...new Set(dupes)], [], 'duplicate ids: the second one is unreachable');
});

// ---------------------------------------------------------------- the tabs
const tabs = [...html.matchAll(/<button class="tab" id="tab-([a-z]+)"[^>]*data-panel="([a-z]+)"[^>]*>/g)];
const panels = [...html.matchAll(/<div class="panel" id="panel-([a-z]+)"([^>]*)>/g)];

test('every tab has a panel and every panel has a tab', () => {
  assert.ok(tabs.length >= 3, `found ${tabs.length} tabs`);
  assert.deepEqual(tabs.map(t => t[2]), tabs.map(t => t[1]), 'a tab points at a panel that is not its own');
  assert.deepEqual(panels.map(p => p[1]), tabs.map(t => t[1]), 'tabs and panels are out of step');
  // exactly one panel is open on load, and it is the first tab's
  const open = panels.filter(p => !/\bhidden\b/.test(p[2])).map(p => p[1]);
  assert.deepEqual(open, [tabs[0][1]], 'the window must open on exactly one panel');
  const selected = tabs.filter(t => /aria-selected="true"/.test(t[0]));
  assert.equal(selected.length, 1, 'exactly one tab may start selected');
  assert.equal(selected[0][1], tabs[0][1], 'the selected tab is not the open panel');
});

test('every section lives inside a tab, and every tab has something in it', () => {
  // A section left outside the panels renders under all three tabs at once,
  // which looks like a bug and behaves like one.
  const total = [...html.matchAll(/<div class="section">/g)].length;
  assert.ok(total >= 8, `found ${total} sections`);
  let counted = 0;
  for (let i = 0; i < panels.length; i++) {
    const from = panels[i].index;
    const to = i + 1 < panels.length ? panels[i + 1].index : html.indexOf('<div id="hint"');
    const n = [...html.slice(from, to).matchAll(/<div class="section">/g)].length;
    assert.ok(n > 0, `the ${panels[i][1]} tab is empty`);
    counted += n;
  }
  assert.equal(counted, total, 'a section is stranded outside the tabs');
});

test('the debug controls all live in the debug tab', () => {
  // The point of the split: nothing that fakes state may sit in a tab someone
  // opens to rename their pet.
  const start = html.indexOf('<div class="panel" id="panel-debug"');
  assert.ok(start > 0, 'no debug panel');
  const before = html.slice(0, start);
  for (const m of before.matchAll(/id="(dbg-[a-z0-9]+|debug-[a-z]+)"/g)) {
    assert.fail(`#${m[1]} is a debug control outside the debug tab`);
  }
});
