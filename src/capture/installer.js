'use strict';
// Hook installer/uninstaller for ~/.claude/settings.json.
//
// Contract: idempotent, preserves all existing user settings, refuses to
// touch a config it can't parse, and uninstall removes exactly its own
// entries and nothing else. No Electron imports — testable headlessly.

const fs = require('fs');
const path = require('path');

// Marker: any hook command that references this filename is ours. The
// distinctive filename makes ownership detection independent of where the
// pet dir lives.
const HOOK_MARKER = 'claude-pet-hook.js';

const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'Notification', 'SubagentStop', 'PreCompact'
];

function hookCommand(hookScriptPath) {
  return `node "${hookScriptPath}"`;
}

function isOurs(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(h => h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER));
}

// Detect the file's indentation + trailing newline so a rewrite disturbs as
// little as possible (acceptance: uninstall leaves the file byte-identical
// except for our entries).
function detectFormat(text) {
  const m = text.match(/\n([ \t]+)"/);
  return {
    indent: m ? m[1] : '  ',
    trailingNewline: text.endsWith('\n')
  };
}

function serialize(obj, fmt) {
  let out = JSON.stringify(obj, null, fmt.indent);
  if (fmt.trailingNewline) out += '\n';
  return out;
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return { settings: {}, fmt: { indent: '  ', trailingNewline: true }, existed: false };
  }
  const text = fs.readFileSync(settingsPath, 'utf8');
  if (text.trim() === '') {
    return { settings: {}, fmt: { indent: '  ', trailingNewline: text.endsWith('\n') }, existed: true };
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    const e = new Error(`refusing to touch unparseable settings: ${err.message}`);
    e.code = 'PARSE_FAIL';
    throw e;
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    const e = new Error('refusing to touch settings: top level is not an object');
    e.code = 'PARSE_FAIL';
    throw e;
  }
  return { settings, fmt: detectFormat(text), existed: true };
}

function writeSettings(settingsPath, settings, fmt) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmp = settingsPath + '.claude-pet-tmp';
  fs.writeFileSync(tmp, serialize(settings, fmt));
  fs.renameSync(tmp, settingsPath);
}

// Copy the hook script into the pet dir so hooks keep working even if the
// app bundle moves. Re-copied on every install (keeps it current).
function deployHookScript(petDirPath) {
  fs.mkdirSync(petDirPath, { recursive: true });
  const src = path.join(__dirname, 'hook.js');
  const dest = path.join(petDirPath, HOOK_MARKER);
  fs.copyFileSync(src, dest);
  return dest;
}

/**
 * Install hook entries. Returns {ok, changed, reason?, hookPath?}.
 * Idempotent: re-running against an installed config changes nothing.
 */
function installHooks({ settingsPath, petDirPath }) {
  let read;
  try {
    read = readSettings(settingsPath);
  } catch (err) {
    if (err.code === 'PARSE_FAIL') return { ok: false, changed: false, reason: err.message };
    throw err;
  }
  const hookPath = deployHookScript(petDirPath);
  const cmd = hookCommand(hookPath);
  const { settings, fmt } = read;

  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    return { ok: false, changed: false, reason: 'settings.hooks has an unexpected shape; refusing to touch it' };
  }

  let changed = false;
  const hooks = settings.hooks || (settings.hooks = {});
  for (const event of HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      return { ok: false, changed: false, reason: `settings.hooks.${event} has an unexpected shape; refusing to touch it` };
    }
    const list = hooks[event] || (hooks[event] = []);
    const existing = list.find(isOurs);
    if (existing) {
      // Keep current command path if it drifted (app moved, pet dir changed).
      for (const h of existing.hooks) {
        if (h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER) && h.command !== cmd) {
          h.command = cmd;
          changed = true;
        }
      }
      continue;
    }
    list.push({ hooks: [{ type: 'command', command: cmd, timeout: 10 }] });
    changed = true;
  }

  if (changed) writeSettings(settingsPath, settings, fmt);
  return { ok: true, changed, hookPath };
}

/**
 * Remove exactly our entries. Returns {ok, changed, reason?}.
 */
function uninstallHooks({ settingsPath }) {
  let read;
  try {
    read = readSettings(settingsPath);
  } catch (err) {
    if (err.code === 'PARSE_FAIL') return { ok: false, changed: false, reason: err.message };
    throw err;
  }
  if (!read.existed) return { ok: true, changed: false };
  const { settings, fmt } = read;
  if (!settings.hooks || typeof settings.hooks !== 'object') return { ok: true, changed: false };

  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter(e => !isOurs(e));
    if (kept.length !== list.length) {
      changed = true;
      if (kept.length === 0) delete settings.hooks[event];
      else settings.hooks[event] = kept;
    }
  }
  // Only drop the hooks key if WE emptied it just now.
  if (changed && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  if (changed) writeSettings(settingsPath, settings, fmt);
  return { ok: true, changed };
}

function hooksInstalled({ settingsPath }) {
  let read;
  try { read = readSettings(settingsPath); } catch (_) { return false; }
  const hooks = read.settings.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  return HOOK_EVENTS.every(ev => Array.isArray(hooks[ev]) && hooks[ev].some(isOurs));
}

module.exports = { installHooks, uninstallHooks, hooksInstalled, HOOK_EVENTS, HOOK_MARKER };
