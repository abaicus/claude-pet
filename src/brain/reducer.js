'use strict';
// Event → state. Pure game logic, no timers, no Electron, no I/O.
// reduce() mutates the state it is given (single owner: the brain) and
// returns a list of effects: {type:'anim'|'bubble'|'sound'|'milestone', ...}.
//
// ctx: { now, rng, live } — live=false while replaying a backlog: stats
// still move, but no fx (a day's log must not fire fifty parties).

const { TUNING, levelForXp, formForLevel, MAX_LEVEL } = require('../shared/constants');
const { classifyBash } = require('./bash-parser');
const { pick, EXT_FLAVOR } = require('./quips');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const QUIET_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Task', 'NotebookRead']);

// A file that is itself a test — the pet approves of these specifically.
const TEST_FILE = /(\.(test|spec)\.[a-z]+$|^test_|_test\.[a-z]+$)/i;

// permission_mode → what the pet says when it CHANGES. Never announced on
// first sighting: that would be reporting the weather, not noticing a change.
const MODE_QUIP = {
  plan: 'modePlan',
  acceptEdits: 'modeAccept',
  bypassPermissions: 'modeBypass',
  default: 'modeDefault'
};

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

// Claude tells every tool event which permission mode the session is in.
// Announcing the value would be noise; announcing the transition is news.
function notePermissionMode(state, ev, fx, ctx) {
  if (typeof ev.pm !== 'string' || !ev.pm) return;
  const prev = state.pm;
  if (prev === ev.pm) return;
  state.pm = ev.pm;
  if (!prev) return;                       // first sighting is not a change
  const pool = MODE_QUIP[ev.pm];
  if (!pool) return;
  const scary = ev.pm === 'bypassPermissions';
  anim(fx, ctx, scary ? 'shiver' : (ev.pm === 'plan' ? 'think' : 'nod'));
  sound(fx, ctx, scary ? 'spook' : 'ding');
  say(fx, ctx, 1, pool, { important: scary });
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
    } else if (ev.desc) {
      // Claude labels every command it runs; the pet reads the label aloud
      // now and then instead of inventing a description of its own.
      sound(fx, ctx, 'peek');
      say(fx, ctx, 0.06, null, { text: `*${ev.desc.toLowerCase()}*`, kind: 'narrate' });
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
      } else if (c.stat) {
        // git counted these itself, so they are stated flat — no `~`.
        say(fx, ctx, 0.9, null, { text: `+${c.stat.add} −${c.stat.del} committed 🎉`, kind: 'commit' });
      } else {
        say(fx, ctx, 0.9, 'commit');
      }
      addXp(state, TUNING.commit.xp, fx, ctx);
      break;
    }
    case 'amend': {
      sound(fx, ctx, 'undo');
      say(fx, ctx, 0.7, 'amend');
      addXp(state, TUNING.smallCmdXp, fx, ctx);
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
    case 'release': {
      anim(fx, ctx, 'spin');
      sound(fx, ctx, 'release');
      say(fx, ctx, 1, 'release');
      addXp(state, TUNING.deployXp, fx, ctx);
      break;
    }
    case 'push': case 'merge': case 'install':
    case 'branch': case 'stash': case 'build': case 'clone': {
      // motif name == classified kind for these seven
      sound(fx, ctx, c.kind);
      say(fx, ctx, 0.7, c.kind);
      addXp(state, TUNING.smallCmdXp, fx, ctx);
      break;
    }
    case 'diff': {
      sound(fx, ctx, 'diff');
      if (c.stat) {
        anim(fx, ctx, 'nibble');
        const files = `${c.stat.files} file${c.stat.files === 1 ? '' : 's'}`;
        say(fx, ctx, 0.9, null, { text: `+${c.stat.add} −${c.stat.del} · ${files}`, kind: 'diff' });
      } else {
        anim(fx, ctx, 'sniff');
        say(fx, ctx, 0.4, 'diff');
      }
      break;
    }
    case 'inspect': {           // git status/log — constant, so almost silent
      sound(fx, ctx, 'peek');
      say(fx, ctx, 0.08, 'inspect');
      break;
    }
    case 'lint': {
      anim(fx, ctx, 'nod');
      sound(fx, ctx, 'tidy');
      say(fx, ctx, 0.6, 'lint');
      addXp(state, TUNING.smallCmdXp, fx, ctx);
      break;
    }
    case 'typecheck': {
      sound(fx, ctx, 'types');
      say(fx, ctx, 0.5, 'typecheck');
      addXp(state, TUNING.smallCmdXp, fx, ctx);
      break;
    }
    case 'docker': {
      sound(fx, ctx, 'whale');
      say(fx, ctx, 0.45, 'docker');
      break;
    }
    case 'migrate': {
      anim(fx, ctx, 'think');
      sound(fx, ctx, 'migrate');
      say(fx, ctx, 0.9, 'migrate');
      addXp(state, TUNING.smallCmdXp, fx, ctx);
      break;
    }
    case 'search': {
      sound(fx, ctx, 'sniff');
      if (ctx.live && ctx.rng() < 0.2) anim(fx, ctx, 'sniff'); // greps come in bursts
      say(fx, ctx, 0.1, 'search');
      break;
    }
    case 'net': {
      sound(fx, ctx, 'web');
      say(fx, ctx, 0.15, 'net');
      break;
    }
    case 'sudo': {
      sound(fx, ctx, 'zap');
      say(fx, ctx, 0.5, 'sudo');
      break;
    }
    case 'revert': {
      anim(fx, ctx, 'sulk');
      sound(fx, ctx, 'undo');
      say(fx, ctx, 0.8, 'revert');
      break;
    }
    // The three that make the pet physically nervous.
    case 'force-push': {
      anim(fx, ctx, 'shiver');
      sound(fx, ctx, 'spook');
      say(fx, ctx, 1, 'forcePush');
      break;
    }
    case 'reset-hard': {
      anim(fx, ctx, 'shiver');
      sound(fx, ctx, 'spook');
      say(fx, ctx, 1, 'resetHard');
      break;
    }
    case 'kill': {
      anim(fx, ctx, 'flinch');
      sound(fx, ctx, 'spook');
      say(fx, ctx, 0.6, 'kill');
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

// ---------------------------------------------------------------- edits
// Food and reaction scale with how much the edit actually carried. `add`/`del`
// are the edit's own line counts, not a git diff (a rewritten block counts on
// both sides), which is exactly why every number here is labeled `~`.
function reduceEdit(state, ev, fx, ctx) {
  const touched = (ev.add || 0) + (ev.del || 0);
  const feast = touched >= TUNING.feastLines;
  addFood(state, TUNING.foodPerEdit + (feast ? TUNING.feastFood : 0));

  const combo = state.combo;
  combo.count = (ev.ts - combo.lastAt <= TUNING.comboWindowMs) ? combo.count + 1 : 1;
  combo.lastAt = ev.ts;

  if (TUNING.comboAt.includes(combo.count)) {
    anim(fx, ctx, 'party');
    sound(fx, ctx, 'combo');
    say(fx, ctx, 1, null, { text: `${combo.count}x ${pick(ctx.rng, 'combo')}`, kind: 'combo' });
    if (ctx.live) fx.push({ type: 'milestone', name: 'combo', count: combo.count });
  } else if (feast) {
    anim(fx, ctx, 'feast');
    sound(fx, ctx, 'feast');
    say(fx, ctx, 0.85, null, { text: `${pick(ctx.rng, 'feast')} ~${touched} lines`, kind: 'feast' });
  } else if (ev.file && TEST_FILE.test(ev.file)) {
    anim(fx, ctx, 'nibble');
    sound(fx, ctx, 'eat');
    say(fx, ctx, 0.5, 'testFile');
  } else {
    anim(fx, ctx, touched > 0 && touched <= 2 ? 'nibble' : 'eat');
    sound(fx, ctx, 'eat'); // throttled hard renderer-side: a busy session is not a metronome
    const flavor = ev.ext && EXT_FLAVOR[ev.ext];
    if (flavor) say(fx, ctx, 0.1, null, { text: flavor, kind: 'flavor' });
    else say(fx, ctx, 0.08, touched > 0 && touched <= 2 ? 'tinyEdit' : 'edit');
  }
  addXp(state, TUNING.xpPerEdit, fx, ctx);
}

// ---------------------------------------------------------------- todos
// Claude's own task list, straight from the TodoWrite payload. The pet cares
// about the DELTA — a box ticked, a list finished, a new plan appearing.
function reduceTodos(state, ev, fx, ctx) {
  const prev = state.todos || { n: 0, d: 0 };
  const cur = { n: ev.todo.n, d: ev.todo.d, p: ev.todo.p, at: ev.ts };
  state.todos = cur;

  if (cur.n > 0 && cur.d === cur.n && prev.d < cur.n) {
    anim(fx, ctx, 'spin');
    sound(fx, ctx, 'checklist');
    say(fx, ctx, 1, 'todosDone');
    addXp(state, TUNING.todoDoneXp, fx, ctx);
    return;
  }
  if (cur.d > prev.d) {
    anim(fx, ctx, 'nod');
    sound(fx, ctx, 'todo');
    say(fx, ctx, 0.7, null, { text: `${cur.d}/${cur.n} done ✓`, kind: 'todo' });
    addXp(state, TUNING.todoXp, fx, ctx);
    return;
  }
  if (cur.n > prev.n) {                    // a plan appeared
    sound(fx, ctx, 'todo');
    say(fx, ctx, 0.35, 'todoPlan');
  }
}

// ---------------------------------------------------------------- quiet tools
// Claude reading, searching, fetching, delegating. These fire constantly, so
// the pet stays near-silent — but when it does speak it uses the real detail
// from the payload (which host, which MCP server, which subagent) rather than
// a generic noise.
function reduceQuietTool(state, ev, tool, fx, ctx) {
  if (tool.startsWith('mcp__') || tool.startsWith('ListMcpResources')) {
    sound(fx, ctx, 'mcp');
    if (ev.srv) say(fx, ctx, 0.12, null, { text: `*pokes the ${ev.srv} server*`, kind: 'mcp' });
    else say(fx, ctx, 0.04, 'whisper');
    return;
  }
  switch (tool) {
    case 'WebFetch':
      sound(fx, ctx, 'web');
      if (ev.host) say(fx, ctx, 0.25, null, { text: `*reads ${ev.host}*`, kind: 'web' });
      else say(fx, ctx, 0.08, 'whisper');
      return;
    case 'WebSearch':
      sound(fx, ctx, 'web');
      say(fx, ctx, 0.12, 'net');
      return;
    case 'Task':                          // the subagent came home
      sound(fx, ctx, 'minion');
      if (ev.agent) say(fx, ctx, 0.35, null, { text: `the ${ev.agent} is back!`, kind: 'minion' });
      else say(fx, ctx, 0.15, 'whisper');
      return;
    case 'Grep': case 'Glob':
      sound(fx, ctx, 'sniff');
      if (ctx.live && ctx.rng() < 0.15) anim(fx, ctx, 'sniff'); // frequent: rarely moves
      say(fx, ctx, 0.05, 'search');
      return;
    default: {
      sound(fx, ctx, 'peek');
      const flavor = ev.ext && EXT_FLAVOR[ev.ext];
      if (flavor) say(fx, ctx, 0.05, null, { text: flavor, kind: 'flavor' });
      else say(fx, ctx, 0.04, 'whisper');
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
      notePermissionMode(state, ev, fx, ctx);
      const plen = ev.plen || 0;
      const big = plen >= TUNING.longPromptLen;
      addFood(state, TUNING.foodPerPrompt + (big ? TUNING.longPromptFood : 0));
      anim(fx, ctx, big ? 'feast' : 'eat');
      if (state.food > 150) { sound(fx, ctx, 'chonk'); say(fx, ctx, 0.5, 'promptChonk'); }
      else if (state.food < 10 + TUNING.foodPerPrompt) { sound(fx, ctx, 'growl'); say(fx, ctx, 0.6, 'promptStarving'); }
      else if (big) { sound(fx, ctx, 'feast'); say(fx, ctx, 0.5, 'promptLong'); }
      else if (plen > 0 && plen <= TUNING.shortPromptLen) { sound(fx, ctx, 'prompt'); say(fx, ctx, 0.4, 'promptShort'); }
      else {
        sound(fx, ctx, 'prompt');
        // The work is going out the door — sometimes the pet shouts after it
        // instead of commenting on the meal.
        if (ctx.rng() < TUNING.cheerChance) say(fx, ctx, 1, 'cheer');
        else say(fx, ctx, 0.25, 'prompt');
      }
      break;
    }
    case 'PreToolUse': {
      wakeIfSleeping(state, fx, ctx);
      touch(state, ev, true);
      notePermissionMode(state, ev, fx, ctx);
      // The one thing worth reacting to BEFORE it happens: Claude handing work
      // to a subagent. `agent` is the subagent_type Claude asked for.
      if (ev.tool === 'Task') {
        anim(fx, ctx, 'think');
        sound(fx, ctx, 'dispatch');
        // no article — subagent types are proper-ish names ("Explore",
        // "general-purpose") and "a Explore" reads terribly.
        say(fx, ctx, 0.6, 'dispatch', ev.agent ? { text: `*${ev.agent}, go!*`, kind: 'dispatch' } : {});
      }
      break;
    }
    case 'PostToolUse': {
      wakeIfSleeping(state, fx, ctx);
      touch(state, ev, true);
      notePermissionMode(state, ev, fx, ctx);
      const tool = ev.tool || '';
      addEnergy(state, isQuietTool(tool) ? TUNING.energyPerToolCall / 2 : TUNING.energyPerToolCall);

      if (EDIT_TOOLS.has(tool)) {
        reduceEdit(state, ev, fx, ctx);
      } else if (tool === 'TodoWrite' && ev.todo && ev.ok !== false) {
        reduceTodos(state, ev, fx, ctx);
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
        reduceQuietTool(state, ev, tool, fx, ctx);
      }
      break;
    }
    case 'Notification': {
      // The headline trick: relay the ACTUAL message, bypass mute.
      wakeIfSleeping(state, fx, ctx);
      touch(state, ev, false);
      if (ctx.live) {
        // "waiting for your input" is a nudge; a permission request is a
        // gate. Same relay, different urgency in the chime.
        const idle = /waiting for your input|idle/i.test(ev.msg || '');
        fx.push({ type: 'anim', name: idle ? 'nod' : 'attention' });
        fx.push({ type: 'sound', name: idle ? 'hint' : 'notify', important: true });
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
      touch(state, ev, true);
      // source 'compact' is the SAME session coming back from a compaction —
      // greeting you again there would be a lie about what just happened.
      if (ev.source === 'compact') break;
      wakeIfSleeping(state, fx, ctx);
      anim(fx, ctx, 'wake');
      sound(fx, ctx, 'wake');
      if (ev.source === 'resume') say(fx, ctx, 0.9, 'sessionResume');
      else if (ev.source === 'clear') say(fx, ctx, 0.9, 'sessionClear');
      else say(fx, ctx, 0.8, 'sessionStart');
      break;
    }
    case 'SessionEnd': {
      touch(state, ev, false);
      addEnergy(state, TUNING.stopEnergy);
      if (ev.reason === 'clear') {   // not goodbye — the context was wiped
        sound(fx, ctx, 'reset');
        say(fx, ctx, 0.6, 'sessionCleared');
        break;
      }
      anim(fx, ctx, 'wave');
      sound(fx, ctx, 'bye');
      say(fx, ctx, 0.35, 'sessionEnd');
      break;
    }
    case 'Stop': {
      touch(state, ev, false);
      addEnergy(state, TUNING.stopEnergy / 2);
      sound(fx, ctx, 'done');
      // No quip here: the session registry announces this one by name
      // ("claudy-pet · done ✓ your turn"), and which session finished is the
      // only part of "Claude stopped" a human can't already see.
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
      // auto = the window filled up on its own; that's worth a different line
      // from the deliberate /compact.
      say(fx, ctx, 0.9, ev.trigger === 'auto' ? 'preCompactAuto' : 'preCompact');
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
