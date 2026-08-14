'use strict';
// Synthesized chiptune motifs — Web Audio square waves, no audio files.
// Short, throttled, off by default. Notification/warning motifs are the ones
// allowed to bypass the mute (at a modest fixed volume).
//
// The motif table and its envelope are carried over from the earlier
// Gogu prototype: notes play back-to-back with an instant attack and an
// exponential decay across the whole note. That hard attack is what makes them
// read as chiptune rather than as bleeps — don't "improve" it with a fade-in.

(function (global) {
  let audioCtx = null;
  const lastPlayed = new Map(); // name → ts
  const PEAK = 0.35; // gain at volume 1.0 — loud enough to hear from a room away

  // per-sound minimum gap (ms) — ambient/high-frequency motifs get throttled
  // hard, one-off celebrations barely at all
  const GAP = {
    // ambient: the pet following along, must never become a metronome
    peek: 10000, web: 6000, mcp: 6000, prompt: 8000, eat: 8000,
    sniff: 8000, diff: 4000, todo: 1500,
    growl: 20000, chonk: 20000, lonely: 60000,
    // per-action
    ding: 1200, gossip: 3000, done: 3000, minion: 2000, compact: 4000,
    pet: 120, treat: 400, equip: 400, nope: 800,
    push: 800, branch: 800, stash: 800, install: 1500, build: 1500,
    commit: 500, green: 500, red: 800, merge: 800, combo: 800,
    clone: 1500, tidy: 1500, types: 1500, whale: 2000, migrate: 2000,
    undo: 800, zap: 1500, dispatch: 1500, feast: 2000,
    // moments
    deploy: 1500, milestone: 1500, levelup: 1500, transform: 1500,
    release: 1500, checklist: 1500,
    hatch: 2000, reset: 500, sad: 1500, spook: 1500,
    notify: 1200, warn: 3000, hint: 3000, sleep: 2000, wake: 2000, bye: 2000
  };

  // One motif per moment, all tiny and square: [freqHz, durationSeconds]…
  const MOTIFS = {
    // --- work landing
    commit:    [[659, 0.07], [880, 0.14]],
    green:     [[784, 0.08], [1047, 0.16]],
    red:       [[330, 0.12], [247, 0.22]],
    merge:     [[523, 0.07], [659, 0.07], [784, 0.12]],
    push:      [[659, 0.05], [988, 0.13]],
    branch:    [[784, 0.06], [659, 0.06], [880, 0.13]],
    stash:     [[698, 0.06], [523, 0.13]],
    install:   [[392, 0.05], [440, 0.05], [392, 0.05], [523, 0.12]],
    build:     [[330, 0.05], [392, 0.05], [494, 0.05], [587, 0.14]],
    deploy:    [[523, 0.06], [659, 0.06], [880, 0.06], [1175, 0.2]],
    release:   [[523, 0.06], [784, 0.06], [1047, 0.06], [1319, 0.18]],
    clone:     [[587, 0.05], [587, 0.05], [784, 0.11]],
    undo:      [[880, 0.06], [698, 0.06], [587, 0.12]],
    tidy:      [[1047, 0.04], [1175, 0.04], [1319, 0.04], [1568, 0.1]],
    types:     [[784, 0.05], [784, 0.05], [1047, 0.12]],
    whale:     [[247, 0.12], [208, 0.2]],
    migrate:   [[392, 0.06], [494, 0.06], [587, 0.06], [698, 0.14]],
    // --- the pet living
    eat:       [[392, 0.06], [523, 0.08]],
    feast:     [[523, 0.05], [392, 0.05], [523, 0.05], [392, 0.05], [659, 0.12]],
    prompt:    [[587, 0.05], [784, 0.08]],
    growl:     [[262, 0.09], [220, 0.17]],
    chonk:     [[523, 0.06], [440, 0.06], [349, 0.14]],
    pet:       [[880, 0.05], [1319, 0.1]],
    treat:     [[523, 0.05], [659, 0.05], [784, 0.12]],
    nope:      [[392, 0.07], [311, 0.13]],
    sad:       [[294, 0.1], [262, 0.18]],
    lonely:    [[587, 0.09], [494, 0.17]],
    wake:      [[440, 0.07], [554, 0.07], [659, 0.14]],
    sleep:     [[659, 0.12], [494, 0.12], [392, 0.2]],
    bye:       [[659, 0.09], [523, 0.09], [392, 0.16]],
    spook:     [[440, 0.08], [370, 0.08], [311, 0.16]],
    zap:       [[1175, 0.04], [880, 0.04], [1319, 0.04], [988, 0.08]],
    // --- ambient: Claude working in the background
    peek:      [[1047, 0.03], [1319, 0.05]],
    sniff:     [[1319, 0.03], [988, 0.03], [1319, 0.05]],
    diff:      [[698, 0.05], [880, 0.05], [1047, 0.09]],
    web:       [[494, 0.05], [740, 0.05], [988, 0.1]],
    mcp:       [[440, 0.05], [880, 0.05], [440, 0.05], [880, 0.1]],
    done:      [[1047, 0.05], [880, 0.11]],
    minion:    [[1175, 0.04], [988, 0.04], [1319, 0.09]],
    dispatch:  [[659, 0.05], [880, 0.05], [1175, 0.09]],
    todo:      [[988, 0.04], [1319, 0.08]],
    checklist: [[784, 0.06], [988, 0.06], [1175, 0.06], [1568, 0.18]],
    compact:   [[880, 0.05], [698, 0.05], [523, 0.05], [392, 0.14]],
    gossip:    [[698, 0.05], [880, 0.08]],
    ding:      [[880, 0.06], [1175, 0.14]],
    // --- growing up
    levelup:   [[523, 0.09], [659, 0.09], [784, 0.09], [1047, 0.24]],
    transform: [[440, 0.06], [554, 0.06], [659, 0.06], [880, 0.16]],
    hatch:     [[330, 0.05], [440, 0.05], [659, 0.05], [880, 0.07], [1319, 0.18]],
    milestone: [[659, 0.08], [880, 0.08], [1047, 0.08], [1319, 0.22]],
    combo:     [[784, 0.05], [988, 0.05], [1319, 0.1]],
    equip:     [[880, 0.05], [988, 0.05], [1175, 0.1]],
    reset:     [[784, 0.08], [587, 0.08], [440, 0.08], [294, 0.2]],
    // --- you are needed
    notify:    [[988, 0.07], [784, 0.07], [988, 0.12]],
    warn:      [[988, 0.09], [740, 0.09], [988, 0.09], [740, 0.14]],
    hint:      [[988, 0.06], [880, 0.13]]
  };

  function ensureCtx() {
    if (!audioCtx) audioCtx = new (global.AudioContext || global.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  /**
   * @param {string} name
   * @param {{on:boolean, volume:number, important:boolean}} opts
   */
  function play(name, opts) {
    const motif = MOTIFS[name];
    if (!motif) return;
    if (!opts.on && !opts.important) return;       // off by default
    const now = Date.now();
    const last = lastPlayed.get(name) || 0;
    if (now - last < (GAP[name] || 250)) return;   // throttle
    lastPlayed.set(name, now);

    const vol = opts.on ? Math.max(0, Math.min(1, opts.volume)) : 0.35; // important-through-mute volume
    if (vol <= 0) return;
    // Squared so the low end stays a whisper while the top end has real
    // headroom; notes never overlap, so PEAK is the actual sample ceiling.
    const peak = PEAK * vol * vol;
    try {
      const ctx = ensureCtx();
      let t = ctx.currentTime + 0.01;
      for (const [freq, dur] of motif) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square'; // chiptune, obviously
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(peak, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur);
        t += dur;
      }
    } catch (_) { /* audio is a garnish — never let it throw */ }
  }

  global.PetSounds = { play, NAMES: Object.keys(MOTIFS) };
})(window);
