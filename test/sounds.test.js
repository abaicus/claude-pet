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

// The bash branch picks its motif from the classified kind, so the static scan
// above can't see those names — drive real events through the reducer instead.
test('sounds computed at runtime resolve to real motifs', () => {
  const { reduce } = require('../src/brain/reducer');
  const { defaultState } = require('../src/brain/state');
  const motifs = new Set(motifNames());
  const ctx = { now: 1, rng: () => 0.99, live: true };
  const bash = (cmd, out = '', ok = true) =>
    ({ t: 'PostToolUse', ts: 1, tool: 'Bash', cmd, out, ok });
  const events = [
    bash('git push origin main'), bash('git merge main'), bash('npm install'),
    bash('git checkout -b feat/x'), bash('git stash'), bash('npm run build'),
    bash('git commit -m x'), bash('npm test', '2 passing'), bash('npm test', '1 failing'),
    bash('npm test', 'ran something'), bash('gh pr create'), bash('rm -rf dist'),
    { t: 'PostToolUse', ts: 1, tool: 'Read', file: 'a.js', ok: true },
    { t: 'PostToolUse', ts: 1, tool: 'WebSearch', ok: true },
    { t: 'PostToolUse', ts: 1, tool: 'mcp__thing__do', ok: true },
    { t: 'PostToolUse', ts: 1, tool: 'Edit', file: 'a.js', ok: true },
    { t: 'UserPromptSubmit', ts: 1 }, { t: 'Stop', ts: 1 }, { t: 'SubagentStop', ts: 1 },
    { t: 'PreCompact', ts: 1 }, { t: 'SessionStart', ts: 1 }, { t: 'SessionEnd', ts: 1 },
    { t: 'Notification', ts: 1, msg: 'hi' }
  ];
  const seen = new Set();
  for (const ev of events) {
    for (const f of reduce(defaultState(1), ev, ctx)) {
      if (f.type !== 'sound') continue;
      seen.add(f.name);
      assert.ok(motifs.has(f.name), `${ev.t} ${ev.cmd || ev.tool || ''} → '${f.name}': no such motif`);
    }
  }
  for (const kind of ['push', 'merge', 'install', 'branch', 'stash', 'build']) {
    assert.ok(seen.has(kind), `${kind} should have its own motif, not a shared blip`);
  }
});

test('no motif is dead weight — everything in the table is reachable', () => {
  const wired = emittedNames();
  for (const kind of ['push', 'merge', 'install', 'branch', 'stash', 'build']) wired.add(kind);
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
