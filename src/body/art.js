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
  // Eyes are BIG — they are most of what makes the thing cute, and a 3×4 eye
  // has no room for a catchlight that reads as one.
  const FORMS = {
    egg:       { w: 13, h: 17, cap: 0.95, shape: 'egg', ears: 'none', crest: null, tail: 0, eyeW: 2, eyeH: 3, gap: 2, eyeF: 0.40 },
    hatchling: { w: 17, h: 12, cap: 0.85, ears: 'none', crest: null, tail: 0, eyeW: 4, eyeH: 5, gap: 1, eyeF: 0.40 },
    junior:    { w: 19, h: 14, cap: 0.80, ears: 'nubs', crest: null, tail: 0, eyeW: 4, eyeH: 5, gap: 2, eyeF: 0.40 },
    senior:    { w: 23, h: 16, cap: 0.75, ears: 'ears', crest: null, tail: 5, eyeW: 5, eyeH: 6, gap: 2, eyeF: 0.36 },
    elder:     { w: 25, h: 19, cap: 0.70, ears: 'ears', crest: 'tuft', tail: 7, eyeW: 5, eyeH: 6, gap: 2, eyeF: 0.36 },
    // The two forms past 25 levels of feeding. They must read as growth at a
    // glance and not merely as "elder again, bigger": one goes TALL and slim
    // with long ears, the other keeps the elder's build and grows a crest.
    principal: { w: 21, h: 24, cap: 0.55, ears: 'long', crest: null, tail: 7, eyeW: 5, eyeH: 6, gap: 2, eyeF: 0.30 },
    legend:    { w: 25, h: 22, cap: 0.70, ears: 'ears', crest: 'mane', tail: 7, eyeW: 5, eyeH: 6, gap: 2, eyeF: 0.32 }
  };

  const TOP_EXTRA = { none: 0, nubs: 3, ears: 4, long: 5 }; // silhouette above the dome

  // Crests, in art pixels above the crown. The elder's punk tuft leans right
  // on purpose; the legend's mane is the same idea grown into a fin.
  const CRESTS = {
    tuft: [[0, 1], [0, 2], [1, 1], [-1, 1], [1, 3]],
    // Two prongs off a common base, the taller one leaning with the tuft it
    // grew from. A smooth triangle here just reads as a pointed hat.
    mane: [[-3, 1], [-2, 1], [-1, 1], [0, 1], [1, 1], [2, 1],
      [-3, 2], [-2, 2], [0, 2], [1, 2],
      [-3, 3], [-2, 3], [0, 3], [1, 3],
      [0, 4], [1, 4],
      [0, 5], [1, 5]]
  };
  // …measured, never declared twice: a crest that reached one row past the
  // number next to it would poke through the top of its own window.
  const crestH = (F) => (CRESTS[F.crest] || []).reduce((h, c) => Math.max(h, c[1]), 0);

  const GEOM = {}; // logical box per form — the speech bubble anchors off this
  for (const [name, F] of Object.entries(FORMS)) {
    GEOM[name] = { w: F.w * PX, h: (F.h + TOP_EXTRA[F.ears] + crestH(F)) * PX };
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
    footRoom: 30,     // under the feet — the pet's own stats pill sits in here
    sessionLine: 20,  // …plus one of these per session line shown below it
    maxLines: 4,      // …up to here; past that the last line says "+N more"
    headGap: 14,      // logical units of air between the head and the tail
    bubbleRoom: 74    // above that: three lines of speech, its border and shadow
  };
  // How far above the window's bottom edge the feet stand. It GROWS with the
  // per-session lines, so the box is only ever as tall as what it holds.
  function footRoom(lines) {
    const n = Math.max(0, Math.min(LAYOUT.maxLines, Math.round(lines || 0)));
    return LAYOUT.footRoom + n * LAYOUT.sessionLine;
  }
  function boxHeight(form, scale, lines) {
    const g = GEOM[form] || GEOM.hatchling;
    return Math.round(footRoom(lines) + (g.h + LAYOUT.headGap) * (scale || 1) + LAYOUT.bubbleRoom);
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
    const idx = { hatchling: 0, junior: 1, senior: 2, elder: 3, principal: 3, legend: 3 }[form];
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
    // Long ears: attached two rows further down the dome, so they spring from
    // the shoulders rather than clustering on the crown, and never narrower
    // than 3 until the tip — a 2-wide ear is all outline and reads as wire.
    if (F.ears === 'long') {
      for (const s of [-1, 1]) {
        const bx = s * (hw[top - 2] - 3);
        [4, 4, 3, 3, 3, 3, 2, 1].forEach((n, r) => {
          for (let i = 0; i < n; i++) m.add(key(bx + s * i, top - 2 + r));
        });
      }
    }
    // The crest, drawn cell by cell rather than generated: these are five and
    // sixteen pixels, and a formula that produced a pleasing tuft AND a
    // pleasing mane would be longer than both put together.
    for (const [dx, dy] of CRESTS[F.crest] || []) m.add(key(dx, top + dy));
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
  // The eye's ink, as a rounded slab. Corners come off only when there is
  // enough eye left for the result to still read as an oval: cutting all four
  // corners off a 3-wide eye produces a plus sign, which is precisely what the
  // face used to wear. [lesson: seen at 3× on a contact sheet, not reasoned]
  function eyeCells(w, h) {
    const cells = [];
    for (let y = 0; y < h; y++) {
      for (let i = 0; i < w; i++) {
        const endCol = i === 0 || i === w - 1;
        const endRow = y === 0 || y === h - 1;
        if (endCol && (w >= 4 ? endRow : y === h - 1)) continue;
        cells.push([i, y]);
      }
    }
    return cells;
  }

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
    const eh = h - droop;
    for (const [i, y] of eyeCells(w, eh)) px(ctx, col(i), eyeY + y, INK);

    // The shine. This is the whole difference between a black bean and an
    // eye: one big square catchlight high in the pupil, and a small cool one
    // low on the far side, so the eye reads as wet and round.
    // …centred on the narrowest eye, where an off-centre highlight stops
    // reading as a highlight and starts reading as an eyebrow.
    const hx = w >= 3 ? 1 : 0;
    const hy = eyeY + eh - 3;
    // A squinted eye is too small to hold the big one — it would be more
    // catchlight than pupil, which reads as startled rather than grumpy.
    if (eh >= 5) {
      for (const dx of [0, 1]) for (const dy of [0, 1]) px(ctx, col(hx + dx), hy + dy, '#fffdf5');
    } else {
      px(ctx, col(hx), eyeY + eh - 2, '#fffdf5');
    }
    // Delighted is that second catchlight going bright — a THIRD one just
    // makes a busy eye, since both bottom corners are then spoken for.
    px(ctx, col(w - 1), eyeY + 1,
      opts.mood === 'happy' ? '#fffdf5' : mix(ramp[0], '#ffffff', 0.6), 0.9);
  }

  function drawMouth(ctx, F, opts, ramp, eyeY) {
    // TWO rows below the eyes, never one: the smile's arms rise a row, and on
    // the row directly under an eye they fuse with it into a single black
    // moustache. That is what the face has always done at 4×.
    const y = eyeY - 2;
    // …and for the same reason the wide grin only opens up on forms with a
    // face big enough to hold it. On the egg, five pixels of smile under two
    // dot eyes is not a smile, it is one zigzag band across the whole face.
    const wide = F.gap >= 2 && F.eyeW >= 4;
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
    if (opts.mood === 'happy' && wide) {
      // A proper grin: a flat floor with the corners turned up. Widening the
      // little ∨ instead leaves a hole under its centre, and four pixels with
      // a hole in the middle read as two small marks, not one big smile.
      px(ctx, -1, y, INK); px(ctx, 0, y, INK); px(ctx, 1, y, INK);
      px(ctx, -2, y + 1, INK); px(ctx, 2, y + 1, INK);
      return;
    }
    px(ctx, -1, y + 1, INK); px(ctx, 0, y, INK); px(ctx, 1, y + 1, INK); // ∪
  }

  function drawFace(ctx, F, hw, opts, ramp) {
    const eyeY = Math.round(F.h * F.eyeF);
    const track = Math.max(-1, Math.min(1, Math.round((opts.eyeTrack || 0) / 4)));
    ctx.save();
    ctx.translate(track * PX, 0);
    for (const s of [-1, 1]) drawEye(ctx, F, s, eyeY, opts, ramp);
    ctx.restore();

    if (!opts.sleeping) {
      // Cheeks: one row BELOW the eyes, level with the smile, and clamped
      // inside the silhouette. Beside them (the old row) they had to dodge a
      // wider eye on the narrow forms and ended up on the outline itself.
      const bc = blushColor(ramp);
      const row = Math.max(0, eyeY - 1);
      const edge = hw[Math.min(hw.length - 1, row)] - 1;
      const x0 = Math.min(F.gap + F.eyeW + 1, edge);
      for (const s of [-1, 1]) {
        px(ctx, s * x0, row, bc, 0.9);
        if (x0 + 1 <= edge) px(ctx, s * (x0 + 1), row, bc, 0.6);
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
        // -3, not -2: the mouth sits two rows under the eyes, and a scarf
        // through the smile is not a scarf.
        const y = Math.max(2, eyeY - 3);
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
        // +1, not +2: the spokes reach two pixels further still, and on the
        // widest form that put the outermost one past the window edge at 2.5×.
        const spots = [[-(hw[top - 2] + 1), top], [hw[top - 3] + 1, top - 2],
          [-(hw[4] + 1), 5], [hw[6] + 1, 7]];
        spots.forEach(([x, y], i) => {
          const on = (i % 2) === phase;
          px(ctx, x, y, '#fff8d0', on ? 1 : 0.55);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) px(ctx, x + dx, y + dy, '#ffe98a', on ? 0.95 : 0.35);
          if (on) for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) px(ctx, x + dx, y + dy, '#ffe98a', 0.5);
        });
        break;
      }

      // ---- lv.11 and up: one per level, all the way to 25 ----------------
      case 'bell': {                                // collar, bell under the chin
        const y = Math.max(1, eyeY - 3);
        for (let x = -(hw[y] - 1); x <= hw[y] - 1; x++) px(ctx, x, y, '#c0392b');
        rect(ctx, -1, y, 3, 2, gold);
        px(ctx, 1, y + 1, '#fff3c4');
        px(ctx, 0, y, INK);                         // the slit
        break;
      }
      case 'catears': {                             // perked, pink inside
        for (const s of [-1, 1]) {
          const bx = s * (hw[top - 1] - 2);
          [4, 3, 2, 1].forEach((n, r) => {
            for (let i = 0; i < n; i++) px(ctx, bx + s * i, top + r, INK);
          });
          px(ctx, bx + s, top, '#ff9ec4'); px(ctx, bx + s, top + 1, '#ff9ec4');
        }
        break;
      }
      case 'laurel': {                              // leaves up both temples
        for (const s of [-1, 1]) {
          for (let i = 0; i < 5; i++) {
            const y = top - 1 - i;
            if (y < 1) break;
            px(ctx, s * (hw[y] - 1), y, i % 2 ? '#7cb342' : '#aed581');
          }
          px(ctx, s * (hw[top - 1] - 2), top, '#c8e6a0');
        }
        break;
      }
      case 'tophat': {
        const y = top;
        for (let x = -4; x <= 4; x++) px(ctx, x, y + 1, INK);        // brim
        rect(ctx, -2, y + 2, 5, 4, '#33333d');                       // crown
        for (let x = -2; x <= 2; x++) px(ctx, x, y + 2, '#b03030');   // band
        px(ctx, -2, y + 4, '#565663'); px(ctx, -2, y + 5, '#565663'); // a shine
        break;
      }
      case 'mushroom': {                            // a red cap with white spots
        for (let x = -4; x <= 4; x++) px(ctx, x, top + 1, '#b83838');
        for (let x = -3; x <= 3; x++) px(ctx, x, top + 2, '#d64545');
        for (let x = -2; x <= 2; x++) px(ctx, x, top + 3, '#e05555');
        for (let x = -1; x <= 1; x++) px(ctx, x, top + 4, '#e05555');
        px(ctx, -2, top + 2, '#fff3e0'); px(ctx, 2, top + 3, '#fff3e0');
        px(ctx, 0, top + 2, '#fff3e0'); px(ctx, 3, top + 1, '#fff3e0');
        break;
      }
      case 'gradcap': {
        const y = top;
        rect(ctx, -1, y + 1, 3, 2, '#2f2f38');                       // the skull cap
        for (let x = -4; x <= 4; x++) px(ctx, x, y + 3, INK);        // the board
        px(ctx, 0, y + 4, '#2f2f38');
        for (let i = 0; i < 3; i++) px(ctx, 4, y + 2 - i, gold);     // tassel
        px(ctx, 4, y - 1, goldDark);
        break;
      }
      case 'horns': {                               // two little bone horns
        for (const s of [-1, 1]) {
          const bx = s * (hw[top - 1] - 1);
          px(ctx, bx, top, '#f0e4cc'); px(ctx, bx, top + 1, '#f0e4cc');
          px(ctx, bx + s, top + 2, '#dcc9a4');
        }
        break;
      }
      case 'cape': {                                // behind, flaring to the floor
        const y0 = Math.min(hw.length - 1, Math.round(F.h * 0.62));
        for (const s of [-1, 1]) {
          for (let y = 0; y <= y0; y++) {
            const flare = 1 + Math.round((y0 - y) / 4);   // …and no wider: see the window test
            const base = hw[Math.min(y, hw.length - 1)];
            for (let i = 0; i < flare; i++) {
              px(ctx, s * (base + i), y, i === flare - 1 ? '#7a1f2b' : '#b3283c');
            }
          }
        }
        for (let x = -(hw[y0] - 1); x <= hw[y0] - 1; x++) px(ctx, x, y0 + 1, '#b3283c'); // collar
        break;
      }
      case 'propeller': {
        const y = top;
        for (let x = -2; x <= 2; x++) px(ctx, x, y + 1, '#3f7cc9');
        for (let x = -1; x <= 1; x++) px(ctx, x, y + 2, '#5b9ae0');
        px(ctx, 0, y + 3, '#b9bfc7');
        // The blade is foreshortened rather than rotated — a pixel blade that
        // spins is a blade that changes length.
        const len = 1 + Math.round(Math.abs(Math.sin(t / 190)) * 2);
        for (let i = 1; i <= len; i++) {
          px(ctx, i, y + 4, '#e05555');
          px(ctx, -i, y + 4, '#f2f2f2');
        }
        px(ctx, 0, y + 4, '#8f959d');
        break;
      }
      case 'flame': {
        const lick = Math.sin(t / 170) > 0;
        for (let x = -1; x <= 1; x++) px(ctx, x, top + 1, '#ff8f2e');
        px(ctx, 0, top + 2, '#ffb74d'); px(ctx, lick ? 1 : -1, top + 2, '#ff8f2e');
        px(ctx, 0, top + 3, '#ffe082');
        if (lick) px(ctx, 0, top + 4, '#fff3c4');
        break;
      }
      case 'moon': {                                // a crescent, drifting
        const bob = Math.round(Math.sin(t / 760));
        const x = hw[top - 2] + 3, y = top + bob;
        for (const [dx, dy] of [[0, 0], [0, 1], [0, 2], [1, 3], [1, -1]]) px(ctx, x + dx, y + dy, '#ffe98a');
        px(ctx, x + 1, y + 1, '#fff6c8', 0.45);
        break;
      }
      case 'jetpack': {                             // behind, with thrust
        const y0 = Math.min(hw.length - 1, Math.round(F.h * 0.34));
        const puff = Math.sin(t / 110) > 0 ? 2 : 1;
        for (const s of [-1, 1]) {
          // OUTSIDE the silhouette: this is drawn before the body, so a tank
          // flush with the outline is a tank nobody ever sees.
          const x = s * (hw[y0] + 1);
          for (let r = 0; r < 4; r++) px(ctx, x, y0 + r, r === 3 ? '#cfd4da' : '#8a8f98');
          px(ctx, x - s, y0 + 3, '#8a8f98');           // a strap onto the shoulder
          for (let i = 1; i <= puff; i++) {
            px(ctx, x, y0 - i, i === 1 ? '#ffb300' : '#ff7043', i === 2 ? 0.8 : 1);
          }
        }
        break;
      }
      case 'rainbow': {                             // an arc over the head
        const bands = ['#e05555', '#f0a04b', '#7cc47c', '#5b9ae0'];
        for (let b = 0; b < bands.length; b++) {
          const R = 5 - b;
          for (let i = 0; i <= 10; i++) {
            const a = Math.PI * (i / 10);
            px(ctx, Math.round(-Math.cos(a) * R), top + 1 + Math.round(Math.sin(a) * R), bands[b]);
          }
        }
        break;
      }
      case 'orbit': {                               // a little world going round
        const a = t / 900;
        const R = hw[top - 2] + 4;
        const x = Math.round(Math.cos(a) * R), y = top + 1 + Math.round(Math.sin(a) * 2);
        rect(ctx, x - 1, y, 2, 2, '#6fa8dc');
        px(ctx, x - 1, y + 1, '#a9cdf0');
        px(ctx, x - 2, y, '#c9d9e8', 0.7); px(ctx, x + 2, y + 1, '#c9d9e8', 0.7);
        break;
      }
      case 'galaxy': {                              // the lv.25 trophy
        // A ring of real stars, not more sparkles: each is a four-point
        // twinkle with a violet halo, and the whole ring turns.
        const R = hw[top - 2] + 3;
        for (let i = 0; i < 5; i++) {
          const a = t / 1600 + (i * Math.PI * 2) / 5;
          const x = Math.round(Math.cos(a) * R), y = top + 2 + Math.round(Math.sin(a) * 3);
          const bright = Math.sin(t / 300 + i * 1.7) > -0.2;
          px(ctx, x, y, '#fff8d0');
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            px(ctx, x + dx, y + dy, bright ? '#ffe98a' : '#c9b3f0', bright ? 0.95 : 0.5);
          }
          if (bright) for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) px(ctx, x + dx, y + dy, '#c9b3f0', 0.45);
        }
        break;
      }
    }
  }

  const BEHIND = new Set(['wings', 'balloon', 'cape', 'jetpack']);

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

  const PetArt = { drawPet, GEOM, FEET_Y, PX, LAYOUT, footRoom, boxHeight, shade, bodyColor };
  if (typeof module !== 'undefined' && module.exports) module.exports = PetArt;
  else global.PetArt = PetArt;

})(typeof window !== 'undefined' ? window : globalThis);
