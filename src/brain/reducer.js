'use strict';
// Event → state. Pure game logic, no timers, no Electron, no I/O.
// reduce() mutates the state it is given (single owner: the brain) and
// returns a list of effects: {type:'anim'|'bubble'|'sound'|'milestone', ...}.
//
// ctx: { now, rng, live } — live=false while replaying a backlog: stats
// still move, but no fx (a day's log must not fire fifty parties).

const { TUNING, levelForXp, formForLevel, MAX_LEVEL } = require('../shared/constants');
const { classifyBash } = require('./bash-parser');
const { pick } = require('./quips');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const QUIET_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Task', 'NotebookRead']);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function isQuietTool(tool) {
  if (!tool) return true;
  return QUIET_TOOLS.has(tool) || tool.startsWith('mcp__') || tool.startsWith('ListMcpResources');
}

// ---------------------------------------------------------------- helpers
function addMood(state, delta) { state.mood = clamp(state.mood + delta, 0, 100); }
function addEnergy(state, delta) { state.energy = clamp(state.energy + delta, 0, 100); }
function addFood(state, delta) { state.food = Math.max(0, state.food + delta); } // uncapped up — overfed pet is the point

function addXp(state, amount, fx, ctx) {
  if (amount <= 0) return;
  state.xp += amount;
  const newLevel = levelForXp(state.xp);
  if (newLevel > state.level) {
    const oldForm = formForLevel(state.level);
    state.level = Math.min(newLevel, MAX_LEVEL);
    const newForm = formForLevel(state.level);
    if (ctx.live) {
      if (newForm !== oldForm) {
        fx.push({ type: 'anim', name: 'party', big: true });
        fx.push({ type: 'bubble', text: pick(ctx.rng, 'evolve'), kind: 'evolve' });
        fx.push({ type: 'sound', name: newForm === 'hatchling' ? 'hatch' : 'transform' });
        fx.push({ type: 'milestone', name: 'evolve', form: newForm, level: state.level });
      } else {
        fx.push({ type: 'anim', name: 'party', big: false });
        fx.push({ type: 'bubble', text: pick(ctx.rng, 'levelUp'), kind: 'levelUp' });
        fx.push({ type: 'sound', name: 'levelup' });
        fx.push({ type: 'milestone', name: 'levelUp', level: state.level });
      }
    }
  }
}

function say(fx, ctx, chance, pool, opts = {}) {
  if (!ctx.live) return;
  if (ctx.rng() > chance) return;
  const text = opts.text || pick(ctx.rng, pool);
  if (!text) return;
  fx.push(Object.assign({ type: 'bubble', text, kind: opts.kind || pool }, opts.important ? { important: true } : {}));
}

function anim(fx, ctx, name, extra = {}) {
  if (!ctx.live) return;
  fx.push(Object.assign({ type: 'anim', name }, extra));
}
function sound(fx, ctx, name) {
  if (!ctx.live) return;
  fx.push({ type: 'sound', name });
}

function wakeIfSleeping(state, fx, ctx) {
  if (!state.sleeping) return;
  state.sleeping = false;
  anim(fx, ctx, 'wake');
  sound(fx, ctx, 'wake');
  say(fx, ctx, 0.5, 'wake');
}

function touch(state, ev, meaningful) {
  state.lastEventAt = ev.ts;
  if (meaningful) state.lastMeaningfulAt = ev.ts;
}

