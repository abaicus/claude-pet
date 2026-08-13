'use strict';
// Pet window renderer — a dumb puppet. Contract with the brain: render the
// latest state object; play one-shot fx by sequence number. No game logic.

/* global PetArt, PetSounds, petAPI */

const canvas = document.getElementById('pet');
const ctx2d = canvas.getContext('2d');
const bubbleEl = document.getElementById('bubble');
const bubbleZone = document.getElementById('bubble-zone');
const statsEl = document.getElementById('stats');
const stripEl = document.getElementById('strip');

const LOGICAL_H = 130;      // art box height (see art.js)
const FOOT_MARGIN = 46;     // px above window bottom where feet sit

let state = null;           // latest brain state
let lastFxSeq = 0;
let lastSoundSeq = 0;
let lastBubbleSeq = 0;

// animation runtime
let anim = null;            // {name, big, start, dur}
let particles = [];         // {x,y,vx,vy,life,age,type,color}
let blinkAt = performance.now() + 2000 + Math.random() * 3000;
let blinking = 0;           // 0..1 closure
let eyeTarget = 0, eyeNow = 0;
let cursor = { dx: 9999, dy: 0, walking: false, facing: 0 };
let glanceUntil = 0, glanceDir = 0, nextGlanceAt = 0;
let facing = 1;             // 1 = right, -1 = left

const ANIM_DUR = {
  eat: 700, party: 1600, partyBig: 2800, sulk: 1800, wake: 900,
  attention: 1600, hearts: 1100, flinch: 500, wave: 1000, sleep: 1200,
  nibble: 460, feast: 1300, sniff: 950, think: 1500, nod: 620,
  spin: 720, shiver: 700
};

// Idle fidgets. The renderer owns these outright — the brain has no opinion
// about them, exactly as it has none about blinking. They are how the puppet
// stands still. Kept out of ANIM_DUR so the seam test can still prove that
// every BRAIN-emitted animation name exists on this side.
const IDLE_DUR = { look: 1200, stretch: 1000, bounce: 760, wiggle: 900 };
const IDLE_NAMES = Object.keys(IDLE_DUR);
const durationOf = (name) => ANIM_DUR[name] || IDLE_DUR[name] || 800;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
window.addEventListener('resize', resize);

// ------------------------------------------------------------------ state in
function consume(s) {
  state = s;

  for (const f of s.fx || []) {
    if (f.seq <= lastFxSeq) continue;
    lastFxSeq = f.seq;
    startAnim(f.name, f.big);
  }
  for (const snd of s.sounds || []) {
    if (snd.seq <= lastSoundSeq) continue;
    lastSoundSeq = snd.seq;
    PetSounds.play(snd.name, { on: s.soundOn, volume: s.volume, important: snd.important });
  }

  // bubble
  if (s.bubble && s.bubble.seq !== lastBubbleSeq) {
    lastBubbleSeq = s.bubble.seq;
    bubbleEl.textContent = s.bubble.text;
    bubbleEl.classList.toggle('important', !!s.bubble.important);
    bubbleEl.classList.add('show');
    bubbleZone.classList.toggle('important', !!s.bubble.important);
    bubbleZone.classList.add('show');
  }
  if (!s.bubble) { bubbleEl.classList.remove('show'); bubbleZone.classList.remove('show'); }

  // stats line
  const line = s.statsLine || { mode: 'hidden' };
  if (line.mode === 'hidden') {
    statsEl.style.display = 'none';
    stripEl.style.display = 'none';
  } else {
    statsEl.style.display = '';
    statsEl.textContent = line.text;
    if (line.strip && line.strip.length) {
      stripEl.style.display = '';
      stripEl.textContent = line.strip.join('  ·  ');
    } else {
      stripEl.style.display = 'none';
    }
  }

  // bubble zone anchors just above THIS form's head at current scale
  const g = PetArt.GEOM[s.form] || PetArt.GEOM.hatchling;
  const headroom = FOOT_MARGIN + (g.h + 14) * (s.scale || 1);
  bubbleZone.style.bottom = Math.min(headroom, innerHeight - 60) + 'px';
  bubbleZone.style.top = '4px';
}

petAPI.onState(consume);
petAPI.getState().then(consume);
petAPI.onCursor((c) => { cursor = c; });

