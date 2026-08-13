'use strict';
// The brain owns ALL state and game logic. The renderer is a dumb puppet:
// it receives one render-state object and draws it. Deleting the renderer
// leaves this file fully functional — that boundary is the architecture.
// No Electron imports (headless-testable).

const path = require('path');
const { EventEmitter } = require('events');
const C = require('../shared/constants');
const { TUNING } = C;
const { loadJson, saveJson, Saver } = require('./persistence');
const { defaultState, resetState, migrate, defaultPrefs, migratePrefs } = require('./state');
const { reduce, tick, checkTokenMilestone, ensureWords } = require('./reducer');
const { LogTailer } = require('./tailer');
const { SessionRegistry } = require('./sessions');
const { pick } = require('./quips');
const installer = require('../capture/installer');

const TICK_MS = 5000;
const SESSION_POLL_MS = 10000;
const LIVE_EVENT_MAX_AGE_MS = 30 * 1000;

class Brain extends EventEmitter {
  constructor({ dir, settingsPath, now = () => Date.now(), rng = Math.random } = {}) {
    super();
    this.dir = dir || C.petDir();
    this.settingsPath = settingsPath || C.claudeSettingsPath();
    this.now = now;
    this.rng = rng;

    this.files = {
      state: path.join(this.dir, C.FILES.state),
      prefs: path.join(this.dir, C.FILES.prefs),
      cursor: path.join(this.dir, C.FILES.cursor),
      events: path.join(this.dir, C.FILES.events)
    };

    this.state = migrate(loadJson(this.files.state, null), this.now());
    this.prefs = migratePrefs(loadJson(this.files.prefs, null));
    this.cursor = loadJson(this.files.cursor, { events: 0, transcripts: {} });
    if (typeof this.cursor.events !== 'number') this.cursor.events = 0;
    if (!this.cursor.transcripts || typeof this.cursor.transcripts !== 'object') this.cursor.transcripts = {};
    if (!this.cursor.ctxCeilings || typeof this.cursor.ctxCeilings !== 'object') this.cursor.ctxCeilings = {};

    this.sessions = new SessionRegistry({
      transcriptOffsets: this.cursor.transcripts,
      ctxCeilings: this.cursor.ctxCeilings   // measured at auto-compactions; too rare to relearn
    });

    this.stateSaver = new Saver(this.files.state, () => this.state);
    this.prefsSaver = new Saver(this.files.prefs, () => this.prefs, 1000);
    this.cursorSaver = new Saver(this.files.cursor, () => this.cursor, 1500);

    // transient render bits
    this.seq = 0;
    this.bubble = null;        // {seq, text, important, until}
    this.fxQueue = [];         // [{seq, name, big}]
    this.soundQueue = [];      // [{seq, name, important}]
    this.hooksStatus = { installed: false, ok: true, reason: null };
    this.lastGossipAt = 0;
    this.volumeSampleAt = 0;   // a slider drag must not machine-gun the sample
    this.replayDone = false;
    this.log = [];             // recent events for the debug log view
    this.emitScheduled = false;

    this.tailer = new LogTailer({ file: this.files.events, offset: this.cursor.events });
    this.tailer.on('events', (events, meta) => this.onEvents(events, meta));
    this.tailer.on('cursor', (offset) => {
      this.cursor.events = offset;
      this.cursorSaver.markDirty();
    });
    this.timers = [];
  }

  // ------------------------------------------------------------- lifecycle
  start({ installHooks = true } = {}) {
    if (installHooks) this.installHooks();
    this.state.lastTickAt = this.now();
    this.tailer.start();
    this.replayDone = true; // everything tailed from here on is live
    const t1 = setInterval(() => this.onTick(), TICK_MS);
    const t2 = setInterval(() => this.pollSessions(), SESSION_POLL_MS);
    const t3 = setTimeout(() => this.pollSessions(), 1000); // snappy first ctx readout
    this.timers = [t1, t2, t3];
    for (const t of this.timers) if (t.unref) t.unref();
    this.scheduleEmit();
  }

