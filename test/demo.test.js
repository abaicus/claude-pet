'use strict';
// The demo reel is the one feature whose whole job is to work in front of an
// audience, which is exactly when nobody can debug it. So: every beat has to
// name something real, the reel has to survive a slow tick, and the pet it
// borrows has to come back in one piece.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DemoReel, REEL } = require('../src/brain/demo');
const { Brain } = require('../src/brain/brain');

const T0 = 1_700_000_000_000;

function makeBrain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-demo-'));
  let now = T0;
  const brain = new Brain({
    dir, settingsPath: path.join(dir, 'claude-settings.json'),
    now: () => now, rng: () => 0.99
  });
  return { brain, setNow: (t) => { now = t; } };
}

test('every beat in the reel names something the brain actually has', () => {
  // A typo here is a beat that silently does nothing in front of a room.
  const brainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'brain', 'brain.js'), 'utf8');
  const block = brainSrc.slice(brainSrc.indexOf('const presets = {'));
  const presets = new Set([...block.slice(0, block.indexOf('};')).matchAll(/^\s{10}([a-zA-Z]+):/gm)].map(m => m[1]));
  assert.ok(presets.size > 20, `parsed only ${presets.size} presets — did the block move?`);
  for (const beat of REEL) {
    if (beat.event) assert.ok(presets.has(beat.event), `reel fires '${beat.event}', which is not a preset`);
    if (beat.level !== undefined) assert.ok(beat.level >= 0 && beat.level <= 25, 'level off the ladder');
    assert.ok(beat.event || beat.level !== undefined || beat.say, 'a beat that does nothing');
  }
});

test('the reel shows off what it is meant to show off', () => {
  // The pitch is "it eats, sulks, recovers, ships and evolves". If a rewrite
  // drops one of those, the demo stops making the argument.
  const events = REEL.filter(b => b.event).map(b => b.event);
  for (const must of ['feast', 'testsRed', 'testsGreen', 'commitStat', 'deploy', 'notification']) {
    assert.ok(events.includes(must), `the reel no longer shows ${must}`);
  }
  const forms = REEL.filter(b => b.level !== undefined).map(b => b.level);
  assert.ok(forms.length >= 3, 'at least three evolutions, or the ladder never shows');
  assert.deepEqual(forms, forms.slice().sort((a, b) => a - b), 'the pet must grow, not shrink');
});

test('beats come due in order, once each', () => {
  const reel = new DemoReel([{ at: 0, say: 'a' }, { at: 100, say: 'b' }, { at: 250, say: 'c' }]);
  reel.start(T0);
  assert.deepEqual(reel.due(T0).map(b => b.say), ['a']);
  assert.deepEqual(reel.due(T0 + 50).map(b => b.say), []);
  assert.deepEqual(reel.due(T0 + 120).map(b => b.say), ['b']);
  assert.deepEqual(reel.due(T0 + 120).map(b => b.say), [], 'a beat played twice');
  assert.deepEqual(reel.due(T0 + 9999).map(b => b.say), ['c']);
});

test('a slow tick plays the beats it missed rather than dropping them', () => {
  // A busy event loop (or a lid closed mid-reel) must not silently skip the
  // evolution — late is recoverable, missing is not.
  const reel = new DemoReel([{ at: 0, say: 'a' }, { at: 100, say: 'b' }, { at: 200, say: 'c' }]);
  reel.start(T0);
  assert.deepEqual(reel.due(T0 + 5000).map(b => b.say), ['a', 'b', 'c']);
});

test('the reel is not finished until its last beat has been let breathe', () => {
  const reel = new DemoReel([{ at: 0, say: 'a' }]);
  reel.start(T0);
  reel.due(T0 + 10);
  assert.equal(reel.finished(T0 + 10), false, 'ended on the frame the last beat played');
  assert.equal(reel.finished(T0 + reel.durationMs), true);
});

test('the reel borrows the pet and gives it back exactly', () => {
  const { brain, setNow } = makeBrain();
  brain.state.xp = 4200; brain.state.level = 11; brain.state.lifetimeCommits = 7;
  brain.prefs.accessory = 'bell'; // a lv.11 item — the reel drops to lv.2 and back
  const before = JSON.parse(JSON.stringify(brain.state));

  brain.command({ type: 'startDemo' });
  assert.equal(brain.getRenderState().demo.running, true);

  // …play the whole thing
  setNow(T0 + 5000);
  brain.demoTick();
  assert.notEqual(brain.state.level, before.level, 'the reel never touched the pet');
  setNow(T0 + brain.demo.durationMs + 1);
  brain.demoTick();

  assert.equal(brain.getRenderState().demo.running, false, 'the reel did not end itself');
  assert.equal(brain.state.level, before.level);
  assert.equal(brain.state.xp, before.xp);
  assert.equal(brain.state.lifetimeCommits, before.lifetimeCommits, 'the demo banked real commits');
  assert.equal(brain.prefs.accessory, 'bell', 'the demo kept the pet undressed');
});

test('stopping early restores just the same', () => {
  const { brain, setNow } = makeBrain();
  brain.state.xp = 700; brain.state.level = 5;
  brain.command({ type: 'startDemo' });
  setNow(T0 + 20000);
  brain.demoTick();
  brain.command({ type: 'stopDemo' });
  assert.equal(brain.state.level, 5);
  assert.equal(brain.getRenderState().demo.running, false);
});

test('quitting mid-reel does not save the reel over the real pet', () => {
  const { brain, setNow } = makeBrain();
  brain.state.xp = 700; brain.state.level = 5;
  brain.command({ type: 'startDemo' });
  setNow(T0 + 20000);
  brain.demoTick();
  brain.stop();
  assert.equal(brain.state.level, 5, 'the borrowed pet was written to disk');
});

test('a second start does not lose the original pet', () => {
  // Double-clicking the button must snapshot the REAL pet once, not the
  // reel's pet on top of it.
  const { brain, setNow } = makeBrain();
  brain.state.xp = 700; brain.state.level = 5;
  brain.command({ type: 'startDemo' });
  setNow(T0 + 20000);
  brain.demoTick();
  brain.command({ type: 'startDemo' });
  brain.command({ type: 'stopDemo' });
  assert.equal(brain.state.level, 5);
});
