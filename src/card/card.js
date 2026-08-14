'use strict';
// The pet card: one PNG worth posting in a channel.
//
// Drawn into a canvas rather than screenshotted, so the file is the artwork at
// whatever resolution we ask for rather than a picture of a window — and the
// creature on it is drawn by the same PetArt the pet window uses, wearing the
// palette and the accessory it is wearing right now.

/* global PetArt, petAPI */

const SCALE = 3;                 // export at 3× — 1260×720, sharp on a retina timeline
const W = 420, H = 240;
const INK = '#2b2b2b', PAPER = '#fdfcf5', PAPER2 = '#f4f1e4';

const canvas = document.getElementById('card');
const ctx = canvas.getContext('2d');
let state = null;

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function daysAlive(born) {
  if (!born) return 0;
  return Math.max(1, Math.round((Date.now() - born) / 86_400_000));
}

// A row of the stat block: label left, figure right, dotted leader between —
// the same trick the receipt uses to make two columns read as one line.
function statRow(x, y, w, label, value) {
  ctx.fillStyle = INK;
  ctx.font = '9px "SF Mono", ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(label, x, y);
  ctx.textAlign = 'right';
  ctx.font = 'bold 12px "SF Mono", ui-monospace, Menlo, monospace';
  ctx.fillText(String(value), x + w, y);
  const from = x + ctx.measureText(label).width + 60;
  ctx.globalAlpha = 0.25;
  for (let dx = from; dx < x + w - 34; dx += 4) ctx.fillRect(dx, y - 3, 2, 1);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';   // leaving this as 'right' walks the footer off the card
}

function draw() {
  if (!state) return;
  const dpr = SCALE;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;

  // paper + hard border
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = PAPER2;
  ctx.fillRect(0, 0, 168, H);                 // the portrait panel
  ctx.strokeStyle = INK;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, W - 6, H - 6);
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(168, 6); ctx.lineTo(168, H - 6); ctx.stroke();

  // ---- the creature, standing on a pedestal line
  const g = PetArt.GEOM[state.form] || PetArt.GEOM.hatchling;
  const scale = Math.min(3.2, Math.min((H - 90) / g.h, 120 / Math.max(1, g.w)));
  ctx.save();
  ctx.translate(84, H - 62 - PetArt.FEET_Y * scale);
  ctx.scale(scale, scale);
  PetArt.drawPet(ctx, {
    form: state.form,
    ramp: state.paletteRamps && state.paletteRamps[state.palette],
    accessory: state.accessory,
    mood: 'happy',
    sick: state.sick,
    t: 1200,                                   // a fixed frame: cards do not breathe
    blink: 0,
    glow: false
  });
  ctx.restore();
  ctx.fillStyle = INK;
  ctx.globalAlpha = 0.18;
  ctx.fillRect(28, H - 58, 112, 3);
  ctx.globalAlpha = 1;

  // ---- the name plate
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.font = 'bold 26px "SF Mono", ui-monospace, Menlo, monospace';
  ctx.fillText(String(state.name || 'Gogu').slice(0, 12), 190, 52);
  ctx.font = '11px "SF Mono", ui-monospace, Menlo, monospace';
  ctx.fillText(`LV.${state.level}  ·  ${String(state.form).toUpperCase()}`, 191, 70);

  // A level pip strip: one filled square per level, so growth is visible at a
  // glance rather than needing the number to be read.
  const pips = Math.min(25, state.level);
  for (let i = 0; i < 25; i++) {
    ctx.globalAlpha = i < pips ? 1 : 0.16;
    ctx.fillRect(191 + i * 8.4, 80, 6, 6);
  }
  ctx.globalAlpha = 1;

  // ---- the numbers
  let y = 110;
  const rows = [
    ['COMMITS FED', state.lifetimeCommits || 0],
    ['TOKENS HEARD', fmtTokens(state.lifetimeOutputTokens)],
    ['TOTAL XP', state.xp || 0],
    ['GREEN STREAK', state.greenStreak || 0],
    ['DAYS ALIVE', daysAlive(state.born)]
  ];
  for (const [label, value] of rows) { statRow(191, y, 210, label, value); y += 20; }

  // ---- the footer, kept a clear line below the last figure
  ctx.globalAlpha = 0.55;
  ctx.textAlign = 'left';
  ctx.font = '8px "SF Mono", ui-monospace, Menlo, monospace';
  ctx.fillText('GOGU · A DESKTOP PET FED ON CLAUDE CODE', 191, H - 20);
  ctx.globalAlpha = 1;
}

petAPI.onState((s) => { state = s; draw(); });
petAPI.getState().then((s) => { state = s; draw(); });

const fileName = () => {
  const name = String((state && state.name) || 'gogu').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `gogu-${name}-lv${(state && state.level) || 0}.png`;
};

document.getElementById('save').addEventListener('click', async () => {
  const btn = document.getElementById('save');
  const res = await petAPI.savePetCard(canvas.toDataURL('image/png'), fileName());
  btn.textContent = res && res.ok ? 'saved ✓' : 'failed';
  setTimeout(() => { btn.textContent = 'save png'; }, 1400);
});
document.getElementById('copy').addEventListener('click', () => {
  petAPI.copyPetCard(canvas.toDataURL('image/png'));
  const btn = document.getElementById('copy');
  btn.textContent = 'copied ✓';
  setTimeout(() => { btn.textContent = 'copy'; }, 1400);
});
document.getElementById('close').addEventListener('click', () => petAPI.closeCard());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') petAPI.closeCard(); });
