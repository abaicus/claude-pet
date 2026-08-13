'use strict';
// Dev helper: renders mockups/art-preview.html to PNGs (for the M4 art
// approval gate). Usage: npx electron scripts/shoot-mockups.js [outDir]
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const outDir = process.argv[2] || path.join(__dirname, '..', 'mockups');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { offscreen: true }
  });
  await win.loadFile(path.join(__dirname, '..', 'mockups', 'art-preview.html'));
  await new Promise(r => setTimeout(r, 800));
  const height = await win.webContents.executeJavaScript('document.body.scrollHeight');
  win.setSize(1400, Math.min(height + 40, 8000));
  await new Promise(r => setTimeout(r, 600));
  const image = await win.webContents.capturePage();
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'art-preview.png');
  fs.writeFileSync(out, image.toPNG());
  console.log('wrote', out, image.getSize());
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
