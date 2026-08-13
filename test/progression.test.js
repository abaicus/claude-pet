'use strict';
// The ladder, the forms and the wardrobe are three tables that have to agree
// with each other and with the art file — and every disagreement here is
// silent at runtime: a level nobody can reach, an accessory that equips and
// draws nothing, a form with no silhouette. So they are checked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const C = require('../src/shared/constants');
const PetArt = require('../src/body/art');
const artSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'body', 'art.js'), 'utf8');

// The ladder as it shipped. A pet that has earned level 7 must still be level
// 7 after any future edit to XP_LADDER — re-spacing rungs is a silent demotion
// of every pet already on them.
const SHIPPED = [0, 50, 120, 250, 450, 700, 1000, 1500, 2200, 3000, 4200];

test('the xp ladder only ever grows at the top', () => {
  assert.deepEqual(C.XP_LADDER.slice(0, SHIPPED.length), SHIPPED,
    'the rungs pets are already standing on may not move');
  assert.ok(C.MAX_LEVEL >= 25, `only ${C.MAX_LEVEL} levels`);
  for (let i = 1; i < C.XP_LADDER.length; i++) {
    assert.ok(C.XP_LADDER[i] > C.XP_LADDER[i - 1], `rung ${i} does not go up`);
    // …and no rung may be more than twice the one before it: a wall is not a
    // level, it is where people stop.
    if (i > 1) {
      const step = C.XP_LADDER[i] - C.XP_LADDER[i - 1];
      const prev = C.XP_LADDER[i - 1] - C.XP_LADDER[i - 2];
      assert.ok(step <= prev * 2, `level ${i} costs ${step} xp after a ${prev} xp step`);
    }
  }
  assert.equal(C.levelForXp(C.XP_LADDER[C.MAX_LEVEL]), C.MAX_LEVEL);
  assert.equal(C.levelForXp(C.XP_LADDER[C.MAX_LEVEL] * 10), C.MAX_LEVEL, 'the top holds');
});

test('every level has a form, and no form is unreachable', () => {
  const seen = new Set();
  let prev = null;
  for (let lvl = 0; lvl <= C.MAX_LEVEL; lvl++) {
    const form = C.formForLevel(lvl);
    assert.ok(C.FORMS.includes(form), `level ${lvl} is a '${form}', which is not a form`);
    assert.ok(PetArt.GEOM[form], `'${form}' has no silhouette in art.js`);
    // forms only ever move forward down the ladder
    if (prev && form !== prev) assert.ok(!seen.has(form), `'${form}' comes back at level ${lvl}`);
    seen.add(form); prev = form;
  }
  assert.equal(seen.size, C.FORMS.length, `unreachable forms: ${C.FORMS.filter(f => !seen.has(f))}`);
  // the frozen part of the ladder: an elder must not wake up a senior
  assert.equal(C.formForLevel(0), 'egg');
  assert.equal(C.formForLevel(1), 'hatchling');
  assert.equal(C.formForLevel(3), 'junior');
  assert.equal(C.formForLevel(6), 'senior');
  assert.equal(C.formForLevel(9), 'elder');
  assert.equal(C.formForLevel(10), 'elder', 'the old level cap kept its form');
});

test('every level from 1 up unlocks something to wear', () => {
  const byLevel = new Map();
  for (const a of C.ACCESSORIES) {
    assert.ok(a.level >= 1 && a.level <= C.MAX_LEVEL, `${a.id} unlocks at lv.${a.level}`);
    byLevel.set(a.level, (byLevel.get(a.level) || 0) + 1);
  }
  const bare = [];
  for (let lvl = 1; lvl <= C.MAX_LEVEL; lvl++) if (!byLevel.has(lvl)) bare.push(lvl);
  assert.deepEqual(bare, [], `levels that hand you nothing: ${bare.join(', ')}`);
  const ids = C.ACCESSORIES.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate accessory id');
});

test('every accessory the settings window offers, the art file can draw', () => {
  // An unknown id falls through drawAccessory's switch in silence: the brain
  // equips it, the chip lights up, and the pet wears nothing.
  const drawable = new Set([...artSrc.matchAll(/case '([a-z]+)':/g)].map(m => m[1]));
  for (const a of C.ACCESSORIES) {
    assert.ok(drawable.has(a.id), `'${a.id}' equips but draws nothing`);
  }
  // …and nothing is drawn that cannot be equipped
  const equippable = new Set(C.ACCESSORIES.map(a => a.id));
  const behind = artSrc.match(/const BEHIND = new Set\(\[([^\]]*)\]\)/)[1];
  for (const m of behind.matchAll(/'([a-z]+)'/g)) {
    assert.ok(equippable.has(m[1]), `BEHIND lists '${m[1]}', which is not an accessory`);
  }
});

test('no form outgrows its own window', () => {
  // GEOM is what main.js sizes the window from; the mask is what actually
  // gets painted. A crest or an ear that reaches past the box pokes through
  // the top of the window with nothing to catch it.
  for (const form of C.FORMS) {
    const g = PetArt.GEOM[form];
    assert.ok(g && g.h > 0 && g.w > 0, `${form} has no box`);
    // A window this tall must still clear the menu bar at the default size.
    assert.ok(PetArt.boxHeight(form, 1.5, 0) < 460,
      `${form} at 1.5× needs ${PetArt.boxHeight(form, 1.5, 0)}px of window`);
  }
});

// A stub 2D context: art.js only ever paints rectangles, so this is the whole
// surface it touches. Recording them lets a plain node test prove the art
// actually runs — the renderer swallows exceptions frame by frame, so a bad
// index in one accessory is invisible until someone equips it.
function stubCtx() {
  const rects = [];
  return {
    rects,
    save() {}, restore() {}, translate() {}, scale() {},
    set fillStyle(v) { this._f = v; }, get fillStyle() { return this._f; },
    set globalAlpha(v) { this._a = v; }, get globalAlpha() { return this._a; },
    fillRect(x, y, w, h) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `painted at (${x}, ${y})`);
      assert.ok(w > 0 && h > 0, `painted a ${w}×${h} rect`);
      rects.push([x, y, w, h]);
    }
  };
}

test('every form wears every accessory without falling over', () => {
  for (const form of C.FORMS) {
    for (const acc of [null, ...C.ACCESSORIES.map(a => a.id)]) {
      for (const t of [0, 700, 1500]) {          // the animated ones move
        const ctx = stubCtx();
        PetArt.drawPet(ctx, {
          form, accessory: acc, t, mood: 'happy', glow: true,
          ramp: C.PALETTES.mint, eyeTrack: 0, blink: 0
        });
        assert.ok(ctx.rects.length > 20, `${form} + ${acc} painted almost nothing`);
      }
    }
  }
});

test('nothing a pet wears reaches outside the window it is drawn in', () => {
  // The pet window is 320 wide and the sprite is centred in it, so at the
  // largest size everything must stay inside ±160 logical units — an orbiting
  // moon that leaves the window is simply gone, with no error anywhere.
  const SCALE = 2.5, HALF = 160;
  for (const form of C.FORMS) {
    for (const acc of C.ACCESSORIES.map(a => a.id)) {
      for (const t of [0, 400, 900, 1500, 2600]) {
        const ctx = stubCtx();
        PetArt.drawPet(ctx, { form, accessory: acc, t, mood: 'happy', ramp: C.PALETTES.mint });
        for (const [x, , w] of ctx.rects) {
          assert.ok(x * SCALE >= -HALF && (x + w) * SCALE <= HALF,
            `${form} + ${acc} paints at x=${x}..${x + w}, which is off the window at ${SCALE}×`);
        }
      }
    }
  }
});
