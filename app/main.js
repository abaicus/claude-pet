const { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain, dialog, globalShortcut } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PET_DIR = path.join(os.homedir(), ".claude-pet");
const HOOK_FILE = path.join(PET_DIR, "pet-hook.js");
const STATE_FILE = path.join(PET_DIR, "state.json");
// Window placement lives apart from state.json: the renderer owns that file and
// writes it constantly, so two writers would race.
const WINDOW_FILE = path.join(PET_DIR, "window.json");
const BASE_W = 220;
const BASE_H = 280;
const SCALE_MIN = 0.7; // below this the size slider no longer fits in the window
const SCALE_MAX = 2;
const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SessionEnd",
];
const TOOL_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]); // these take a tool matcher
const HOOK_TIMEOUT = 5;
const MARKER = "pet-hook.js"; // how we recognize our own entries
// Click-through swallows the right-click that would turn it back off, so a
// working global shortcut is the only way home. Another app may already own
// one, so try a couple and tell the truth about which (if any) we got.
const CLICK_THROUGH_SHORTCUTS = ["CommandOrControl+Alt+P", "CommandOrControl+Alt+Shift+P"];

/* ---------------- hook script (written on every launch, so upgrades propagate) ---------------- */

const HOOK_SOURCE = `#!/usr/bin/env node
// claude-pet hook emitter. Appends a compact record to ~/.claude-pet/events.jsonl.
// Fire-and-forget: always exits 0, never blocks a tool call. Installed with
// "async": true so Claude Code does not even wait for it.
const fs = require("fs"), os = require("os"), path = require("path");

const HEAD = 600;   // commands: the interesting part (the program name) is at the front
const TAIL = 3000;  // output: test summaries live at the END, so keep the tail
const head = (s) => (s = str(s)).length > HEAD ? s.slice(0, HEAD) : s;
const tail = (s) => (s = str(s)).length > TAIL ? s.slice(-TAIL) : s;
function str(s) { return s == null ? "" : String(s); }

// Tool responses are shaped differently per tool; pull out anything text-like.
function flatten(r) {
  if (r == null) return "";
  if (typeof r !== "object") return String(r);
  if (Array.isArray(r)) return r.map(flatten).join("\\n");
  const parts = [];
  for (const k of ["stdout", "stderr", "output", "error", "message", "content", "text"]) {
    const v = r[k];
    if (v == null) continue;
    parts.push(typeof v === "object" ? flatten(v) : String(v));
  }
  if (parts.length) return parts.join("\\n");
  try { return JSON.stringify(r); } catch (e) { return ""; }
}

let data = "";
const bail = () => process.exit(0);

function done() {
  try {
    const o = JSON.parse(data || "{}");
    const ti = o.tool_input || {};
    const rec = {
      hook_event_name: str(o.hook_event_name),
      tool_name: str(o.tool_name),
      session_id: str(o.session_id),
      cwd: str(o.cwd),
      // A path, not content — lets the app (never this hook) peek at token
      // usage so the pet can gossip about the session.
      transcript_path: str(o.transcript_path),
      ts: Date.now() / 1000,
    };
    if (typeof ti.command === "string") rec.command = head(ti.command);
    if (o.reason) rec.reason = str(o.reason);
    // Only Bash output is worth carrying (test runs); file writes would just bloat the log.
    if (rec.tool_name === "Bash") rec.output = tail(flatten(o.tool_response));
    if (o.error != null) rec.error = tail(flatten(o.error));
    const dir = path.join(os.homedir(), ".claude-pet");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(rec) + "\\n");
  } catch (e) {}
  bail();
}

setTimeout(bail, 2000).unref(); // never hang a session, even on a stuck stdin
process.stdin.on("data", (d) => (data += d));
process.stdin.on("end", done);
process.stdin.on("error", bail);
`;

/* ---------------- locating a node interpreter ---------------- */

