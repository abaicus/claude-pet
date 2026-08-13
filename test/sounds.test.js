'use strict';
// The brain names sounds; the renderer owns the motifs. Nothing at runtime
// complains when those two drift — you just get silence — so the seam is
// guarded here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

// sounds.js is a browser IIFE; run it against a stub window to read its table.
function motifNames() {
  const src = fs.readFileSync(path.join(SRC, 'body', 'sounds.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.PetSounds.NAMES;
}

// every sound name the brain can emit: `sound(fx, ctx, 'x')` and
// `{ type: 'sound', name: 'x' }` (including the `a ? 'x' : 'y'` form)
function emittedNames() {
  const names = new Set();
  for (const file of ['reducer.js', 'brain.js', 'sessions.js']) {
    const src = fs.readFileSync(path.join(SRC, 'brain', file), 'utf8')
      .replace(/[!=]== '[^']*'/g, ''); // form comparisons are not sound names
    for (const m of src.matchAll(/sound\(fx, ctx, '([a-z]+)'\)/g)) names.add(m[1]);
    for (const m of src.matchAll(/type: 'sound',\s*name:([^,}]+)/g)) {
      for (const q of m[1].matchAll(/'([a-z]+)'/g)) names.add(q[1]);
    }
  }
  return names;
}

test('every sound the brain emits exists in the renderer motif table', () => {
  const motifs = new Set(motifNames());
  const emitted = emittedNames();
  assert.ok(emitted.size > 10, `expected a real vocabulary, found ${emitted.size}`);
  for (const name of emitted) {
    assert.ok(motifs.has(name), `brain emits '${name}' but no motif defines it`);
  }
});

// Some motif names are COMPUTED (the bash branch plays its classified kind),
// so no static scan can see them. Drive real events through the real reducer
// and collect what actually comes out. This table doubles as the reachability
// proof below, so anything added to the vocabulary has to be reachable from a
// real event to survive.
const bash = (cmd, out = '', ok = true) => ({ t: 'PostToolUse', ts: 1, tool: 'Bash', cmd, out, ok });
const RUNTIME_EVENTS = [
  bash('git push origin main'), bash('git merge main'), bash('npm install'),
  bash('git checkout -b feat/x'), bash('git stash'), bash('npm run build'),
  bash('git clone git@github.com:x/y.git'), bash('git commit -m x'),
  bash('git commit --amend'), bash('git revert abc'), bash('npm publish'),
  bash('git diff --stat', ' 1 file changed, 2 insertions(+)'), bash('git status'),
  bash('npm run lint'), bash('tsc --noEmit'), bash('docker compose up'),
  bash('prisma migrate dev'), bash('rg TODO src/'), bash('curl https://x.com'),
  bash('sudo systemctl restart nginx'), bash('git push --force'), bash('git reset --hard'),
  bash('kill -9 100'), bash('rm -rf dist'), bash('vercel --prod'), bash('gh pr create'),
  bash('npm test', '2 passing'), bash('npm test', '1 failing'), bash('npm test', 'ran something'),
  bash('ls -la', '', false),
  { t: 'PostToolUse', ts: 1, tool: 'Read', file: 'a.js', ok: true },
  { t: 'PostToolUse', ts: 1, tool: 'Grep', ok: true },
  { t: 'PostToolUse', ts: 1, tool: 'WebSearch', ok: true },
  { t: 'PostToolUse', ts: 1, tool: 'WebFetch', host: 'x.com', ok: true },
  { t: 'PostToolUse', ts: 1, tool: 'Task', agent: 'Explore', ok: true },
  { t: 'PreToolUse', ts: 1, tool: 'Task', agent: 'Explore' },
  { t: 'PostToolUse', ts: 1, tool: 'mcp__thing__do', srv: 'thing', ok: true },
  { t: 'PostToolUse', ts: 1, tool: 'Edit', file: 'a.js', add: 1, del: 1, ok: true },
  { t: 'PostToolUse', ts: 1, tool: 'Edit', file: 'a.js', add: 60, del: 20, ok: true },
  { t: 'PostToolUse', ts: 1, tool: 'TodoWrite', todo: { n: 3, d: 1, p: 1 }, ok: true },
  { t: 'PostToolUse', ts: 1, tool: 'TodoWrite', todo: { n: 3, d: 3, p: 0 }, ok: true },
  { t: 'UserPromptSubmit', ts: 1 }, { t: 'UserPromptSubmit', ts: 1, plen: 2000 },
  { t: 'Stop', ts: 1 }, { t: 'SubagentStop', ts: 1 },
  { t: 'PreCompact', ts: 1 }, { t: 'SessionStart', ts: 1 },
  { t: 'SessionEnd', ts: 1 }, { t: 'SessionEnd', ts: 1, reason: 'clear' },
  { t: 'Notification', ts: 1, msg: 'hi' },
  { t: 'Notification', ts: 1, msg: 'Claude is waiting for your input' },
  // a permission-mode CHANGE (the pre-set state below is what makes it one)
  { t: 'PostToolUse', ts: 1, tool: 'Read', pm: 'bypassPermissions', ok: true },
  { t: 'PostToolUse', ts: 1, tool: 'Read', pm: 'default', ok: true }
];

function drivenNames(assertReal) {
  const { reduce } = require('../src/brain/reducer');
  const { defaultState } = require('../src/brain/state');
  const seen = new Set();
  for (const ev of RUNTIME_EVENTS) {
    const state = defaultState(1);
    state.pm = 'plan';           // so a mode change is a change
    state.food = 60;             // neither starving nor stuffed
    for (const f of reduce(state, ev, { now: 1, rng: () => 0.99, live: true })) {
      if (f.type !== 'sound') continue;
      seen.add(f.name);
      if (assertReal) assertReal(f.name, ev);
    }
  }
  return seen;
}

test('sounds computed at runtime resolve to real motifs', () => {
  const motifs = new Set(motifNames());
  const seen = drivenNames((name, ev) => {
    assert.ok(motifs.has(name), `${ev.t} ${ev.cmd || ev.tool || ''} → '${name}': no such motif`);
  });
  for (const kind of ['push', 'merge', 'install', 'branch', 'stash', 'build', 'clone']) {
    assert.ok(seen.has(kind), `${kind} should have its own motif, not a shared blip`);
  }
});

test('no motif is dead weight — everything in the table is reachable', () => {
  const wired = emittedNames();
  for (const name of drivenNames()) wired.add(name);
  const unreachable = motifNames().filter(n => !wired.has(n));
  assert.deepEqual(unreachable, [], `motifs nothing can play: ${unreachable.join(', ')}`);
});

test('the debug sound grid only offers real motifs', () => {
  const motifs = new Set(motifNames());
  const src = fs.readFileSync(path.join(SRC, 'settings', 'settings.js'), 'utf8');
  const list = src.match(/const DEBUG_SOUNDS = \[([\s\S]*?)\];/)[1];
  const names = [...list.matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  assert.ok(names.length >= 10);
  for (const n of names) assert.ok(motifs.has(n), `debug grid offers '${n}' — no such motif`);
});

test('motifs are short, ordered note sequences (no runaway jingles)', () => {
  const src = fs.readFileSync(path.join(SRC, 'body', 'sounds.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  // re-read the table through a play() call is overkill; parse the literal
  const table = src.match(/const MOTIFS = \{([\s\S]*?)\n  \};/)[1];
  const rows = [...table.matchAll(/^\s{4}([a-z]+):\s*\[(.+)\],?$/gm)];
  assert.equal(rows.length, win.PetSounds.NAMES.length, 'every motif parsed');
  for (const [, name, body] of rows) {
    const notes = [...body.matchAll(/\[(\d+), ([\d.]+)\]/g)];
    assert.ok(notes.length >= 1 && notes.length <= 6, `${name}: ${notes.length} notes`);
    const total = notes.reduce((a, n) => a + Number(n[2]), 0);
    assert.ok(total <= 0.8, `${name} runs ${total.toFixed(2)}s — too long to interrupt work with`);
    for (const n of notes) {
      const hz = Number(n[1]);
      assert.ok(hz >= 200 && hz <= 2000, `${name}: ${hz}Hz out of the chiptune range`);
    }
  }
});

test('every motif has words to go with it', () => {
  // A noise the pet can make but cannot explain is the bug this table exists
  // to prevent; the brain falls back to these words whenever a reaction had
  // nothing more specific to say.
  const { SOUND_QUIP, POOLS } = require('../src/brain/quips');
  for (const name of motifNames()) {
    const pool = SOUND_QUIP[name];
    assert.ok(pool, `motif '${name}' can play with nothing on screen to explain it`);
    assert.ok(POOLS[pool] && POOLS[pool].length, `'${name}' points at '${pool}', which has no words`);
  }
});