// ------------------------------------------------------------------ anims
function startAnim(name, big) {
  const t = performance.now();
  if (name === 'party') {
    anim = { name, big, start: t, dur: big ? ANIM_DUR.partyBig : ANIM_DUR.party };
    spawnConfetti(big ? 40 : 16, big);
  } else if (name === 'hearts') {
    anim = { name, start: t, dur: ANIM_DUR.hearts };
    spawnHearts(5);
  } else if (name === 'attention') {
    anim = { name, start: t, dur: ANIM_DUR.attention };
  } else if (name === 'feast') {
    anim = { name, start: t, dur: ANIM_DUR.feast };
    spawnCrumbs(9);
  } else if (name === 'think') {
    anim = { name, start: t, dur: ANIM_DUR.think };
    spawnDots(3);
  } else if (name === 'spin') {
    anim = { name, start: t, dur: ANIM_DUR.spin };
    spawnConfetti(8, false);
  } else {
    anim = { name, big, start: t, dur: durationOf(name) };
  }
}

// One fidget every several seconds, and never over the top of a real reaction —
// an idle pet should look alive, not twitchy. A grumpy one sulks: it fidgets
// half as often and only in the two joyless ways.
let nextIdleAt = performance.now() + 4000 + Math.random() * 5000;
function maybeIdle(t) {
  if (!state || state.sleeping || anim || t < nextIdleAt) return;
  const grumpy = state.moodBand === 'grumpy';
  nextIdleAt = t + (grumpy ? 15000 : 6500) + Math.random() * 8000;
  const pool = grumpy ? ['look', 'wiggle'] : IDLE_NAMES;
  const name = pool[Math.floor(Math.random() * pool.length)];
  startAnim(name);
  if (name === 'look') {
    anim.dir = Math.random() < 0.5 ? -1 : 1;
    // the eyes go where the head goes, then hold still a moment afterwards
    glanceDir = anim.dir;
    glanceUntil = t + IDLE_DUR.look;
    nextGlanceAt = Math.max(nextGlanceAt, glanceUntil + 1500);
  }
}

function spawnConfetti(n, big) {
  const colors = ['#ff6f91', '#ffd54f', '#4fc3f7', '#81c784', '#ba68c8', '#ffb74d'];
  for (let i = 0; i < n; i++) {
    particles.push({
      type: 'confetti',
      x: (Math.random() * 2 - 1) * 50,
      y: -LOGICAL_H * (0.5 + Math.random() * 0.6),
      vx: (Math.random() * 2 - 1) * 40,
      vy: -60 - Math.random() * (big ? 120 : 60),
      spin: Math.random() * Math.PI,
      color: colors[i % colors.length],
      age: 0, life: 1.4 + Math.random() * 0.8
    });
  }
}
function spawnHearts(n) {
  for (let i = 0; i < n; i++) {
    particles.push({
      type: 'heart',
      x: (Math.random() * 2 - 1) * 26,
      y: -LOGICAL_H * (0.75 + Math.random() * 0.3),
      vx: (Math.random() * 2 - 1) * 14,
      vy: -28 - Math.random() * 20,
      age: -i * 0.08, life: 1.1
    });
  }
}
// Where this form's head actually ends — particles anchor to the sprite, not
// to the art box, or they hover in empty space above a small pet.
function headTopY() {
  const g = (state && PetArt.GEOM[state.form]) || PetArt.GEOM.hatchling;
  return -g.h;
}

// Crumbs from a big diff: they spray from mouth height and fall past the body.
function spawnCrumbs(n) {
  const colors = ['#c9a227', '#a8813a', '#e0c069'];
  const mouthY = headTopY() * 0.4;
  for (let i = 0; i < n; i++) {
    // Two sprays from the mouth corners, thrown outward — the face is sacred,
    // so crumbs must clear it rather than settle on it.
    const side = i % 2 ? 1 : -1;
    particles.push({
      type: 'crumb',
      x: side * (9 + Math.random() * 7),
      y: mouthY - Math.random() * 6,
      vx: side * (30 + Math.random() * 45),
      vy: -40 - Math.random() * 45,
      color: colors[i % colors.length],
      age: -i * 0.05, life: 0.9 + Math.random() * 0.4
    });
  }
}
// Thought dots, rising in sequence just above the head.
function spawnDots(n) {
  const top = headTopY() - 8;
  for (let i = 0; i < n; i++) {
    particles.push({
      type: 'dot',
      x: 13 + i * 8, y: top - i * 6,
      vx: 3, vy: -7,
      age: -i * 0.22, life: 1.0
    });
  }
}
function spawnZzz() {
  particles.push({
    type: 'zzz',
    x: 22, y: -LOGICAL_H * 0.85,
    vx: 8, vy: -16,
    age: 0, life: 2.2
  });
}

