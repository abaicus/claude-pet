'use strict';
// First-launch intro. Like the settings window it is a remote control: it
// explains, it sends commands, and the brain decides what any of them mean.
// Everything the user changes here applies to the live pet immediately — this
// is the same setName/setPalette/setSound the settings window sends, so there
// is no "apply" step and nothing to undo if they quit halfway.

/* global petAPI, PetArt */

const $ = (id) => document.getElementById(id);
const STEPS = [...document.querySelectorAll('.step')];
let state = null;
let suppress = false;   // don't echo brain state back at the brain
let step = 0;

// ------------------------------------------------------------------ steps
function show(i) {
  step = Math.max(0, Math.min(STEPS.length - 1, i));
  STEPS.forEach((el, n) => { el.hidden = n !== step; });
  for (const [n, d] of [...$('dots').children].entries()) d.classList.toggle('on', n === step);
  $('back').disabled = step === 0;
  $('next').textContent = step === STEPS.length - 1 ? "let's go ♥" : 'next';
  $('stage').scrollTop = 0;
}
for (const [i] of STEPS.entries()) {
  const d = document.createElement('button');
  d.className = 'dot';
  d.title = `step ${i + 1}`;
  d.addEventListener('click', () => show(i));
  $('dots').appendChild(d);
}
$('back').addEventListener('click', () => show(step - 1));
$('next').addEventListener('click', () => {
  if (step < STEPS.length - 1) { show(step + 1); return; }
  finish();
});

// Skipping still counts as onboarded — otherwise the intro would ambush them
// on every launch. The right-click menu can bring it back.
function finish() {
  petAPI.command({ type: 'completeOnboarding' });
  petAPI.closeOnboarding();
}
$('skip').addEventListener('click', finish);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') finish();
  else if (e.key === 'ArrowRight') show(step + 1);
  else if (e.key === 'ArrowLeft') show(step - 1);
});

// ------------------------------------------------------------------ state
function render(s) {
  state = s;
  suppress = true;

  if (document.activeElement !== $('name')) $('name').value = s.name;
  $('t-sound').checked = s.soundOn;
  $('t-gravity').checked = s.toggles.gravity;
  if (document.activeElement !== $('scale')) $('scale').value = s.scale;
  $('scale-label').textContent = Math.round(s.scale * 100) + '%';

  const pal = $('palettes');
  if (!pal.childElementCount) {
    for (const name of s.palettes) {
      const d = document.createElement('div');
      d.className = 'swatch'; d.dataset.name = name; d.title = name;
      for (const c of s.paletteRamps[name]) {
        const i = document.createElement('i');
        i.style.background = c;
        d.appendChild(i);
      }
      d.addEventListener('click', () => petAPI.command({ type: 'setPalette', palette: name }));
      pal.appendChild(d);
    }
  }
  for (const el of pal.children) el.classList.toggle('sel', el.dataset.name === s.palette);
  $('egg-note').hidden = s.form !== 'egg';

  // The hooks are installed by the app at startup, not by this window — so
  // this reports what actually happened rather than promising anything.
  const st = $('hook-state');
  const note = $('hook-note');
  if (s.hooks && s.hooks.ok && s.hooks.installed) {
    st.textContent = 'installed ✓'; st.className = 'state ok';
    note.textContent = 'the pet can hear Claude.';
  } else if (s.hooks && s.hooks.ok) {
    st.textContent = 'not installed'; st.className = 'state';
    note.textContent = 'Settings → Claude hooks → reinstall.';
  } else {
    st.textContent = 'could not install'; st.className = 'state bad';
    note.textContent = (s.hooks && s.hooks.reason) || 'unknown error';
  }

  suppress = false;
}
petAPI.onState(render);
petAPI.getState().then(render);

$('name').addEventListener('input', () => {
  if (!suppress && $('name').value.trim()) petAPI.command({ type: 'setName', name: $('name').value });
});
$('t-sound').addEventListener('change', () => {
  if (!suppress) petAPI.command({ type: 'setSound', on: $('t-sound').checked });
});
$('t-gravity').addEventListener('change', () => {
  if (!suppress) petAPI.command({ type: 'setToggle', key: 'gravity', value: $('t-gravity').checked });
});
$('scale').addEventListener('input', () => {
  if (!suppress) petAPI.command({ type: 'setScale', value: Number($('scale').value) });
});

// ------------------------------------------------------------------ preview
// The real art module, drawn the same way the pet window draws it, so what you
// pick here is exactly what walks out of this window when it closes.
const CANVASES = [$('preview'), $('preview-2')];
// Sized on the first frame it is actually visible: a canvas inside a hidden
// step measures 0×0, and a 0-wide canvas draws nothing, silently, forever.
function sizeCanvas(c, dpr) {
  const w = c.clientWidth * dpr, h = c.clientHeight * dpr;
  if (w > 0 && (c.width !== w || c.height !== h)) { c.width = w; c.height = h; }
  return c.width > 0;
}
// An egg is a shell: it wears the same cream whatever palette you pick. So the
// colour step previews the hatchling instead — and says so, because showing a
// creature the user does not have yet without a word would be a small lie.
function previewForm(canvasId) {
  return (canvasId === 'preview-2' && state.form === 'egg') ? 'hatchling' : state.form;
}
function frame(t) {
  for (const c of CANVASES) {
    if (!state || c.offsetParent === null) continue;   // hidden step: don't paint
    const dpr = window.devicePixelRatio || 1;
    if (!sizeCanvas(c, dpr)) continue;
    const ctx = c.getContext('2d');
    const w = c.width / dpr, h = c.height / dpr;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // A portrait, not the pet's own window: fit the form to the box. GEOM is in
    // logical units already (the tallest form is 116 of them; a tail reaches
    // ~65 sideways), and the sprite stands on FEET_Y with its shadow 4 below.
    const form = previewForm(c.id);
    const g = PetArt.GEOM[form] || PetArt.GEOM.hatchling;
    const scale = Math.max(1, Math.min(2.6, Math.min((h - 10) / (g.h + 8), (w / 2 - 6) / 66)));
    ctx.translate(w / 2, h - 6 - (PetArt.FEET_Y + 4) * scale);
    ctx.scale(scale, scale);
    PetArt.drawPet(ctx, {
      form,
      ramp: state.paletteRamps && state.paletteRamps[state.palette],
      accessory: state.accessory,
      mood: 'happy',
      t,
      // a slow blink so the portrait is alive without being distracting
      blink: Math.max(0, 1 - Math.abs(((t % 4200) - 3900) / 130)),
      glow: state.toggles && state.toggles.glow
    });
    ctx.restore();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

show(0);