  stop() {
    this.tailer.stop();
    for (const t of this.timers) clearInterval(t); // clears timeouts too
    if (this.pollSoon) { clearTimeout(this.pollSoon); this.pollSoon = null; }
    this.timers = [];
    this.flush();
  }

  flush() {
    this.stateSaver.flush();
    this.prefsSaver.flush();
    this.cursorSaver.flush();
  }

  installHooks() {
    try {
      const res = installer.installHooks({ settingsPath: this.settingsPath, petDirPath: this.dir });
      this.hooksStatus = { installed: res.ok, ok: res.ok, reason: res.reason || null };
      if (!res.ok) {
        this.pushBubble({ text: pick(this.rng, 'hooksBroken'), important: true, kind: 'hooks' });
        this.applyFx([{ type: 'sound', name: 'warn', important: true }]);
      }
    } catch (err) {
      this.hooksStatus = { installed: false, ok: false, reason: err.message };
    }
    this.scheduleEmit();
    return this.hooksStatus;
  }

  uninstallHooks() {
    try {
      const res = installer.uninstallHooks({ settingsPath: this.settingsPath });
      if (res.ok) this.hooksStatus = { installed: false, ok: true, reason: null };
      else this.hooksStatus = { installed: this.hooksStatus.installed, ok: false, reason: res.reason };
    } catch (err) {
      this.hooksStatus = { installed: this.hooksStatus.installed, ok: false, reason: err.message };
    }
    this.scheduleEmit();
    return this.hooksStatus;
  }

  // ------------------------------------------------------------- events
  onEvents(events, meta = {}) {
    const now = this.now();
    for (const ev of events) {
      // Stale events (queued while the app was closed, or the initial
      // replay) still move stats but fire no fx.
      const live = this.replayDone && !meta.replay && (now - (ev.ts || 0)) < LIVE_EVENT_MAX_AGE_MS;
      const ctx = { now, rng: this.rng, live };
      // One event, one voice: the registry's line and the reducer's are judged
      // together so ensureWords only fills a silence that is really there.
      const fx = this.sessions.noteEvent(ev, ctx).concat(reduce(this.state, ev, ctx));
      this.applyFx(ensureWords(fx, ctx));
      this.log.push(ev);
    }
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    this.stateSaver.markDirty();
    // fresh events often mean fresh transcript bytes — poll soon (debounced)
    if (!this.pollSoon) {
      this.pollSoon = setTimeout(() => { this.pollSoon = null; this.pollSessions(); }, 600);
      if (this.pollSoon.unref) this.pollSoon.unref();
    }
    this.scheduleEmit();
  }

  onTick() {
    const now = this.now();
    const ctx = { now, rng: this.rng, live: true };
    this.applyFx(ensureWords(tick(this.state, now, ctx), ctx));
    this.maybeGossip(now);
    if (this.bubble && now > this.bubble.until) this.bubble = null;
    this.stateSaver.markDirty();
    this.scheduleEmit();
  }

  pollSessions() {
    const now = this.now();
    const { fx, outputTokensDelta } = this.sessions.poll(now);
    this.applyFx(fx);
    if (outputTokensDelta > 0) {
      this.state.lifetimeOutputTokens += outputTokensDelta;
      this.applyFx(checkTokenMilestone(this.state, { now, rng: this.rng, live: true }));
      this.stateSaver.markDirty();
    }
    this.cursorSaver.markDirty(); // transcript offsets live in cursor.json
    this.scheduleEmit();
  }

  // ------------------------------------------------------------- fx
  applyFx(fx) {
    for (const f of fx || []) {
      switch (f.type) {
        case 'bubble': this.pushBubble(f); break;
        case 'anim':
          this.fxQueue.push({ seq: ++this.seq, name: f.name, big: !!f.big });
          if (this.fxQueue.length > 8) this.fxQueue.shift();
          break;
        case 'sound':
          this.soundQueue.push({ seq: ++this.seq, name: f.name, important: !!f.important });
          if (this.soundQueue.length > 8) this.soundQueue.shift();
          break;
        case 'milestone':
          this.emit('milestone', f);
          break;
      }
    }
  }

