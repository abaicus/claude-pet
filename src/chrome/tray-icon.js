'use strict';
// Tray icon rasterized in code: a tiny blob-with-ears silhouette.
// Rendered as a macOS template image (pure black + alpha) so the system
// recolors it for light/dark menu bars automatically.

const { encodePng } = require('./png');

// Coverage of the blob silhouette at point (x, y) in a unit box (0..1).
function blobAlpha(x, y) {
  // body: superellipse-ish blob, feet at bottom
  const bx = (x - 0.5) / 0.36;
  const by = (y - 0.60) / 0.34;
  let a = bx * bx + by * by * (y < 0.60 ? 1.25 : 0.9) <= 1 ? 1 : 0;
  // ear nubs
  for (const s of [-1, 1]) {
    const ex = (x - (0.5 + s * 0.19)) / 0.10;
    const ey = (y - 0.24) / 0.14;
    if (ex * ex + ey * ey <= 1) a = 1;
  }
  // eye holes (transparent, so the face reads even as silhouette)
  for (const s of [-1, 1]) {
    const ex = (x - (0.5 + s * 0.13)) / 0.065;
    const ey = (y - 0.52) / 0.085;
    if (ex * ex + ey * ey <= 1) a = 0;
  }
  return a;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 3; // supersampling
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          acc += blobAlpha((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
        }
      }
      const alpha = Math.round((acc / (ss * ss)) * 255);
      const i = (py * size + px) * 4;
      rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = alpha;
    }
  }
  return encodePng(size, size, rgba);
}

/** Returns { png1x, png2x } buffers (16pt and 32px) for a template image. */
function trayIconPngs() {
  return { png1x: renderIcon(16), png2x: renderIcon(32) };
}

module.exports = { trayIconPngs, renderIcon };
