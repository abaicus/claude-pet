'use strict';
// Progression state: shape, defaults, schema migrations.

const SCHEMA_VERSION = 1;

function defaultState(now = 0) {
  return {
    schemaVersion: SCHEMA_VERSION,
    born: now,
    xp: 0,
    level: 0,
    food: 20,
    energy: 80,
    mood: 60,
    lifetimeCommits: 0,
    greenStreak: 0,
    lifetimeOutputTokens: 0,
    tokenMilestonesAwarded: 0,   // millions already celebrated
    lastEventAt: 0,              // any hook event
    lastMeaningfulAt: 0,         // events that count as "activity" for sleep/idle
    sleeping: false,
    combo: { count: 0, lastAt: 0 },
    petXpAt: 0,                  // last time petting granted xp (rate limit)
    treatAt: 0                   // last treat (cooldown)
  };
}

// Progression wiped by the danger-zone reset. Customization, sound settings
// and the event-log cursor live in prefs/cursor files and survive.
function resetState(state, now) {
  const fresh = defaultState(now);
  fresh.born = now;
  return fresh;
}

function migrate(state, now = 0) {
  if (!state || typeof state !== 'object') return defaultState(now);
  if (typeof state.schemaVersion !== 'number') return defaultState(now);
  // Future migrations: one function per version bump, applied in order.
  // if (state.schemaVersion === 1) { ...; state.schemaVersion = 2; }
  if (state.schemaVersion !== SCHEMA_VERSION) return defaultState(now);
  // Fill any missing fields defensively (hand-edited files are expected).
  const merged = Object.assign(defaultState(now), state);
  merged.combo = Object.assign({ count: 0, lastAt: 0 }, state.combo || {});
  return merged;
}

function defaultPrefs() {
  return {
    schemaVersion: 1,
    name: 'Pixel',
    palette: 'mint',
    accessory: null,
    bubbles: true,
    statsLine: true,
    glow: true,
    scale: 1,
    soundOn: false,        // off by default — deliberate
    volume: 0.5,
    clickThrough: false,
    position: null         // {x, y} — persists separately from pet state
  };
}

function migratePrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return defaultPrefs();
  return Object.assign(defaultPrefs(), prefs);
}

module.exports = { SCHEMA_VERSION, defaultState, resetState, migrate, defaultPrefs, migratePrefs };
