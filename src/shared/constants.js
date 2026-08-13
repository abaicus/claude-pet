'use strict';
// Shared constants: game tuning, forms, palettes, accessories, IPC channels.
// No Electron imports here — used by brain (headless) and renderer alike.

const os = require('os');
const path = require('path');

// ---------------------------------------------------------------- paths
// CLAUDE_PET_DIR / CLAUDE_PET_SETTINGS let tests and smoke runs sandbox
// everything away from the real ~/.claude-pet and ~/.claude/settings.json.
function petDir() {
  return process.env.CLAUDE_PET_DIR || path.join(os.homedir(), '.claude-pet');
}
function claudeSettingsPath() {
  return process.env.CLAUDE_PET_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
}

const FILES = {
  events: 'events.jsonl',   // hook-appended event log
  state: 'state.json',      // progression (wiped by reset)
  prefs: 'prefs.json',      // customization + window position (survives reset)
  cursor: 'cursor.json',    // event-log read offset (survives reset — real bug once)
  hook: 'claude-pet-hook.js' // installed copy of the hook script (name doubles as ownership marker)
};

// ---------------------------------------------------------------- leveling
const XP_LADDER = [0, 50, 120, 250, 450, 700, 1000, 1500, 2200, 3000, 4200];
const MAX_LEVEL = XP_LADDER.length - 1; // 10

const FORMS = ['egg', 'hatchling', 'junior', 'senior', 'elder'];
function formForLevel(level) {
  if (level >= 9) return 'elder';
  if (level >= 6) return 'senior';
  if (level >= 3) return 'junior';
  if (level >= 1) return 'hatchling';
  return 'egg';
}
function levelForXp(xp) {
  let lvl = 0;
  for (let i = 0; i < XP_LADDER.length; i++) if (xp >= XP_LADDER[i]) lvl = i;
  return lvl;
}

// ---------------------------------------------------------------- palettes
// 12 four-color ramps. One color per (non-egg) form so evolution reads as
// growth in any palette: hatchling→ramp[0] … elder→ramp[3].
// Each entry: [c0, c1, c2, c3] light→deep. Egg ignores palettes.
const PALETTES = {
  mint:     ['#a8e6cf', '#7bd4b2', '#4fbf96', '#2e9c78'],
  peach:    ['#ffd3b6', '#ffb28a', '#ff8f66', '#e56e4a'],
  sky:      ['#bde0fe', '#8ec9f5', '#5fa8e8', '#3c82c4'],
  lavender: ['#e0c3fc', '#c39df0', '#9d70dc', '#7a4fc0'],
  sunset:   ['#ffd97d', '#ffb26b', '#ff7f51', '#e0503a'],
  ocean:    ['#90e0ef', '#48cae4', '#0096c7', '#023e8a'],
  forest:   ['#b7e4c7', '#74c69d', '#40916c', '#1b4332'],
  sakura:   ['#ffe5ec', '#ffc2d1', '#ff8fab', '#f75c8b'],
  ember:    ['#ffba8c', '#ff8552', '#e84a27', '#b03015'],
  mono:     ['#d8d8d8', '#ababab', '#7c7c7c', '#4d4d4d'],
  candy:    ['#ffc8dd', '#f8a1d1', '#e26bc4', '#b23aa8'],
  midnight: ['#9fa8da', '#7986cb', '#5c6bc0', '#3949ab']
};
const PALETTE_NAMES = Object.keys(PALETTES);

// ---------------------------------------------------------------- accessories
// Exactly one equipped; unlocked by level; locks enforced by the brain.
// All sit off the face; wings sweep away from the body.
const ACCESSORIES = [
  { id: 'bow',       name: 'Bow',        level: 1 },
  { id: 'sprout',    name: 'Sprout',     level: 1 },
  { id: 'flower',    name: 'Flower',     level: 2 },
  { id: 'scarf',     name: 'Scarf',      level: 2 },
  { id: 'beret',     name: 'Beret',      level: 3 },
  { id: 'headphones',name: 'Headphones', level: 4 },
  { id: 'crown',     name: 'Crown',      level: 5 },
  { id: 'wings',     name: 'Wings',      level: 6 },
  { id: 'halo',      name: 'Halo',       level: 7 },
  { id: 'wizardhat', name: 'Wizard hat', level: 8 },
  { id: 'balloon',   name: 'Balloon',    level: 9 },
  { id: 'sparkles',  name: 'Sparkles',   level: 10 }
];

// ---------------------------------------------------------------- tuning
const TUNING = {
  foodPerPrompt: 6,
  foodPerEdit: 4,
  xpPerEdit: 6,
  commit: { food: 10, mood: 15, xp: 25 },
  testsGreenXp: 20,
  testsRedMood: -10,
  prXp: 15,
  deployXp: 30,
  smallCmdXp: 5,
  toolFailMood: -8,
  stopEnergy: 20,
  energyPerToolCall: -0.8,
  energyRecoverPerMin: 3,     // while idle
  foodDecayPerMin: 1.2,
  lonelyAfterMin: 30,
  lonelyMoodPerMin: -0.5,
  sleepEnergyBelow: 25,
  sleepQuietMs: 60 * 1000,    // never doze mid-work
  wanderAfterIdleMs: 3 * 60 * 1000,
  petMood: 3,
  petXp: 2,
  petXpCooldownMs: 2 * 60 * 1000,
  petFactChance: 0.45,        // share a REAL session fact instead of a quip
  treat: { food: 15, mood: 5, xp: 3, cooldownMs: 5 * 60 * 1000 },
  comboWindowMs: 2 * 60 * 1000,
  comboAt: [8, 20],
  commitMilestoneEvery: 10,
  greenStreakMilestone: 5,
  tokenMilestoneEvery: 1_000_000,
  gossipEveryMs: 2.5 * 60 * 1000,
  gossipChance: 0.35,
  gossipRecentMs: 10 * 60 * 1000, // only while events are recent
  ctxWindow: 200_000,             // assumed window; readouts are labeled ~
  ctxWarn1: 0.75,
  ctxWarn2: 0.90,
  ctxRearmBelow: 0.60,
  ctxReportPct: 0.40,
  ctxReportEveryMs: 10 * 60 * 1000,
  burnWindowMs: 5 * 60 * 60 * 1000,
  sessionDeadAfterMs: 30 * 60 * 1000,
  maxNameLen: 12
};

// ---------------------------------------------------------------- IPC
const IPC = {
  state: 'pet:state',            // brain → windows (single state object)
  command: 'pet:command',        // windows → brain
  cursor: 'pet:cursor',          // main → pet window (cursor pos for eyes)
  moveWindow: 'pet:move-window', // pet renderer drag → main
  contextMenu: 'pet:context-menu'
};

module.exports = {
  petDir, claudeSettingsPath, FILES,
  XP_LADDER, MAX_LEVEL, FORMS, formForLevel, levelForXp,
  PALETTES, PALETTE_NAMES, ACCESSORIES, TUNING, IPC
};
