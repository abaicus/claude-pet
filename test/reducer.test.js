'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reduce, tick, checkTokenMilestone, ensureWords } = require('../src/brain/reducer');
const { defaultState } = require('../src/brain/state');
const { TUNING, XP_LADDER } = require('../src/shared/constants');
const { POOLS } = require('../src/brain/quips');

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
  assert.ok(fx.some(f => f.type === 'sound' && f.name === 'notify' && f.important));
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

// ---------------------------------------------------------------- detail from Claude
const bubbles = (fx) => fx.filter(f => f.type === 'bubble').map(f => f.text);
const anims = (fx) => fx.filter(f => f.type === 'anim').map(f => f.name);
const sounds = (fx) => fx.filter(f => f.type === 'sound').map(f => f.name);

test('a big edit is a feast: more food, and the size is labeled ~', () => {
  const s = fresh();
  const fx = reduce(s, ev('PostToolUse', { tool: 'Edit', file: 'a.ts', add: 50, del: 20 }), ctx(T0, true, () => 0.01));
  assert.equal(s.food, 20 + TUNING.foodPerEdit + TUNING.feastFood);
  assert.ok(anims(fx).includes('feast'));
  assert.ok(sounds(fx).includes('feast'));
  // `add`/`del` are the edit's own line counts, not a git diff — so `~`.
  assert.match(bubbles(fx)[0], /~70 lines/);
});

test('a one-line edit is a nibble, not a feast', () => {
  const s = fresh();
  const fx = reduce(s, ev('PostToolUse', { tool: 'Edit', file: 'a.js', add: 1, del: 1 }), ctx());
  assert.equal(s.food, 20 + TUNING.foodPerEdit);
  assert.ok(anims(fx).includes('nibble'));
  assert.ok(!anims(fx).includes('feast'));
});

test('editing a test file is its own moment', () => {
  const s = fresh();
  const fx = reduce(s, ev('PostToolUse', { tool: 'Write', file: 'reducer.test.js', add: 10 }), ctx(T0, true, () => 0.1));
  assert.match(bubbles(fx)[0], /test/i);
});

test('commit states git\'s own numbers flat — no ~ on facts git counted', () => {
  const s = fresh();
  const out = '[main abc1234] x\n 3 files changed, 48 insertions(+), 12 deletions(-)';
  const fx = reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'git commit -m x', out }), ctx(T0, true, () => 0.01));
  assert.match(bubbles(fx)[0], /\+48 −12/);
  assert.ok(!bubbles(fx)[0].includes('~'));
});

test('a diff without a stat line reports no numbers at all', () => {
  const s = fresh();
  const fx = reduce(s, ev('PostToolUse', { tool: 'Bash', cmd: 'git diff', out: '+ a line\n- another' }), ctx());
  for (const b of bubbles(fx)) assert.ok(!/\d+/.test(b), `invented numbers: ${b}`);
});

test('todos: a ticked box, then a finished list', () => {
  const s = fresh();
  const speak = ctx(T0, true, () => 0.01);
  let fx = reduce(s, ev('PostToolUse', { tool: 'TodoWrite', todo: { n: 3, d: 0, p: 1 } }), speak);
  assert.deepEqual(anims(fx), []);                       // a new plan is quiet
  assert.equal(s.todos.n, 3);

  fx = reduce(s, ev('PostToolUse', { tool: 'TodoWrite', todo: { n: 3, d: 1, p: 1 } }), speak);
  assert.ok(anims(fx).includes('nod'));
  assert.equal(bubbles(fx)[0], '1/3 done ✓');
  assert.equal(s.xp, TUNING.todoXp);

  fx = reduce(s, ev('PostToolUse', { tool: 'TodoWrite', todo: { n: 3, d: 3, p: 0 } }), speak);
  assert.ok(anims(fx).includes('spin'));
  assert.ok(sounds(fx).includes('checklist'));
  assert.equal(s.xp, TUNING.todoXp + TUNING.todoDoneXp);
});

