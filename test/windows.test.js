'use strict';
// The settings and onboarding windows are markup on one side and a script on
// the other, and nothing checks that they still agree: a section moved into
// the wrong tab still renders, and an id that lost its element throws once, at
// load, into a devtools console nobody has open — after which every control in
// that window is dead. So the seams are checked here, along with the one
// boolean the intro turns on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (dir, file) => fs.readFileSync(path.join(SRC, dir, file), 'utf8');
const html = read('settings', 'settings.html');
const js = read('settings', 'settings.js');

// Both hand-drawn windows are the same kind of pairing, and break the same way.
const PAGES = [
  { name: 'settings', html, js, minLookups: 20 },
  { name: 'onboarding', html: read('onboarding', 'onboarding.html'), js: read('onboarding', 'onboarding.js'), minLookups: 8 }
];

for (const page of PAGES) {
  const pageIds = new Set([...page.html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

  test(`${page.name}: every element the script reaches for exists in the page`, () => {
    const wanted = [...page.js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
    assert.ok(wanted.length >= page.minLookups, `only ${wanted.length} lookups — did the parse break?`);
    for (const id of new Set(wanted)) {
      assert.ok(pageIds.has(id), `${page.name}.js reads #${id}, which the page does not have`);
    }
  });

  test(`${page.name}: no id is used twice`, () => {
    const all = [...page.html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    const dupes = all.filter((x, i) => all.indexOf(x) !== i);
    assert.deepEqual([...new Set(dupes)], [], 'duplicate ids: the second one is unreachable');
  });

  test(`${page.name}: every script it loads is really there`, () => {
    const dir = path.join(SRC, page.name);
    for (const m of page.html.matchAll(/<script src="([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.resolve(dir, m[1])), `${page.name}.html loads ${m[1]}, which does not exist`);
    }
  });
}

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

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

// ---------------------------------------------------------------- the intro
// The whole feature is one boolean: get it wrong in either direction and the
// intro either never appears or appears forever.
test('the intro runs once, and only for a genuinely new pet', () => {
  const { defaultPrefs, migratePrefs } = require('../src/brain/state');
  assert.equal(defaultPrefs().onboarded, false, 'a fresh install must be greeted');
  // …but a prefs file written before the intro existed belongs to somebody who
  // already has a pet, and greeting them would be a lie.
  assert.equal(migratePrefs({ name: 'Rex', scale: 1.5 }).onboarded, true);
  // an intro that was genuinely left unfinished still comes back
  assert.equal(migratePrefs({ name: 'Rex', onboarded: false }).onboarded, false);
  assert.equal(migratePrefs(null).onboarded, false, 'no file at all is a first launch');
});

test('finishing the intro is a real command, and it sticks', () => {
  const { Brain } = require('../src/brain/brain');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-intro-'));
  const brain = new Brain({ dir, settingsPath: path.join(dir, 'claude-settings.json') });
  assert.equal(brain.prefs.onboarded, false);
  assert.equal(brain.getRenderState().onboarded, false, 'the window has to be able to see it');
  assert.equal(brain.command({ type: 'completeOnboarding' }).ok, true);
  assert.equal(brain.prefs.onboarded, true);
  assert.ok(brain.bubble && /Gogu/.test(brain.bubble.text), 'it should say hello, by name');
  // replaying it from the menu is not a second hatching
  brain.bubble = null;
  brain.command({ type: 'completeOnboarding' });
  assert.equal(brain.bubble, null);
});

test('main opens the intro on a first launch and never traps the user in it', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.match(main, /if \(!brain\.prefs\.onboarded\) createOnboardingWindow\(\)/,
    'nothing opens the intro');
  assert.match(main, /if \(brain && !brain\.prefs\.onboarded\) brain\.command\(\{ type: 'completeOnboarding' \}\)/,
    'closing the window must count as done, or it reopens forever');
  assert.match(main, /label: 'Intro…'/, 'no way back to it once dismissed');
  // the pet window is not the only one that needs fresh state
  const fanout = main.match(/for \(const win of \[([^\]]+)\]\)/);
  assert.ok(fanout, 'nothing broadcasts state to the windows');
  for (const w of ['petWin', 'settingsWin', 'onboardWin']) {
    assert.ok(fanout[1].includes(w), `${w} would never see a state change`);
  }
});

test('the pet stays backstage until the intro is over', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.match(main, /waitingForIntro = !brain\.prefs\.onboarded/,
    'nothing decides whether the curtain is down');
  assert.match(main, /show: !waitingForIntro/,
    'the pet window would open on top of its own introduction');
  assert.match(main, /if \(!waitingForIntro \|\| !state\.onboarded\) return;[\s\S]*?showInactive\(\)/,
    'the curtain never lifts — the pet would be invisible after the intro');
  // The state that ends the intro is also the one carrying the hatch party and
  // the hello bubble, and a hidden window is not rendering to play them.
  const body = main.slice(main.indexOf('function broadcast(state)'));
  assert.ok(body.indexOf('revealPetAfterIntro(state)') < body.indexOf('for (const win of'),
    'the pet is shown after its own greeting has already been sent');
  // …and an unclickable, invisible pet with a stuck curtain needs a way out.
  assert.match(main, /waitingForIntro = false; \/\/ asking for the pet by hand/,
    '"Show pet" during the intro would be undone by the reveal');
});

test('the intro can only send commands the brain actually has', () => {
  const brainSrc = fs.readFileSync(path.join(SRC, 'brain', 'brain.js'), 'utf8');
  const known = new Set([...brainSrc.matchAll(/case '([a-zA-Z]+)':/g)].map(m => m[1]));
  const obJs = read('onboarding', 'onboarding.js');
  const sent = [...obJs.matchAll(/command\(\{ type: '([a-zA-Z]+)'/g)].map(m => m[1]);
  assert.ok(sent.length >= 4, `only ${sent.length} commands — did the parse break?`);
  for (const t of new Set(sent)) assert.ok(known.has(t), `the intro sends '${t}', which the brain ignores`);
});
