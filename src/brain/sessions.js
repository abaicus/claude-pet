'use strict';
// Session registry + incremental transcript reading (app-side ONLY — hooks
// never read transcripts). Tracks per-session context fullness, a rolling 5h
// output-token burn figure, and one-shot ctx warnings. Excludes
// subagent/sidechain usage from ctx — it makes the readout bounce. No timers,
// no Electron: the brain calls poll(now).
//
// The numerator is READ, never guessed: the newest main-chain assistant turn
// carries input + cache_read + cache_creation, and Claude Code writes its own
// counts into a `compact_boundary` entry when a session is compacted.
//
// The denominator is the one thing the transcript does not state — the model's
// context window — so it comes from three sources, best first:
//   1. an `auto` compact_boundary: it fired AT the ceiling, so its preTokens
//      is a measurement of the real limit for that model. Persisted.
//   2. the per-model table in constants.js.
//   3. the largest reading seen, when it exceeds (2) — proof the table is out
//      of date. A pet reporting "ctx ~180%" is a pet nobody believes.
//
// A context we have not read is null, not zero, and prints as nothing at all.

const fs = require('fs');
const { TUNING, contextWindowFor } = require('../shared/constants');

const MAX_READ_PER_POLL = 8 * 1024 * 1024;
const SEED_TAIL_BYTES = 1024 * 1024;

class SessionRegistry {
  /**
   * @param {object} opts
   * @param {object} opts.transcriptOffsets  persisted {path: byteOffset} —
   *   survives restarts AND resets, else tokens would refeed.
   * @param {object} opts.ctxCeilings  persisted {model: tokens} measured at
   *   auto-compactions; rare events, so losing them on restart wastes them.
   */
  constructor({ transcriptOffsets = {}, ctxCeilings = {} } = {}) {
    this.sessions = new Map();          // sid → session
    this.offsets = transcriptOffsets;   // transcript path → byte offset (persisted)
    this.ceilings = ctxCeilings;        // model → measured window (persisted)
    this.observed = {};                 // model → biggest ctx seen this run
    this.partials = new Map();          // transcript path → partial line buffer
    this.seeded = new Set();            // transcript paths already tail-seeded
    this.burn = [];                     // [{ts, tokens}] pruned to 5h
    this.lastReportAt = 0;
  }

  session(sid) {
    let s = this.sessions.get(sid);
    if (!s) {
      s = {
        sid, project: null, transcript: null, live: true,
        ctxTokens: null,                // null = never read one. Not zero.
        ctxAt: 0,                       // timestamp of the reading above
        model: null,
        lastActivityAt: 0, warned75: false, warned90: false
      };
      this.sessions.set(sid, s);
    }
    return s;
  }

  noteEvent(ev) {
    if (!ev || !ev.sid) return;
    const s = this.session(ev.sid);
    s.lastActivityAt = Math.max(s.lastActivityAt, ev.ts || 0);
    if (ev.project) s.project = ev.project;
    if (ev.tp) s.transcript = ev.tp;
    if (ev.t === 'SessionEnd') s.live = false;
    else s.live = true;
  }

  // ------------------------------------------------------------- polling
  /**
   * Incrementally read live sessions' transcripts.
   * @returns {{fx: Array, outputTokensDelta: number}}
   */
  poll(now) {
    const fx = [];
    let outputTokensDelta = 0;

    // One read per transcript FILE, applied to every session using it. Two
    // live sids can share a file, and a byte cursor can only be spent once —
    // whichever session read first would otherwise starve the other.
    const byPath = new Map();
    for (const s of this.sessions.values()) {
      // liveness decay: silence for 30 min → treat as gone
      if (s.live && now - s.lastActivityAt > TUNING.sessionDeadAfterMs) s.live = false;
      if (!s.live || !s.transcript) continue;
      if (!byPath.has(s.transcript)) byPath.set(s.transcript, []);
      byPath.get(s.transcript).push(s);
    }
    for (const [file, group] of byPath) {
      outputTokensDelta += this.readTranscript(file, group, now);
    }

    for (const group of byPath.values()) {
      for (const s of group) {
        const pct = this.ctxFraction(s);
        if (pct === null) continue;       // unknown is not zero — warn about nothing
        // one-shot warnings, re-armed only below 60%
        if (pct < TUNING.ctxRearmBelow) { s.warned75 = false; s.warned90 = false; }
        if (pct >= TUNING.ctxWarn2 && !s.warned90) {
          s.warned90 = true; s.warned75 = true;
          fx.push({ type: 'anim', name: 'attention' });
          fx.push({ type: 'sound', name: 'warn', important: true });
          fx.push({
            type: 'bubble', important: true, kind: 'ctx-warning',
            text: `${this.label(s)} ctx ~${Math.round(pct * 100)}% — /compact now!!`
          });
        } else if (pct >= TUNING.ctxWarn1 && !s.warned75) {
          s.warned75 = true;
          fx.push({ type: 'sound', name: 'hint', important: true });
          fx.push({
            type: 'bubble', important: true, kind: 'ctx-warning',
            text: `${this.label(s)} ctx ~${Math.round(pct * 100)}% — /compact soon!`
          });
        }
      }
    }

    this.pruneBurn(now);
    this.pruneDead(now);

    // periodic report every 10 min once any session passes 40%
    const worst = this.worstCtx();
    if (worst && worst.pct >= TUNING.ctxReportPct
        && now - this.lastReportAt >= TUNING.ctxReportEveryMs) {
      this.lastReportAt = now;
      const live = this.liveSessions();
      fx.push({ type: 'sound', name: 'gossip' });
      fx.push({
        type: 'bubble', kind: 'ctx-report',
        text: `${live.length} session${live.length === 1 ? '' : 's'} · worst ctx ~${Math.round(worst.pct * 100)}% · ${this.burnLabel(now)}/5h`
      });
    }

    return { fx, outputTokensDelta };
  }