  pushBubble({ text, important, kind }) {
    if (!text) return;
    // Mute rule: non-important bubbles respect the toggle; important ones
    // (notifications, ctx warnings) ALWAYS get through. Never refactor away.
    if (!important && !this.prefs.bubbles) return;
    // Don't let a quip stomp an important bubble that is still showing.
    if (!important && this.bubble && this.bubble.important && this.now() < this.bubble.until) return;
    const dur = Math.max(2800, Math.min(9000, 1500 + text.length * 60));
    // The same words twice in a row are one thought, not two: keep them up
    // longer instead of re-popping the bubble (a busy turn greps five times).
    if (this.bubble && this.bubble.text === text && this.now() < this.bubble.until) {
      this.bubble.until = this.now() + dur;
      return;
    }
    this.bubble = { seq: ++this.seq, text, important: !!important, kind: kind || null, until: this.now() + dur };
  }

  // ------------------------------------------------------------- gossip
  maybeGossip(now) {
    if (now - this.lastGossipAt < TUNING.gossipEveryMs) return;
    this.lastGossipAt = now;
    if (this.rng() > TUNING.gossipChance) return;
    if (!this.state.lastEventAt || now - this.state.lastEventAt > TUNING.gossipRecentMs) return;
    if (this.state.sleeping) return;
    // Some of the time it drops the telemetry and just says something about
    // being a language model. Clearly a joke, so it can't be mistaken for one
    // of the real numbers.
    if (this.rng() < TUNING.jokeChance) {
      this.pushBubble({ text: pick(this.rng, 'aiJoke'), kind: 'joke' });
      return;
    }
    const fact = this.pickFact(now, /*forGossip*/ true);
    if (fact) this.pushBubble({ text: fact, kind: 'gossip' });
  }

  /** A REAL fact about the day — used by gossip and by ~45% of pets. */
  pickFact(now, forGossip = false) {
    const facts = [];
    const sum = this.sessions.summary(now);
    if (sum.count > 0) {
      const worst = sum.sessions[0];
      if (worst.pct !== null) facts.push(`${worst.project} ctx ~${Math.round(worst.pct * 100)}%`);
      facts.push(`${sum.count} session${sum.count === 1 ? '' : 's'} live rn`);
    }
    const todo = this.freshTodos(now);
    if (todo) facts.push(`${todo.d}/${todo.n} todos done so far`);
    const burnT = this.sessions.burnTokens(now);
    if (burnT > 0) facts.push(`${this.sessions.burnLabel(now)} tokens out in 5h`);
    if (this.state.lifetimeCommits > 0) facts.push(`${this.state.lifetimeCommits} commits fed to me so far`);
    if (this.state.greenStreak > 1) facts.push(`green streak ✓×${this.state.greenStreak}!`);
    if (this.state.level < C.MAX_LEVEL) {
      const need = C.XP_LADDER[this.state.level + 1] - this.state.xp;
      facts.push(`${need} xp to lv.${this.state.level + 1}~`);
    }
    if (this.state.lifetimeOutputTokens > 1000) {
      facts.push(`${Math.round(this.state.lifetimeOutputTokens / 1000)}k tokens spoken, lifetime`);
    }
    if (!facts.length) return forGossip ? null : pick(this.rng, 'petted');
    return facts[Math.floor(this.rng() * facts.length)];
  }

