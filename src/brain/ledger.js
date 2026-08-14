'use strict';
// What the pet ate today, counted.
//
// Everything else in this app is a running total or a mood — nothing could
// answer "what did we actually get done today?" without the answer decaying by
// morning. This is the day's till roll: one counter per kind of thing, reset
// at local midnight, persisted with the rest of the state so closing the lid
// at lunch does not lose the morning.

/** Local YYYY-MM-DD. Local, not UTC: a day ends when the human's day does. */
function dayKey(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyDay(now) {
  return {
    key: dayKey(now),
    startedAt: now,
    prompts: 0,
    edits: 0,
    feasts: 0,
    commits: 0,
    testsGreen: 0,
    testsRed: 0,
    todos: 0,
    prs: 0,
    deploys: 0,
    releases: 0,
    treats: 0,
    pets: 0,
    sick: 0,          // times it fell ill
    levels: 0,
    xp: 0,
    tokens: 0,
    bestStreak: 0
  };
}

/**
 * Add to today's count.
 *
 * Deliberately does NOT roll the day over: that needs a clock, and threading
 * one through every call site would put a timestamp argument on lines whose
 * whole job is to say `note(state, 'commit')`. The entry points (reduce, tick,
 * command) roll over once, on the way in.
 *
 * Every counter is created by emptyDay, so an unknown key is a typo — dropped
 * rather than quietly inventing a line item nobody can read.
 */
function note(state, key, n = 1) {
  if (!n || !state.day) return;
  if (!(key in state.day) || key === 'key' || key === 'startedAt') return;
  state.day[key] += n;
}

/** Today's ledger, replacing it if the calendar has moved on. */
function rollover(state, now) {
  if (!state.day || state.day.key !== dayKey(now)) {
    state.day = emptyDay(now);
  }
  return state.day;
}

module.exports = { dayKey, emptyDay, note, rollover };