  /** @returns {number} output tokens read (for the lifetime counter) */
  readTranscript(file, group, now) {
    let outputTokens = 0;
    let st;
    try { st = fs.statSync(file); } catch (_) { return outputTokens; }
    let offset = this.offsets[file] || 0;
    if (st.size < offset) { offset = 0; this.partials.delete(file); } // rotated

    // If this poll's read can't reach the newest bytes, take the reading from
    // the tail first. Two cases: a restart (the cursor survived, the reading
    // did not) and a first run against a transcript larger than one poll.
    const behind = st.size - offset;
    if (behind > MAX_READ_PER_POLL || (offset > 0 && behind <= 0)) {
      this.seedFromTail(file, group, now, st.size);
    }
    if (st.size === offset) return outputTokens;

    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (_) { return outputTokens; }
    try {
      const len = Math.min(st.size - offset, MAX_READ_PER_POLL);
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, offset);
      offset += read;
      this.offsets[file] = offset;

      const text = (this.partials.get(file) || '') + buf.toString('utf8', 0, read);
      const lines = text.split('\n');
      this.partials.set(file, lines.pop());
      for (const line of lines) outputTokens += this.applyLine(line, group, now, true);
    } catch (_) { /* transcript unreadable → just report nothing (never lie) */ }
    finally { try { fs.closeSync(fd); } catch (_) {} }
    return outputTokens;
  }

  /**
   * Take the newest ctx reading straight from the end of the file, so the pet
   * knows the number NOW instead of after Claude's next turn (a restarted app
   * claiming "ctx ~0%") or after several polls of catch-up (a cold start on a
   * 15MB transcript reporting a number from the middle of the morning).
   * Output tokens are deliberately NOT counted here — the catch-up read will
   * walk these same bytes and bank them exactly once. The setCtx timestamp
   * guard is what lets those older entries pass without clobbering this.
   */
  seedFromTail(file, group, now, end) {
    if (this.seeded.has(file)) return;
    this.seeded.add(file);
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (_) { return; }
    try {
      const start = Math.max(0, end - SEED_TAIL_BYTES);
      const len = end - start;
      if (len <= 0) return;
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, start);
      const lines = buf.toString('utf8', 0, read).split('\n');
      if (start > 0) lines.shift();  // the first line is half a line
      for (const line of lines) this.applyLine(line, group, now, false);
    } catch (_) { /* unreadable tail → report nothing */ }
    finally { try { fs.closeSync(fd); } catch (_) {} }
  }

  /** @returns {number} output tokens this line contributed to burn */
  applyLine(line, group, now, countBurn) {
    if (!line || !line.trim()) return 0;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { return 0; }
    if (!entry || typeof entry !== 'object') return 0;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) || now : now;

    // A compaction: Claude Code writes its OWN before/after token counts here,
    // so the pet can drop the readout the instant the context is folded down
    // instead of waiting for the next turn to imply it.
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const m = entry.compactMetadata || {};
      if (typeof m.postTokens === 'number') this.setCtx(group, m.postTokens, ts);
      // An AUTO compaction fires because the window filled, so preTokens is a
      // direct measurement of the ceiling — the only non-assumed denominator
      // this app can obtain.
      if (m.trigger === 'auto' && typeof m.preTokens === 'number' && m.preTokens > 0) {
        for (const s of group) {
          if (!s.model) continue;
          this.ceilings[s.model] = Math.max(this.ceilings[s.model] || 0, m.preTokens);
        }
      }
      return 0;
    }

    const usage = entry.message && entry.message.usage;
    if (!usage) return 0;

    let counted = 0;
    const out = usage.output_tokens || 0;
    if (out > 0 && countBurn) {
      counted = out;                            // burn counts everything — it is real spend
      this.burn.push({ ts, tokens: out });
    }
    if (entry.isSidechain) return counted;      // ctx: main chain only
    if (entry.type !== 'assistant') return counted;

    const model = entry.message.model;
    if (typeof model === 'string' && model && !model.startsWith('<')) {
      for (const s of group) s.model = model;   // models change mid-session
    }
    const ctx = (usage.input_tokens || 0)
      + (usage.cache_read_input_tokens || 0)
      + (usage.cache_creation_input_tokens || 0);
    if (ctx > 0) this.setCtx(group, ctx, ts);
    return counted;
  }

  // Only ever moves forward in transcript time: a tail seed reads the newest
  // entries first and the catch-up read then walks older ones.
  setCtx(group, tokens, ts) {
    for (const s of group) {
      if (ts < s.ctxAt) continue;
      s.ctxTokens = tokens;
      s.ctxAt = ts;
      s.lastActivityAt = Math.max(s.lastActivityAt, ts);
      const key = s.model || '';
      this.observed[key] = Math.max(this.observed[key] || 0, tokens);
    }
  }

  // ------------------------------------------------------------- queries
  /** The denominator, best source first. See the header. */
  ctxWindow(s) {
    const model = s.model || '';
    const measured = this.ceilings[model];
    if (measured > 0) return measured;
    return Math.max(contextWindowFor(s.model), this.observed[model] || 0);
  }

  /** @returns {number|null} null when no reading exists — say nothing, not 0. */
  ctxFraction(s) {
    if (s.ctxTokens == null) return null;
    return s.ctxTokens / this.ctxWindow(s);
  }

  label(s) { return s.project || (s.sid || '').slice(0, 8); }

  liveSessions() {
    return [...this.sessions.values()].filter(s => s.live);
  }

  worstCtx() {
    let worst = null;
    for (const s of this.liveSessions()) {
      const pct = this.ctxFraction(s);
      if (pct === null) continue;
      if (!worst || pct > worst.pct) worst = { session: s, pct };
    }
    return worst;
  }

  pruneBurn(now) {
    const cutoff = now - TUNING.burnWindowMs;
    while (this.burn.length && this.burn[0].ts < cutoff) this.burn.shift();
    // entries can arrive slightly out of order across sessions; cheap filter fallback
    if (this.burn.length && this.burn.some(b => b.ts < cutoff)) {
      this.burn = this.burn.filter(b => b.ts >= cutoff);
    }
  }

  burnTokens(now) {
    this.pruneBurn(now);
    return this.burn.reduce((sum, b) => sum + b.tokens, 0);
  }

  burnLabel(now) {
    const t = this.burnTokens(now);
    if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
    if (t >= 1000) return `${Math.round(t / 1000)}k`;
    return `${t}`;
  }

  pruneDead(now) {
    for (const [sid, s] of this.sessions) {
      if (!s.live && now - s.lastActivityAt > 2 * 60 * 60 * 1000) {
        this.sessions.delete(sid);
        if (s.transcript && ![...this.sessions.values()].some(o => o.transcript === s.transcript)) {
          // keep offsets of recent files only; cap the map so it can't grow forever
          const keys = Object.keys(this.offsets);
          if (keys.length > 60) delete this.offsets[s.transcript];
        }
      }
    }
  }

  /** Data for the stats line — real telemetry, not game fiction. */
  summary(now) {
    const live = this.liveSessions()
      .map(s => ({ sid: s.sid, project: this.label(s), pct: this.ctxFraction(s) }))
      // unknown context sorts last: it is the absence of a reading, not a low one
      .sort((a, b) => (b.pct === null ? -1 : b.pct) - (a.pct === null ? -1 : a.pct));
    const known = live.filter(x => x.pct !== null);
    return {
      count: live.length,
      sessions: live,
      worstPct: known.length ? known[0].pct : null,
      burn: this.burnLabel(now)
    };
  }
}

module.exports = { SessionRegistry };