// ---------------------------------------------------------------- bash
function reduceBash(state, ev, fx, ctx) {
  const c = classifyBash(ev.cmd, ev.out || '', ev.ok !== false);
  if (!c) {
    if (ev.ok === false) {
      addMood(state, TUNING.toolFailMood);
      anim(fx, ctx, 'sulk');
      sound(fx, ctx, 'sad');
      say(fx, ctx, 0.6, 'toolFail');
    }
    return;
  }
  switch (c.kind) {
    case 'commit': {
      addFood(state, TUNING.commit.food);
      addMood(state, TUNING.commit.mood);
      state.lifetimeCommits += 1;
      anim(fx, ctx, 'party');
      sound(fx, ctx, 'commit');
      if (state.lifetimeCommits % TUNING.commitMilestoneEvery === 0) {
        anim(fx, ctx, 'party', { big: true });
        sound(fx, ctx, 'milestone');
        say(fx, ctx, 1, null, { text: `commit #${state.lifetimeCommits}!! 🎉`, kind: 'milestone' });
        if (ctx.live) fx.push({ type: 'milestone', name: 'commits', count: state.lifetimeCommits });
      } else {
        say(fx, ctx, 0.9, 'commit');
      }
      addXp(state, TUNING.commit.xp, fx, ctx);
      break;
    }
    case 'commit-failed': {
      addMood(state, -3);
      anim(fx, ctx, 'sulk');
      sound(fx, ctx, 'sad');
      say(fx, ctx, 0.6, 'commitFailed');
      break;
    }
    case 'tests-green': {
      state.greenStreak += 1;
      const n = c.counts && c.counts.passed;
      anim(fx, ctx, 'party');
      sound(fx, ctx, 'green');
      if (state.greenStreak > 0 && state.greenStreak % TUNING.greenStreakMilestone === 0) {
        say(fx, ctx, 1, null, { text: `${state.greenStreak} green runs straight!! ✓✓`, kind: 'milestone' });
        sound(fx, ctx, 'milestone');
        if (ctx.live) fx.push({ type: 'milestone', name: 'greenStreak', count: state.greenStreak });
      } else if (n != null) {
        say(fx, ctx, 0.9, null, { text: `${n} test${n === 1 ? '' : 's'} green ✓`, kind: 'tests' });
      } else {
        say(fx, ctx, 0.9, 'testsGreenNoCount');
      }
      addXp(state, TUNING.testsGreenXp, fx, ctx);
      break;
    }
    case 'tests-red': {
      addMood(state, TUNING.testsRedMood);
      state.greenStreak = 0;
      anim(fx, ctx, 'sulk');
      sound(fx, ctx, 'red');
      const n = c.counts && c.counts.failed;
      say(fx, ctx, 0.95, null, {
        text: n != null ? `${n} test${n === 1 ? '' : 's'} red…` : 'tests failed…',
        kind: 'tests'
      });
      break;
    }
    case 'tests-unknown': {
      sound(fx, ctx, 'peek');
      say(fx, ctx, 0.3, 'testsUnknown');
      break;
    }
    case 'pr-create': {
      anim(fx, ctx, 'party');
      sound(fx, ctx, 'merge');
      say(fx, ctx, 0.9, 'prCreate');
      addXp(state, TUNING.prXp, fx, ctx);
      break;
    }
    case 'pr-merge': {
      anim(fx, ctx, 'party');
      sound(fx, ctx, 'merge');
      say(fx, ctx, 0.9, 'prMerge');
      addXp(state, TUNING.prXp, fx, ctx);
      break;
    }
    case 'deploy': {
      anim(fx, ctx, 'party', { big: true });
      sound(fx, ctx, 'deploy');
      say(fx, ctx, 1, 'deploy');
      addXp(state, TUNING.deployXp, fx, ctx);
      break;
    }
    case 'push': case 'merge': case 'install':
    case 'branch': case 'stash': case 'build': {
      // motif name == classified kind for these six
      sound(fx, ctx, c.kind);
      say(fx, ctx, 0.7, c.kind);
      addXp(state, TUNING.smallCmdXp, fx, ctx);
      break;
    }
    case 'rm-rf': {
      anim(fx, ctx, 'flinch');
      sound(fx, ctx, 'warn');
      say(fx, ctx, 1, 'rmRf');
      break;
    }
  }
}