  // ------------------------------------------------------------- commands
  /** All rules enforced HERE — a forged IPC message cannot bypass locks. */
  command(cmd) {
    if (!cmd || typeof cmd.type !== 'string') return { ok: false, reason: 'bad command' };
    const now = this.now();
    const ctx = { now, rng: this.rng, live: true };
    let result = { ok: true };

    switch (cmd.type) {
      case 'pet': {
        if (this.state.sleeping) { this.state.sleeping = false; this.applyFx([{ type: 'anim', name: 'wake' }]); }
        this.applyFx([{ type: 'anim', name: 'hearts' }]);
        addClamped(this.state, 'mood', TUNING.petMood);
        if (now - this.state.petXpAt >= TUNING.petXpCooldownMs) {
          this.state.petXpAt = now; // xp from petting is rate-limited: not farmable
          this.state.xp += TUNING.petXp;
          this.recheckLevel(ctx);
        }
        if (this.rng() < TUNING.petFactChance) {
          this.pushBubble({ text: this.pickFact(now), kind: 'fact' });
          this.applyFx([{ type: 'sound', name: 'ding' }]);
        } else if (this.rng() < TUNING.jokeChance) {
          this.pushBubble({ text: pick(this.rng, 'aiJoke'), kind: 'joke' });
          this.applyFx([{ type: 'sound', name: 'pet' }]);
        } else {
          this.pushBubble({ text: pick(this.rng, 'petted'), kind: 'petted' });
          this.applyFx([{ type: 'sound', name: 'pet' }]);
        }
        break;
      }
      case 'treat': {
        if (now - this.state.treatAt < TUNING.treat.cooldownMs) {
          this.pushBubble({ text: pick(this.rng, 'treatFull'), kind: 'treatFull' });
          this.applyFx([{ type: 'sound', name: 'nope' }]);
          result = { ok: false, reason: 'cooldown' };
          break;
        }
        this.state.treatAt = now;
        this.state.food += TUNING.treat.food;
        addClamped(this.state, 'mood', TUNING.treat.mood);
        this.state.xp += TUNING.treat.xp;
        this.recheckLevel(ctx);
        this.applyFx([{ type: 'anim', name: 'eat' }, { type: 'sound', name: 'treat' }]);
        this.pushBubble({ text: pick(this.rng, 'treat'), kind: 'treat' });
        break;
      }
      case 'setName': {
        const name = String(cmd.name || '').trim().slice(0, TUNING.maxNameLen);
        if (!name) { result = { ok: false, reason: 'empty name' }; break; }
        this.prefs.name = name;
        break;
      }
      case 'setPalette': {
        if (!C.PALETTE_NAMES.includes(cmd.palette)) { result = { ok: false, reason: 'unknown palette' }; break; }
        this.prefs.palette = cmd.palette;
        break;
      }
      case 'setAccessory': {
        if (cmd.accessory === null || cmd.accessory === undefined || cmd.accessory === '') {
          this.prefs.accessory = null;
          break;
        }
        const acc = C.ACCESSORIES.find(a => a.id === cmd.accessory);
        if (!acc) { result = { ok: false, reason: 'unknown accessory' }; break; }
        if (this.state.level < acc.level) {
          this.applyFx([{ type: 'sound', name: 'nope' }]);
          result = { ok: false, reason: `locked until lv.${acc.level}` }; // brain enforces, not UI
          break;
        }
        if (this.state.level < 1) { result = { ok: false, reason: 'eggs wear nothing' }; break; }
        this.prefs.accessory = acc.id;
        this.applyFx([{ type: 'anim', name: 'party' }, { type: 'sound', name: 'equip' }]);
        this.pushBubble({ text: pick(this.rng, 'accessory'), kind: 'accessory' });
        break;
      }
      case 'setToggle': {
        if (!['bubbles', 'statsLine', 'glow'].includes(cmd.key)) { result = { ok: false, reason: 'unknown toggle' }; break; }
        this.prefs[cmd.key] = !!cmd.value;
        break;
      }
      case 'setScale': {
        const v = Number(cmd.value);
        if (!(v >= 1 && v <= 2.5)) { result = { ok: false, reason: 'scale out of range' }; break; }
        this.prefs.scale = v;
        break;
      }
      case 'setSound': {
        const wasOn = !!this.prefs.soundOn;
        if (cmd.on !== undefined) this.prefs.soundOn = !!cmd.on;
        if (cmd.volume !== undefined) {
          const v = Math.max(0, Math.min(1, Number(cmd.volume) || 0));
          const moved = v !== this.prefs.volume;
          this.prefs.volume = v;
          // A volume slider you can't hear is a slider you have to guess at, so
          // sample the new level as it moves. Throttled — `input` fires on every
          // notch of a drag — and silent while muted, because muted means muted.
          if (moved && this.prefs.soundOn && v > 0 && now - this.volumeSampleAt > 140) {
            this.volumeSampleAt = now;
            this.applyFx([{ type: 'sound', name: 'pet' }]);
          }
        }
        // Hear what you just switched on, wherever you switched it on from.
        if (!wasOn && this.prefs.soundOn) this.applyFx([{ type: 'sound', name: 'ding' }]);
        break;
      }
      case 'setClickThrough': {
        this.prefs.clickThrough = !!cmd.value;
        break;
      }
      case 'setPosition': {
        if (cmd.position && typeof cmd.position.x === 'number' && typeof cmd.position.y === 'number') {
          this.prefs.position = { x: Math.round(cmd.position.x), y: Math.round(cmd.position.y) };
          // A corner means nothing without the box it belongs to — nor without
          // where the feet stood inside that box.
          if (cmd.boxH > 0) this.prefs.boxH = Math.round(cmd.boxH);
          if (cmd.footH > 0) this.prefs.footH = Math.round(cmd.footH);
        }
        break;
      }
      case 'resetProgress': {
        // Wipes progression. Customization, sound settings and — critically —
        // the event-log read cursor survive, otherwise replaying the old log
        // refeeds the newborn instantly. [lesson: real bug]
        this.state = resetState(this.state, now);
        this.state.lastTickAt = now;
        this.bubble = null;
        this.prefs.accessory = null; // reset wipes accessory per plan
        this.pushBubble({ text: pick(this.rng, 'reset'), kind: 'reset' });
        this.applyFx([{ type: 'sound', name: 'reset' }]);
        this.stateSaver.flush();
        break;
      }
      case 'playAnim': { // debug menu: every animation reachable
        this.applyFx([{ type: 'anim', name: String(cmd.name || 'party'), big: !!cmd.big }]);
        break;
      }
      case 'debugSetLevel': {
        const lvl = Math.round(Number(cmd.level));
        if (!(lvl >= 0 && lvl <= C.MAX_LEVEL)) { result = { ok: false, reason: 'level out of range' }; break; }
        const oldLevel = this.state.level;
        const oldForm = C.formForLevel(oldLevel);
        this.state.xp = C.XP_LADDER[lvl];
        this.state.level = lvl;
        // accessory locks stay honest even in debug: downleveling unequips
        if (this.prefs.accessory) {
          const acc = C.ACCESSORIES.find(a => a.id === this.prefs.accessory);
          if (acc && lvl < acc.level) this.prefs.accessory = null;
        }
        if (lvl > oldLevel) {
          const newForm = C.formForLevel(lvl);
          const evolved = newForm !== oldForm;
          this.applyFx([
            { type: 'anim', name: 'party', big: evolved },
            { type: 'sound', name: evolved ? (newForm === 'hatchling' ? 'hatch' : 'transform') : 'levelup' },
            { type: 'bubble', text: pick(this.rng, evolved ? 'evolve' : 'levelUp'), kind: 'levelUp' }
          ]);
        }
        break;
      }
      case 'debugAdjust': {
        const v = Number(cmd.value);
        if (!Number.isFinite(v)) { result = { ok: false, reason: 'bad value' }; break; }
        switch (cmd.key) {
          case 'food': this.state.food = Math.max(0, v); break; // uncapped up
          case 'energy': this.state.energy = Math.max(0, Math.min(100, v)); break;
          case 'mood': this.state.mood = Math.max(0, Math.min(100, v)); break;
          case 'xp': this.state.xp = Math.max(0, v); this.recheckLevel(ctx); break;
          case 'greenStreak': this.state.greenStreak = Math.max(0, Math.round(v)); break;
          case 'lifetimeCommits': this.state.lifetimeCommits = Math.max(0, Math.round(v)); break;
          case 'lifetimeOutputTokens': this.state.lifetimeOutputTokens = Math.max(0, Math.round(v)); break;
          default: result = { ok: false, reason: 'unknown stat' };
        }
        break;
      }
      case 'debugEvent': {
        // Inject a synthetic event through the REAL reducer path (live fx).
        // sid 'debug' is deliberately kept out of the session registry.
        const presets = {
          prompt: { t: 'UserPromptSubmit' },
          edit: { t: 'PostToolUse', tool: 'Edit', file: 'debug.js' },
          commit: { t: 'PostToolUse', tool: 'Bash', cmd: 'git commit -m "debug"' },
          testsGreen: { t: 'PostToolUse', tool: 'Bash', cmd: 'npx jest', out: 'Tests:       27 passed, 27 total' },
          testsRed: { t: 'PostToolUse', tool: 'Bash', cmd: 'npx jest', out: 'Tests:       3 failed, 24 passed, 27 total', ok: false },
          deploy: { t: 'PostToolUse', tool: 'Bash', cmd: 'vercel --prod' },
          push: { t: 'PostToolUse', tool: 'Bash', cmd: 'git push origin main' },
          rmRf: { t: 'PostToolUse', tool: 'Bash', cmd: 'rm -rf node_modules' },
          toolFail: { t: 'PostToolUse', tool: 'Read', ok: false },
          notification: { t: 'Notification', msg: 'Claude needs your permission to use Bash' },
          waiting: { t: 'Notification', msg: 'Claude is waiting for your input' },
          sessionStart: { t: 'SessionStart' },
          sessionEnd: { t: 'SessionEnd' },
          preCompact: { t: 'PreCompact' },
          // --- the detail-rich ones
          feast: { t: 'PostToolUse', tool: 'Edit', file: 'big.ts', ext: 'ts', add: 61, del: 18 },
          tinyEdit: { t: 'PostToolUse', tool: 'Edit', file: 'tiny.js', ext: 'js', add: 1, del: 1 },
          testFile: { t: 'PostToolUse', tool: 'Write', file: 'pet.test.js', ext: 'js', add: 12, del: 0 },
          gitDiff: { t: 'PostToolUse', tool: 'Bash', cmd: 'git diff --stat', out: ' 3 files changed, 48 insertions(+), 12 deletions(-)' },
          commitStat: { t: 'PostToolUse', tool: 'Bash', cmd: 'git commit -m "x"', out: '[main 1a2b3c4] x\n 2 files changed, 30 insertions(+), 4 deletions(-)' },
          todos: { t: 'PostToolUse', tool: 'TodoWrite', todo: { n: 5, d: 2, p: 1 } },
          todosDone: { t: 'PostToolUse', tool: 'TodoWrite', todo: { n: 5, d: 5, p: 0 } },
          dispatch: { t: 'PreToolUse', tool: 'Task', agent: 'Explore' },
          subagentBack: { t: 'PostToolUse', tool: 'Task', agent: 'Explore' },
          webFetch: { t: 'PostToolUse', tool: 'WebFetch', host: 'docs.claude.com' },
          mcpCall: { t: 'PostToolUse', tool: 'mcp__sanity__query', srv: 'sanity' },
          forcePush: { t: 'PostToolUse', tool: 'Bash', cmd: 'git push --force origin main' },
          resetHard: { t: 'PostToolUse', tool: 'Bash', cmd: 'git reset --hard HEAD~1' },
          release: { t: 'PostToolUse', tool: 'Bash', cmd: 'npm publish' },
          docker: { t: 'PostToolUse', tool: 'Bash', cmd: 'docker compose up -d' },
          lint: { t: 'PostToolUse', tool: 'Bash', cmd: 'npm run lint' },
          migrate: { t: 'PostToolUse', tool: 'Bash', cmd: 'prisma migrate dev' },
          bigPrompt: { t: 'UserPromptSubmit', plen: 900 },
          // Mode changes only fire on a CHANGE, so these two demo each other.
          modePlan: { t: 'PostToolUse', tool: 'Read', pm: 'plan' },
          modeNormal: { t: 'PostToolUse', tool: 'Read', pm: 'default' },
          resume: { t: 'SessionStart', source: 'resume' },
          compactAuto: { t: 'PreCompact', trigger: 'auto' }
        };
        const preset = presets[cmd.name];
        if (!preset) { result = { ok: false, reason: 'unknown event preset' }; break; }
        const ev = Object.assign({ ts: now, sid: 'debug' }, preset);
        this.applyFx(ensureWords(reduce(this.state, ev, ctx), ctx));
        break;
      }
      case 'debugSleep': {
        this.state.sleeping = !!cmd.value;
        this.applyFx([{ type: 'anim', name: cmd.value ? 'sleep' : 'wake' }]);
        break;
      }
      case 'playSound': { // debug
        this.applyFx([{ type: 'sound', name: String(cmd.name || 'ding'), important: true }]);
        break;
      }
      case 'testBubble': { // debug
        this.pushBubble({ text: cmd.text || 'test bubble!', important: !!cmd.important, kind: 'debug' });
        break;
      }
      case 'completeOnboarding': {
        const first = !this.prefs.onboarded;
        this.prefs.onboarded = true;
        // Only celebrate the first time — replaying the intro from the menu is
        // not a hatching.
        if (first) {
          this.applyFx([{ type: 'anim', name: 'party' }, { type: 'sound', name: 'hatch' }]);
          this.pushBubble({ text: `hi! I'm ${this.prefs.name} ♥`, kind: 'hello' });
        }
        break;
      }
      case 'installHooks': result = this.installHooks(); break;
      case 'uninstallHooks': result = this.uninstallHooks(); break;
      default: result = { ok: false, reason: 'unknown command' };
    }

    this.prefsSaver.markDirty();
    this.stateSaver.markDirty();
    this.scheduleEmit();
    return result;
  }