// Hooks run through `sh -c` with Claude Code's environment. When Claude Code was
// launched from Spotlight/Dock, or node comes from nvm/fnm/volta, bare \`node\` is
// frequently NOT on that PATH — the hook then fails silently and the pet simply
// never eats. So bake an absolute interpreter path into the command.
function resolveNode() {
  const works = (bin) => {
    if (!bin) return null;
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 3000 });
      return bin;
    } catch (e) {
      return null;
    }
  };

  // process.execPath is Electron, not node — but npm/npx hands us the real one.
  let found = works(process.env.CLAUDE_PET_NODE) || works(process.env.npm_node_execpath);
  if (found) return found;

  if (process.platform !== "win32") {
    // A login+interactive shell is the only thing that knows about version-manager shims.
    try {
      const out = execFileSync(process.env.SHELL || "/bin/sh", ["-lic", "command -v node"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // rc files can be chatty; the answer is the last line.
      found = works(out.trim().split("\n").pop().trim());
      if (found) return found;
    } catch (e) {}
  }

  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    found = works(p);
    if (found) return found;
  }
  return "node"; // last resort: hope it is on PATH
}

let NODE_BIN = null;
function hookCommand() {
  if (!NODE_BIN) NODE_BIN = resolveNode();
  // quote both: home dirs contain spaces, especially on Windows
  return `"${NODE_BIN}" "${HOOK_FILE}"`;
}

/* ---------------- settings.json install / uninstall ---------------- */

function isOurs(handler) {
  return String((handler && handler.command) || "").includes(MARKER);
}

function installHooks() {
  fs.mkdirSync(PET_DIR, { recursive: true });
  fs.writeFileSync(HOOK_FILE, HOOK_SOURCE);

  let settings = {};
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8"));
    } catch (e) {
      // Never risk destroying a settings file we can't parse.
      return {
        ok: false,
        message:
          "~/.claude/settings.json exists but is not valid JSON. " +
          "Fix it, then use right-click → Reinstall hooks.",
      };
    }
    fs.copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS + ".pet-backup");
  } else {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  }

  const command = hookCommand();
  settings.hooks = settings.hooks || {};
  let changed = false;

  for (const ev of HOOK_EVENTS) {
    const groups = (settings.hooks[ev] = settings.hooks[ev] || []);
    let present = false;
    for (const g of groups) {
      for (const h of g.hooks || []) {
        if (!isOurs(h)) continue;
        present = true;
        // Repair our own stale entries — e.g. node moved after an nvm upgrade.
        if (h.command !== command || h.async !== true || h.timeout !== HOOK_TIMEOUT) {
          h.command = command;
          h.async = true;
          h.timeout = HOOK_TIMEOUT;
          changed = true;
        }
      }
    }
    if (!present) {
      const group = { hooks: [{ type: "command", command, async: true, timeout: HOOK_TIMEOUT }] };
      if (TOOL_EVENTS.has(ev)) group.matcher = "*";
      groups.push(group);
      changed = true;
    }
  }

  if (changed) fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  return { ok: true, changed, node: NODE_BIN };
}

function uninstallHooks() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return { ok: true, changed: false };
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8"));
  } catch (e) {
    return { ok: false, message: "settings.json is not valid JSON; nothing removed." };
  }
  if (!settings.hooks) return { ok: true, changed: false };

  let changed = false;
  for (const ev of Object.keys(settings.hooks)) {
    const groups = settings.hooks[ev];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    let touched = false;
    for (const g of groups) {
      const orig = g.hooks || [];
      const hooks = orig.filter((h) => !isOurs(h));
      if (hooks.length === orig.length) {
        kept.push(g); // none of ours in here — keep the group verbatim
        continue;
      }
      touched = true;
      if (hooks.length) kept.push({ ...g, hooks }); // keep the user's siblings
      // a group that was only ours disappears entirely
    }
    if (!touched) continue; // never rewrite an event we don't appear in
    changed = true;
    if (kept.length) settings.hooks[ev] = kept;
    else delete settings.hooks[ev];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (changed) {
    fs.copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS + ".pet-backup");
    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  }
  return { ok: true, changed };
}