// ---------------------------------------------------------------- events
function reduce(state, ev, ctx) {
  const fx = [];
  if (!ev || typeof ev.t !== 'string') return fx;
  if (typeof ev.ts !== 'number') ev.ts = ctx.now;

  switch (ev.t) {
    case 'UserPromptSubmit': {
      wakeIfSleeping(state, fx, ctx);
      touch(state, ev, true);
      addFood(state, TUNING.foodPerPrompt);
      anim(fx, ctx, 'eat');
      if (state.food > 150) { sound(fx, ctx, 'chonk'); say(fx, ctx, 0.5, 'promptChonk'); }
      else if (state.food < 10 + TUNING.foodPerPrompt) { sound(fx, ctx, 'growl'); say(fx, ctx, 0.6, 'promptStarving'); }
      else { sound(fx, ctx, 'prompt'); say(fx, ctx, 0.25, 'prompt'); }
      break;
    }
    case 'PreToolUse': {
      wakeIfSleeping(state, fx, ctx);
      touch(state, ev, true);
      break;
    }
    case 'PostToolUse': {
      wakeIfSleeping(state, fx, ctx);
      touch(state, ev, true);
      const tool = ev.tool || '';
      addEnergy(state, isQuietTool(tool) ? TUNING.energyPerToolCall / 2 : TUNING.energyPerToolCall);

      if (EDIT_TOOLS.has(tool)) {
        addFood(state, TUNING.foodPerEdit);
        // rolling 2-minute edit combo
        const combo = state.combo;
        combo.count = (ev.ts - combo.lastAt <= TUNING.comboWindowMs) ? combo.count + 1 : 1;
        combo.lastAt = ev.ts;
        if (TUNING.comboAt.includes(combo.count)) {
          anim(fx, ctx, 'party');
          sound(fx, ctx, 'combo');
          say(fx, ctx, 1, null, { text: `${combo.count}x ${pick(ctx.rng, 'combo')}`, kind: 'combo' });
          if (ctx.live) fx.push({ type: 'milestone', name: 'combo', count: combo.count });
        } else {
          anim(fx, ctx, 'eat');
          sound(fx, ctx, 'eat'); // throttled hard renderer-side: a busy session is not a metronome
          say(fx, ctx, 0.08, 'edit');
        }
        addXp(state, TUNING.xpPerEdit, fx, ctx);
      } else if (tool === 'Bash') {
        if (ev.ok === false && !ev.cmd) {
          addMood(state, TUNING.toolFailMood);
          anim(fx, ctx, 'sulk');
          sound(fx, ctx, 'sad');
        } else {
          // classified kinds (tests-red, commit-failed…) carry their own
          // penalties; reduceBash also handles unclassified failures
          reduceBash(state, ev, fx, ctx);
        }
      } else if (ev.ok === false) {
        addMood(state, TUNING.toolFailMood);
        anim(fx, ctx, 'sulk');
        sound(fx, ctx, 'sad');
        say(fx, ctx, 0.4, 'toolFail');
      } else if (isQuietTool(tool)) {
        if (tool.startsWith('mcp__') || tool.startsWith('ListMcpResources')) sound(fx, ctx, 'mcp');
        else if (tool === 'WebFetch' || tool === 'WebSearch') sound(fx, ctx, 'web');
        else sound(fx, ctx, 'peek');
        say(fx, ctx, 0.04, 'whisper');
      }
      break;
    }
    case 'Notification': {
      // The headline trick: relay the ACTUAL message, bypass mute.
      wakeIfSleeping(state, fx, ctx);
      touch(state, ev, false);
      if (ctx.live) {
        fx.push({ type: 'anim', name: 'attention' });
        fx.push({ type: 'sound', name: 'notify', important: true });
        fx.push({
          type: 'bubble',
          text: ev.msg || 'Claude needs you!',
          kind: 'notification',
          important: true
        });
      }
      break;
    }
    case 'SessionStart': {
      wakeIfSleeping(state, fx, ctx);
      touch(state, ev, true);
      anim(fx, ctx, 'wake');
      sound(fx, ctx, 'wake');
      say(fx, ctx, 0.8, 'sessionStart');
      break;
    }
    case 'SessionEnd': {
      touch(state, ev, false);
      addEnergy(state, TUNING.stopEnergy);
      anim(fx, ctx, 'wave');
      sound(fx, ctx, 'bye');
      say(fx, ctx, 0.35, 'sessionEnd');
      break;
    }
    case 'Stop': {
      touch(state, ev, false);
      addEnergy(state, TUNING.stopEnergy / 2);
      sound(fx, ctx, 'done');
      say(fx, ctx, 0.06, 'stop');
      break;
    }
    case 'SubagentStop': {
      touch(state, ev, false);
      sound(fx, ctx, 'minion');
      say(fx, ctx, 0.05, 'whisper');
      break;
    }
    case 'PreCompact': {
      touch(state, ev, true);
      sound(fx, ctx, 'compact');
      say(fx, ctx, 0.9, 'preCompact');
      break;
    }
    default:
      touch(state, ev, false);
  }
  return fx;
}

