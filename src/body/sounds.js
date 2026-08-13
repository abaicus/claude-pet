'use strict';
// Synthesized chiptune motifs — Web Audio square waves, no audio files.
// Short, throttled, off by default. Notification/warning motifs are the ones
// allowed to bypass the mute (at a modest fixed volume).
//
// The motif table and its envelope are carried over from the earlier
// claude-pet prototype: notes play back-to-back with an instant attack and an
// exponential decay across the whole note. That hard attack is what makes them
// read as chiptune rather than as bleeps — don't "improve" it with a fade-in.

(function (global) {
  let audioCtx = null;
  const lastPlayed = new Map(); // name → ts

  // per-sound minimum gap (ms) — high-frequency events get throttled hard
  const GAP = {
    prompt: 8000, eat: 8000, ding: 1200, gossip: 3000,
    pet: 120, treat: 400, equip: 400,
    commit: 500, green: 500, red: 800, merge: 800, combo: 800,
    deploy: 1500, milestone: 1500, levelup: 1500, transform: 1500, sad: 1500,
    notify: 1200, warn: 3000, sleep: 2000, wake: 2000, bye: 2000
  };

  // One motif per moment, all tiny and square: [freqHz, durationSeconds]…
  const MOTIFS = {
    levelup:   [[523, 0.09], [659, 0.09], [784, 0.09], [1047, 0.24]],
    green:     [[784, 0.08], [1047, 0.16]],
    commit:    [[659, 0.07], [880, 0.14]],
    red:       [[330, 0.12], [247, 0.22]],
    eat:       [[392, 0.06], [523, 0.08]],
    pet:       [[880, 0.05], [1319, 0.1]],
    treat:     [[523, 0.05], [659, 0.05], [784, 0.12]],
    wake:      [[440, 0.07], [554, 0.07], [659, 0.14]],
    sleep:     [[659, 0.12], [494, 0.12], [392, 0.2]],
    sad:       [[294, 0.1], [262, 0.18]],
    notify:    [[988, 0.07], [784, 0.07], [988, 0.12]],
    warn:      [[988, 0.09], [740, 0.09], [988, 0.09], [740, 0.14]],
    gossip:    [[698, 0.05], [880, 0.08]],
    transform: [[440, 0.06], [554, 0.06], [659, 0.06], [880, 0.16]],
    prompt:    [[587, 0.05], [784, 0.08]],
    merge:     [[523, 0.07], [659, 0.07], [784, 0.12]],
    deploy:    [[523, 0.06], [659, 0.06], [880, 0.06], [1175, 0.2]],
    milestone: [[659, 0.08], [880, 0.08], [1047, 0.08], [1319, 0.22]],
    equip:     [[880, 0.05], [988, 0.05], [1175, 0.1]],
    ding:      [[880, 0.06], [1175, 0.14]],
    bye:       [[659, 0.09], [523, 0.09], [392, 0.16]],
    combo:     [[784, 0.05], [988, 0.05], [1319, 0.1]]
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
    try {
      const ctx = ensureCtx();
      let t = ctx.currentTime + 0.01;
      for (const [freq, dur] of motif) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square'; // chiptune, obviously
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.1 * vol, t);
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