/* ---------------- window ---------------- */

let win;
let tray;
let clickThrough = false;
let soundOn = false; // mirrored from the renderer so the menu label is honest
let scale = 1;

function readSoundSetting() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).sound === true;
  } catch (e) {
    return false;
  }
}

/* ---------------- window placement ---------------- */

const clampScale = (s) => Math.max(SCALE_MIN, Math.min(SCALE_MAX, Number(s) || 1));
const scaledSize = () => ({ width: Math.round(BASE_W * scale), height: Math.round(BASE_H * scale) });

function readWindowPrefs() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_FILE, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

let saveTimer = null;
function saveWindowPrefs() {
  // Debounced: 'moved' fires continuously while you drag the pet around.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const [x, y] = win.getPosition();
      fs.writeFileSync(WINDOW_FILE, JSON.stringify({ x, y, scale }));
    } catch (e) {}
    refreshMenus(); // the size readout in the menu label just went stale
  }, 400);
}

// A saved position can point at a monitor that is no longer attached, which
// would restore the pet somewhere you can't reach it.
function clampToDisplay(x, y, width, height) {
  const area = screen.getDisplayMatching({ x, y, width, height }).workArea;
  return {
    x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
  };
}

function setScale(next) {
  scale = clampScale(next);
  const { width, height } = scaledSize();
  // Grow from the pet's feet, not the window's top-left, so it doesn't lurch
  // across the screen while you drag the slider.
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  const pos = clampToDisplay(Math.round(x + w / 2 - width / 2), Math.round(y + h - height), width, height);
  // Some platforms ignore a programmatic resize on a non-resizable window.
  win.setResizable(true);
  win.setBounds({ ...pos, width, height });
  win.setResizable(false);
  // The slider lives in the settings window, so the pet renderer has to be
  // told what to render at, and the settings page gets its echo.
  win.webContents.send("pet-scale-set", scale);
  if (settingsWin) settingsWin.webContents.send("pet-state", settingsPayload());
  saveWindowPrefs();
}

function resetWindow() {
  setScale(1);
  const area = screen.getPrimaryDisplay().workArea;
  const { width, height } = scaledSize();
  win.setBounds({ ...clampToDisplay(area.x + area.width - width - 30, area.y + 60, width, height), width, height });
  saveWindowPrefs();
}

let toggleShortcut = null; // the accelerator we actually got, or null

function prettyAccel(accel) {
  return process.platform === "darwin"
    ? accel.replace("CommandOrControl", "⌘").replace("Alt", "⌥").replace("Shift", "⇧").replace(/\+/g, "")
    : accel.replace("CommandOrControl", "Ctrl");
}

function registerToggleShortcut() {
  for (const accel of CLICK_THROUGH_SHORTCUTS) {
    try {
      if (globalShortcut.register(accel, () => win && setClickThrough(!clickThrough))) return accel;
    } catch (e) {}
  }
  return null; // every candidate was taken — say so rather than trapping the user
}

function setClickThrough(on) {
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  // Say how to get back BEFORE the pet stops accepting clicks.
  win.webContents.send(
    "pet-notice",
    on
      ? `click-through on — ${toggleShortcut ? prettyAccel(toggleShortcut) : "restart me"} to undo`
      : "click-through off"
  );
}