  recheckLevel(ctx) {
    const newLevel = C.levelForXp(this.state.xp);
    if (newLevel > this.state.level) {
      const oldForm = C.formForLevel(this.state.level);
      this.state.level = newLevel;
      const newForm = C.formForLevel(newLevel);
      const evolved = newForm !== oldForm;
      this.applyFx([
        { type: 'anim', name: 'party', big: evolved },
        { type: 'sound', name: evolved ? (newForm === 'hatchling' ? 'hatch' : 'transform') : 'levelup' },
        { type: 'bubble', text: pick(this.rng, evolved ? 'evolve' : 'levelUp'), kind: 'levelUp' }
      ]);
    }
  }

  // ------------------------------------------------------------- render state
  moodBand() {
    const m = this.state.mood;
    if (m >= 70) return 'happy';
    if (m >= 40) return 'neutral';
    return 'grumpy';
  }

  /** Claude's own todo list, while it's still current. Null once finished. */
  freshTodos(now) {
    const t = this.state.todos;
    if (!t || !t.n || !t.at) return null;
    if (now - t.at > TUNING.todoFreshMs) return null;  // stale is not telemetry
    if (t.d >= t.n) return null;                       // a done list isn't progress
    return t;
  }

  statsLine(now) {
    if (!this.prefs.statsLine) return { mode: 'hidden', text: '', lines: [] };
    const s = this.state;
    const idPart = `${this.prefs.name} lv.${s.level}`;
    const todo = this.freshTodos(now);
    const todoPart = todo ? ` │ ☑ ${todo.d}/${todo.n}` : '';
    const sum = this.sessions.summary(now);
    if (sum.count === 0) return { mode: 'idle', text: idPart + todoPart, lines: [] };

    // The pill is what's true of the PET; the per-session facts (which one,
    // how full, what it's doing) each get their own line below it, so nothing
    // is stated twice and no session hides behind a "worst of" figure.
    let text = `${idPart} │ ${sum.burn}/5h`;
    if (s.greenStreak > 0) text += ` │ ✓×${s.greenStreak}`;
    text += todoPart;
    return { mode: 'active', text, lines: this.sessionLines(sum, now) };
  }

