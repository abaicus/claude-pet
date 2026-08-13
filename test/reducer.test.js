'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reduce, tick, checkTokenMilestone } = require('../src/brain/reducer');
const { defaultState } = require('../src/brain/state');
const { TUNING, XP_LADDER } = require('../src/shared/constants');

const T0 = 1_700_000_000_000;
function ctx(now = T0, live = true, rng = () => 0.99) { return { now, rng, live }; }
function ev(t, extra = {}, ts = T0) { return Object.assign({ t, ts, sid: 's1' }, extra); }
function fresh() { const s = defaultState(T0); s.lastTickAt = T0; return s; }

test('prompt feeds the pet', () => {
  const s = fresh();
  const before = s.food;
  reduce(s, ev('UserPromptSubmit'), ctx());
  assert.equal(s.food, before + TUNING.foodPerPrompt);
});

test('food is uncapped — an overfed pet is the point', () => {
  const s = fresh();
  s.food = 300;
  reduce(s, ev('UserPromptSubmit'), ctx());
  assert.equal(s.food, 300 + TUNING.foodPerPrompt);
});

test('edit gives food and xp', () => {
  const s = fresh();
  reduce(s, ev('PostToolUse', { tool: 'Edit' }), ctx());
  assert.equal(s.xp, TUNING.xpPerEdit);
  assert.equal(s.food, 20 + TUNING.foodPerEdit);
});

test('edit combo fires at 8th edit within rolling 2-min gaps', () => {
  const s = fresh();
  let fired = [];
  for (let i = 0; i < 8; i++) {
    const ts = T0 + i * 60_000; // 1-min gaps, each within the window of the previous
    const fx = reduce(s, ev('PostToolUse', { tool: 'Edit' }, ts), ctx(ts));
    fired = fired.concat(fx.filter(f => f.type === 'milestone' && f.name === 'combo'));
  }
  assert.equal(fired.length, 1);
  assert.equal(fired[0].count, 8);
});

test('edit combo breaks after a gap > 2 min', () => {
  const s = fresh();
  for (let i = 0; i < 5; i++) reduce(s, ev('PostToolUse', { tool: 'Edit' }, T0 + i * 1000), ctx(T0 + i * 1000));
  assert.equal(s.combo.count, 5);
  const late = T0 + 5 * 1000 + TUNING.comboWindowMs + 1;
  reduce(s, ev('PostToolUse', { tool: 'Edit' }, late), ctx(late));
  assert.equal(s.combo.count, 1);
});

test('commit: food, mood, xp, lifetime count', () => {
  const s = fresh();
  const fx = reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'git commit -m x' }), ctx());
  assert.equal(s.lifetimeCommits, 1);
  assert.equal(s.xp, TUNING.commit.xp);
  assert.equal(s.mood, 60 + TUNING.commit.mood);
  assert.equal(s.food, 20 + TUNING.commit.food);
  assert.ok(fx.some(f => f.type === 'anim' && f.name === 'party'));
});

test('every 10th commit is a milestone fanfare', () => {
  const s = fresh();
  let milestones = 0;
  for (let i = 0; i < 20; i++) {
    const fx = reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'git commit -m x' }, T0 + i), ctx(T0 + i));
    milestones += fx.filter(f => f.type === 'milestone' && f.name === 'commits').length;
  }
  assert.equal(s.lifetimeCommits, 20);
  assert.equal(milestones, 2); // at 10 and 20
});

test('green tests raise streak; 5 straight is a milestone; red resets', () => {
  const s = fresh();
  const green = { tool: 'Bash', cmd: 'npx jest', out: 'Tests:       9 passed, 9 total' };
  let milestone = null;
  for (let i = 0; i < 5; i++) {
    const fx = reduce(s, ev('PostToolUse', green, T0 + i), ctx(T0 + i));
    const m = fx.find(f => f.type === 'milestone' && f.name === 'greenStreak');
    if (m) milestone = m;
  }
  assert.equal(s.greenStreak, 5);
  assert.ok(milestone && milestone.count === 5);
  const moodBefore = s.mood;
  reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'npx jest', out: 'Tests: 2 failed, 7 passed, 9 total', ok: false }), ctx());
  assert.equal(s.greenStreak, 0);
  assert.equal(s.mood, Math.max(0, moodBefore + TUNING.testsRedMood));
});

test('xp ladder: leveling and evolution effects', () => {
  const s = fresh();
  const fx = [];
  // 3 commits (75xp) → level 1 (50xp threshold)
  for (let i = 0; i < 3; i++) fx.push(...reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'git commit -m x' }, T0 + i), ctx(T0 + i)));
  assert.equal(s.level, 1);
  const evolve = fx.find(f => f.type === 'milestone' && f.name === 'evolve');
  assert.ok(evolve, 'egg → hatchling is an evolution');
  assert.equal(evolve.form, 'hatchling');
});

test('level curve matches the ladder', () => {
  const s = fresh();
  s.xp = XP_LADDER[6] - 1;
  reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'git commit -m x' }), ctx());
  assert.equal(s.level, 6); // crossed into senior territory
});

test('replay (live=false) moves stats but emits no fx', () => {
  const s = fresh();
  const fx = reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'git commit -m x' }), ctx(T0, false));
  assert.equal(s.lifetimeCommits, 1);
  assert.equal(fx.length, 0);
});

test('notification relays the actual message, important, even in replay-mute terms', () => {
  const s = fresh();
  const fx = reduce(s, ev('Notification', { msg: 'Claude needs your permission to use Bash' }), ctx());
  const bubble = fx.find(f => f.type === 'bubble');
  assert.ok(bubble.important);
  assert.match(bubble.text, /permission to use Bash/);
  assert.ok(fx.some(f => f.type === 'anim' && f.name === 'attention'));
  assert.ok(fx.some(f => f.type === 'sound' && f.name === 'chime' && f.important));
});