let lastZzz = 0;

// motion computed from active anim + passive state
function computeMotion(t) {
  const m = { hop: 0, squash: 0, tilt: 0, spinX: 1, mouthOpen: false, exclaim: false, sweat: false };
  const s = state;
  if (!s) return m;

  if (cursor.walking) {
    m.hop = Math.abs(Math.sin(t / 110)) * 3;
    m.tilt = Math.sin(t / 110) * 0.05;
  }
  if (!anim) return m;

  const el = (t - anim.start) / anim.dur; // 0..1
  if (el >= 1) { anim = null; return m; }

  switch (anim.name) {
    case 'eat': {
      m.mouthOpen = (el * 4) % 1 < 0.55;
      m.squash = Math.sin(el * Math.PI * 4) * 0.03;
      break;
    }
    case 'party': {
      const hops = anim.big ? 4 : 2;
      m.hop = Math.abs(Math.sin(el * Math.PI * hops)) * (anim.big ? 16 : 10);
      m.tilt = Math.sin(el * Math.PI * hops * 2) * 0.06;
      break;
    }
    case 'sulk': {
      m.tilt = -0.06 * Math.min(1, el * 3);
      m.squash = 0.05 * Math.min(1, el * 3);
      m.sweat = true;
      break;
    }
    case 'wake': {
      m.squash = -0.62 * Math.sin(el * Math.PI); // stretch up: 2 whole rows
      break;
    }
    case 'attention': {
      m.hop = Math.abs(Math.sin(el * Math.PI * 3)) * 14;
      m.exclaim = true;
      break;
    }
    case 'flinch': {
      m.tilt = Math.sin(el * Math.PI * 6) * 0.09;
      m.squash = 0.06;
      break;
    }
    case 'wave': {
      m.tilt = Math.sin(el * Math.PI * 3) * 0.08;
      break;
    }
    // Motion below is sized in whole ART PIXELS, because that is all the
    // sprite can express: hop is quantised by PX (4) and squash by rows
    // (round(squash * 3)), so a hop of 2 or a squash of 0.05 is not a subtle
    // movement — it is no movement at all.
    case 'nibble': {                            // a one-liner: quick little chew
      const chew = (el * 6) % 1 < 0.5;
      m.mouthOpen = chew;
      m.hop = chew ? 4 : 0;                     // 1px bob per bite
      break;
    }
    case 'feast': {                             // a tasty diff: whole-body chomp
      const beat = Math.abs(Math.sin(el * Math.PI * 4));
      m.mouthOpen = (el * 8) % 1 < 0.6;
      m.squash = beat * 0.22;                   // up to 1 row of splat
      m.hop = beat * 8;                         // …and 2px of bounce
      break;
    }
    case 'sniff': {                             // leans in, nose twitching
      m.tilt = 0.16 + Math.sin(el * Math.PI * 6) * 0.08;
      m.hop = Math.abs(Math.sin(el * Math.PI * 3)) * 4;
      break;
    }
    case 'think': {                             // head cocked, dots overhead
      m.tilt = 0.12;
      m.hop = Math.abs(Math.sin(el * Math.PI * 2)) * 4;
      break;
    }
    case 'nod': {                               // yes! (a ticked box)
      const b = Math.sin(el * Math.PI * 4);
      m.hop = Math.max(0, b) * 8;
      m.squash = Math.max(0, -b) * 0.22;
      break;
    }
    case 'spin': {
      // A pixel sprite doesn't rotate — it flips through a few whole-pixel
      // widths, the way a spinning sprite sheet would.
      const c = Math.cos(el * Math.PI * 2);
      const a = Math.abs(c);
      m.spinX = (c < 0 ? -1 : 1) * (a > 0.75 ? 1 : a > 0.35 ? 0.5 : 0.25);
      m.hop = Math.sin(el * Math.PI) * 6;
      break;
    }
    case 'shiver': {                            // ±2 art pixels, fast — dread
      m.tilt = (Math.floor(el * 26) % 2 ? 1 : -1) * 0.18;
      break;
    }
    // ---- idle fidgets (renderer-owned; see IDLE_DUR)
    case 'look': {                              // a slow look to one side
      const d = anim.dir || 1;
      m.tilt = Math.sin(el * Math.PI) * 0.19 * d;
      break;
    }
    case 'stretch': {                           // up on tiptoes, then settle
      m.squash = -0.62 * Math.sin(el * Math.PI);
      m.hop = Math.sin(el * Math.PI) * 4;
      break;
    }
    case 'bounce': {                            // two little hops, because why not
      m.hop = Math.abs(Math.sin(el * Math.PI * 2)) * 8;
      break;
    }
    case 'wiggle': {                            // a shimmy, one art pixel each way
      m.tilt = Math.sin(el * Math.PI * 4) * 0.12;
      break;
    }
    case 'hearts': break;
    case 'sleep': break;
  }
  return m;
}

