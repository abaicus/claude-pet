'use strict';
// The demo reel: a day of Claude Code, compressed into forty seconds.
//
// The pet only performs when Claude does something, which makes it a hard app
// to show to a room. This is the answer — a scripted afternoon that runs on
// demand, through the REAL reducer and the REAL debug presets, so what the
// room sees is the app reacting, not a second animation system posing for the
// camera. (Same principle as the README's screenshots: nothing is re-drawn for
// the audience.)
//
// A beat is one of three things, and nothing else:
//   { at, event }  a debugEvent preset name — the whole vocabulary of reactions
//   { at, level }  jump the ladder, which is how the reel shows off evolution
//   { at, say }    a line in the pet's own bubble, for the two beats that
//                  need narrating (the open and the close)
// `at` is milliseconds from the start of the reel. Order is not significant —
// the runner sorts — but keeping the list in time order is how it stays
// readable as a screenplay.

// ------------------------------------------------------------------ the reel
// The story: a session opens, work goes well, tests go red, the pet sulks, the
// tests come back green, a commit lands, it grows up. Then the second act —
// a permission prompt it can't continue past, a scare, a deploy, a release —
// and it grows up twice more before bed.
const REEL = [
  { at: 0, level: 2, say: 'watch this ♥' },

  // --- act one: an ordinary good hour
  { at: 900, event: 'sessionStart' },
  { at: 2000, event: 'prompt' },
  { at: 3100, event: 'edit' },
  { at: 3800, event: 'tinyEdit' },
  { at: 4900, event: 'feast' },            // a 61-line diff: the whole-body chomp
  { at: 6300, event: 'todos' },
  { at: 7400, event: 'dispatch' },         // *Explore, go!*
  { at: 8600, event: 'subagentBack' },
  // …and then the afternoon turns. Three red runs with nothing green between
  // them is the whole illness rule, played out at the speed it needs to be
  // seen at: sulk, sulk, plaster.
  { at: 9800, event: 'testsRed' },
  { at: 10900, event: 'edit' },
  { at: 11800, event: 'testsRed' },
  { at: 13000, event: 'toolFail' },
  { at: 13900, event: 'testsRed' },        // the third: the plaster goes on
  { at: 15600, event: 'edit' },
  { at: 16400, event: 'edit' },
  { at: 17400, event: 'testsGreen' },      // …and comes straight back off
  { at: 19000, event: 'commitStat' },
  { at: 20400, level: 3 },                 // hatchling → junior, the first evolution

  // --- act two: the day gets interesting
  { at: 22400, event: 'bigPrompt' },
  { at: 23600, event: 'webFetch' },
  { at: 24400, event: 'mcpCall' },
  { at: 25400, event: 'modePlan' },        // permission mode is news
  { at: 26800, event: 'notification' },    // the ! badge: cannot continue without you
  { at: 29000, event: 'modeNormal' },
  { at: 30000, event: 'rmRf' },            // 😱
  { at: 31400, event: 'forcePush' },
  { at: 32800, event: 'gitDiff' },
  { at: 34000, event: 'commit' },
  { at: 35200, event: 'testsGreen' },
  { at: 36400, level: 6 },                 // junior → senior
  { at: 38400, event: 'deploy' },
  { at: 39800, event: 'release' },
  { at: 41400, level: 9 },                 // senior → elder
  { at: 43400, event: 'preCompact' },
  { at: 44800, event: 'sessionEnd' },
  { at: 46000, say: 'that was my whole day ♥' }
];

/**
 * Plays a reel against a clock somebody else owns.
 *
 * Deliberately inert: it holds no timer and fires nothing. `due(now)` hands
 * back the beats that have come round since the last call, and the caller
 * decides what a beat MEANS. That is what makes the reel testable without
 * waiting forty real seconds for it.
 */
class DemoReel {
  constructor(reel = REEL) {
    this.reel = reel.slice().sort((a, b) => a.at - b.at);
    this.startedAt = null;
    this.i = 0;
  }

  get running() { return this.startedAt !== null; }

  /** Total length, including a beat of silence after the last line lands. */
  get durationMs() {
    return (this.reel.length ? this.reel[this.reel.length - 1].at : 0) + 1500;
  }

  start(now) { this.startedAt = now; this.i = 0; }
  stop() { this.startedAt = null; this.i = 0; }

  elapsed(now) { return this.running ? now - this.startedAt : 0; }

  /**
   * Every beat whose moment has arrived, in order. A slow tick (or a laptop
   * that slept mid-reel) hands back all of them at once rather than dropping
   * the ones it missed — a demo that silently skips its evolution because the
   * event loop was busy is worse than one that plays it late.
   */
  due(now) {
    if (!this.running) return [];
    const el = now - this.startedAt;
    const out = [];
    while (this.i < this.reel.length && this.reel[this.i].at <= el) out.push(this.reel[this.i++]);
    return out;
  }

  /** True once the last beat has played AND its moment has been let breathe. */
  finished(now) {
    return this.running && this.i >= this.reel.length && this.elapsed(now) >= this.durationMs;
  }
}

module.exports = { DemoReel, REEL };