  /**
   * One line per live session: which project, what it is doing, how full its
   * context is. Sorted by who is waiting on whom — a session that cannot
   * continue without you comes first, a happily working one comes last —
   * because the whole point is answering "which terminal do I go to?".
   *
   * Every session gets a line. How many of them fit under the pet is the
   * window's business, not the brain's (see PetArt.LAYOUT.maxLines).
   */
  sessionLines(sum, now) {
    const rank = (x) => (C.SESSION_STATUS[x.status] || C.SESSION_STATUS.working).rank;
    return sum.sessions.slice()
      .sort((a, b) => rank(a) - rank(b) || (b.pct === null ? -1 : b.pct) - (a.pct === null ? -1 : a.pct))
      .map(x => {
        const st = C.SESSION_STATUS[x.status] || C.SESSION_STATUS.working;
        // "working" is the present tense; the rest are things that STARTED at
        // a moment, and how long ago is most of what you want to know.
        const age = x.status === 'working' ? '' : C.ago(now - (x.statusAt || now));
        // A context nobody has read is left off entirely — printing ~0% for
        // "don't know yet" is the small lie that makes a readout untrustworthy.
        const ctxPart = x.pct === null ? '' : ` · ~${Math.round(x.pct * 100)}%`;
        const name = x.project.length > 18 ? x.project.slice(0, 17) + '…' : x.project;
        return {
          kind: x.status,
          text: `${st.glyph} ${name} · ${st.label}${age ? ' ' + age : ''}${ctxPart}`
        };
      });
  }