// ------------------------------------------------------------------ draw loop
let lastFrame = performance.now();
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - lastFrame) / 1000);
  lastFrame = t;
  ctx2d.clearRect(0, 0, innerWidth, innerHeight);
  if (!state) return;
  const s = state;

  // blink scheduling
  if (!s.sleeping && t > blinkAt) {
    blinking = 1;
    blinkAt = t + 2200 + Math.random() * 3800;
  }
  if (blinking > 0) blinking = Math.max(0, blinking - dt * 9);
  const blinkClosure = blinking > 0 ? Math.sin(Math.min(1, 1 - blinking) * Math.PI) : 0;

  // eyes: horizontal-only tracking; idle glances when the cursor is far
  const far = Math.abs(cursor.dx) > 500;
  if (!far) {
    eyeTarget = Math.max(-1, Math.min(1, cursor.dx / 260));
  } else {
    if (t > nextGlanceAt) {
      glanceDir = (Math.random() * 2 - 1);
      glanceUntil = t + 900 + Math.random() * 900;
      nextGlanceAt = t + 3500 + Math.random() * 4000;
    }
    eyeTarget = t < glanceUntil ? glanceDir : 0;
  }
  eyeNow += (eyeTarget - eyeNow) * Math.min(1, dt * 10);

  if (cursor.walking && cursor.facing) facing = cursor.facing;

  maybeIdle(t);
  const motion = computeMotion(t);

  // sleeping Zzz
  if (s.sleeping && t - lastZzz > 1400) { lastZzz = t; spawnZzz(); }

  const scale = s.scale || 1;
  const cx = innerWidth / 2;
  const feetY = innerHeight - FOOT_MARGIN;

  ctx2d.save();
  ctx2d.translate(cx, feetY - PetArt.FEET_Y * scale);
  // scale about the feet; facing flips X, spinX narrows it mid-spin
  ctx2d.scale(scale * facing * (motion.spinX || 1), scale);

  PetArt.drawPet(ctx2d, {
    form: s.form,
    ramp: (s.paletteRamps && s.paletteRamps[s.palette]) || undefined,
    accessory: s.accessory,
    mood: s.sleeping ? 'neutral' : s.moodBand,
    t,
    eyeTrack: eyeNow * facing,          // compensate mirror so eyes still follow cursor
    blink: blinkClosure,
    sleeping: s.sleeping,
    glow: s.toggles && s.toggles.glow,
    mouthOpen: motion.mouthOpen,
    hop: motion.hop,
    squash: motion.squash,
    tilt: motion.tilt * facing
  });
  ctx2d.restore();

  drawOverlays(t, motion, scale, cx, feetY, dt);
}
requestAnimationFrame(frame);

