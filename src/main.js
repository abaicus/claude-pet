'use strict';
// Electron main: wires the (headless) brain to windows, tray, shortcuts.
// All game rules live in the brain; this file is plumbing and chrome.

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, globalShortcut, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const { Brain } = require('./brain/brain');
const { IPC, petDir, claudeSettingsPath } = require('./shared/constants');
const { trayIconPngs } = require('./chrome/tray-icon');
const physics = require('./chrome/physics');
const focus = require('./chrome/focus');
const PetArt = require('./body/art'); // geometry only — it draws nothing here

const PET_W = 320;
// Height is NOT fixed: it is exactly the creature, its speech room and one
// line per live session, and it changes when any of those do. macOS will not
// place a window above the menu bar, so a tall box is a pet that can never be
// dragged into the top of the screen — 420px of it kept the feet below y≈400.
function petBox(rs) {
  const lines = (rs.statsLine && rs.statsLine.lines) ? rs.statsLine.lines.length : 0;
  return { h: PetArt.boxHeight(rs.form, rs.scale, lines), foot: PetArt.footRoom(lines) };
}
const LEGACY_BOX_H = 420;   // the fixed height every position was saved against
const LEGACY_FOOT = 46;     // …and the foot room those saved positions assumed
let lastFoot = LEGACY_FOOT; // the gap the feet currently stand at, tracked so a
                            // resize can put them back exactly where they were

let brain;
let petWin = null;
let settingsWin = null;
let onboardWin = null;
let receiptWin = null;
let cardWin = null;
let tray = null;
let cursorTimer = null;
// True between "the pet window exists" and "the intro is over" on a fresh
// install: the window is built (so it sizes, positions and listens like any
// other launch) but never shown until onboarding says so.
let waitingForIntro = false;
let wander = null; // {phase, home:{x,y}, target, startedAt, timer}

const single = app.requestSingleInstanceLock();
if (!single) app.quit();

