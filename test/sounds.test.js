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
    const src = fs.readFileSync(path.join(SRC, 'brain', file), 'utf8');
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