test('tool failure hurts mood', () => {
  const s = fresh();
  const before = s.mood;
  reduce(s, ev('PostToolUse', { tool: 'Read', ok: false }), ctx());
  assert.equal(s.mood, before + TUNING.toolFailMood);
});

test('rm -rf flinches without stat damage', () => {
  const s = fresh();
  const before = { mood: s.mood, xp: s.xp };
  const fx = reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'rm -rf dist' }), ctx());
  assert.equal(s.mood, before.mood);
  assert.equal(s.xp, before.xp);
  assert.ok(fx.some(f => f.type === 'anim' && f.name === 'flinch'));
});

test('food decays over time', () => {
  const s = fresh();
  s.food = 50;
  tick(s, T0 + 10 * 60_000, ctx(T0 + 10 * 60_000)); // 10 minutes
  assert.ok(Math.abs(s.food - (50 - 12)) < 0.01, `food=${s.food}`);
});

test('loneliness after 30 idle minutes', () => {
  const s = fresh();
  s.lastMeaningfulAt = T0;
  s.lastEventAt = T0;
  s.mood = 60;
  s.energy = 100; // not sleepy — isolate loneliness
  tick(s, T0 + 40 * 60_000, ctx(T0 + 40 * 60_000));
  assert.ok(s.mood < 60, 'mood drifted down');
});

test('sleep requires low energy AND quiet — never doze mid-work', () => {
  const s = fresh();
  s.energy = 10;
  s.lastEventAt = T0; s.lastMeaningfulAt = T0;
  // only 20s of quiet: must NOT sleep even though energy is low
  tick(s, T0 + 20_000, ctx(T0 + 20_000));
  assert.equal(s.sleeping, false);
  // 2 min of quiet: sleeps
  tick(s, T0 + 2 * 60_000, ctx(T0 + 2 * 60_000));
  assert.equal(s.sleeping, true);
});

test('events wake the pet', () => {
  const s = fresh();
  s.sleeping = true;
  const fx = reduce(s, ev('UserPromptSubmit'), ctx());
  assert.equal(s.sleeping, false);
  assert.ok(fx.some(f => f.type === 'anim' && f.name === 'wake'));
});

test('energy drains per tool call and recovers when idle', () => {
  const s = fresh();
  s.energy = 50;
  reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'ls' }), ctx());
  assert.ok(s.energy < 50);
  const e = s.energy;
  s.lastMeaningfulAt = T0 - 10 * 60_000; // long idle
  s.lastEventAt = T0 - 10 * 60_000;
  tick(s, T0 + 5 * 60_000, ctx(T0 + 5 * 60_000));
  assert.ok(s.energy > e, 'recovered while idle');
});

test('token milestone at every million output tokens', () => {
  const s = fresh();
  s.lifetimeOutputTokens = 999_999;
  assert.equal(checkTokenMilestone(s, ctx()).length, 0);
  s.lifetimeOutputTokens = 1_000_001;
  const fx = checkTokenMilestone(s, ctx());
  assert.ok(fx.some(f => f.type === 'milestone' && f.name === 'tokens' && f.millions === 1));
  // not re-awarded
  assert.equal(checkTokenMilestone(s, ctx()).length, 0);
});

test('SessionEnd restores energy; Stop restores a little', () => {
  const s = fresh();
  s.energy = 40;
  reduce(s, ev('Stop'), ctx());
  assert.equal(s.energy, 40 + TUNING.stopEnergy / 2);
  reduce(s, ev('SessionEnd'), ctx());
  assert.equal(s.energy, Math.min(100, 40 + TUNING.stopEnergy / 2 + TUNING.stopEnergy));
});

test('a replayed synthetic "real day" produces sane numbers', () => {
  const s = fresh();
  let t = T0;
  const events = [];
  events.push(ev('SessionStart', {}, t));
  for (let hour = 0; hour < 6; hour++) {
    for (let i = 0; i < 10; i++) {
      t += 4 * 60_000;
      events.push(ev('UserPromptSubmit', {}, t));
      t += 20_000; events.push(ev('PostToolUse', { tool: 'Read' }, t));
      t += 20_000; events.push(ev('PostToolUse', { tool: 'Edit' }, t));
      t += 20_000; events.push(ev('PostToolUse', { tool: 'Edit' }, t));
      t += 30_000; events.push(ev('PostToolUse', { tool: 'Bash', cmd: 'npm test', out: '  12 passing (1s)' }, t));
      t += 10_000; events.push(ev('Stop', {}, t));
    }
    t += 5 * 60_000;
    events.push(ev('PostToolUse', { tool: 'Bash', cmd: 'git commit -m "wip"' }, t));
  }
  events.push(ev('SessionEnd', {}, t));
  for (const e of events) {
    reduce(s, e, ctx(e.ts, false));
    tick(s, e.ts, ctx(e.ts, false));
  }
  assert.equal(s.lifetimeCommits, 6);
  assert.ok(s.greenStreak >= 5, `streak=${s.greenStreak}`);
  assert.ok(s.xp > 800 && s.xp < 3000, `xp=${s.xp}`);
  assert.ok(s.level >= 4 && s.level <= 8, `level=${s.level}`);
  assert.ok(s.food > 0, 'did not starve');
  assert.ok(s.energy >= 0 && s.energy <= 100);
  assert.ok(s.mood >= 0 && s.mood <= 100);
});