// ---------------------------------------------------------------- passive
// Called on a timer by the brain (and directly by tests). dt derived from
// state.lastTickAt so replays/pauses behave.
function tick(state, now, ctx) {
  const fx = [];
  const last = state.lastTickAt || now;
  const dtMin = Math.max(0, Math.min((now - last) / 60000, 24 * 60)); // cap: clock jumps
  state.lastTickAt = now;
  if (dtMin <= 0) return fx;

  // food decays
  addFood(state, -TUNING.foodDecayPerMin * dtMin);

  const idleMs = now - (state.lastMeaningfulAt || 0);
  const idle = state.lastMeaningfulAt ? idleMs : Infinity;

  // energy recovers while idle (no tool churn)
  if (idle > 60 * 1000) addEnergy(state, TUNING.energyRecoverPerMin * dtMin);

  // loneliness after 30 quiet minutes
  if (idle > TUNING.lonelyAfterMin * 60 * 1000 && state.lastMeaningfulAt) {
    addMood(state, TUNING.lonelyMoodPerMin * dtMin);
    if (!state.sleeping && ctx.rng() < 0.04 * dtMin) {
      sound(fx, ctx, 'lonely');
      say(fx, ctx, 1, 'lonely');
    }
  }

  // sleep requires low energy AND ≥1 min of event silence — never doze mid-work
  const quietMs = now - (state.lastEventAt || 0);
  if (!state.sleeping && state.energy < TUNING.sleepEnergyBelow && quietMs >= TUNING.sleepQuietMs) {
    state.sleeping = true;
    anim(fx, ctx, 'sleep');
    sound(fx, ctx, 'sleep');
    say(fx, ctx, 0.5, 'sleepy');
  }
  if (state.sleeping) addEnergy(state, TUNING.energyRecoverPerMin * 2 * dtMin);

  return fx;
}

// Lifetime output-token milestone check (tokens are fed by the session
// module, not by events).
function checkTokenMilestone(state, ctx) {
  const fx = [];
  const millions = Math.floor(state.lifetimeOutputTokens / TUNING.tokenMilestoneEvery);
  if (millions > (state.tokenMilestonesAwarded || 0)) {
    state.tokenMilestonesAwarded = millions;
    if (ctx.live) {
      fx.push({ type: 'anim', name: 'party', big: true });
      fx.push({ type: 'sound', name: 'milestone' });
      fx.push({ type: 'bubble', text: `${millions} million tokens spoken!! ✨`, kind: 'milestone' });
      fx.push({ type: 'milestone', name: 'tokens', millions });
    }
  }
  return fx;
}

module.exports = { reduce, tick, checkTokenMilestone, EDIT_TOOLS, isQuietTool };
