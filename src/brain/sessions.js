'use strict';
// Session registry + incremental transcript reading (app-side ONLY — hooks
// never read transcripts). Tracks per-session context fullness against an
// assumed 200k window (always labeled ~), a rolling 5h output-token burn
// figure, and one-shot ctx warnings. Excludes subagent/sidechain usage from
// ctx — it makes the readout bounce. No timers, no Electron: the brain
// calls poll(now).

const fs = require('fs');
const { TUNING } = require('../shared/constants');

const MAX_READ_PER_POLL = 8 * 1024 * 1024;

class SessionRegistry {
  /**
   * @param {object} opts
   * @param {object} opts.transcriptOffsets  persisted {path: byteOffset} —
   *   survives restarts AND resets, else tokens would refeed.
   */
  constructor({ transcriptOffsets = {} } = {}) {
    this.sessions = new Map();          // sid → session
    this.offsets = transcriptOffsets;   // transcript path → byte offset (persisted)
    this.partials = new Map();          // transcript path → partial line buffer
    this.burn = [];                     // [{ts, tokens}] pruned to 5h
    this.lastReportAt = 0;
  }

  session(sid) {
    let s = this.sessions.get(sid);
    if (!s) {
      s = {
        sid, project: null, transcript: null, live: true,
        ctxTokens: 0, lastActivityAt: 0, warned75: false, warned90: false
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

    for (const s of this.sessions.values()) {
      // liveness decay: silence for 30 min → treat as gone
      if (s.live && now - s.lastActivityAt > TUNING.sessionDeadAfterMs) s.live = false;
      if (!s.live || !s.transcript) continue;

      const res = this.readTranscript(s, now);
      outputTokensDelta += res.outputTokens;

      const pct = this.ctxFraction(s);
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

  readTranscript(s, now) {
    let outputTokens = 0;
    let st;
    try { st = fs.statSync(s.transcript); } catch (_) { return { outputTokens }; }
    let offset = this.offsets[s.transcript] || 0;
    if (st.size < offset) { offset = 0; this.partials.delete(s.transcript); } // rotated
    if (st.size === offset) return { outputTokens };

    let fd;
    try { fd = fs.openSync(s.transcript, 'r'); } catch (_) { return { outputTokens }; }
    try {
      const len = Math.min(st.size - offset, MAX_READ_PER_POLL);
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, offset);
      offset += read;
      this.offsets[s.transcript] = offset;

      const text = (this.partials.get(s.transcript) || '') + buf.toString('utf8', 0, read);
      const lines = text.split('\n');
      this.partials.set(s.transcript, lines.pop());

      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch (_) { continue; }
        const usage = entry && entry.message && entry.message.usage;
        if (!usage) continue;
        const ts = entry.timestamp ? Date.parse(entry.timestamp) || now : now;

        const out = usage.output_tokens || 0;
        if (out > 0) {
          outputTokens += out;                    // burn counts everything — it is real spend
          this.burn.push({ ts, tokens: out });
        }
        if (entry.isSidechain) continue;          // ctx: main chain only
        if (entry.type !== 'assistant') continue;
        const ctx = (usage.input_tokens || 0)
          + (usage.cache_read_input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0);
        if (ctx > 0) {
          s.ctxTokens = ctx;                      // latest main-chain turn = current fullness
          s.lastActivityAt = Math.max(s.lastActivityAt, ts);
        }
      }
    } catch (_) { /* transcript unreadable → just report nothing (never lie) */ }
    finally { try { fs.closeSync(fd); } catch (_) {} }
    return { outputTokens };
  }

  // ------------------------------------------------------------- queries
  ctxFraction(s) { return s.ctxTokens / TUNING.ctxWindow; }
  label(s) { return s.project || (s.sid || '').slice(0, 8); }

  liveSessions() {
    return [...this.sessions.values()].filter(s => s.live);
  }

  worstCtx() {
    let worst = null;
    for (const s of this.liveSessions()) {
      const pct = this.ctxFraction(s);
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
      .sort((a, b) => b.pct - a.pct);
    return {
      count: live.length,
      sessions: live,
      worstPct: live.length ? live[0].pct : 0,
      burn: this.burnLabel(now)
    };
  }
}

module.exports = { SessionRegistry };
