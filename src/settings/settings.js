'use strict';
// Settings window — a pure remote control. It displays the brain's actual
// state and sends commands; every rule (accessory locks, name length,
// reset semantics) is enforced brain-side. No game logic here.

/* global petAPI */

const $ = (id) => document.getElementById(id);
let state = null;
let suppress = false; // avoid echo loops while reflecting state into inputs

// ------------------------------------------------------------------ render
function render(s) {
  state = s;
  suppress = true;

  if (document.activeElement !== $('name')) $('name').value = s.name;
  $('level-label').textContent = `lv.${s.level} · ${s.xp} xp` + (s.xpNext ? ` (next: ${s.xpNext})` : ' (max)');

  // palettes
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

  // accessories
  const accs = $('accessories');
  if (!accs.childElementCount) {
    const none = document.createElement('div');
    none.className = 'acc'; none.dataset.id = '';
    none.innerHTML = 'none<small>&nbsp;</small>';
    none.addEventListener('click', () => petAPI.command({ type: 'setAccessory', accessory: null }));
    accs.appendChild(none);
    for (const a of s.accessories) {
      const d = document.createElement('div');
      d.className = 'acc'; d.dataset.id = a.id;
      d.addEventListener('click', () => {
        // send regardless; the BRAIN decides. UI lock styling is cosmetic.
        petAPI.command({ type: 'setAccessory', accessory: a.id });
      });
      accs.appendChild(d);
    }
  }
  for (const el of accs.children) {
    if (el.dataset.id === '') { el.classList.toggle('sel', !s.accessory); continue; }
    const a = s.accessories.find(x => x.id === el.dataset.id);
    el.classList.toggle('locked', !a.unlocked);
    el.classList.toggle('sel', a.equipped);
    el.innerHTML = `${a.name}<small>${a.unlocked ? 'lv.' + a.level : '🔒 lv.' + a.level}</small>`;
  }

  $('t-bubbles').checked = s.toggles.bubbles;
  $('t-stats').checked = s.toggles.statsLine;
  $('t-glow').checked = s.toggles.glow;
  $('scale').value = s.scale;
  $('scale-label').textContent = Math.round(s.scale * 100) + '%';
  $('t-sound').checked = s.soundOn;
  $('volume').value = s.volume;

  const hs = $('hook-status');
  if (s.hooks.ok && s.hooks.installed) { hs.textContent = 'installed ✓'; hs.className = ''; }
  else if (s.hooks.ok) { hs.textContent = 'not installed'; hs.className = ''; }
  else { hs.textContent = s.hooks.reason || 'error'; hs.className = 'bad'; }

  // debug state sliders reflect the brain's truth unless being dragged
  const dbg = [
    ['dbg-level', s.level, `lv.${s.level}`],
    ['dbg-food', Math.min(200, s.food), `${s.food}`],
    ['dbg-energy', s.energy, `${s.energy}`],
    ['dbg-mood', s.mood, `${s.mood} (${s.moodBand}${s.sleeping ? ', asleep' : ''})`]
  ];
  for (const [id, value, label] of dbg) {
    if (document.activeElement !== $(id)) $(id).value = value;
    $(id + '-label').textContent = label;
  }

  suppress = false;
}

petAPI.onState(render);
petAPI.getState().then(render);

// ------------------------------------------------------------------ inputs
$('name').addEventListener('change', () => {
  if (!suppress) petAPI.command({ type: 'setName', name: $('name').value });
});
for (const [id, key] of [['t-bubbles', 'bubbles'], ['t-stats', 'statsLine'], ['t-glow', 'glow']]) {
  $(id).addEventListener('change', () => {
    if (!suppress) petAPI.command({ type: 'setToggle', key, value: $(id).checked });
  });
}
$('scale').addEventListener('input', () => {
  if (!suppress) petAPI.command({ type: 'setScale', value: Number($('scale').value) });
});
$('t-sound').addEventListener('change', () => {
  if (!suppress) petAPI.command({ type: 'setSound', on: $('t-sound').checked });
});
$('volume').addEventListener('input', () => {
  if (!suppress) petAPI.command({ type: 'setSound', volume: Number($('volume').value) });
});
$('hooks-install').addEventListener('click', () => petAPI.command({ type: 'installHooks' }));
$('hooks-uninstall').addEventListener('click', () => petAPI.command({ type: 'uninstallHooks' }));

