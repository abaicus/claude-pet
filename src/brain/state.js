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
    todos: null,                 // last TodoWrite seen: {n, d, p, at}
    pm: null,                    // last permission_mode seen (changes are news)
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
    name: 'Gogu',
    palette: 'mint',
    accessory: null,
    bubbles: true,
    statsLine: true,
    glow: true,
    scale: 1.5,           // the pixel sprite wants room; 1 is the floor
    soundOn: false,        // off by default — deliberate
    volume: 0.7,
    clickThrough: false,
    onboarded: false,      // the intro runs once, on the very first launch
    position: null,        // {x, y} — persists separately from pet state
    boxH: null,            // …and the window height it was a corner of, plus
    footH: null            // how far the feet stood above that box's bottom, so
                           // the FEET can be put back where they were even when
                           // the box has changed size since (see main.js)
  };
}

function migratePrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return defaultPrefs();
  const out = Object.assign(defaultPrefs(), prefs);
  // The scale floor moved from 0.5 to 1 when the art became pixel art —
  // a pet saved below the floor must not render smaller than the slider can
  // express, or the settings window would be lying about the size.
  out.scale = Math.max(1, Math.min(2.5, Number(out.scale) || 1.5));
  // A prefs file that predates the intro belongs to somebody who already has a
  // pet: greeting them with "hello, I'm new here" would be a lie. Only a
  // genuinely absent file (handled above) counts as a first launch.
  if (prefs.onboarded === undefined) out.onboarded = true;
  return out;
}

module.exports = { SCHEMA_VERSION, defaultState, resetState, migrate, defaultPrefs, migratePrefs };
