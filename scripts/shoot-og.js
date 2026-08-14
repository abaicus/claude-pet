'use strict';
// Draws the 1200×630 social card for the landing page.
//
//   npx electron scripts/shoot-og.js [out.png]
//
// Same rule as every other image here: the creature on the card is drawn by
// the app's own art module, so the thing in a link preview is the thing that
// gets installed. The type and the frame follow abaic.us — near-black ground,
// hairline rules, one orange accent.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'media', 'og.png'));

const W = 1200;
const H = 630;

// abaic.us tokens, the paper palette.
const BG = '#0a0a0a';
const FG = '#efede6';
const MUTED = '#9d998f';
const DIM = '#5a5750';
const LINE = '#3d3a34';
const ACCENT = '#ff6b1a';

const MONO = 'ui-monospace, "SF Mono", Menlo, Monaco, monospace';

function page() {
  const art = fs.readFileSync(path.join(ROOT, 'src', 'body', 'art.js'), 'utf8');
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}</style>
<script>${art}</script>
<script>
const W = ${W}, H = ${H};
const BG = ${JSON.stringify(BG)}, FG = ${JSON.stringify(FG)}, MUTED = ${JSON.stringify(MUTED)};
const DIM = ${JSON.stringify(DIM)}, LINE = ${JSON.stringify(LINE)}, ACCENT = ${JSON.stringify(ACCENT)};
const MONO = ${JSON.stringify(MONO)};
const RAMP = ['#a8e6cf', '#7bd4b2', '#4fbf96', '#2e9c78'];

function rule(ctx, x, y, w, h) { ctx.fillStyle = LINE; ctx.fillRect(x, y, w, h); }

function draw() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // The floor the pet stands on — the same faint accent wash the page uses.
  const glow = ctx.createRadialGradient(880, 470, 10, 880, 470, 320);
  glow.addColorStop(0, 'rgba(255,107,26,0.13)');
  glow.addColorStop(1, 'rgba(255,107,26,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(560, 150, 640, 400);

  // Hairline frame, inset — a Braun front panel, not a border.
  const M = 36;
  rule(ctx, M, M, W - M * 2, 1);
  rule(ctx, M, H - M - 1, W - M * 2, 1);
  rule(ctx, M, M, 1, H - M * 2);
  rule(ctx, W - M - 1, M, 1, H - M * 2);

  // Top rail: the site, and the product's index on it.
  ctx.font = '500 15px ' + MONO;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = DIM;
  ctx.letterSpacing = '3.5px';
  ctx.fillText('ABAIC.US', M + 34, M + 46);
  ctx.fillText('NO. 04', W - M - 34 - ctx.measureText('NO. 04').width, M + 46);
  rule(ctx, M, M + 70, W - M * 2, 1);

  // The orange chip: the one piece of product colour on the panel.
  ctx.fillStyle = ACCENT;
  ctx.fillRect(M + 34, 168, 46, 10);

  ctx.letterSpacing = '2px';
  ctx.fillStyle = FG;
  ctx.font = '500 72px ' + MONO;
  ctx.fillText('GOGU', M + 32, 250);

  ctx.letterSpacing = '0px';
  ctx.fillStyle = MUTED;
  ctx.font = '400 25px ' + MONO;
  const lines = [
    'A desktop tamagotchi that feeds on',
    'your Claude Code sessions — and tells',
    'you which terminal is waiting on you.'
  ];
  lines.forEach((l, i) => ctx.fillText(l, M + 32, 316 + i * 40));

  // The install line, in the box it has on the page. The box is measured from
  // the string rather than guessed at — a command running out of its own frame
  // is the one thing on this card nobody would trust.
  const cmd = 'brew install --cask abaicus/tap/gogu';
  ctx.font = '400 20px ' + MONO;
  const bx = M + 32, by = 470, bh = 56;
  const bw = Math.ceil(ctx.measureText(cmd).width) + 36;
  rule(ctx, bx, by, bw, 1);
  rule(ctx, bx, by + bh, bw, 1);
  rule(ctx, bx, by, 1, bh);
  rule(ctx, bx + bw - 1, by, 1, bh);
  ctx.fillStyle = FG;
  ctx.fillText(cmd, bx + 18, by + 36);

  ctx.fillStyle = DIM;
  ctx.font = '500 14px ' + MONO;
  ctx.letterSpacing = '3.5px';
  ctx.fillText('MACOS  ·  FREE  ·  MIT', bx + 2, H - M - 44);

  // The pet itself, standing on the wash.
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const scale = 3;
  ctx.translate(880, 500 - PetArt.FEET_Y * scale);
  ctx.scale(scale, scale);
  PetArt.drawPet(ctx, {
    form: 'elder', ramp: RAMP, accessory: 'headphones',
    mood: 'happy', t: 700, glow: true
  });
  ctx.restore();

  return c.toDataURL('image/png').split(',')[1];
}
</script>`;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W, height: H, show: false, webPreferences: { offscreen: true }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page()));
  const b64 = await win.webContents.executeJavaScript('draw()');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
  console.log('wrote', OUT);
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
