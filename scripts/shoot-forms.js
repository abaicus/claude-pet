'use strict';
// Renders the evolution strip the README uses: every form the pet grows
// through, drawn by the app's own art module rather than posed by hand.
//
//   npx electron scripts/shoot-forms.js [outfile]
//
// Run through shoot-readme.js, which produces all the README images at once.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'media', 'forms.png'));

// Name, and the level it arrives at — read off the same table the brain uses,
// so a re-tuned ladder cannot leave this picture quietly lying.
const { FORMS, formForLevel, MAX_LEVEL } = require(path.join(ROOT, 'src', 'shared', 'constants'));
const ARRIVES = FORMS.map(form => {
  for (let lvl = 0; lvl <= MAX_LEVEL; lvl++) if (formForLevel(lvl) === form) return lvl;
  return 0;
});

const CELL_W = 150;
const CELL_H = 190;
const SCALE = 2; // retina — the strip is pixel art and must not be resampled

function page() {
  const art = fs.readFileSync(path.join(ROOT, 'src', 'body', 'art.js'), 'utf8');
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}</style>
<script>${art}</script>
<script>
const FORMS = ${JSON.stringify(FORMS)};
const ARRIVES = ${JSON.stringify(ARRIVES)};
const RAMP = ['#a8e6cf', '#7bd4b2', '#4fbf96', '#2e9c78'];

function draw() {
  const c = document.createElement('canvas');
  c.width = ${CELL_W * SCALE} * FORMS.length;
  c.height = ${CELL_H * SCALE};
  const ctx = c.getContext('2d');
  ctx.scale(${SCALE}, ${SCALE});
  ctx.imageSmoothingEnabled = false;

  FORMS.forEach((form, i) => {
    ctx.save();
    // The art draws down to a feet line 112 units below its origin; 150 units
    // of headroom fits the tallest form (the legend's mane) with margin.
    ctx.translate(i * ${CELL_W} + ${CELL_W} / 2, 8);
    ctx.scale(${CELL_H} / 190, ${CELL_H} / 190);
    PetArt.drawPet(ctx, { t: 700, glow: true, mood: 'happy', form, ramp: RAMP });
    ctx.restore();

    // Labels sit on the same baseline for every cell, so the strip reads as a
    // sequence rather than seven separate drawings.
    ctx.fillStyle = '#2b2b2b';
    ctx.textAlign = 'center';
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(form, i * ${CELL_W} + ${CELL_W} / 2, ${CELL_H} - 22);
    ctx.fillStyle = '#6b6b6b';
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('lv.' + ARRIVES[i], i * ${CELL_W} + ${CELL_W} / 2, ${CELL_H} - 6);
  });
  return c.toDataURL('image/png').split(',')[1];
}
</script>`;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 400, show: false,
    webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page()));
  const b64 = await win.webContents.executeJavaScript('draw()');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
  console.log('wrote', OUT);
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
