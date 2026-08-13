'use strict';
// All art is generated in code — no sprite files. Draws into a 2D canvas.
// Pure drawing: no Electron, no IPC, no game logic. Also powers the static
// mockup page, so it must run in a plain browser.
//
// Contract constraints (paid for in a previous build):
// - every form is a different SILHOUETTE, never a recolor
// - the face is sacred: nothing covers it
// - accessories sit off the face; wings sweep away from the body
// - glow = rim light hugging the sprite + small ground shadow, no radial cloud
// - eyes track horizontally only

(function (global) {

  // Logical space: 120 wide × 130 tall, feet line at y=112.
  const FEET_Y = 112;

  const GEOM = {
    egg:       { w: 46, h: 58, earNubs: false, ears: false, crest: false, tail: false, belly: false, eyeR: 3.2, eyeDX: 8,  eyeYFrac: 0.48, mouthYFrac: 0.62 },
    hatchling: { w: 44, h: 40, earNubs: false, ears: false, crest: false, tail: false, belly: false, eyeR: 4.6, eyeDX: 9,  eyeYFrac: 0.42, mouthYFrac: 0.66 },
    junior:    { w: 48, h: 56, earNubs: true,  ears: false, crest: false, tail: false, belly: false, eyeR: 4.6, eyeDX: 10, eyeYFrac: 0.34, mouthYFrac: 0.52 },
    senior:    { w: 56, h: 66, earNubs: false, ears: true,  crest: false, tail: true,  belly: true,  eyeR: 4.8, eyeDX: 11, eyeYFrac: 0.30, mouthYFrac: 0.46 },
    elder:     { w: 58, h: 78, earNubs: false, ears: true,  crest: true,  tail: true,  belly: true,  eyeR: 4.4, eyeDX: 11, eyeYFrac: 0.26, mouthYFrac: 0.40 }
  };

  const EGG_COLORS = { base: '#f3ead8', shade: '#d9cbb0', speckle: '#c4b18d', outline: '#8f7f63' };

  // ---------------------------------------------------------------- utils
  function shade(hex, f) { // f<0 darken, f>0 lighten
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    else { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  function bodyColor(form, ramp) {
    const idx = { hatchling: 0, junior: 1, senior: 2, elder: 3 }[form];
    return idx === undefined ? EGG_COLORS.base : ramp[idx];
  }

  // Body silhouette path (also used for glow rim + clipping).
  function bodyPath(ctx, form, g) {
    const w = g.w, h = g.h, topY = FEET_Y - h;
    ctx.beginPath();
    if (form === 'egg') {
      ctx.ellipse(0, FEET_Y - h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      return;
    }
    // Rounded blob: wider at the bottom, softly domed top.
    const bottomW = w / 2, topW = w / 2 * (form === 'hatchling' ? 0.92 : 0.78);
    ctx.moveTo(-bottomW, FEET_Y - h * 0.18);
    ctx.quadraticCurveTo(-bottomW - 2, FEET_Y, -bottomW * 0.55, FEET_Y);
    ctx.lineTo(bottomW * 0.55, FEET_Y);
    ctx.quadraticCurveTo(bottomW + 2, FEET_Y, bottomW, FEET_Y - h * 0.18);
    ctx.quadraticCurveTo(bottomW + 1, topY + h * 0.22, topW, topY + h * 0.10);
    ctx.quadraticCurveTo(topW * 0.6, topY, 0, topY);
    ctx.quadraticCurveTo(-topW * 0.6, topY, -topW, topY + h * 0.10);
    ctx.quadraticCurveTo(-bottomW - 1, topY + h * 0.22, -bottomW, FEET_Y - h * 0.18);
    ctx.closePath();
  }

  // ---------------------------------------------------------------- pieces
  function drawGroundShadow(ctx, g, hop) {
    const squish = Math.max(0.45, 1 - hop / 40);
    ctx.save();
    ctx.globalAlpha = 0.18 * squish;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, FEET_Y + 4, (g.w / 2 + 4) * squish, 5 * squish, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawTail(ctx, form, g, base, outline, t) {
    if (!g.tail) return;
    const sway = Math.sin(t / 900) * 0.15;
    ctx.save();
    ctx.translate(g.w / 2 - 4, FEET_Y - g.h * 0.28);
    ctx.rotate(sway);
    ctx.beginPath();
    const len = form === 'elder' ? 26 : 18;
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.9, 2, len, -len * 0.55);
    ctx.quadraticCurveTo(len * 1.05, -len * 0.85, len * 0.72, -len * 0.8);
    ctx.quadraticCurveTo(len * 0.55, -len * 0.35, 0, 6);
    ctx.closePath();
    ctx.fillStyle = base;
    ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = outline; ctx.stroke();
    ctx.restore();
  }

  function drawEars(ctx, form, g, base, outline) {
    const topY = FEET_Y - g.h;
    if (g.earNubs) {
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * g.w * 0.28, topY + 3, 6, 9, s * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = base; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = outline; ctx.stroke();
      }
    }
    if (g.ears) {
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * g.w * 0.16, topY + 6);
        ctx.quadraticCurveTo(s * g.w * 0.42, topY - 14, s * g.w * 0.46, topY + 2);
        ctx.quadraticCurveTo(s * g.w * 0.42, topY + 9, s * g.w * 0.16, topY + 9);
        ctx.closePath();
        ctx.fillStyle = base; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = outline; ctx.stroke();
      }
    }
    if (g.crest) {
      ctx.beginPath();
      ctx.moveTo(-2, topY + 2);
      ctx.quadraticCurveTo(-6, topY - 12, 4, topY - 16);
      ctx.quadraticCurveTo(2, topY - 8, 6, topY - 2);
      ctx.closePath();
      ctx.fillStyle = base; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = outline; ctx.stroke();
      ctx.beginPath();
      ctx.arc(4, topY - 16, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = base; ctx.fill(); ctx.strokeStyle = outline; ctx.stroke();
    }
  }

  function drawBody(ctx, form, g, ramp, glowOn) {
    const base = form === 'egg' ? EGG_COLORS.base : bodyColor(form, ramp);
    const outline = form === 'egg' ? EGG_COLORS.outline : shade(ramp[3], -0.35);

    if (glowOn) { // rim light hugging the sprite — never a radial cloud
      ctx.save();
      bodyPath(ctx, form, g);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(255,255,240,0.55)';
      ctx.shadowColor = 'rgba(255,255,220,0.8)';
      ctx.shadowBlur = 7;
      ctx.stroke();
      ctx.restore();
    }

    bodyPath(ctx, form, g);
    ctx.fillStyle = base;
    ctx.fill();

    // soft top highlight + bottom shade, clipped to the body
    ctx.save();
    bodyPath(ctx, form, g);
    ctx.clip();
    const topY = FEET_Y - g.h;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = shade(form === 'egg' ? EGG_COLORS.base : base, 0.45);
    ctx.beginPath();
    ctx.ellipse(-g.w * 0.12, topY + g.h * 0.24, g.w * 0.34, g.h * 0.20, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = form === 'egg' ? EGG_COLORS.shade : shade(base, -0.4);
    ctx.beginPath();
    ctx.ellipse(0, FEET_Y + 2, g.w * 0.55, g.h * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    if (form === 'egg') {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = EGG_COLORS.speckle;
      for (const [sx, sy, r] of [[-10, -34, 2], [8, -42, 1.6], [13, -22, 2.2], [-14, -16, 1.5], [2, -10, 1.8]]) {
        ctx.beginPath(); ctx.ellipse(sx, FEET_Y + sy, r, r * 1.3, 0.4, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    ctx.save();
    bodyPath(ctx, form, g);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = outline;
    ctx.stroke();
    ctx.restore();

    if (g.belly) {
      const bw = g.w * 0.30, bh = g.h * 0.30;
      ctx.beginPath();
      ctx.ellipse(0, FEET_Y - bh * 0.72, bw, bh, 0, 0, Math.PI * 2);
      ctx.fillStyle = shade(base, 0.5);
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // stubby feet
    if (form !== 'egg') {
      ctx.fillStyle = shade(base, -0.18);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * g.w * 0.22, FEET_Y - 1, 7, 4.5, 0, 0, Math.PI);
        ctx.fill();
      }
    }
    return { base, outline };
  }

  // ---------------------------------------------------------------- face
  // The face is sacred. Eyes track horizontally ONLY.
  function drawFace(ctx, form, g, opts) {
    const { eyeTrack = 0, blink = 0, sleeping = false, mood = 'neutral' } = opts;
    const topY = FEET_Y - g.h;
    const eyeY = topY + g.h * g.eyeYFrac;
    const mouthY = topY + g.h * g.mouthYFrac;
    const px = Math.max(-1, Math.min(1, eyeTrack)) * 2.4; // horizontal only

    for (const s of [-1, 1]) {
      const ex = s * g.eyeDX;
      if (sleeping || blink > 0.85) {
        ctx.beginPath();
        ctx.moveTo(ex - g.eyeR, eyeY);
        ctx.quadraticCurveTo(ex, eyeY + g.eyeR * 0.9, ex + g.eyeR, eyeY);
        ctx.lineWidth = 2; ctx.lineCap = 'round';
        ctx.strokeStyle = '#3a3330'; ctx.stroke();
        continue;
      }
      const openness = 1 - blink;
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, g.eyeR, g.eyeR * 1.15 * openness, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 1.4; ctx.strokeStyle = '#3a3330'; ctx.stroke();
      ctx.beginPath();
      const grumpy = mood === 'grumpy';
      ctx.ellipse(ex + px, eyeY + (grumpy ? 0.6 : 0), g.eyeR * 0.52, g.eyeR * 0.62 * openness, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#2b2320'; ctx.fill();
      ctx.beginPath();
      ctx.arc(ex + px - g.eyeR * 0.16, eyeY - g.eyeR * 0.2, g.eyeR * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      if (grumpy) { // flat upper lid
        ctx.beginPath();
        ctx.moveTo(ex - g.eyeR, eyeY - g.eyeR * 0.55);
        ctx.lineTo(ex + g.eyeR, eyeY - g.eyeR * 0.75);
        ctx.lineWidth = 2; ctx.strokeStyle = '#3a3330'; ctx.stroke();
      }
    }

    // mouth: tiny arc; happy up, grumpy down
    ctx.beginPath();
    const mw = form === 'egg' ? 3.5 : 5;
    if (opts.mouthOpen) {
      ctx.ellipse(0, mouthY + 1, mw * 0.8, mw * 0.9, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#6b3f3a'; ctx.fill();
    } else if (mood === 'happy') {
      ctx.arc(0, mouthY - 1.5, mw, Math.PI * 0.2, Math.PI * 0.8);
      ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.strokeStyle = '#3a3330'; ctx.stroke();
    } else if (mood === 'grumpy') {
      ctx.arc(0, mouthY + 3.5, mw, Math.PI * 1.2, Math.PI * 1.8);
      ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.strokeStyle = '#3a3330'; ctx.stroke();
    } else {
      ctx.moveTo(-mw * 0.7, mouthY); ctx.quadraticCurveTo(0, mouthY + 1.6, mw * 0.7, mouthY);
      ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.strokeStyle = '#3a3330'; ctx.stroke();
    }

    // blush
    if (form !== 'egg' && mood === 'happy' && !sleeping) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#ff8f8f';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * (g.eyeDX + g.eyeR + 2.5), eyeY + g.eyeR * 1.1, 3.4, 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // elder whiskers — swept away from the face, never over it
    if (form === 'elder' && !sleeping) {
      ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(58,51,48,0.65)';
      for (const s of [-1, 1]) {
        for (const dy of [0, 3]) {
          ctx.beginPath();
          ctx.moveTo(s * (g.eyeDX + g.eyeR + 3), mouthY - 2 + dy);
          ctx.quadraticCurveTo(s * (g.w * 0.62), mouthY - 4 + dy * 1.6, s * (g.w * 0.72), mouthY - 1 + dy * 2);
          ctx.stroke();
        }
      }
    }
  }

  // ---------------------------------------------------------------- accessories
  // All positioned OFF the face: top of head, side, neck, back, or floating.
  function drawAccessory(ctx, id, form, g, ramp, t) {
    if (!id || form === 'egg') return; // eggs wear nothing
    const topY = FEET_Y - g.h;
    const w = g.w;
    const accent = ramp ? ramp[3] : '#c0392b';
    const o = '#5c4a3d';
    ctx.save();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = o;
    switch (id) {
      case 'bow': { // side of head-top
        ctx.translate(w * 0.26, topY + 2);
        ctx.rotate(-0.25);
        ctx.fillStyle = '#ff6f91';
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.quadraticCurveTo(s * 9, -7, s * 10, 0);
          ctx.quadraticCurveTo(s * 9, 6, 0, 1.5);
          ctx.closePath(); ctx.fill(); ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(0, 0.5, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        break;
      }
      case 'sprout': { // top of head
        ctx.translate(0, topY + 1);
        ctx.strokeStyle = '#3d8b40'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(1, -6, 0, -9); ctx.stroke();
        ctx.fillStyle = '#66bb6a';
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.ellipse(s * 4.5, -10, 5, 2.8, s * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'flower': { // side of head
        ctx.translate(-w * 0.30, topY + 4);
        ctx.fillStyle = '#ffd54f';
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          ctx.beginPath();
          ctx.ellipse(Math.cos(a) * 5, Math.sin(a) * 5, 3.4, 2.2, a, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#ff7043';
        ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'scarf': { // snug band low on the body, tail flapping to the side
        const y = FEET_Y - g.h * (form === 'hatchling' ? 0.36 : 0.32);
        ctx.fillStyle = '#e05d5d';
        ctx.beginPath();
        ctx.moveTo(-w * 0.31, y);
        ctx.quadraticCurveTo(0, y + 4.5, w * 0.31, y);
        ctx.lineTo(w * 0.30, y + 5);
        ctx.quadraticCurveTo(0, y + 9.5, -w * 0.30, y + 5);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.save();
        ctx.translate(-w * 0.22, y + 6);
        ctx.rotate(0.4);
        ctx.beginPath();
        ctx.moveTo(-2.6, 0); ctx.lineTo(2.6, 0); ctx.lineTo(3.2, 10);
        ctx.quadraticCurveTo(0, 12, -3.2, 10);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();
        break;
      }
      case 'beret': { // tilted on top — never over the eyes
        ctx.translate(-w * 0.13, topY);
        ctx.rotate(-0.2);
        ctx.fillStyle = '#e64a4a';
        ctx.beginPath(); ctx.ellipse(0, -2, w * 0.32, 8, 0, Math.PI * 1.02, Math.PI * -0.02); ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#8f2626'; ctx.stroke();
        ctx.beginPath(); ctx.arc(0, -10.5, 2.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        break;
      }
      case 'headphones': { // band over the top, cups on the SIDES
        ctx.strokeStyle = '#455a64'; ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, topY + g.h * 0.30, w * 0.44, Math.PI * 1.12, Math.PI * 1.88);
        ctx.stroke();
        ctx.fillStyle = '#546e7a';
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.ellipse(s * w * 0.44, topY + g.h * 0.30, 4.5, 7, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 1.5; ctx.strokeStyle = '#37474f'; ctx.stroke();
        }
        break;
      }
      case 'crown': { // small, sits on top
        ctx.translate(0, topY - 1);
        ctx.fillStyle = '#ffca28';
        ctx.beginPath();
        ctx.moveTo(-9, 0); ctx.lineTo(-9, -7); ctx.lineTo(-4.5, -2.5); ctx.lineTo(0, -8);
        ctx.lineTo(4.5, -2.5); ctx.lineTo(9, -7); ctx.lineTo(9, 0);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#c79a00'; ctx.stroke();
        ctx.fillStyle = '#ef5350';
        ctx.beginPath(); ctx.arc(0, -1.5, 1.6, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'wings': { // sweep AWAY from the body — hugging reads as earmuffs
        const flap = Math.sin(t / 420) * 0.18;
        const y = topY + g.h * 0.42;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.strokeStyle = '#9fb4c7';
        for (const s of [-1, 1]) {
          ctx.save();
          ctx.translate(s * w * 0.46, y);
          ctx.rotate(s * (0.55 + flap));
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.quadraticCurveTo(s * 20, -16, s * 30, -8);
          ctx.quadraticCurveTo(s * 22, -4, s * 24, 2);
          ctx.quadraticCurveTo(s * 14, 2, s * 12, 7);
          ctx.quadraticCurveTo(s * 6, 4, 0, 0);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.restore();
        }
        break;
      }
      case 'halo': { // floats above
        const bob = Math.sin(t / 800) * 1.5;
        ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 2.6;
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.ellipse(0, topY - 9 + bob, w * 0.26, 3.6, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'wizardhat': { // tall, perched back on the head
        ctx.translate(w * 0.06, topY + 1);
        ctx.rotate(0.1);
        ctx.fillStyle = '#5e35b1';
        ctx.beginPath();
        ctx.ellipse(0, 0, w * 0.30, 5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-w * 0.17, -1); ctx.quadraticCurveTo(0, -8, w * 0.10, -24);
        ctx.quadraticCurveTo(w * 0.14, -10, w * 0.17, -1);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ffd54f';
        ctx.beginPath();
        star(ctx, w * 0.02, -13, 2.6, 5);
        ctx.fill();
        break;
      }
      case 'balloon': { // string from the side, floats up and away
        const bob = Math.sin(t / 1000) * 2;
        const bx = w * 0.52, by = topY - 16 + bob;
        ctx.strokeStyle = 'rgba(90,80,70,0.8)'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(w * 0.30, FEET_Y - g.h * 0.45);
        ctx.quadraticCurveTo(bx - 4, by + 24, bx, by + 11);
        ctx.stroke();
        ctx.fillStyle = '#ef5350';
        ctx.beginPath(); ctx.ellipse(bx, by, 8, 9.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#c62828'; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(bx - 2, by + 9.5); ctx.lineTo(bx + 2, by + 9.5); ctx.lineTo(bx, by + 12);
        ctx.closePath(); ctx.fillStyle = '#c62828'; ctx.fill();
        ctx.globalAlpha = 0.5; ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.ellipse(bx - 2.5, by - 3, 2, 3, -0.5, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'sparkles': { // orbiting glints, off the body
        for (let i = 0; i < 6; i++) {
          const a = t / 700 + (i / 6) * Math.PI * 2;
          const rx = w * 0.60, ry = g.h * 0.42;
          const x = Math.cos(a) * rx, y = FEET_Y - g.h * 0.52 + Math.sin(a) * ry;
          const size = 2.6 + Math.sin(t / 300 + i * 2.1) * 1.4;
          ctx.globalAlpha = 0.65 + 0.35 * Math.sin(t / 220 + i);
          ctx.fillStyle = i % 2 ? '#ffe082' : '#fff3c4';
          ctx.beginPath(); star(ctx, x, y, Math.max(1.4, size), 4); ctx.fill();
        }
        ctx.globalAlpha = 1;
        break;
      }
    }
    ctx.restore();
  }

  function star(ctx, cx, cy, r, points) {
    for (let i = 0; i < points * 2; i++) {
      const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 === 0 ? r : r * 0.45;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // ---------------------------------------------------------------- main draw
  /**
   * Draw the pet, centered horizontally at x=0, feet at y=FEET_Y (logical
   * 120×130 box). Caller sets the outer transform (position, scale, facing).
   *
   * opts: { form, ramp, accessory, mood, t, eyeTrack, blink, sleeping,
   *         glow, mouthOpen, hop, squash, tilt }
   */
  function drawPet(ctx, opts) {
    const form = GEOM[opts.form] ? opts.form : 'hatchling';
    const g = GEOM[form];
    const ramp = opts.ramp || ['#a8e6cf', '#7bd4b2', '#4fbf96', '#2e9c78'];
    const t = opts.t || 0;
    const hop = opts.hop || 0;
    const squash = opts.squash || 0;   // + = squashed down
    const breathe = opts.sleeping ? Math.sin(t / 1100) * 0.03 : Math.sin(t / 1600) * 0.015;

    drawGroundShadow(ctx, g, hop);

    ctx.save();
    ctx.translate(0, -hop);
    if (opts.tilt) ctx.rotate(opts.tilt);
    // squash & breathe about the FEET
    ctx.translate(0, FEET_Y);
    ctx.scale(1 + (squash + breathe) * 0.6, 1 - squash - (-breathe));
    ctx.translate(0, -FEET_Y);

    const base = form === 'egg' ? EGG_COLORS.base : bodyColor(form, ramp);
    const outline = form === 'egg' ? EGG_COLORS.outline : shade(ramp[3], -0.35);

    drawTail(ctx, form, g, base, outline, t);
    if (opts.accessory === 'wings' || opts.accessory === 'balloon') {
      drawAccessory(ctx, opts.accessory, form, g, ramp, t); // behind the body
    }
    drawEars(ctx, form, g, base, outline);
    drawBody(ctx, form, g, ramp, !!opts.glow);
    drawFace(ctx, form, g, opts);
    if (opts.accessory && opts.accessory !== 'wings' && opts.accessory !== 'balloon') {
      drawAccessory(ctx, opts.accessory, form, g, ramp, t);
    }
    ctx.restore();
  }

  const PetArt = { drawPet, GEOM, FEET_Y, star, shade, bodyColor };
  if (typeof module !== 'undefined' && module.exports) module.exports = PetArt;
  else global.PetArt = PetArt;

})(typeof window !== 'undefined' ? window : globalThis);
