'use strict';
// Electron main: wires the (headless) brain to windows, tray, shortcuts.
// All game rules live in the brain; this file is plumbing and chrome.

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const { Brain } = require('./brain/brain');
const { IPC, petDir, claudeSettingsPath } = require('./shared/constants');
const { trayIconPngs } = require('./chrome/tray-icon');

const PET_W = 320, PET_H = 420;
const CLICK_THROUGH_SHORTCUT = 'CommandOrControl+Alt+P';

let brain;
let petWin = null;
let settingsWin = null;
let tray = null;
let cursorTimer = null;
let wander = null; // {phase, home:{x,y}, target, startedAt, timer}

const single = app.requestSingleInstanceLock();
if (!single) app.quit();

// ------------------------------------------------------------------ windows
function createPetWindow() {
  const pos = brain.prefs.position;
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const x = pos ? pos.x : wa.x + wa.width - PET_W - 40;
  const y = pos ? pos.y : wa.y + wa.height - PET_H - 20;

  petWin = new BrowserWindow({
    x, y, width: PET_W, height: PET_H,
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
    petWin.setPosition(disp.x + disp.width - PET_W - 40, disp.y + disp.height - PET_H - 20);
  }
}

function createSettingsWindow() {
  abortWander();
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 400, height: 720, resizable: true, minWidth: 400, maxWidth: 480,
    title: 'claude-pet settings', fullscreenable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'body', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.loadFile(path.join(__dirname, 'settings', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function broadcast(state) {
  for (const win of [petWin, settingsWin]) {
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

// ------------------------------------------------------------------ tray
function buildMenu() {
  // One lean menu shared by tray and right-click. Nothing else.
  return Menu.buildFromTemplate([
    { label: 'Settings…', click: () => createSettingsWindow() },
    {
      label: 'Click-through (⌘⌥P)',
      type: 'checkbox',
      checked: !!brain.prefs.clickThrough,
      click: () => toggleClickThrough()
    },
    { type: 'separator' },
    { label: 'Reinstall Claude hooks', click: () => brain.command({ type: 'installHooks' }) },
    { label: 'Uninstall Claude hooks', click: () => brain.command({ type: 'uninstallHooks' }) },
    { type: 'separator' },
    { label: 'Quit claude-pet', click: () => app.quit() }
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
  tray.setToolTip('claude-pet');
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
        facing: wander ? wander.facing : 0
      });
    } catch (_) { /* screen may be asleep */ }
  }, 100);
}

// ------------------------------------------------------------------ wander
// After ~3 idle minutes the pet may stroll; it always returns home. Any
// grab, menu, settings-open, or click-through toggle aborts the stroll.
function maybeStartWander() {
  if (wander || !petWin || petWin.isDestroyed()) return;
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
    if (typeof dx === 'number' && typeof dy === 'number') {
      const b = petWin.getBounds();
      petWin.setPosition(b.x + Math.round(dx), b.y + Math.round(dy));
    }
    if (done) {
      const b = petWin.getBounds();
      brain.command({ type: 'setPosition', position: { x: b.x, y: b.y } });
    }
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
  brain.start({ installHooks: process.env.CLAUDE_PET_NO_HOOKS !== '1' });

  wireIpc();
  createPetWindow();
  createTray();
  startCursorFeed();

  globalShortcut.register(CLICK_THROUGH_SHORTCUT, toggleClickThrough);

  setInterval(maybeStartWander, 45 * 1000);

  // Dev/debug: screenshot the pet window (CLAUDE_PET_SHOT=/path/out.png)
  if (process.env.CLAUDE_PET_SHOT) {
    setTimeout(async () => {
      try {
        const img = await petWin.webContents.capturePage();
        require('fs').writeFileSync(process.env.CLAUDE_PET_SHOT, img.toPNG());
        console.log('shot written:', process.env.CLAUDE_PET_SHOT);
      } catch (err) { console.error('shot failed', err); }
    }, Number(process.env.CLAUDE_PET_SHOT_DELAY || 3000));
  }
  if (process.env.CLAUDE_PET_SHOT_SETTINGS) {
    createSettingsWindow();
    setTimeout(async () => {
      try {
        if (process.env.CLAUDE_PET_SHOT_SCROLL) {
          await settingsWin.webContents.executeJavaScript(
            `window.scrollTo(0, ${process.env.CLAUDE_PET_SHOT_SCROLL === 'end' ? 'document.body.scrollHeight' : Number(process.env.CLAUDE_PET_SHOT_SCROLL) || 0})`);
          await new Promise(r => setTimeout(r, 300));
        }
        const img = await settingsWin.webContents.capturePage();
        require('fs').writeFileSync(process.env.CLAUDE_PET_SHOT_SETTINGS, img.toPNG());
        console.log('settings shot written');
      } catch (err) { console.error('settings shot failed', err); }
    }, Number(process.env.CLAUDE_PET_SHOT_DELAY || 3000));
  }
});

app.on('window-all-closed', () => { /* tray app: keep running */ });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (cursorTimer) clearInterval(cursorTimer);
  abortWander();
  if (brain) brain.stop(); // flush state — quit + relaunch loses nothing
});
