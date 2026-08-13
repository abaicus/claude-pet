'use strict';
// Builds the macOS app icon from the same code that draws the pet — there are
// no sprite files here and the icon must not become the one exception that
// drifts from the creature it depicts.
//
//   npx electron scripts/make-icon.js            → build/icon.png (1024) + .icns
//   npx electron scripts/make-icon.js --variants → candidate grid, no writes to build/
//
// The pet is drawn once on a big transparent canvas, its alpha bounding box is
// measured, and only then is it placed — the art module's origin is its own
// business, and measuring beats hardcoding a translate that a new form breaks.

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const VARIANTS = process.argv.includes('--variants');
const OUT_DIR = process.argv[process.argv.indexOf('--out') + 1];

// The icon: an elder in mint on a warm cream squircle. Elder is the first form
// with both ears and a crest, so the silhouette still reads at 16px in the
// menu bar; mint is the default palette a new pet hatches with.
const ICON = { form: 'elder', ramp: 'mint', accessory: null, bg: 'cream' };

const RAMPS = {
  mint: ['#a8e6cf', '#7bd4b2', '#4fbf96', '#2e9c78'],
  sky: ['#bde0fe', '#8ec9f5', '#5fa8e8', '#3c82c4'],
  sakura: ['#ffe5ec', '#ffc2d1', '#ff8fab', '#f75c8b'],
  sunset: ['#ffd97d', '#ffb26b', '#ff7f51', '#e0503a']
};

// Backgrounds are two stops and nothing else. An app icon carrying a detailed
// scene is mud at 32px, which is the size it is actually looked at.
const BACKGROUNDS = {
  cream: ['#fff3e0', '#ffd9b0'],
  night: ['#3a4256', '#1d2130'],
  slate: ['#5b6b7a', '#2f3a45'],
  lilac: ['#e6d9ff', '#bda4ea']
};

function page() {
  const art = fs.readFileSync(path.join(ROOT, 'src', 'body', 'art.js'), 'utf8');
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}</style>
<script>${art}</script>
<script>
const RAMPS = ${JSON.stringify(RAMPS)};
const BACKGROUNDS = ${JSON.stringify(BACKGROUNDS)};

// Draw the pet alone, then hand back the pixels and their tight bounds.
function spriteOf(opts, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  // The art's origin is the TOP of its logical box and it draws down to a feet
  // line at y=+112, with ears and crests poking a little above the origin. 150
  // logical units tall with a 10% lead-in fits every form with room to spare —
  // and a form whose feet land off-canvas is a sprite cropped at the ankles.
  ctx.translate(size / 2, size * 0.10);
  const scale = size / 150;
  ctx.scale(scale, scale);
  PetArt.drawPet(ctx, { t: 700, glow: true, mood: 'happy', form: opts.form,
    ramp: RAMPS[opts.ramp], accessory: opts.accessory });
  ctx.restore();

  const data = ctx.getImageData(0, 0, size, size).data;
  let x0 = size, y0 = size, x1 = -1, y1 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 8 and not 0: the rim glow fades to a haze that is not part of the
      // silhouette, and cropping to it would shrink the pet inside the plate.
      if (data[(y * size + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { canvas: c, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Apple's squircle is close enough to a rounded rect at 22.37% radius, and the
// difference is invisible at every size this is rendered at.
function squircle(ctx, size, r) {
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
}

function drawIcon(size, opts) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');

  // macOS 11+ does not mask app icons: the plate is the icon, and it sits in
  // the 824/1024 content box Apple's grid reserves.
  const pad = size * 0.098;
  const box = size - pad * 2;
  ctx.save();
  ctx.translate(pad, pad);
  squircle(ctx, box, box * 0.2237);
  const [top, bottom] = BACKGROUNDS[opts.bg];
  const g = ctx.createLinearGradient(0, 0, 0, box);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();

  // The pet, centred in the plate and sized to leave a margin that survives
  // being scaled to 16px.
  const s = spriteOf(opts, size * 2);
  const inner = box * 0.66;
  const k = Math.min(inner / s.w, inner / s.h);
  const dw = s.w * k, dh = s.h * k;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(s.canvas, s.x0, s.y0, s.w, s.h,
    (size - dw) / 2, (size - dh) / 2, dw, dh);
  return c.toDataURL('image/png').split(',')[1];
}
</script>`;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 1200, show: false,
    webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page()));

  const render = (size, opts) =>
    win.webContents.executeJavaScript(`drawIcon(${size}, ${JSON.stringify(opts)})`);

  if (VARIANTS) {
    const dir = OUT_DIR || path.join(ROOT, 'mockups');
    fs.mkdirSync(dir, { recursive: true });
    const combos = [];
    for (const bg of Object.keys(BACKGROUNDS)) {
      for (const form of ['elder', 'legend']) combos.push({ form, ramp: 'mint', accessory: null, bg });
    }
    combos.push({ form: 'elder', ramp: 'sakura', accessory: null, bg: 'night' });
    combos.push({ form: 'elder', ramp: 'sky', accessory: null, bg: 'night' });
    combos.push({ form: 'elder', ramp: 'mint', accessory: 'sparkles', bg: 'cream' });
    combos.push({ form: 'senior', ramp: 'mint', accessory: null, bg: 'cream' });
    for (const [i, opts] of combos.entries()) {
      const b64 = await render(512, opts);
      const name = `icon-${String(i).padStart(2, '0')}-${opts.bg}-${opts.form}-${opts.ramp}${opts.accessory ? '-' + opts.accessory : ''}.png`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
      console.log('wrote', name);
    }
    app.quit();
    return;
  }

  fs.mkdirSync(BUILD, { recursive: true });
  const master = Buffer.from(await render(1024, ICON), 'base64');
  fs.writeFileSync(path.join(BUILD, 'icon.png'), master);

  // .icns: every size rendered from scratch rather than downscaled, so the
  // pixel art stays crisp at the small end where a resample turns it to soup.
  const iconset = path.join(BUILD, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    const png = Buffer.from(await render(size, ICON), 'base64');
    if (size <= 512) fs.writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), png);
    if (size >= 32) fs.writeFileSync(path.join(iconset, `icon_${size / 2}x${size / 2}@2x.png`), png);
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
  console.log('wrote build/icon.png and build/icon.icns',
    nativeImage.createFromBuffer(master).getSize());
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
