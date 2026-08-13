'use strict';
// Puts a transparent screenshot on a solid plate.
//
//   npx electron scripts/plate.js <in.png> <out.png> [padding]
//
// The pet window is transparent by design — it floats over your desktop with
// no chrome. A transparent PNG in a README, though, is at the mercy of the
// reader's theme: on GitHub's dark theme the pet's ink outline disappears into
// the page. This paints the same shot onto the app's own cream card so it
// reads the same for everybody.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [input, output, padArg] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: plate.js <in.png> <out.png> [padding]');
  process.exit(1);
}
const PAD = Number(padArg || 40);

function page(dataUri) {
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}</style>
<script>
const SRC = ${JSON.stringify(dataUri)};
const PAD = ${PAD};
function plate() {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width + PAD * 2;
      c.height = img.height + PAD * 2;
      const ctx = c.getContext('2d');

      const r = 28;
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(c.width, 0, c.width, c.height, r);
      ctx.arcTo(c.width, c.height, 0, c.height, r);
      ctx.arcTo(0, c.height, 0, 0, r);
      ctx.arcTo(0, 0, c.width, 0, r);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, c.height);
      g.addColorStop(0, '#fffdf4');
      g.addColorStop(1, '#f3ead6');
      ctx.fillStyle = g;
      ctx.fill();

      ctx.imageSmoothingEnabled = false;   // pixel art: never resample
      ctx.drawImage(img, PAD, PAD);
      resolve(c.toDataURL('image/png').split(',')[1]);
    };
    img.src = SRC;
  });
}
</script>`;
}

app.whenReady().then(async () => {
  const src = 'data:image/png;base64,' + fs.readFileSync(path.resolve(input)).toString('base64');
  const win = new BrowserWindow({ width: 800, height: 600, show: false,
    webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(src)));
  const b64 = await win.webContents.executeJavaScript('plate()');
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), Buffer.from(b64, 'base64'));
  console.log('wrote', output);
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