test('the same todo list resubmitted unchanged says nothing', () => {
  const s = fresh();
  reduce(s, ev('PostToolUse', { tool: 'TodoWrite', todo: { n: 2, d: 1, p: 1 } }), ctx());
  const fx = reduce(s, ev('PostToolUse', { tool: 'TodoWrite', todo: { n: 2, d: 1, p: 1 } }), ctx());
  assert.deepEqual(fx.filter(f => f.type !== 'sound'), []);
});

test('permission mode: the change is news, the first sighting is not', () => {
  const s = fresh();
  let fx = reduce(s, ev('PostToolUse', { tool: 'Read', pm: 'default' }), ctx());
  assert.deepEqual(bubbles(fx), []);              // just learning where we are
  assert.equal(s.pm, 'default');

  fx = reduce(s, ev('PostToolUse', { tool: 'Read', pm: 'bypassPermissions' }), ctx());
  assert.ok(sounds(fx).includes('spook'));
  assert.ok(fx.some(f => f.type === 'bubble' && f.important));

  fx = reduce(s, ev('PostToolUse', { tool: 'Read', pm: 'bypassPermissions' }), ctx());
  assert.deepEqual(bubbles(fx), []);              // unchanged is not a change
});

test('SessionStart after a compaction is not a new hello', () => {
  const s = fresh();
  const quiet = reduce(s, ev('SessionStart', { source: 'compact' }), ctx());
  assert.deepEqual(quiet.filter(f => f.type !== 'milestone'), []);
  const hello = reduce(s, ev('SessionStart', { source: 'resume' }), ctx());
  assert.ok(anims(hello).includes('wake'));
});

test('a subagent is announced when it goes out and when it comes back', () => {
  const s = fresh();
  const out = reduce(s, ev('PreToolUse', { tool: 'Task', agent: 'Explore' }), ctx(T0, true, () => 0.01));
  assert.ok(anims(out).includes('think'));
  assert.match(bubbles(out)[0], /Explore/);
  const back = reduce(s, ev('PostToolUse', { tool: 'Task', agent: 'Explore', ok: true }), ctx(T0, true, () => 0.01));
  assert.match(bubbles(back)[0], /Explore/);
});

test('a WebFetch names the host it actually read', () => {
  const s = fresh();
  const fx = reduce(s, ev('PostToolUse', { tool: 'WebFetch', host: 'docs.claude.com', ok: true }), ctx(T0, true, () => 0.01));
  assert.match(bubbles(fx)[0], /docs\.claude\.com/);
});

test('nothing fires during a replay, however detailed the event', () => {
  const s = fresh();
  const events = [
    ev('PostToolUse', { tool: 'Edit', add: 90, del: 40 }),
    ev('PostToolUse', { tool: 'TodoWrite', todo: { n: 2, d: 2, p: 0 } }),
    ev('PostToolUse', { tool: 'Bash', cmd: 'git push --force' }),
    ev('PreToolUse', { tool: 'Task', agent: 'Explore' })
  ];
  for (const e of events) assert.deepEqual(reduce(s, e, ctx(T0, false)), []);
  assert.ok(s.xp > 0, 'stats still moved');
});

test('a prompt sometimes gets cheered on its way out the door', () => {
  const s = fresh();
  s.food = 50;                                   // neither starving nor stuffed
  // rng below cheerChance on the branch roll, then 0 to pick from the pool
  const fx = reduce(s, ev('UserPromptSubmit', { plen: 200 }), ctx(T0, true, () => 0.01));
  const bubble = fx.find(f => f.type === 'bubble');
  assert.equal(bubble.kind, 'cheer');
  assert.ok(POOLS.cheer.includes(bubble.text), bubble.text);
  assert.ok(POOLS.cheer.includes('make no mistakes!'), 'the one quip that was asked for by name');
});

