'use strict';
// All art is generated in code — no sprite files. Draws into a 2D canvas.
// Pure drawing: no Electron, no IPC, no game logic. Also powers the static
// mockup page, so it must run in a plain browser.
//
// PIXEL ART. Everything lands on an integer grid of art pixels (PX logical
// units each), painted with fillRect — no curves, no gradients, no rotation.
// The silhouette is a mochi dome: a pixel-circle cap sitting on straight
// sides. Its per-row half-width table (hw) is the single source of truth —
// the face, the ears, the scarf and every accessory are placed FROM it, so
// nothing can float off the body or spill past an edge.
//
// Contract constraints (paid for in a previous build):
// - every form is a different SILHOUETTE, never a recolor
// - the face is sacred: nothing covers it
// - accessories sit off the face; wings sweep away from the body
// - glow = rim light hugging the sprite + small ground shadow, no radial cloud
// - eyes track horizontally only (and only in whole pixels)

(function (global) {

  // Logical space: feet line at y=112, sprite centred on x=0.
  const FEET_Y = 112;
  // 4 logical units per art pixel: with the size slider stepping in 0.25s,
  // PX * scale * dpr always lands on a whole device pixel, so the sprite has
  // no seams. The +0.5 overlap in px() covers exotic DPRs anyway.
  const PX = 4;
  const INK = '#2b2b2b';     // same ink as the speech bubble and settings card

  // Sprite metrics in ART PIXELS. Widths are odd so there is a true centre
  // column — a kawaii face is symmetrical or it is nothing. `gap` is the
  // number of clear columns between the two eyes.
  const FORMS = {
    egg:       { w: 13, h: 17, cap: 0.95, shape: 'egg', ears: 'none', crest: false, tail: 0, eyeW: 2, eyeH: 3, gap: 1, eyeF: 0.42 },
    hatchling: { w: 17, h: 12, cap: 0.85, ears: 'none', crest: false, tail: 0, eyeW: 3, eyeH: 4, gap: 1, eyeF: 0.30 },
    junior:    { w: 19, h: 14, cap: 0.80, ears: 'nubs', crest: false, tail: 0, eyeW: 3, eyeH: 4, gap: 2, eyeF: 0.30 },
    senior:    { w: 23, h: 16, cap: 0.75, ears: 'ears', crest: false, tail: 5, eyeW: 4, eyeH: 5, gap: 2, eyeF: 0.32 },
    elder:     { w: 25, h: 19, cap: 0.70, ears: 'ears', crest: true,  tail: 7, eyeW: 4, eyeH: 5, gap: 2, eyeF: 0.34 }
  };

  const TOP_EXTRA = { none: 0, nubs: 3, ears: 4 }; // silhouette above the dome

  const GEOM = {}; // logical box per form — the speech bubble anchors off this
  for (const [name, F] of Object.entries(FORMS)) {
    GEOM[name] = { w: F.w * PX, h: (F.h + TOP_EXTRA[F.ears] + (F.crest ? 2 : 0)) * PX };
  }

  // The window box, shared by the two files that have to agree on it: main.js
  // sizes the pet window with boxHeight(), pet.js lays these same numbers out
  // inside it. A duplicated 46 on one side only is a window that no longer
  // fits its pet.
  //
  // It is grown and shrunk to fit the creature rather than fixed, because
  // macOS refuses to place any window above the menu bar: every unreserved
  // pixel up here is a pixel the pet can never be dragged past.
  const LAYOUT = {
    footRoom: 46,    // under the feet — the stats pills stack in here
    headGap: 14,     // logical units of air between the head and the tail
    bubbleRoom: 74   // above that: three lines of speech, its border and shadow
  };
  function boxHeight(form, scale) {
    const g = GEOM[form] || GEOM.hatchling;
    return Math.round(LAYOUT.footRoom + (g.h + LAYOUT.headGap) * (scale || 1) + LAYOUT.bubbleRoom);
  }

  const EGG = { light: '#f7f0e2', mid: '#e6dac2', dark: '#cdbc9c', outline: '#8a7a5e', speck: '#c0ab86' };

  // ---------------------------------------------------------------- utils
  function shade(hex, f) { // f<0 darken, f>0 lighten
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    else { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  function mix(a, b, f) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = ((pa >> 16) & 255) * (1 - f) + ((pb >> 16) & 255) * f;
    const g = ((pa >> 8) & 255) * (1 - f) + ((pb >> 8) & 255) * f;
    const bl = (pa & 255) * (1 - f) + (pb & 255) * f;
    return `rgb(${r | 0},${g | 0},${bl | 0})`;
  }

  function bodyColor(form, ramp) {
    const idx = { hatchling: 0, junior: 1, senior: 2, elder: 3 }[form];
    return idx === undefined ? EGG.light : ramp[idx];
  }

  // Blush must read warm against all twelve palettes, so it is mixed toward
  // pink rather than taken from the ramp.
  const blushColor = (ramp) => mix(ramp[2], '#ff8fa8', 0.75);

  // ---------------------------------------------------------------- grid
  // x: art-pixel column, 0 = centre. y: art-pixel row, 0 = the row sitting on
  // the feet line, positive upward.
  function px(ctx, x, y, color, alpha) {
    const bleed = alpha === undefined ? 0.5 : 0; // see note above
    if (alpha !== undefined) { ctx.save(); ctx.globalAlpha = alpha; }
    ctx.fillStyle = color;
    ctx.fillRect(x * PX - PX / 2, FEET_Y - (y + 1) * PX, PX + bleed, PX + bleed);
    if (alpha !== undefined) ctx.restore();
  }

  function rect(ctx, x0, y0, w, h, color, alpha) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px(ctx, x0 + x, y0 + y, color, alpha);
  }

  const key = (x, y) => x + ',' + y;

  // ---------------------------------------------------------------- shape
  // Half-width per row: a pixel-circle cap of radius R on straight sides.
  // Sampling at d+0.5 keeps the apex a rounded 5-7px cap instead of a spike.
  function halfWidths(F) {
    const half = (F.w - 1) / 2;
    const hw = [];
    if (F.shape === 'egg') {
      // an ellipse squeezed narrower toward the top — an actual egg
      const cy = (F.h - 1) / 2;
      for (let y = 0; y < F.h; y++) {
        const t = (y - cy) / (cy + 0.5);
        const taper = 1 - 0.26 * Math.max(0, t);
        hw[y] = Math.max(1, Math.round(half * Math.sqrt(Math.max(0, 1 - t * t)) * taper));
      }
      return hw;
    }
    const R = Math.min(half, Math.round(F.h * F.cap));
    for (let y = 0; y < F.h; y++) {
      const d = F.h - 1 - y;
      const v = d >= R ? half : Math.round(Math.sqrt(Math.max(0, R * R - Math.pow(R - (d + 0.5), 2))));
      hw[y] = Math.min(half, Math.max(1, v));
    }
    hw[0] = Math.max(1, hw[0] - 1); // rounded bottom corners
    return hw;
  }

  function buildMask(F, hw) {
    const m = new Set();
    for (let y = 0; y < F.h; y++) for (let x = -hw[y]; x <= hw[y]; x++) m.add(key(x, y));

    const top = F.h - 1;
    // Ears overlap the dome by a row so they read as part of the creature
    // rather than as horns stuck on top.
    // Widths taper 4→1 so each ear keeps an interior pixel; a 2px-wide ear is
    // all outline and reads as a horn.
    if (F.ears === 'nubs') {
      for (const s of [-1, 1]) {
        const bx = s * (hw[top - 1] - 3);
        [4, 4, 3].forEach((n, r) => { for (let i = 0; i < n; i++) m.add(key(bx + s * i, top - 1 + r)); });
      }
    }
    if (F.ears === 'ears') {
      for (const s of [-1, 1]) {
        const bx = s * (hw[top - 1] - 3);
        [4, 4, 3, 2].forEach((n, r) => { for (let i = 0; i < n; i++) m.add(key(bx + s * i, top - 1 + r)); });
      }
    }
    if (F.crest) {
      for (const [dx, dy] of [[0, 1], [0, 2], [1, 1], [-1, 1], [1, 3]]) m.add(key(dx, top + dy));
    }
    if (F.tail) {                      // a fat comma curling off the right hip
      const bx = hw[3];
      const curl = [[0, 3], [1, 3], [1, 4], [2, 4], [2, 5], [3, 5], [3, 6], [2, 6], [1, 2]];
      for (const [dx, dy] of curl.slice(0, F.tail + 2)) m.add(key(bx + dx, dy));
    }
    return m;
  }

  // ---------------------------------------------------------------- body
  function drawMask(ctx, F, mask, ramp, isEgg) {
    const light = isEgg ? EGG.light : ramp[0];
    const mid = isEgg ? EGG.mid : ramp[1];
    const dark = isEgg ? EGG.dark : ramp[2];
    const outline = isEgg ? EGG.outline : shade(ramp[3], -0.45);

    for (const cell of mask) {
      const [x, y] = cell.split(',').map(Number);
      const edge = !mask.has(key(x + 1, y)) || !mask.has(key(x - 1, y))
        || !mask.has(key(x, y + 1)) || !mask.has(key(x, y - 1));
      if (edge) { px(ctx, x, y, outline); continue; }
      const fy = y / F.h;
      let c;
      if (fy > 0.22) c = light;
      else if (fy > 0.15) c = ((x + y) & 1) ? light : mid;   // dithered seam, clear of the face
      else if (fy > 0.07) c = mid;
      else c = dark;
      px(ctx, x, y, c);
    }

    // gloss: the classic two-pixel dot high on the left of the dome
    const gy = Math.round(F.h * 0.74), gx = -Math.round(F.w * 0.18);
    if (mask.has(key(gx, gy))) px(ctx, gx, gy, shade(light, 0.6));
    if (mask.has(key(gx + 1, gy))) px(ctx, gx + 1, gy, shade(light, 0.6));
    if (mask.has(key(gx, gy - 1))) px(ctx, gx, gy - 1, shade(light, 0.42));

    if (isEgg) { // fixed speckles — a shimmering egg would look like noise
      for (const [sx, sy] of [[-2, 12], [2, 9], [-3, 6], [3, 13], [1, 3]]) {
        if (mask.has(key(sx, sy))) px(ctx, sx, sy, EGG.speck);
      }
    }
  }

  // rim light: exactly one ring of pale pixels hugging the silhouette
  function drawRim(ctx, mask) {
    const ring = new Set();
    for (const cell of mask) {
      const [x, y] = cell.split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = key(x + dx, y + dy);
        if (!mask.has(k) && y + dy >= 0) ring.add(k);
      }
    }
    for (const cell of ring) {
      const [x, y] = cell.split(',').map(Number);
      px(ctx, x, y, '#fffdf5', 0.18);
    }
  }

  function drawGroundShadow(ctx, F, hop) {
    const squish = Math.max(0.4, 1 - hop / 40);
    const half = Math.max(1, Math.round(((F.w - 1) / 2 - 1) * squish));
    ctx.save();
    ctx.globalAlpha = 0.16 * squish;
    ctx.fillStyle = '#000';
    ctx.fillRect(-half * PX - PX / 2, FEET_Y, (half * 2 + 1) * PX, PX);
    ctx.restore();
  }

  // ---------------------------------------------------------------- face
  function drawEye(ctx, F, side, eyeY, opts, ramp) {
    const w = F.eyeW, h = F.eyeH;
    const inner = F.gap + 1;                       // first column of the eye
    const col = (i) => side * (inner + i);
    const midY = eyeY + Math.floor(h / 2);

    // The happy ^ ^ arc IS what a blink looks like, so it cannot also be the
    // resting face: a pet that is delighted most of the day would then never
    // blink and its eyes could never follow the cursor. Open eyes at rest,
    // arc on the blink — a grumpy pet squeezes flat instead of smiling.
    const smiley = opts.mood !== 'grumpy' && opts.mood !== 'sad';
    if (opts.sleeping || (opts.blink > 0.5 && smiley)) {
      for (let i = 0; i < w; i++) {
        const lift = (i === 0 || i === w - 1) ? 0 : 1;
        px(ctx, col(i), midY + lift, INK);
      }
      return;
    }
    if (opts.blink > 0.5) {
      for (let i = 0; i < w; i++) px(ctx, col(i), midY, INK);
      return;
    }

    const droop = opts.mood === 'grumpy' ? 2 : (opts.mood === 'sad' ? 1 : 0); // squint / droop
    for (let y = 0; y < h - droop; y++) {
      for (let i = 0; i < w; i++) {
        const corner = (i === 0 || i === w - 1) && (y === 0 || y === h - 1 - droop);
        if (corner) continue;                      // rounds the oval
        px(ctx, col(i), eyeY + y, INK);
      }
    }
    // a bright pixel low-inside and a dim one high-outside: wet, cute eyes
    px(ctx, col(0), eyeY + 1, '#fffdf5');
    px(ctx, col(w - 1), eyeY + h - 2 - droop, shade(ramp[1], 0.3));
    // a second glint is what separates delighted from merely awake, now that
    // both moods have open eyes
    if (opts.mood === 'happy') px(ctx, col(w - 2), eyeY + h - 2, '#fffdf5');
  }

  function drawMouth(ctx, F, opts, ramp, eyeY) {
    const y = eyeY - 1;
    const inside = mix(ramp[3], '#8a3348', 0.6);

    if (opts.mouthOpen > 0.35) {                   // eating / cheering
      rect(ctx, -1, y - 1, 3, 2, INK);
      px(ctx, 0, y - 1, inside);
      return;
    }
    if (opts.sleeping) { px(ctx, 0, y, INK); return; }
    if (opts.mood === 'sad') {                     // frown ∩
      px(ctx, -1, y, INK); px(ctx, 0, y + 1, INK); px(ctx, 1, y, INK);
      return;
    }
    if (opts.mood === 'grumpy') {                  // a flat little line
      px(ctx, -1, y, INK); px(ctx, 0, y, INK); px(ctx, 1, y, INK);
      return;
    }
    px(ctx, -1, y + 1, INK); px(ctx, 0, y, INK); px(ctx, 1, y + 1, INK); // ∪
    // A wider ∪ — properly pleased. It grows sideways along the arms of the
    // smile, never upward: one row higher and it runs into the eyes.
    if (opts.mood === 'happy') { px(ctx, -2, y + 1, INK); px(ctx, 2, y + 1, INK); }
  }

  function drawFace(ctx, F, hw, opts, ramp) {
    const eyeY = Math.round(F.h * F.eyeF);
    const track = Math.max(-1, Math.min(1, Math.round((opts.eyeTrack || 0) / 4)));
    ctx.save();
    ctx.translate(track * PX, 0);
    for (const s of [-1, 1]) drawEye(ctx, F, s, eyeY, opts, ramp);
    ctx.restore();

    if (!opts.sleeping) {                          // blush, outside each eye
      const bc = blushColor(ramp);
      const x0 = F.gap + F.eyeW + 1;
      for (const s of [-1, 1]) {
        px(ctx, s * x0, eyeY, bc, 0.9);
        px(ctx, s * (x0 + 1), eyeY, bc, 0.6);
      }
    }
    drawMouth(ctx, F, opts, ramp, eyeY);

    if (opts.sleeping) {                           // one drifting sleep bubble
      px(ctx, F.gap + F.eyeW + 3, eyeY + 2, '#ffffff', 0.75);
    }
    if (opts.mood === 'sad' && !opts.sleeping) {   // a single tear, off-eye
      px(ctx, -(F.gap + F.eyeW), eyeY - 1, '#9fd8ff', 0.9);
    }
  }

  // ---------------------------------------------------------------- accessories
  // Placement reads the silhouette (hw) so nothing floats or covers the face.
  function drawAccessory(ctx, id, F, hw, ramp, t) {
    const top = F.h - 1;                            // apex row of the dome
    const eyeY = Math.round(F.h * F.eyeF);
    const gold = '#f5c542', goldDark = '#c9992a';

    switch (id) {
      case 'bow': {                                 // on the upper-left slope
        const y = top - 2, x = -(hw[y] - 2);
        rect(ctx, x - 2, y, 2, 3, '#ff8fa8');
        rect(ctx, x + 1, y, 2, 3, '#ff8fa8');
        px(ctx, x - 2, y + 2, '#ffd0da'); px(ctx, x + 2, y + 2, '#ffd0da');
        px(ctx, x, y + 1, '#e0637f'); px(ctx, x, y, '#e0637f');
        break;
      }
      case 'sprout': {
        px(ctx, 0, top + 1, '#5aa05a'); px(ctx, 0, top + 2, '#5aa05a');
        px(ctx, 1, top + 2, '#7cc47c'); px(ctx, 2, top + 3, '#7cc47c'); px(ctx, 1, top + 3, '#7cc47c');
        break;
      }
      case 'flower': {
        const y = top - 1, x = -(hw[y] - 1);
        px(ctx, x, y, '#ffe08a');
        px(ctx, x - 1, y, '#ff9ec4'); px(ctx, x + 1, y, '#ff9ec4');
        px(ctx, x, y + 1, '#ff9ec4'); px(ctx, x, y - 1, '#ff9ec4');
        break;
      }
      case 'scarf': {                               // a collar just under the face
        const y = Math.max(2, eyeY - 2);
        for (let x = -(hw[y] - 1); x <= hw[y] - 1; x++) px(ctx, x, y, '#e0574f');
        for (let x = -(hw[y - 1] - 1); x <= hw[y - 1] - 1; x++) px(ctx, x, y - 1, '#f2726a');
        for (let i = 0; i < 3 && y - 2 - i >= 0; i++) px(ctx, hw[y] - 3, y - 2 - i, i === 2 ? '#c94a43' : '#e0574f');
        break;
      }
      case 'beret': {
        const y = top;
        for (let x = -3; x <= 3; x++) px(ctx, x, y, '#c93b3b');
        for (let x = -2; x <= 2; x++) px(ctx, x, y + 1, '#e64a4a');
        px(ctx, 2, y + 2, '#e64a4a');
        break;
      }
      case 'headphones': {
        for (let x = -2; x <= 2; x++) px(ctx, x, top + 1, INK);
        px(ctx, -3, top, INK); px(ctx, 3, top, INK);
        for (const s of [-1, 1]) {                  // cups clamped onto the head sides
          const y = Math.round(F.h * 0.55), x = s * hw[y];
          rect(ctx, s < 0 ? x : x - 1, y - 1, 2, 3, '#4a4a55');
          px(ctx, s * (hw[y] - 1), y, '#6e6e7d');
        }
        break;
      }
      case 'crown': {
        const y = top + 1;
        for (let x = -2; x <= 2; x++) px(ctx, x, y, goldDark);
        px(ctx, -2, y + 1, gold); px(ctx, 0, y + 1, gold); px(ctx, 2, y + 1, gold);
        px(ctx, 0, y + 2, '#fff0a8');
        break;
      }
      case 'wings': {                               // behind, sweeping away
        const flap = Math.round(Math.sin(t / 260));
        for (const s of [-1, 1]) {
          const y0 = Math.round(F.h * 0.30);
          const start = hw[Math.min(hw.length - 1, y0)] - 1; // bites into the body so it attaches
          const widths = [2, 3, 3, 2];                // a feather, widest mid-span
          for (let r = 0; r < widths.length; r++) {
            for (let i = 0; i < widths[r]; i++) {
              px(ctx, s * (start + i + r), y0 + r + flap, i === widths[r] - 1 ? '#e6e6f5' : '#ffffff');
            }
          }
        }
        break;
      }
      case 'halo': {
        const y = top + 3;
        for (let x = -2; x <= 2; x++) px(ctx, x, y, '#ffe98a', 0.95);
        px(ctx, -3, y - 1, '#ffe98a', 0.6); px(ctx, 3, y - 1, '#ffe98a', 0.6);
        break;
      }
      case 'wizardhat': {
        const y = top;
        for (let x = -4; x <= 4; x++) px(ctx, x, y, '#4a3d85');
        for (let x = -3; x <= 3; x++) px(ctx, x, y + 1, '#5b4b9e');
        for (let x = -2; x <= 2; x++) px(ctx, x, y + 2, '#6d5cb8');
        for (let x = -1; x <= 1; x++) px(ctx, x, y + 3, '#5b4b9e');
        px(ctx, 0, y + 4, '#5b4b9e'); px(ctx, 1, y + 5, '#ffe08a');
        break;
      }
      case 'balloon': {                             // floats beside the head, on a string
        const bob = Math.round(Math.sin(t / 700));
        const x = hw[top - 2] + 3, yTie = Math.round(F.h * 0.5), y = top + 3 + bob;
        for (let yy = yTie; yy < y - 1; yy++) px(ctx, x, yy, '#bdb6a8'); // string down to the body
        rect(ctx, x - 1, y, 3, 3, '#ff6f7d');
        px(ctx, x, y + 3, '#ff6f7d'); px(ctx, x - 1, y + 2, '#ff9aa4');
        px(ctx, x, y - 1, '#e0525f');
        break;
      }
      case 'sparkles': {
        const phase = Math.sin(t / 320) > 0 ? 0 : 1;
        const spots = [[-(hw[top - 2] + 2), top], [hw[top - 3] + 2, top - 2],
          [-(hw[4] + 2), 5], [hw[6] + 2, 7]];
        spots.forEach(([x, y], i) => {
          const on = (i % 2) === phase;
          px(ctx, x, y, '#fff8d0', on ? 1 : 0.55);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) px(ctx, x + dx, y + dy, '#ffe98a', on ? 0.95 : 0.35);
          if (on) for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) px(ctx, x + dx, y + dy, '#ffe98a', 0.5);
        });
        break;
      }
    }
  }

  const BEHIND = new Set(['wings', 'balloon']);

  // ---------------------------------------------------------------- entry
  function drawPet(ctx, opts) {
    const form = FORMS[opts.form] ? opts.form : 'hatchling';
    const F = FORMS[form];
    const ramp = opts.ramp || ['#a8e6cf', '#7bd4b2', '#4fbf96', '#2e9c78'];
    const t = opts.t || 0;
    const hop = opts.hop || 0;
    const isEgg = form === 'egg';

    drawGroundShadow(ctx, F, hop);

    ctx.save();
    // Motion is quantised to whole art pixels: a pixel sprite that slides by
    // half a pixel stops being a pixel sprite. Tilt leans instead of rotating
    // for the same reason.
    const lean = Math.round((opts.tilt || 0) * 10);
    // Breathing, always — an idle pet that holds perfectly still reads as a
    // frozen screenshot. Awake it is slower and shallower than asleep, and it
    // rounds to a whole art pixel, so it shows as one unhurried rise and fall.
    const breathe = opts.sleeping
      ? Math.round(Math.sin(t / 1100) * 0.7)
      : Math.round(Math.sin(t / 2300) * 0.62);
    const rise = Math.round(hop / PX);
    ctx.translate(lean * PX, -(rise + breathe) * PX);

    const hw = halfWidths(F);
    const mask = buildMask(F, hw);
    // Negative squash is a STRETCH. It used to fall through to `mask`, which
    // is why waking up and stretching were animations that played as pauses.
    const squashRows = Math.round((opts.squash || 0) * 3);
    const drawn = squashRows > 0 ? squashMask(mask, squashRows)
      : squashRows < 0 ? stretchMask(mask, -squashRows)
        : mask;

    if (opts.glow) drawRim(ctx, drawn);
    if (BEHIND.has(opts.accessory)) drawAccessory(ctx, opts.accessory, F, hw, ramp, t);
    drawMask(ctx, F, drawn, ramp, isEgg);

    ctx.save();
    if (squashRows !== 0) ctx.translate(0, squashRows * PX); // the face rides the squash — and the stretch
    drawFace(ctx, F, hw, opts, ramp);
    if (opts.accessory && !BEHIND.has(opts.accessory)) {
      drawAccessory(ctx, opts.accessory, F, hw, ramp, t);
    }
    ctx.restore();
    ctx.restore();
  }

  // Squash: drop the top rows and splat the base outward, all on the grid.
  function squashMask(mask, rows) {
    const out = new Set();
    let maxY = 0;
    for (const cell of mask) maxY = Math.max(maxY, Number(cell.split(',')[1]));
    for (const cell of mask) {
      const [x, y] = cell.split(',').map(Number);
      if (y > maxY - rows) continue;
      out.add(key(x, y));
      if (y <= 1) { out.add(key(x - 1, y)); out.add(key(x + 1, y)); }
    }
    return out;
  }

  // Stretch: the mirror of squash. The feet stay planted and everything above
  // lifts, with the seam row repeated to fill the gap — a taller, thinner
  // creature rather than one that has quietly levitated.
  function stretchMask(mask, rows) {
    const out = new Set();
    for (const cell of mask) {
      const [x, y] = cell.split(',').map(Number);
      if (y <= 1) { out.add(key(x, y)); continue; }
      out.add(key(x, y + rows));
      if (y === 2) for (let r = 0; r < rows; r++) out.add(key(x, y + r));
    }
    return out;
  }

  const PetArt = { drawPet, GEOM, FEET_Y, PX, LAYOUT, boxHeight, shade, bodyColor };
  if (typeof module !== 'undefined' && module.exports) module.exports = PetArt;
  else global.PetArt = PetArt;

})(typeof window !== 'undefined' ? window : globalThis);