// ------------------------------------------------------------------ reset: arm → sure? → REALLY sure? (4s auto-disarm)
const resetBtn = $('reset');
let resetStage = 0, disarmTimer = null;
const RESET_LABELS = ['Reset to lv.0…', 'sure?', 'REALLY sure?'];
function disarm() {
  resetStage = 0;
  resetBtn.textContent = RESET_LABELS[0];
  resetBtn.classList.remove('armed');
  if (disarmTimer) { clearTimeout(disarmTimer); disarmTimer = null; }
}
resetBtn.addEventListener('click', () => {
  resetStage++;
  if (disarmTimer) clearTimeout(disarmTimer);
  if (resetStage >= 3) {
    petAPI.command({ type: 'resetProgress' });
    disarm();
    return;
  }
  resetBtn.textContent = RESET_LABELS[resetStage];
  resetBtn.classList.add('armed');
  disarmTimer = setTimeout(disarm, 4000);
});

// ------------------------------------------------------------------ debug: state
$('dbg-level').addEventListener('input', () => {
  if (!suppress) petAPI.command({ type: 'debugSetLevel', level: Number($('dbg-level').value) });
});
for (const key of ['food', 'energy', 'mood']) {
  $('dbg-' + key).addEventListener('input', () => {
    if (!suppress) petAPI.command({ type: 'debugAdjust', key, value: Number($('dbg-' + key).value) });
  });
}
$('dbg-xp').addEventListener('click', () => petAPI.command({ type: 'debugAdjust', key: 'xp', value: (state ? state.xp : 0) + 100 }));
$('dbg-commits9').addEventListener('click', () => {
  const c = state ? state.lifetimeCommits : 0;
  petAPI.command({ type: 'debugAdjust', key: 'lifetimeCommits', value: Math.floor(c / 10) * 10 + 9 });
});
$('dbg-streak4').addEventListener('click', () => petAPI.command({ type: 'debugAdjust', key: 'greenStreak', value: 4 }));
$('dbg-tokens').addEventListener('click', () => {
  const t = state ? state.lifetimeOutputTokens : 0;
  petAPI.command({ type: 'debugAdjust', key: 'lifetimeOutputTokens', value: Math.floor(t / 1e6) * 1e6 + 990_000 });
});
$('dbg-sleep').addEventListener('click', () => petAPI.command({ type: 'debugSleep', value: true }));
$('dbg-wake').addEventListener('click', () => petAPI.command({ type: 'debugSleep', value: false }));

// ------------------------------------------------------------------ debug: fake events through the real reducer
const DEBUG_EVENTS = [
  ['prompt', 'prompt'], ['edit', 'edit'], ['commit', 'commit'],
  ['testsGreen', 'tests ✓'], ['testsRed', 'tests ✗'], ['deploy', 'deploy 🚀'],
  ['push', 'push'], ['rmRf', 'rm -rf'], ['toolFail', 'tool fail'],
  ['notification', 'notification'], ['sessionStart', 'session start'],
  ['sessionEnd', 'session end'], ['preCompact', 'pre-compact']
];
for (const [name, label] of DEBUG_EVENTS) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => petAPI.command({ type: 'debugEvent', name }));
  $('debug-events').appendChild(b);
}

// ------------------------------------------------------------------ debug: every animation reachable
const DEBUG_ANIMS = ['eat', 'party', 'party-big', 'sulk', 'sleep', 'wake', 'attention', 'flinch', 'hearts', 'wave'];
for (const a of DEBUG_ANIMS) {
  const b = document.createElement('button');
  b.textContent = a;
  b.addEventListener('click', () => {
    if (a === 'party-big') petAPI.command({ type: 'playAnim', name: 'party', big: true });
    else petAPI.command({ type: 'playAnim', name: a });
  });
  $('debug-anims').appendChild(b);
}
const DEBUG_SOUNDS = [
  'prompt', 'eat', 'pet', 'treat', 'commit', 'green', 'red', 'merge', 'deploy',
  'combo', 'milestone', 'levelup', 'transform', 'equip', 'ding', 'gossip',
  'notify', 'warn', 'sad', 'sleep', 'wake', 'bye'
];
for (const snd of DEBUG_SOUNDS) {
  const b = document.createElement('button');
  b.textContent = '♪ ' + snd;
  b.addEventListener('click', () => petAPI.command({ type: 'playSound', name: snd }));
  $('debug-sounds').appendChild(b);
}
$('dbg-bubble').addEventListener('click', () => petAPI.command({ type: 'testBubble', text: 'mm, fresh prompt' }));
$('dbg-important').addEventListener('click', () => petAPI.command({ type: 'testBubble', text: 'Claude needs your permission to use Bash', important: true }));
