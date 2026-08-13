'use strict';
// Versioned JSON persistence: state.json (progression), prefs.json
// (customization — survives reset), cursor.json (log offset — survives
// reset). Human-readable on purpose; players may cheat. Atomic writes.

const fs = require('fs');
const path = require('path');

function loadJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') return obj;
  } catch (_) { /* missing or corrupt → fallback */ }
  return fallback;
}

function saveJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

// Debounced saver: frequent state changes coalesce; flush() forces a write
// (used on quit so a relaunch loses nothing).
class Saver {
  constructor(file, getObj, delayMs = 3000) {
    this.file = file;
    this.getObj = getObj;
    this.delayMs = delayMs;
    this.timer = null;
    this.dirty = false;
  }
  markDirty() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.delayMs);
    if (this.timer.unref) this.timer.unref();
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    saveJson(this.file, this.getObj());
  }
}

module.exports = { loadJson, saveJson, Saver };
