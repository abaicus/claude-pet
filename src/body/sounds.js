'use strict';
// Synthesized chiptune motifs — Web Audio square waves, no audio files.
// Short, throttled, off by default. The notification chime is the one
// sound allowed to bypass the mute (at a modest fixed volume).

(function (global) {
  let audioCtx = null;
  const lastPlayed = new Map(); // name → ts

  // per-sound minimum gap (ms) — high-frequency events get throttled hard
  const GAP = { blip: 1200, pop: 400, munch: 300, party: 800, fanfare: 1500, levelup: 1500, sad: 800, chime: 1200, equip: 500 };

  // [freqHz, startMs, durMs, type?]
  const MOTIFS = {
    blip:    [[660, 0, 55]],
    pop:     [[392, 0, 45]],
    munch:   [[220, 0, 60], [175, 80, 70]],
    party:   [[523, 0, 70], [659, 80, 70], [784, 160, 70], [1047, 240, 130]],
    fanfare: [[523, 0, 90], [523, 100, 60], [523, 170, 60], [659, 240, 140], [784, 400, 90], [1047, 500, 240]],
    levelup: [[440, 0, 70], [554, 80, 70], [659, 160, 70], [880, 240, 180]],
    sad:     [[440, 0, 150], [349, 180, 150], [294, 380, 260]],
    chime:   [[880, 0, 120, 'sine'], [1109, 130, 120, 'sine'], [1319, 260, 260, 'sine']],
    equip:   [[784, 0, 55], [988, 65, 55], [1175, 130, 100]]
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
      const t0 = ctx.currentTime + 0.01;
      for (const [freq, startMs, durMs, type] of motif) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type || 'square';
        osc.frequency.value = freq;
        const start = t0 + startMs / 1000, dur = durMs / 1000;
        const peak = 0.12 * vol * (osc.type === 'square' ? 1 : 1.6);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + dur + 0.02);
      }
    } catch (_) { /* audio is a garnish — never let it throw */ }
  }

  global.PetSounds = { play };
})(window);
