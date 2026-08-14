'use strict';
// Thin, safe bridge. The renderer can only: receive state, send commands
// (validated by the brain), move its window, and ask for the context menu.

const { contextBridge, ipcRenderer } = require('electron');

// Channel names duplicated here on purpose: preload runs sandboxed and we
// keep it dependency-free. Must match src/shared/constants.js IPC.
const CH = {
  state: 'pet:state',
  command: 'pet:command',
  cursor: 'pet:cursor',
  moveWindow: 'pet:move-window',
  contextMenu: 'pet:context-menu',
  closeSettings: 'pet:close-settings',
  land: 'pet:land',
  focusSession: 'pet:focus-session',
  closeOnboarding: 'pet:close-onboarding'
};

contextBridge.exposeInMainWorld('petAPI', {
  onState: (cb) => ipcRenderer.on(CH.state, (_e, state) => cb(state)),
  onCursor: (cb) => ipcRenderer.on(CH.cursor, (_e, data) => cb(data)),
  onLand: (cb) => ipcRenderer.on(CH.land, (_e, data) => cb(data)),
  getState: () => ipcRenderer.invoke('pet:get-state'),
  command: (cmd) => ipcRenderer.invoke(CH.command, cmd),
  moveWindowBy: (dx, dy) => ipcRenderer.send(CH.moveWindow, { dx, dy }),
  dragEnd: () => ipcRenderer.send(CH.moveWindow, { done: true }),
  contextMenu: () => ipcRenderer.send(CH.contextMenu),
  focusSession: (cwd) => ipcRenderer.send(CH.focusSession, { cwd }),
  getReceipt: () => ipcRenderer.invoke('pet:get-receipt'),
  copyReceipt: (text) => ipcRenderer.send('pet:copy-receipt', { text }),
  closeReceipt: () => ipcRenderer.send('pet:close-receipt'),
  savePetCard: (dataUrl, name) => ipcRenderer.invoke('pet:save-card', { dataUrl, name }),
  copyPetCard: (dataUrl) => ipcRenderer.send('pet:copy-card', { dataUrl }),
  closeCard: () => ipcRenderer.send('pet:close-card'),
  closeSettings: () => ipcRenderer.send(CH.closeSettings),
  closeOnboarding: () => ipcRenderer.send(CH.closeOnboarding)
});