function drawOverlays(t, motion, scale, cx, feetY, dt) {
  // particles live in logical pet space (origin = feet center)
  ctx2d.save();
  ctx2d.translate(cx, feetY);
  ctx2d.scale(scale, scale);

  particles = particles.filter(p => (p.age += dt) < p.life);
  for (const p of particles) {
    if (p.age < 0) continue;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.type === 'confetti' || p.type === 'crumb') p.vy += 160 * dt; // gravity
    const fade = 1 - p.age / p.life;
    ctx2d.globalAlpha = Math.max(0, Math.min(1, fade * 1.4));
    // Everything here is drawn on the art grid too — a rotating confetti
    // rectangle next to a pixel sprite looks like a bug.
    const G = PetArt.PX;
    const snap = (v) => Math.round(v / G) * G;
    if (p.type === 'confetti') {
      ctx2d.fillStyle = p.color;
      ctx2d.fillRect(snap(p.x), snap(p.y), G, G);
    } else if (p.type === 'crumb') {            // half-pixel specks of diff
      ctx2d.fillStyle = p.color;
      ctx2d.fillRect(snap(p.x), snap(p.y), G / 2, G / 2);
    } else if (p.type === 'dot') {              // thinking…
      ctx2d.fillStyle = '#2b2b2b';
      ctx2d.fillRect(snap(p.x), snap(p.y), G, G);
      ctx2d.fillStyle = '#fffef2';
      ctx2d.fillRect(snap(p.x) + G / 4, snap(p.y) + G / 4, G / 2, G / 2);
    } else if (p.type === 'heart') {
      drawPixelHeart(snap(p.x), snap(p.y), G, '#ff6f91');
    } else if (p.type === 'zzz') {
      ctx2d.fillStyle = 'rgba(150,160,200,0.95)';
      ctx2d.font = `bold ${Math.round(9 + p.age * 3)}px ui-monospace, Menlo, monospace`;
      ctx2d.fillText('z', snap(p.x), snap(p.y));
    }
  }
  ctx2d.globalAlpha = 1;

  const g = PetArt.GEOM[state.form] || PetArt.GEOM.hatchling;
  const headTop = -g.h - 6;

  if (motion.exclaim) { // notification: unmissable
    const bob = Math.sin(t / 120) * 2;
    ctx2d.fillStyle = '#ffb300';
    ctx2d.strokeStyle = '#7a5600';
    ctx2d.lineWidth = 1.2;
    ctx2d.font = 'bold 20px -apple-system, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.strokeText('!', 0, headTop - 6 + bob);
    ctx2d.fillText('!', 0, headTop - 6 + bob);
    ctx2d.textAlign = 'start';
  }
  if (motion.sweat) {
    const drop = Math.min(8, (t % 1800) / 120);
    ctx2d.fillStyle = 'rgba(110,180,240,0.85)';
    ctx2d.beginPath();
    ctx2d.ellipse(g.w * 0.42, headTop + 16 + drop, 2.2, 3.2, 0, 0, Math.PI * 2);
    ctx2d.fill();
  }
  ctx2d.restore();
}

// A 5x5 pixel heart, one cell per art pixel.
const HEART = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
function drawPixelHeart(x, y, g, color) {
  ctx2d.fillStyle = color;
  for (let r = 0; r < HEART.length; r++) {
    for (let c = 0; c < HEART[r].length; c++) {
      if (HEART[r][c] === 'X') ctx2d.fillRect(x + (c - 3) * g, y + (r - 3) * g, g + 0.5, g + 0.5);
    }
  }
}

// ------------------------------------------------------------------ input
// Manual drag (frameless window). Short still click = pet; double = treat.
let down = null;            // {sx, sy, moved}
let clickTimer = null;

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  down = { sx: e.screenX, sy: e.screenY, moved: false };
});

window.addEventListener('mousemove', (e) => {
  if (!down) return;
  const dx = e.screenX - down.sx, dy = e.screenY - down.sy;
  if (!down.moved && Math.hypot(dx, dy) < 4) return;
  down.moved = true;
  petAPI.moveWindowBy(dx, dy);
  down.sx = e.screenX; down.sy = e.screenY;
});

window.addEventListener('mouseup', (e) => {
  if (!down) return;
  const wasDrag = down.moved;
  down = null;
  if (wasDrag) { petAPI.dragEnd(); return; }
  // click vs double-click: wait briefly for a second click
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    petAPI.command({ type: 'treat' });
  } else {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      petAPI.command({ type: 'pet' });
    }, 240);
  }
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  petAPI.contextMenu();
});
