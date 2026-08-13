'use strict';
// Tails events.jsonl with a persistent byte-offset cursor, so events fired
// while the app was closed replay on next launch. fs.watch plus a polling
// fallback; handles truncation. No Electron imports.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const POLL_MS = 1500;

class LogTailer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.file       path to events.jsonl
   * @param {number} opts.offset     starting byte offset (from saved cursor)
   */
  constructor({ file, offset = 0 }) {
    super();
    this.file = file;
    this.offset = offset;
    this.partial = '';
    this.watcher = null;
    this.pollTimer = null;
    this.reading = false;
    this.pendingRead = false;
  }

  start() {
    this.readNew(true); // replay anything queued while we were closed
    this.armWatch();
    this.pollTimer = setInterval(() => this.readNew(false), POLL_MS);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  stop() {
    if (this.watcher) { try { this.watcher.close(); } catch (_) {} this.watcher = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  armWatch() {
    if (this.watcher) return;
    const dir = path.dirname(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, (_evt, name) => {
        if (!name || name === path.basename(this.file)) this.readNew(false);
      });
      this.watcher.on('error', () => { this.watcher = null; });
    } catch (_) { /* poll fallback still runs */ }
  }

  readNew(isReplay) {
    if (this.reading) { this.pendingRead = true; return; }
    this.reading = true;
    try {
      let st;
      try { st = fs.statSync(this.file); } catch (_) { this.reading = false; return; }
      if (st.size < this.offset) { this.offset = 0; this.partial = ''; } // truncated/rotated
      if (st.size === this.offset) { this.reading = false; this.maybeRerun(); return; }

      const fd = fs.openSync(this.file, 'r');
      try {
        const len = st.size - this.offset;
        const buf = Buffer.alloc(len);
        const read = fs.readSync(fd, buf, 0, len, this.offset);
        this.offset += read;
        const text = this.partial + buf.toString('utf8', 0, read);
        const lines = text.split('\n');
        this.partial = lines.pop(); // last element is '' or an incomplete line
        const events = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try { events.push(JSON.parse(trimmed)); } catch (_) { /* skip bad line */ }
        }
        if (events.length) this.emit('events', events, { replay: !!isReplay });
        this.emit('cursor', this.offset - Buffer.byteLength(this.partial, 'utf8'));
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      this.emit('error', err);
    }
    this.reading = false;
    this.maybeRerun();
  }

  maybeRerun() {
    if (this.pendingRead) {
      this.pendingRead = false;
      setImmediate(() => this.readNew(false));
    }
  }
}

module.exports = { LogTailer };