// ---------------------------------------------------------------- a chirp always has words
// The complaint this answers: the pet makes a noise, you look up, and there is
// nothing on screen telling you what it just noticed. Every rng below is 0.99,
// so every one of the reducer's own coin-flipped quips loses — which is
// exactly the case that used to leave a sound alone with no words.
const NOISY = [
  ev('UserPromptSubmit', { plen: 200 }),
  ev('PostToolUse', { tool: 'Edit', file: 'a.js', ext: 'js', add: 3, del: 1 }),
  ev('PostToolUse', { tool: 'Read', file: 'main.js', ext: 'js' }),
  ev('PostToolUse', { tool: 'Grep' }),
  ev('PostToolUse', { tool: 'Task', agent: 'Explore' }),
  ev('PostToolUse', { tool: 'mcp__thing__do', srv: 'thing' }),
  ev('PostToolUse', { tool: 'WebFetch', host: 'example.com' }),
  ev('PostToolUse', { tool: 'Bash', cmd: 'ls -la', desc: 'List the files' }),
  ev('PostToolUse', { tool: 'Bash', cmd: 'git status' }),
  ev('PostToolUse', { tool: 'Bash', cmd: 'git commit -m x' }),
  ev('PostToolUse', { tool: 'Bash', cmd: 'npm test', out: '2 passing' }),
  ev('PostToolUse', { tool: 'Bash', cmd: 'rg TODO src/' }),
  ev('PostToolUse', { tool: 'TodoWrite', todo: { n: 3, d: 1, p: 1 } }),
  ev('Stop'), ev('SubagentStop'), ev('SessionStart'), ev('SessionEnd'), ev('PreCompact')
];

test('every sound the pet makes comes with something to read', () => {
  for (const e of NOISY) {
    const s = fresh();
    s.food = 60;
    const c = ctx();
    const fx = ensureWords(reduce(s, e, c), c);
    if (!fx.some(f => f.type === 'sound')) continue;
    const bubble = fx.find(f => f.type === 'bubble' && f.text);
    assert.ok(bubble, `${e.t} ${e.tool || e.cmd || ''} chirps with nothing to show for it`);
  }
});

test('what the payload names, the pet says by name', () => {
  // The generic fallback must never be what you get when the event carried a
  // filename, a host or a subagent — that detail is the whole point.
  const cases = [
    [ev('PostToolUse', { tool: 'Read', file: 'main.js' }), /main\.js/],
    [ev('PostToolUse', { tool: 'WebFetch', host: 'example.com' }), /example\.com/],
    [ev('PostToolUse', { tool: 'Task', agent: 'Explore' }), /Explore/],
    [ev('PostToolUse', { tool: 'mcp__thing__do', srv: 'thing' }), /thing/],
    [ev('PreToolUse', { tool: 'Task', agent: 'Explore' }), /Explore/],
    [ev('PostToolUse', { tool: 'Bash', cmd: 'ls -la', desc: 'List the files' }), /list the files/]
  ];
  for (const [e, re] of cases) {
    const c = ctx();
    const fx = ensureWords(reduce(fresh(), e, c), c);
    const bubble = fx.find(f => f.type === 'bubble');
    assert.ok(bubble && re.test(bubble.text), `${e.tool} said "${bubble && bubble.text}"`);
  }
});

test('the fallback fills a silence, it does not talk over anyone', () => {
  const c = ctx();
  // the session registry already named the project that finished
  const spoken = [{ type: 'sound', name: 'done' }, { type: 'bubble', text: 'gogu · your turn~ ✓' }];
  ensureWords(spoken, c);
  assert.equal(spoken.filter(f => f.type === 'bubble').length, 1, 'two voices for one event');
  // and it stays quiet on a replayed backlog, like everything else
  const replayed = [{ type: 'sound', name: 'done' }];
  assert.deepEqual(ensureWords(replayed, ctx(T0, false)), [{ type: 'sound', name: 'done' }]);
});