function createWindow(installResult) {
  const prefs = readWindowPrefs();
  scale = clampScale(prefs.scale);
  const { width, height } = scaledSize();

  const area = screen.getPrimaryDisplay().workArea;
  const wanted =
    typeof prefs.x === "number" && typeof prefs.y === "number"
      ? { x: prefs.x, y: prefs.y }
      : { x: area.x + area.width - width - 30, y: area.y + 60 };
  const pos = clampToDisplay(wanted.x, wanted.y, width, height);

  win = new BrowserWindow({
    width,
    height, // BASE_H leaves room for the bubble above a wizard's hat
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false, // sized from the slider, not by dragging an invisible edge
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "index.html"));
  win.on("moved", saveWindowPrefs); // remember where you dragged it

  win.webContents.on("did-finish-load", () => {
    win.webContents.send("pet-init", { scale, min: SCALE_MIN, max: SCALE_MAX });
    if (!installResult.ok) {
      win.webContents.send("pet-notice", "⚠ " + installResult.message);
    } else if (installResult.changed) {
      win.webContents.send("pet-notice", "hooks installed ✓ restart your sessions to feed me");
    }
    if (process.env.CLAUDE_PET_SHOT) captureAndQuit(process.env.CLAUDE_PET_SHOT);
  });
}

/* ---------------- tray ---------------- */

// A 16x16 blob silhouette, drawn straight into a bitmap. Keeps the
// zero-asset-files rule — there is no icon.png to ship or lose.
const TRAY_MASK = [
  "................",
  "................",
  "....XXXXXXXX....",
  "...XXXXXXXXXX...",
  "..XXXXXXXXXXXX..",
  ".XXXXXXXXXXXXXX.",
  ".XX..XXXXXX..XX.",
  ".XX..XXXXXX..XX.",
  ".XXXXXXXXXXXXXX.",
  ".XXXXXXXXXXXXXX.",
  ".XXXXX....XXXXX.",
  "..XXXXXXXXXXXX..",
  "...XXXXXXXXXX...",
  "....XXXXXXXX....",
  "................",
  "................",
];

function trayIcon() {
  const S = 2; // draw at 2x and hand it back as a @2x image, for retina menu bars
  const size = 16 * S;
  const buf = Buffer.alloc(size * size * 4); // BGRA
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (TRAY_MASK[(y / S) | 0][(x / S) | 0] !== "X") continue;
      // Template images are alpha-only; macOS recolors them for light/dark.
      buf[(y * size + x) * 4 + 3] = 255;
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: S });
  img.setTemplateImage(true);
  return img;
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip("claude-pet");
    refreshMenus();
  } catch (e) {
    // No tray is survivable — the right-click menu still works.
    console.error("tray unavailable:", e.message);
  }
}

/* ---------------- menu (shared by the tray and the right-click) ---------------- */

// Sounds, size, and reset live in the settings window now — the menu keeps
// only what you need when the settings window is the thing that's broken.
function menuTemplate() {
  return [
    {
      label: "Settings…",
      click: () => openSettings(),
    },
    {
      label:
        (clickThrough ? "Disable click-through" : "Enable click-through") +
        (toggleShortcut ? `  (${prettyAccel(toggleShortcut)})` : "  — no hotkey free, restart to undo"),
      click: () => setClickThrough(!clickThrough),
    },
    { type: "separator" },
    {
      label: "Reinstall Claude hooks",
      click: () => {
        NODE_BIN = null; // re-resolve: node may have moved since launch
        const r = installHooks();
        win.webContents.send("pet-notice", r.ok ? "hooks refreshed ✓" : "⚠ " + r.message);
      },
    },
    { type: "separator" },
    {
      label: "Uninstall hooks & quit",
      click: () => {
        const r = uninstallHooks();
        if (!r.ok) dialog.showErrorBox("claude-pet", r.message);
        app.quit();
      },
    },
    { label: "Quit (keep hooks)", click: () => app.quit() },
  ];
}

// Checkbox states and the size readout go stale, so rebuild rather than reuse.
function refreshMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

