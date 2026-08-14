'use strict';
// "Which terminal is waiting on me?" — and then, go there.
//
// The pet already knows which session needs you. This is the other half: click
// the line and the terminal running that session comes to the front. macOS has
// no general "focus the window whose shell is in this directory" call, so it
// is done the only way it can be — ask each terminal app to list its windows,
// pick the one whose title or path looks like the project, and raise it.
//
// The picking is deliberately in JavaScript rather than inside the AppleScript:
// it is the part with judgement in it, it is the part that breaks when a
// terminal changes its default title, and this way it can be tested without a
// terminal, a display, or a Mac.

const { execFile } = require('child_process');
const path = require('path');
const os = require('os');

const OSA_TIMEOUT_MS = 4000;

// ------------------------------------------------------------------ matching
/**
 * How well a window title identifies a working directory. Higher is better,
 * 0 means "no reason to think this is it".
 *
 * Terminals title their windows in at least four different ways, and the same
 * app changes its mind between versions, so this scores every convention it
 * knows rather than requiring any one of them:
 *   the full path              /Users/me/code/gogu
 *   the tilde path             ~/code/gogu
 *   the basename, on its own   gogu — -zsh — 80×24
 *   the basename, buried       my-gogu-fork
 * The last one is a guess and is scored like one: a substring match must never
 * outrank a real path match, or opening `~/x/api` raises the window for
 * `~/y/api-docs` because it happened to be listed first.
 */
function matchScore(title, cwd) {
  if (!title || !cwd) return 0;
  const t = String(title).trim();
  const home = os.homedir();
  const tilde = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : null;
  const base = path.basename(cwd);
  if (!base) return 0;

  if (t === cwd || (tilde && t === tilde)) return 100;
  if (containsPath(t, cwd)) return 90;
  if (tilde && containsPath(t, tilde)) return 85;
  // The basename as a word: "gogu — -zsh", "gogu (zsh)", "~/code/gogu".
  if (wordRe(base).test(t)) return 60;
  if (t.includes(base)) return 30;
  return 0;
}

// A path quoted inside a longer title, and ENDING where a path ends. Plain
// containment is not enough: `~/x/api` is inside `~/x/api-docs`, and raising a
// sibling project's window is the one failure that looks like the feature
// working. [lesson: caught by test/focus.test.js]
function containsPath(title, p) {
  return new RegExp(escapeRe(p) + '($|[\\s/:—–\\]),])').test(title);
}

// …and the same care with a bare name. A hyphen is NOT a word boundary here:
// `my-gogu-fork` is a different project from `gogu`, however much it looks
// like one, so it falls through to the weakest score rather than the strong.
function wordRe(base) {
  return new RegExp(`(^|[\\s/\\\\:—–\\[(])${escapeRe(base)}($|[\\s/\\\\:—–\\])])`);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * The window most likely to be the one. Ties go to the earliest listed, which
 * for every terminal here means the most recently used.
 * @param {Array<{app,window,tab,title}>} candidates
 * @returns {object|null} the winner, with its score
 */
function pickBest(candidates, cwd) {
  let best = null;
  for (const c of candidates || []) {
    const score = matchScore(c.title, cwd);
    if (score <= 0) continue;
    if (!best || score > best.score) best = Object.assign({}, c, { score });
  }
  return best;
}

// ------------------------------------------------------------------ scripts
// Enumeration output is one window per line: app|window|tab|title. A pipe is
// used rather than a tab because `tab` is a word both Terminal and iTerm2
// already use for something else.
const LIST_TERMINAL = `
if application "Terminal" is running then
  tell application "Terminal"
    set out to {}
    repeat with wi from 1 to (count of windows)
      try
        repeat with ti from 1 to (count of tabs of window wi)
          set end of out to "Terminal|" & wi & "|" & ti & "|" & (name of tab ti of window wi)
        end repeat
      end try
    end repeat
    set AppleScript's text item delimiters to linefeed
    return out as text
  end tell
end if
return ""`;

// iTerm2 knows the actual working directory of each session, which is the one
// terminal here that can be matched on fact rather than on its window title.
const LIST_ITERM = `
if application "iTerm2" is running then
  tell application "iTerm2"
    set out to {}
    set wi to 0
    repeat with w in windows
      set wi to wi + 1
      set ti to 0
      repeat with t in tabs of w
        set ti to ti + 1
        set p to ""
        try
          set p to (get variable named "session.path" of current session of t)
        end try
        if p is "" then
          try
            set p to (name of current session of t)
          end try
        end if
        set end of out to "iTerm2|" & wi & "|" & ti & "|" & p
      end repeat
    end repeat
    set AppleScript's text item delimiters to linefeed
    return out as text
  end tell
end if
return ""`;

const RAISE = {
  Terminal: (w, t) => `
tell application "Terminal"
  try
    set selected of tab ${t} of window ${w} to true
  end try
  set index of window ${w} to 1
  activate
end tell`,
  iTerm2: (w, t) => `
tell application "iTerm2"
  select window ${w}
  tell window ${w} to select tab ${t}
  activate
end tell`
};

function osascript(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: OSA_TIMEOUT_MS }, (err, stdout) => {
      // A terminal that is not installed, not scriptable, or has not been
      // granted automation consent is not an error worth surfacing — it is
      // simply not where the session is. The caller reports "not found".
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

function parseList(text) {
  return String(text || '').split('\n').map(line => {
    const [app, window, tab, ...rest] = line.split('|');
    if (!app || !window || !rest.length) return null;
    return { app, window: Number(window), tab: Number(tab), title: rest.join('|').trim() };
  }).filter(Boolean);
}

/**
 * Bring the terminal running in `cwd` to the front.
 * @returns {Promise<{ok: boolean, app?: string, reason?: string}>}
 */
async function focusTerminalFor(cwd) {
  if (process.platform !== 'darwin') return { ok: false, reason: 'macOS only' };
  if (!cwd) return { ok: false, reason: 'no directory' };

  const listed = await Promise.all([osascript(LIST_ITERM), osascript(LIST_TERMINAL)]);
  const candidates = listed.flatMap(parseList);
  if (!candidates.length) return { ok: false, reason: 'no scriptable terminal is running' };

  const best = pickBest(candidates, cwd);
  if (!best) return { ok: false, reason: 'no window looks like that project' };

  const raise = RAISE[best.app];
  if (!raise) return { ok: false, reason: `cannot raise ${best.app}` };
  await osascript(raise(best.window, best.tab));
  return { ok: true, app: best.app };
}

module.exports = { focusTerminalFor, matchScore, pickBest, parseList };