// ------------------------------------------------------------------ windows
function createPetWindow() {
  const pos = brain.prefs.position;
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const box = petBox(brain.getRenderState());
  const h = box.h;
  lastFoot = box.foot;
  // The saved position is a top-left CORNER, and the box it was a corner of is
  // very likely not this one: the pet may have grown, the size slider moved, a
  // session line appeared, or the build changed under it. Put the FEET back
  // where they were and let the corner fall where it must.
  const savedFeet = pos ? pos.y + (brain.prefs.boxH || LEGACY_BOX_H) - (brain.prefs.footH || LEGACY_FOOT) : 0;
  const x = pos ? pos.x : wa.x + wa.width - PET_W - 40;
  const y = pos ? savedFeet - (h - box.foot) : wa.y + wa.height - h - 20;

  // On a fresh install the first thing you meet is the intro, not a creature
  // standing behind it — so the window is built now (it has to be: it sizes
  // itself, clamps to the display and takes the state feed like any launch)
  // but stays off-screen until onboarding is done.
  waitingForIntro = !brain.prefs.onboarded;

  petWin = new BrowserWindow({
    x, y, width: PET_W, height: h,
    show: !waitingForIntro,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, hasShadow: false, skipTaskbar: true,
    fullscreenable: false, minimizable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'body', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  petWin.setAlwaysOnTop(true, 'floating');
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  petWin.loadFile(path.join(__dirname, 'body', 'pet.html'));
  petWin.on('closed', () => { petWin = null; });

  applyClickThrough(brain.prefs.clickThrough, { silent: true });

  // clamp back on screen if displays changed since last run
  const b = petWin.getBounds();
  const disp = screen.getDisplayMatching(b).workArea;
  if (b.x > disp.x + disp.width - 60 || b.y > disp.y + disp.height - 60 || b.x < disp.x - PET_W + 60 || b.y < disp.y - 60) {
    petWin.setPosition(disp.x + disp.width - PET_W - 40, disp.y + disp.height - h - 20);
  }
  savePosition(); // …including the box it now belongs to, migrated or not
}

function savePosition() {
  const b = petWin.getBounds();
  // The corner alone is meaningless later: save the box it is a corner of and
  // where the feet stood inside it.
  brain.command({ type: 'setPosition', position: { x: b.x, y: b.y }, boxH: b.height, footH: lastFoot });
}

// Grow/shrink the window to the current form, size and session count. The FEET
// stay where they are — the pet must not jump when it levels up, when the
// slider moves or when a session appears — so the top edge is what travels.
function fitPetWindow(rs) {
  if (!petWin || petWin.isDestroyed()) return;
  const want = petBox(rs);
  const b = petWin.getBounds();
  if (b.height === want.h && lastFoot === want.foot) return;
  const feet = b.y + b.height - lastFoot;   // …the one number that must not change
  lastFoot = want.foot;
  petWin.setBounds({ x: b.x, y: feet - (want.h - want.foot), width: b.width, height: want.h });
  if (wander) wander.home.y = petWin.getBounds().y; // a stroll comes home to the new box
  savePosition();                                   // the OS may have clamped it — save what stuck
}

function createSettingsWindow() {
  abortWander();
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  // Frameless + transparent: the page draws its own card and titlebar, in the
  // same pixel language as the speech bubble.
  settingsWin = new BrowserWindow({
    // Tall enough for the deepest tab (appearance, with the whole wardrobe
    // laid out) without a scrollbar on a laptop screen; the rest scrolls.
    width: 480, height: 700, minWidth: 440, maxWidth: 640, minHeight: 320,
    frame: false, transparent: true, hasShadow: false, resizable: true,
    title: 'Gogu settings', fullscreenable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'body', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.loadFile(path.join(__dirname, 'settings', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// Shown once, on the first launch of a fresh install (brain.prefs.onboarded),
// and on demand from the menu. Same frameless card as the settings window.
function createOnboardingWindow() {
  abortWander();
  if (onboardWin) { onboardWin.show(); onboardWin.focus(); return; }
  onboardWin = new BrowserWindow({
    width: 520, height: 660, minWidth: 460, minHeight: 420, maxWidth: 700,
    center: true, frame: false, transparent: true, hasShadow: false, resizable: true,
    title: 'meet your pet', fullscreenable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'body', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  onboardWin.loadFile(path.join(__dirname, 'onboarding', 'onboarding.html'));
  onboardWin.on('closed', () => {
    onboardWin = null;
    // Closing the window by any route is a decision, not an accident: mark it
    // done so the intro can never ambush the same person twice.
    if (brain && !brain.prefs.onboarded) brain.command({ type: 'completeOnboarding' });
  });
}

// The curtain. `completeOnboarding` is what ends the intro — by the button, by
// skip, or by closing the window — and it reaches here as a state with
// `onboarded` set. Show the pet BEFORE the state goes out: that same state
// carries the hatch party and the hello bubble, and a hidden window is not
// rendering to play them.
function revealPetAfterIntro(state) {
  if (!waitingForIntro || !state.onboarded) return;
  waitingForIntro = false;
  if (petWin && !petWin.isDestroyed()) petWin.showInactive();
  rebuildTray(); // the menu said "Show pet" while it was backstage
}

// The day, on paper. Narrow and tall like a till roll, and frameless so the
// slip itself is the whole window — the page draws its own torn edges.
function createReceiptWindow() {
  abortWander();
  if (receiptWin) { receiptWin.show(); receiptWin.focus(); return; }
  receiptWin = new BrowserWindow({
    width: 330, height: 680, minWidth: 300, maxWidth: 420, minHeight: 320,
    frame: false, transparent: true, hasShadow: false, resizable: true,
    title: "Today's receipt", fullscreenable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'body', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  receiptWin.loadFile(path.join(__dirname, 'receipt', 'receipt.html'));
  receiptWin.on('closed', () => { receiptWin = null; });
}

// The pet card: a portrait and the lifetime figures, sized to be posted.
// Shown rather than rendered offscreen — you should see the thing before you
// save it, and the PNG comes from the canvas, not from this window.
function createCardWindow() {
  abortWander();
  if (cardWin) { cardWin.show(); cardWin.focus(); return; }
  cardWin = new BrowserWindow({
    width: 460, height: 330, resizable: false,
    frame: false, transparent: true, hasShadow: false,
    title: 'Pet card', fullscreenable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'body', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  cardWin.loadFile(path.join(__dirname, 'card', 'card.html'));
  cardWin.on('closed', () => { cardWin = null; });
}

function broadcast(state) {
  fitPetWindow(state);
  revealPetAfterIntro(state);
  for (const win of [petWin, settingsWin, onboardWin, receiptWin, cardWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.state, state);
  }
}

// ------------------------------------------------------------------ click-through
// An unclickable window cannot offer its own way back: the global shortcut
// and the tray item are the escape hatches and must ALWAYS work.
function applyClickThrough(on, { silent = false } = {}) {
  if (!petWin) return;
  abortWander();
  petWin.setIgnoreMouseEvents(on, { forward: true });
  if (!silent) brain.command({ type: 'setClickThrough', value: on });
  rebuildTray();
}

function toggleClickThrough() {
  applyClickThrough(!brain.prefs.clickThrough);
}

// ------------------------------------------------------------------ shortcuts
// A tray menu's `accelerator` is only a LABEL on macOS — it never fires, since
// a dockless app has no key window to receive it. So every shortcut here is a
// real global one, and the menu only claims the ones the OS actually granted.
// Combos avoid documented system shortcuts (⌘⌥H is Hide Others, etc.).
const SHORTCUTS = [
  { id: 'settings', accel: 'CommandOrControl+Alt+,', run: () => createSettingsWindow() },
  { id: 'treat', accel: 'CommandOrControl+Alt+T', run: () => brain.command({ type: 'treat' }) },
  { id: 'visible', accel: 'CommandOrControl+Alt+V', run: () => togglePetVisible() },
  { id: 'sound', accel: 'CommandOrControl+Alt+M', run: () => toggleSound() },
  { id: 'clickThrough', accel: 'CommandOrControl+Alt+P', run: () => toggleClickThrough() },
  { id: 'quit', accel: 'CommandOrControl+Alt+Q', run: () => app.quit() }
];
const granted = new Set();

function registerShortcuts() {
  for (const s of SHORTCUTS) {
    try { if (globalShortcut.register(s.accel, s.run)) granted.add(s.id); } catch (_) { /* taken */ }
  }
}

// Spread into a menu item: shows the key only if we really hold it.
function key(id) {
  if (!granted.has(id)) return {};
  const s = SHORTCUTS.find(x => x.id === id);
  return { accelerator: s.accel, registerAccelerator: false }; // global one already fires it
}

function togglePetVisible() {
  if (!petWin || petWin.isDestroyed()) return;
  abortWander();
  waitingForIntro = false; // asking for the pet by hand outranks the curtain
  if (petWin.isVisible()) petWin.hide(); else petWin.showInactive();
  rebuildTray();
}

function toggleSound() {
  brain.command({ type: 'setSound', on: !brain.prefs.soundOn }); // the brain chimes
  rebuildTray();
}

// ------------------------------------------------------------------ tray
function buildMenu() {
  // One lean menu shared by tray and right-click. Nothing else.
  const hidden = petWin && !petWin.isDestroyed() && !petWin.isVisible();
  return Menu.buildFromTemplate([
    { label: 'Settings…', click: () => createSettingsWindow(), ...key('settings') },
    { label: 'Intro…', click: () => createOnboardingWindow() },
    // The day's numbers, right in the menu — and the whole till roll behind it.
    { label: `Today · ${brain.receiptTeaser()}…`, click: () => createReceiptWindow() },
    { label: 'Pet card…', click: () => createCardWindow() },
    { type: 'separator' },
    { label: 'Give a treat', click: () => brain.command({ type: 'treat' }), ...key('treat') },
    { label: hidden ? 'Show pet' : 'Hide pet', click: () => togglePetVisible(), ...key('visible') },
    {
      label: 'Sounds',
      type: 'checkbox',
      checked: !!brain.prefs.soundOn,
      click: () => toggleSound(),
      ...key('sound')
    },
    {
      label: 'Click-through',
      type: 'checkbox',
      checked: !!brain.prefs.clickThrough,
      click: () => toggleClickThrough(),
      ...key('clickThrough')
    },
    { type: 'separator' },
    { label: 'Reinstall Claude hooks', click: () => brain.command({ type: 'installHooks' }) },
    { label: 'Uninstall Claude hooks', click: () => brain.command({ type: 'uninstallHooks' }) },
    { type: 'separator' },
    { label: 'Quit Gogu', click: () => app.quit(), ...key('quit') }
  ]);
}

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(buildMenu());
}

function createTray() {
  const { png1x, png2x } = trayIconPngs();
  const icon = nativeImage.createEmpty();
  icon.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: png1x });
  icon.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: png2x });
  icon.setTemplateImage(true); // auto light/dark
  tray = new Tray(icon);
  tray.setToolTip('Gogu');
  rebuildTray();
}

// ------------------------------------------------------------------ cursor → eyes
function startCursorFeed() {
  cursorTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return;
    try {
      const p = screen.getCursorScreenPoint();
      const b = petWin.getBounds();
      const cx = b.x + b.width / 2, cy = b.y + b.height * 0.6;
      petWin.webContents.send(IPC.cursor, {
        dx: p.x - cx, dy: p.y - cy,
        walking: wander ? wander.walking : false,
        facing: wander ? wander.facing : 0,
        falling: !!fall
      });
    } catch (_) { /* screen may be asleep */ }
  }, 100);
}

// ------------------------------------------------------------------ wander
// After ~3 idle minutes the pet may stroll; it always returns home. Any
// grab, menu, settings-open, or click-through toggle aborts the stroll.
function maybeStartWander() {
  if (wander || !petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
  const rs = brain.getRenderState();
  if (!rs.wanderOk || rs.clickThrough) return;
  if (Math.random() > 0.30) return;

  const home = petWin.getBounds();
  const disp = screen.getDisplayMatching(home).workArea;
  const range = 160;
  let dx = (Math.random() * 2 - 1) * range;
  const tx = Math.max(disp.x, Math.min(disp.x + disp.width - PET_W, home.x + dx));
  dx = tx - home.x;
  if (Math.abs(dx) < 40) return;

  wander = { home: { x: home.x, y: home.y }, dx, walking: true, facing: Math.sign(dx), t: 0 };
  const stepMs = 33, speed = 1.6; // px per step
  wander.timer = setInterval(() => {
    if (!petWin || petWin.isDestroyed() || !wander) return abortWander();
    const b = petWin.getBounds();
    if (wander.phase === 'pause') {
      if (--wander.pauseSteps <= 0) {
        wander.phase = 'return';
        wander.facing = Math.sign(wander.home.x - b.x) || 1;
      }
      return;
    }
    const targetX = wander.phase === 'return' ? wander.home.x : wander.home.x + wander.dx;
    const step = Math.sign(targetX - b.x) * Math.min(speed, Math.abs(targetX - b.x));
    petWin.setPosition(Math.round(b.x + step), wander.home.y);
    wander.walking = Math.abs(step) > 0.1;
    wander.facing = Math.sign(step) || wander.facing;
    if (Math.abs(b.x + step - targetX) < 1) {
      if (!wander.phase) { wander.phase = 'pause'; wander.pauseSteps = Math.round((1500 + Math.random() * 2500) / stepMs); wander.walking = false; }
      else { // returned home
        petWin.setPosition(wander.home.x, wander.home.y);
        abortWander();
      }
    }
  }, stepMs);
}

// ------------------------------------------------------------------ gravity
// Let go of the pet in mid-air and it falls. The WINDOW moves, so it drops in
// front of every other window on the desktop, bounces off the floor and the
// screen edges, and squashes on each landing. Throwing it sideways works
// because the drag is sampled as it happens — the speed your hand had is the
// speed it leaves with.
//
// Off by preference (`gravity`), because the other half of this app's contract
// is "drag it anywhere; the position sticks", and somebody who parks their pet
// beside their editor is not going to enjoy watching it fall off.
const REST_GAP = 20;      // where it comes to rest above the work area, as on first launch
const STEP_MS = 16;

let fall = null;
let dragSamples = [];     // recent {t, dx, dy} — the throw is read out of these

// The floor, the walls and the ceiling, for whichever display the pet is on.
function fallBounds(b) {
  const disp = screen.getDisplayMatching(b).workArea;
  return {
    floor: disp.y + disp.height - b.height - REST_GAP,
    ceiling: disp.y,
    left: disp.x,
    right: disp.x + disp.width - b.width
  };
}

function startFall() {
  if (!petWin || petWin.isDestroyed()) return;
  const samples = dragSamples;
  dragSamples = [];
  if (!brain.prefs.gravity) { savePosition(); return; }

  const b = petWin.getBounds();
  const v = physics.throwVelocity(samples, Date.now());
  // Carried and set down: it stays exactly there, at any height. Only a throw
  // gets gravity — the raw velocity decides, upward flicks included.
  if (!physics.shouldFall(v)) { savePosition(); return; }

  if (fall) clearInterval(fall.timer);
  fall = { x: b.x, y: b.y, vx: v.vx, vy: v.vy, timer: setInterval(stepFall, STEP_MS) };
}

function stepFall() {
  if (!petWin || petWin.isDestroyed() || !fall) return abortFall();
  const b = petWin.getBounds();
  const next = physics.step(fall, fallBounds(b), STEP_MS / 1000);
  Object.assign(fall, { x: next.x, y: next.y, vx: next.vx, vy: next.vy });
  petWin.setPosition(Math.round(next.x), Math.round(next.y));
  // The squash belongs to the sprite, and only the window knows it landed.
  if (next.impact > 0) {
    petWin.webContents.send(IPC.land, { power: Math.min(1, next.impact / 1600) });
  }
  if (next.done) abortFall({ save: true });
}

function abortFall({ save = false } = {}) {
  if (!fall) return;
  clearInterval(fall.timer);
  fall = null;
  if (save) savePosition();
}

function abortWander() {
  if (!wander) return;
  clearInterval(wander.timer);
  const home = wander.home;
  wander = null;
  if (petWin && !petWin.isDestroyed() && home) petWin.setPosition(home.x, home.y);
}

// ------------------------------------------------------------------ ipc
function wireIpc() {
  ipcMain.handle(IPC.command, (_e, cmd) => brain.command(cmd));
  ipcMain.handle('pet:get-state', () => brain.getRenderState());

  ipcMain.on(IPC.moveWindow, (_e, { dx, dy, done }) => {
    if (!petWin || petWin.isDestroyed()) return;
    abortWander(); // a grab aborts the stroll
    abortFall();   // …and catches it mid-air
    if (typeof dx === 'number' && typeof dy === 'number') {
      const b = petWin.getBounds();
      petWin.setPosition(b.x + Math.round(dx), b.y + Math.round(dy));
      // Sampled for the throw. Trimmed here rather than at release, so a long
      // slow drag cannot grow an unbounded array.
      dragSamples.push({ t: Date.now(), dx, dy });
      if (dragSamples.length > 40) dragSamples.shift();
    }
    if (done) startFall(); // …which saves the position wherever it comes to rest
  });

  ipcMain.on(IPC.closeSettings, () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });

  ipcMain.handle('pet:get-receipt', () => brain.receipt());

  // The card arrives already drawn, as a PNG data URL from its own canvas —
  // main only has to decide where it lands and then show the user.
  ipcMain.handle('pet:save-card', async (_e, { dataUrl, name } = {}) => {
    try {
      const img = nativeImage.createFromDataURL(String(dataUrl || ''));
      if (img.isEmpty()) return { ok: false, reason: 'empty image' };
      const safe = String(name || 'gogu-card.png').replace(/[^a-zA-Z0-9._-]/g, '');
      const file = path.join(app.getPath('desktop'), safe || 'gogu-card.png');
      require('fs').writeFileSync(file, img.toPNG());
      shell.showItemInFolder(file);
      return { ok: true, file };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.on('pet:copy-card', (_e, { dataUrl } = {}) => {
    const img = nativeImage.createFromDataURL(String(dataUrl || ''));
    if (!img.isEmpty()) clipboard.writeImage(img);
  });

  ipcMain.on('pet:close-card', () => {
    if (cardWin && !cardWin.isDestroyed()) cardWin.close();
  });

  ipcMain.on('pet:copy-receipt', (_e, { text } = {}) => {
    if (text) clipboard.writeText(String(text));
  });

  ipcMain.on('pet:close-receipt', () => {
    if (receiptWin && !receiptWin.isDestroyed()) receiptWin.close();
  });

  ipcMain.on(IPC.closeOnboarding, () => {
    if (onboardWin && !onboardWin.isDestroyed()) onboardWin.close();
  });

  // Click a session line and the terminal it belongs to comes forward. The
  // pet only speaks when it FAILS: on success the terminal arriving in front
  // of you is the feedback, and a bubble on top of that is noise.
  ipcMain.on(IPC.focusSession, async (_e, { cwd } = {}) => {
    abortWander();
    const res = await focus.focusTerminalFor(cwd);
    if (!res.ok) brain.command({ type: 'focusFailed', reason: res.reason });
  });

  ipcMain.on(IPC.contextMenu, () => {
    abortWander();
    if (petWin) buildMenu().popup({ window: petWin });
  });
}

// ------------------------------------------------------------------ lifecycle
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide(); // critter, not app

  brain = new Brain({ dir: petDir(), settingsPath: claudeSettingsPath() });
  brain.on('state', broadcast);
  brain.start({ installHooks: process.env.GOGU_NO_HOOKS !== '1' });

  wireIpc();
  createPetWindow();
  createTray();
  startCursorFeed();

  registerShortcuts();

  // First launch of a fresh install: introduce yourself before anything else.
  if (!brain.prefs.onboarded) createOnboardingWindow();

  setInterval(maybeStartWander, 45 * 1000);
  // The tray's menu is built once and cached by the OS, and one of its items
  // now states the day's numbers — so it has to be rebuilt occasionally or it
  // spends the afternoon claiming nothing has happened. (The right-click menu
  // on the pet is built fresh every time it pops, so it never goes stale.)
  setInterval(rebuildTray, 60 * 1000);

  // Dev/debug: screenshot the pet window (GOGU_SHOT=/path/out.png)
  if (process.env.GOGU_SHOT) {
    // GOGU_SHOT_HOVER parks a cursor on the pet so the stats line and
    // the session lines are UP for the shot. Hover is driven by the cursor
    // feed (see startCursorFeed), and a screenshot cannot move a mouse — so
    // the real feed is replaced rather than raced with.
    if (process.env.GOGU_SHOT_HOVER) {
      if (cursorTimer) clearInterval(cursorTimer);
      cursorTimer = setInterval(() => {
        if (!petWin || petWin.isDestroyed()) return;
        petWin.webContents.send(IPC.cursor, { dx: 0, dy: 40, walking: false, facing: 0 });
      }, 100);
    }
    // GOGU_SHOT_FRAMES turns the single shot into a burst — one numbered
    // PNG per frame, for an encoder to turn into an animation. A recording is
    // the only honest way to show a REACTION: the pet chomping a feast or
    // throwing confetti at a commit is the app answering seeded events, not a
    // second implementation of the animation posing for the camera.
    const burst = Number(process.env.GOGU_SHOT_FRAMES || 0);
    setTimeout(async () => {
      try {
        if (burst > 1) {
          const p = require('path');
          const dir = p.dirname(process.env.GOGU_SHOT);
          const stem = p.basename(process.env.GOGU_SHOT).replace(/\.png$/i, '');
          const every = Number(process.env.GOGU_SHOT_EVERY || 80);
          for (let i = 0; i < burst; i++) {
            const frame = await petWin.webContents.capturePage();
            require('fs').writeFileSync(
              p.join(dir, `${stem}-${String(i).padStart(4, '0')}.png`), frame.toPNG());
            await new Promise(r => setTimeout(r, every));
          }
          console.log('shot written:', burst, 'frames');
          return;
        }
        const img = await petWin.webContents.capturePage();
        require('fs').writeFileSync(process.env.GOGU_SHOT, img.toPNG());
        console.log('shot written:', process.env.GOGU_SHOT);
      } catch (err) { console.error('shot failed', err); }
    }, Number(process.env.GOGU_SHOT_DELAY || 3000));
  }
  if (process.env.GOGU_SHOT_SETTINGS) {
    createSettingsWindow();
    setTimeout(async () => {
      try {
        // Which tab to shoot. The window always opens on the first one, and
        // the wardrobe lives on another.
        if (process.env.GOGU_SHOT_TAB) {
          await settingsWin.webContents.executeJavaScript(
            `showTab(${JSON.stringify(process.env.GOGU_SHOT_TAB)})`);
          await new Promise(r => setTimeout(r, 200));
        }
        if (process.env.GOGU_SHOT_SCROLL) {
          await settingsWin.webContents.executeJavaScript(
            `window.scrollTo(0, ${process.env.GOGU_SHOT_SCROLL === 'end' ? 'document.body.scrollHeight' : Number(process.env.GOGU_SHOT_SCROLL) || 0})`);
          await new Promise(r => setTimeout(r, 300));
        }
        const img = await settingsWin.webContents.capturePage();
        require('fs').writeFileSync(process.env.GOGU_SHOT_SETTINGS, img.toPNG());
        console.log('settings shot written');
      } catch (err) { console.error('settings shot failed', err); }
    }, Number(process.env.GOGU_SHOT_DELAY || 3000));
  }
});

app.on('window-all-closed', () => { /* tray app: keep running */ });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (cursorTimer) clearInterval(cursorTimer);
  abortWander();
  abortFall();
  if (brain) brain.stop(); // flush state — quit + relaunch loses nothing
});