// Dev helper: CLAUDE_PET_SHOT=/path/shot.png npm start — renders, snaps, exits.
// CLAUDE_PET_SHOT_FRAMES=N snaps a burst (shot-000.png…) every
// CLAUDE_PET_SHOT_EVERY ms (default 250, the render tick) for assembling GIFs.
function captureAndQuit(dest) {
  if (process.env.CLAUDE_PET_SHOT_SETTINGS) openSettings();
  const frames = Number(process.env.CLAUDE_PET_SHOT_FRAMES || 1);
  const every = Number(process.env.CLAUDE_PET_SHOT_EVERY || 250);
  setTimeout(async () => {
    try {
      const target = process.env.CLAUDE_PET_SHOT_SETTINGS && settingsWin ? settingsWin : win;
      if (frames > 1) {
        const stem = dest.replace(/\.png$/, "");
        for (let i = 0; i < frames; i++) {
          const t = Date.now();
          const img = await target.capturePage();
          fs.writeFileSync(`${stem}-${String(i).padStart(3, "0")}.png`, img.toPNG());
          await new Promise((r) => setTimeout(r, Math.max(0, every - (Date.now() - t))));
        }
      } else {
        const img = await target.capturePage();
        fs.writeFileSync(dest, img.toPNG());
      }
    } catch (e) {
      console.error("capture failed:", e.message);
    }
    app.quit();
  }, Number(process.env.CLAUDE_PET_SHOT_DELAY || 1500));
}

/* ---------------- settings window ---------------- */
// The pet renderer is the single owner of state.json; this window is a remote
// control. Everything flows renderer → here → settings page and back, so the
// page can never race the pet on disk.
let settingsWin = null;
let lastState = null; // renderer's latest {sound, level, custom}, mirrored to the page

