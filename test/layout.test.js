'use strict';
// The window box is a THREE-file agreement — art.js states it, main.js sizes
// the window with it, pet.js lays the contents out inside it — and nothing at
// runtime complains when they drift: you just get a pet with its head through
// the ceiling, or a tall invisible box that swallows clicks and refuses to be
// dragged near the top of the screen (macOS never places a window above the
// menu bar). So the agreement is checked here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const PetArt = require('../src/body/art');

test('the window is exactly as tall as the pet needs', () => {
  const { LAYOUT, GEOM, boxHeight } = PetArt;
  for (const [form, g] of Object.entries(GEOM)) {
    for (const scale of [1, 1.5, 2, 2.5]) {
      const h = boxHeight(form, scale);
      const feet = h - LAYOUT.footRoom;          // where pet.js plants the feet
      const head = feet - g.h * scale;
      assert.ok(head >= LAYOUT.bubbleRoom - 1,
        `${form} at ${scale}× leaves ${head}px above the head — the bubble won't fit`);
      assert.ok(head <= LAYOUT.bubbleRoom + LAYOUT.headGap * scale + 1,
        `${form} at ${scale}× wastes ${head}px of headroom nobody can drag past`);
    }
  }
  // The everyday case has to clear the menu bar by a sensible margin, or the
  // whole point of sizing the box is lost.
  assert.ok(boxHeight('senior', 1) < 240, `a senior at 1× still needs ${boxHeight('senior', 1)}px`);
});

test('main and the renderer size the box from the same table', () => {
  const main = read('main.js');
  const pet = read('body', 'pet.js');
  assert.match(main, /PetArt\.boxHeight\(/, 'main.js must ask art.js how tall the window is');
  assert.ok(!/PET_H|height:\s*4\d\d/.test(main), 'main.js still has a hardcoded window height');
  assert.match(pet, /PetArt\.LAYOUT\.footRoom/, 'pet.js retypes the foot margin instead of reading it');
  assert.match(pet, /PetArt\.LAYOUT\.headGap/, 'pet.js retypes the bubble gap instead of reading it');
  // The feet are the anchor on resize: a pet that jumps when it levels up or
  // when the size slider moves is a bug you can see.
  assert.match(main, /y: b\.y \+ b\.height - want/, 'a resize must keep the feet where they are');
  // …and across a restart, where the saved corner may belong to a box this
  // build no longer uses (every position on disk predates the sizing).
  assert.match(main, /brain\.prefs\.boxH \|\| LEGACY_BOX_H/, 'an upgraded pet would teleport up the screen');
});

test('a saved position carries the box it was a corner of', () => {
  const { Brain } = require('../src/brain/brain');
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-layout-'));
  const brain = new Brain({ dir, settingsPath: path.join(dir, 'claude-settings.json') });

  brain.command({ type: 'setPosition', position: { x: 40, y: 300 }, boxH: 214 });
  assert.deepEqual(brain.prefs.position, { x: 40, y: 300 });
  assert.equal(brain.prefs.boxH, 214);

  // An old prefs file has no box at all — that's the caller's problem to
  // default, but it must never be invented here.
  brain.command({ type: 'setPosition', position: { x: 41, y: 301 } });
  assert.equal(brain.prefs.boxH, 214, 'a move without a box must not clear the known one');
  assert.equal(brain.command({ type: 'setPosition', position: { x: 'x' } }).ok, true);
  assert.deepEqual(brain.prefs.position, { x: 41, y: 301 }, 'a malformed position is ignored');
});

test('the stats line is raised on hover, not worn permanently', () => {
  const pet = read('body', 'pet.js');
  const html = read('body', 'pet.html');
  assert.match(html, /#stats-zone\s*\{[^}]*opacity:\s*0/, 'the stats zone should start hidden');
  assert.match(html, /#stats-zone\.show/, 'nothing defines what a shown stats zone looks like');
  assert.match(pet, /statsZone\.classList\.toggle\('show'/, 'nothing ever raises the stats zone');
  // Driven by the cursor FEED, not by :hover — a click-through pet never gets
  // a mouseover, and that is precisely when it must still answer.
  assert.match(pet, /function updateHover/);
  assert.match(pet, /updateHover\(t, scale, feetY\)/, 'the hover check never runs');
  assert.ok(!/:hover/.test(html), 'CSS :hover cannot see a click-through window');
});
