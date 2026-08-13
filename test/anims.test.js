'use strict';
// Same silent seam as sounds: the brain names an animation, the renderer owns
// what that name looks like. A typo on either side produces a pet that simply
// stands still — no error, no log line. So it is checked here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const petJs = () => fs.readFileSync(path.join(SRC, 'body', 'pet.js'), 'utf8');

const durTable = (name) => {
  const body = petJs().match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`))[1];
  return [...body.matchAll(/([a-zA-Z]+):\s*(\d+)/g)].map(m => [m[1], +m[2]]);
};

// Fidgets the renderer plays on its own initiative. They are NOT part of the
// brain seam — nothing in the brain may name one — so they are tracked
// separately and excluded from the dead-weight check below.
const idleAnims = () => new Set(durTable('IDLE_DUR').map(([n]) => n));

// Names the renderer can actually play: it either has a duration entry or is
// handled explicitly in startAnim.
function knownAnims() {
  const src = petJs();
  const names = new Set(durTable('ANIM_DUR').map(([n]) => n));
  names.delete('partyBig');           // not a name, a duration variant of party
  for (const m of src.matchAll(/name === '([a-zA-Z]+)'/g)) names.add(m[1]);
  for (const n of idleAnims()) names.add(n);
  return names;
}

// Names the brain emits: anim(fx, ctx, 'x') and { type: 'anim', name: 'x' }.
function emittedAnims() {
  const names = new Set();
  for (const file of ['reducer.js', 'brain.js', 'sessions.js']) {
    const src = fs.readFileSync(path.join(SRC, 'brain', file), 'utf8')
      .replace(/[!=]== '[^']*'/g, '');   // `ev.pm === 'plan'` is not an anim name
    // Stop at the statement/object end, never at the line end: two fx often
    // share one line and a sound name is not an animation name.
    for (const m of src.matchAll(/anim\(fx, ctx, ([^;\n]+)/g)) {
      for (const q of m[1].matchAll(/'([a-zA-Z]+)'/g)) names.add(q[1]);
    }
    for (const m of src.matchAll(/type: 'anim', name: ([^}\n]+)/g)) {
      for (const q of m[1].matchAll(/'([a-zA-Z]+)'/g)) names.add(q[1]);
    }
  }
  return names;
}

test('every animation the brain asks for exists in the renderer', () => {
  const known = knownAnims();
  const emitted = emittedAnims();
  assert.ok(emitted.size > 10, `expected a real vocabulary, found ${emitted.size}`);
  for (const name of emitted) {
    assert.ok(known.has(name), `brain plays '${name}' but the renderer has no such animation`);
  }
});

test('no animation is dead weight', () => {
  const emitted = emittedAnims();
  const idle = idleAnims();
  const unreachable = [...knownAnims()].filter(n => !emitted.has(n) && !idle.has(n));
  assert.deepEqual(unreachable, [], `animations nothing can trigger: ${unreachable.join(', ')}`);
});

test('idle fidgets stay on the renderer side of the seam', () => {
  const idle = idleAnims();
  assert.ok(idle.size >= 3, 'an idle pet needs more than one thing to do');
  const emitted = emittedAnims();
  for (const n of idle) {
    assert.ok(!emitted.has(n), `the brain emits '${n}' — idle fidgets belong to the renderer alone`);
  }
  // …and the scheduler must actually be able to reach them
  assert.match(petJs(), /startAnim\(name\)/, 'nothing plays the idle fidgets');
});

test('every animation has a duration and a body', () => {
  const src = petJs();
  const durs = [...durTable('ANIM_DUR'), ...durTable('IDLE_DUR')];
  for (const [name, ms] of durs) {
    assert.ok(ms >= 300 && ms <= 3000, `${name} runs ${ms}ms — too ${ms < 300 ? 'quick to see' : 'long to sit through'}`);
  }
  // Anything with motion must appear in computeMotion's switch, or it plays as
  // a pause of exactly its own duration.
  const motion = src.match(/switch \(anim\.name\) \{([\s\S]*?)\n  \}\n  return m;/)[1];
  const cased = new Set([...motion.matchAll(/case '([a-zA-Z]+)'/g)].map(m => m[1]));
  for (const [name] of durs) {
    if (name === 'partyBig') continue;
    assert.ok(cased.has(name), `'${name}' has a duration but no motion — the pet would freeze`);
  }
});

test('the debug anim grid only offers real animations', () => {
  const known = knownAnims();
  const src = fs.readFileSync(path.join(SRC, 'settings', 'settings.js'), 'utf8');
  const list = src.match(/const DEBUG_ANIMS = \[([\s\S]*?)\];/)[1];
  const names = [...list.matchAll(/'([a-zA-Z-]+)'/g)].map(m => m[1]);
  assert.ok(names.length >= 10);
  for (const n of names) {
    if (n === 'party-big') continue;   // the grid's own label for party {big:true}
    assert.ok(known.has(n), `debug grid offers '${n}' — no such animation`);
  }
});