  getRenderState() {
    const now = this.now();
    const s = this.state;
    return {
      seq: this.seq,
      name: this.prefs.name,
      level: s.level,
      xp: s.xp,
      xpNext: s.level < C.MAX_LEVEL ? C.XP_LADDER[s.level + 1] : null,
      form: C.formForLevel(s.level),
      palette: this.prefs.palette,
      accessory: this.prefs.accessory,
      mood: Math.round(s.mood),
      moodBand: this.moodBand(),
      food: Math.round(s.food),
      energy: Math.round(s.energy),
      sleeping: s.sleeping,
      greenStreak: s.greenStreak,
      lifetimeCommits: s.lifetimeCommits,
      lifetimeOutputTokens: s.lifetimeOutputTokens,
      idleMs: s.lastMeaningfulAt ? now - s.lastMeaningfulAt : null,
      wanderOk: !s.sleeping && s.lastMeaningfulAt > 0 && (now - s.lastMeaningfulAt) > TUNING.wanderAfterIdleMs,
      bubble: this.bubble && now < this.bubble.until ? this.bubble : null,
      fx: this.fxQueue.slice(),
      sounds: this.soundQueue.slice(),
      statsLine: this.statsLine(now),
      toggles: { bubbles: this.prefs.bubbles, statsLine: this.prefs.statsLine, glow: this.prefs.glow },
      scale: this.prefs.scale,
      soundOn: this.prefs.soundOn,
      volume: this.prefs.volume,
      clickThrough: this.prefs.clickThrough,
      onboarded: this.prefs.onboarded,
      position: this.prefs.position,
      hooks: this.hooksStatus,
      sessions: this.sessions.summary(now),
      accessories: C.ACCESSORIES.map(a => ({
        id: a.id, name: a.name, level: a.level,
        unlocked: s.level >= a.level,
        equipped: this.prefs.accessory === a.id
      })),
      palettes: C.PALETTE_NAMES,
      paletteRamps: C.PALETTES,
      recentEvents: this.log.slice(-40)
    };
  }

  scheduleEmit() {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    setImmediate(() => {
      this.emitScheduled = false;
      this.emit('state', this.getRenderState());
    });
  }
}

function addClamped(state, key, delta) {
  state[key] = Math.max(0, Math.min(100, state[key] + delta));
}

module.exports = { Brain };