function openSettings() {
  stopWander(true); // don't let the pet stroll away from its own settings
  if (settingsWin) {
    settingsWin.focus();
    return;
  }
  const W = 292;
  const H = 524; // just the card + its shadow — a frameless window's transparent slack still eats clicks
  const [px, py] = win.getPosition();
  const [pw] = win.getSize();
  const pos = clampToDisplay(px + Math.round(pw / 2 - W / 2), py - 40, W, H);
  settingsWin = new BrowserWindow({
    width: W,
    height: H,
    x: pos.x,
    y: pos.y,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

// The page also needs main's own domain (window scale) — merge it in.
function settingsPayload() {
  return lastState ? { ...lastState, scale, scaleMin: SCALE_MIN, scaleMax: SCALE_MAX } : null;
}

ipcMain.on("pet-state", (_e, state) => {
  soundOn = !!(state && state.sound);
  lastState = state;
  if (settingsWin) settingsWin.webContents.send("pet-state", settingsPayload());
  refreshMenus();
});

// settings page asks on load; changes go back to the pet, which applies,
// saves, and echoes a fresh pet-state so the page always shows the truth
ipcMain.on("pet-state-get", (e) => {
  const p = settingsPayload();
  if (p) e.sender.send("pet-state", p);
});
ipcMain.on("custom-set", (_e, patch) => {
  if (win) win.webContents.send("pet-custom-set", patch);
});
ipcMain.on("pet-reset-window", () => {
  if (win) resetWindow();
});
ipcMain.on("settings-close", () => {
  if (settingsWin) settingsWin.close();
});

ipcMain.on("pet-scale", (_e, next) => setScale(next));

/* ---------------- dragging ---------------- */
// A CSS drag region can't work here (see index.html), so the renderer tells us
// when a drag starts and stops and we move the window ourselves.
let dragTimer = null;
let dragOffset = null;
let dragStarted = 0;

function stopDrag() {
  clearInterval(dragTimer);
  dragTimer = null;
  dragOffset = null;
  saveWindowPrefs();
}

ipcMain.on("pet-drag-start", () => {
  if (!win) return;
  stopWander(false); // grabbing the pet mid-stroll: the hand wins
  const cursor = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  dragOffset = { x: cursor.x - x, y: cursor.y - y }; // where on the pet you grabbed
  dragStarted = Date.now();
  clearInterval(dragTimer);
  // Position is absolute (cursor − grab offset), never accumulated deltas:
  // accumulating drifts badly, because the window slides out from under the
  // cursor as it moves and each move feeds the next one.
  dragTimer = setInterval(() => {
    if (!win || !dragOffset || Date.now() - dragStarted > 60e3) return stopDrag();
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - dragOffset.x, p.y - dragOffset.y);
  }, 16);
});

ipcMain.on("pet-drag-end", stopDrag);

ipcMain.on("pet-menu", () => {
  stopWander(true);
  Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
});

/* ---------------- cursor feed (eye tracking) ---------------- */
// The renderer only sees the mouse while it's over the window, but the pupils
// should follow it anywhere nearby. Poll at low rate and quantize before
// sending, so a jittery hand doesn't turn into an IPC firehose.
let lastCursorKey = "";
setInterval(() => {
  if (!win || win.isDestroyed() || dragTimer) return;
  try {
    const p = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    const cx = wx + ww / 2;
    const cy = wy + wh / 2;
    const near = Math.abs(p.x - cx) < 500 && Math.abs(p.y - cy) < 420;
    const msg = near ? { dx: p.x - cx, dy: p.y - cy } : null;
    const key = msg ? `${(msg.dx / 40) | 0},${(msg.dy / 40) | 0}` : "far";
    if (key === lastCursorKey) return;
    lastCursorKey = key;
    win.webContents.send("pet-cursor", msg);
  } catch (e) {}
}, 150);

/* ---------------- wandering ---------------- */
// The renderer decides WHEN to wander (it owns the idle state); main owns the
// motion, since it owns the window. Chunky 4px steps to match the art, and it
// always walks back home so window.json keeps telling the truth.
let wanderTimer = null;

function stopWander(notify) {
  if (!wanderTimer) return;
  clearInterval(wanderTimer);
  wanderTimer = null;
  if (notify && win && !win.isDestroyed()) win.webContents.send("pet-walk", 0);
}

ipcMain.on("pet-wander", () => {
  if (!win || wanderTimer || dragTimer || clickThrough || settingsWin) return;
  const [hx, hy] = win.getPosition(); // home — the stroll ends back here
  const [ww, wh] = win.getSize();
  const area = screen.getDisplayMatching({ x: hx, y: hy, width: ww, height: wh }).workArea;
  const dir = Math.random() < 0.5 ? -1 : 1;
  const span = 60 + Math.random() * 130;
  const tx = Math.round(Math.max(area.x, Math.min(hx + dir * span, area.x + area.width - ww)));
  if (tx === hx) return; // already pressed against that edge
  let leg = "out"; // out → pause → home
  let pauseUntil = 0;
  win.webContents.send("pet-walk", Math.sign(tx - hx));
  wanderTimer = setInterval(() => {
    if (!win || win.isDestroyed() || dragTimer) return stopWander(false);
    const [x, y] = win.getPosition();
    if (leg === "pause") {
      if (Date.now() < pauseUntil) return;
      leg = "home";
      win.webContents.send("pet-walk", Math.sign(hx - x) || 0);
      return;
    }
    const target = leg === "out" ? tx : hx;
    const step = Math.sign(target - x) * Math.min(4, Math.abs(target - x));
    if (step === 0) {
      if (leg === "out") {
        leg = "pause";
        pauseUntil = Date.now() + 1500 + Math.random() * 2500;
        win.webContents.send("pet-walk", 0); // sniff around a bit
      } else {
        stopWander(true);
      }
      return;
    }
    win.setPosition(x + step, y);
  }, 120);
});

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) app.dock.hide();
  soundOn = readSoundSetting();
  const result = installHooks();
  createWindow(result);
  toggleShortcut = registerToggleShortcut();
  createTray();
  if (process.env.CLAUDE_PET_SCALE) setScale(process.env.CLAUDE_PET_SCALE);
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());

// exposed for test/verify.js (Electron never looks at this)
module.exports = {
  installHooks, uninstallHooks, resolveNode, trayIcon, clampScale, menuTemplate,
  HOOK_SOURCE, HOOK_EVENTS, TRAY_MASK, SCALE_MIN, SCALE_MAX,
};
