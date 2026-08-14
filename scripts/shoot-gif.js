'use strict';
// Records the pet REACTING, as an animated GIF.
//
//   node scripts/shoot-gif.js [out.gif] [--bg '#0a0a0a']
//
// A still can show what the pet looks like; only a recording can show what it
// does. So this seeds a sandbox, boots the real app against it, and then
// appends events to `events.jsonl` on a timeline while the app photographs
// itself frame by frame — a prompt, a 70-line edit, a commit. Every chomp,
// crumb and confetto in the result is the app answering an event, which is the
// only way an animation in a README or on a web page stays honest.
//
// Needs ffmpeg on PATH (brew install ffmpeg). The sandbox is GOGU_DIR +
// GOGU_SETTINGS, so this never touches your real pet or your real
// ~/.claude/settings.json.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const bgArg = process.argv.indexOf('--bg');
const BG = (bgArg > -1 && process.argv[bgArg + 1]) || '#0a0a0a';
const OUT = path.resolve(args[0] || path.join(ROOT, 'docs', 'media', 'reacting.gif'));

const FPS = 10;            // pixel art quantised to whole pixels; 60 buys nothing
const EVERY = 100;         // ms between captures — 1000/FPS
const FRAMES = 56;         // ≈ 5.6 seconds
const BOOT_MS = 4500;      // the app has to be up and settled before frame 0

// The story, in seconds from the first captured frame. Each entry is one hook
// event of the shape the capture script really appends.
const SID = 'gifsession';
const PROJECT = 'gogu';
const BEATS = [
  [0.5, { t: 'UserPromptSubmit', plen: 420 }],
  [1.9, { t: 'PostToolUse', tool: 'Edit', file: 'reducer.js', ext: 'js', add: 64, del: 9 }],
  [3.7, { t: 'PostToolUse', tool: 'Bash', cmd: 'git commit -m "feat: the pet eats"', ok: true,
    out: ' 3 files changed, 71 insertions(+), 9 deletions(-)' }]
];

function need(bin) {
  const probe = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  if (probe.error) {
    console.error(`${bin} is not on PATH — brew install ${bin}`);
    process.exit(1);
  }
}

function seed(dir) {
  const now = Date.now();
  fs.mkdirSync(dir, { recursive: true });

  // A named, dressed level-12 elder at 2× — the pet is the whole subject of
  // the frame, so it is shot at the size someone would actually show it off at.
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({
    name: 'Gogu', palette: 'mint', accessory: 'headphones',
    bubbles: true, statsLine: true, glow: true, scale: 2,
    soundOn: false, volume: 0.7, clickThrough: false, onboarded: true,
    position: { x: 80, y: 80 }
  }, null, 2));

  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 1, born: now - 40 * 24 * 3600 * 1000,
    xp: 8200, level: 12, food: 62, energy: 88, mood: 80,
    lifetimeCommits: 142, greenStreak: 5, lifetimeOutputTokens: 4_100_000,
    tokenMilestonesAwarded: 4, lastEventAt: now, lastMeaningfulAt: now,
    sleeping: false, pm: 'default', combo: { count: 0, lastAt: 0 },
    petXpAt: 0, treatAt: 0
  }, null, 2));

  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
}

function append(dir, ev) {
  const line = JSON.stringify({
    ts: Date.now(), sid: SID, cwd: `/Users/dev/${PROJECT}`, project: PROJECT,
    tp: path.join(dir, 'transcript.jsonl'), ...ev
  });
  fs.appendFileSync(path.join(dir, 'events.jsonl'), line + '\n');
}

function record(dir, frameStem) {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON, [ROOT, `--user-data-dir=${path.join(dir, 'electron')}`], {
      env: {
        ...process.env,
        GOGU_DIR: dir,
        GOGU_SETTINGS: path.join(dir, 'settings.json'),
        GOGU_SHOT: frameStem,
        GOGU_SHOT_FRAMES: String(FRAMES),
        GOGU_SHOT_EVERY: String(EVERY),
        GOGU_SHOT_DELAY: String(BOOT_MS)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });

    // The beats are fired against the same clock the capture starts on, so the
    // reaction lands in frame rather than before or after the recording.
    const timers = BEATS.map(([at, ev]) =>
      setTimeout(() => append(dir, ev), BOOT_MS + at * 1000));

    const budget = BOOT_MS + FRAMES * EVERY + 6000;
    const done = setTimeout(() => {
      timers.forEach(clearTimeout);
      child.kill();
      if (/shot written/.test(out)) resolve();
      else reject(new Error(`no frames were written\n${out.slice(-800)}`));
    }, budget);

    child.on('error', err => { clearTimeout(done); timers.forEach(clearTimeout); reject(err); });
  });
}

// The pet window reserves room for a speech bubble it is not always using and
// for stats lines that are only up on hover, so a raw frame is mostly empty.
// Every one of those pixels is paid for 56 times over. cropdetect is asked
// where the content actually is, and the union across all frames is kept so a
// hop or a wide bubble can never be clipped by a crop measured on frame 1.
function contentCrop(pattern) {
  const probe = spawnSync('ffmpeg', [
    '-i', pattern,
    '-vf', 'format=rgba,scale=iw/2:ih/2,cropdetect=limit=0.03:round=2:reset=1',
    '-f', 'null', '-'
  ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });

  let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1;
  for (const m of (probe.stderr || '').matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) {
    const [w, h, x, y] = m.slice(1).map(Number);
    x1 = Math.min(x1, x); y1 = Math.min(y1, y);
    x2 = Math.max(x2, x + w); y2 = Math.max(y2, y + h);
  }
  if (!(x2 > x1 && y2 > y1)) return null;

  // A little air back, and even numbers — an odd crop on a 2× pixel grid puts
  // the sprite half a device pixel off and every edge softens.
  const pad = 8;
  const even = (n) => n - (n % 2);
  return {
    w: even(x2 - x1 + pad * 2), h: even(y2 - y1 + pad * 2),
    x: even(Math.max(0, x1 - pad)), y: even(Math.max(0, y1 - pad))
  };
}

function encode(dir, stem) {
  const pattern = path.join(dir, `${stem}-%04d.png`);
  const crop = contentCrop(pattern);
  // Two things the default would get wrong: the frames are transparent (the
  // pet window has no background of its own) and they are retina. So they go
  // onto a flat field first, and the palette is generated from the composited
  // result rather than from the alpha.
  const filter = [
    `[0:v]format=rgba,scale=iw/2:ih/2:flags=neighbor` +
      (crop ? `,crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}` : '') + `[fg]`,
    // The colour source must be given the input's rate. Left at its default it
    // generates 25fps, overlay emits at the faster of the two, and a 76-frame
    // recording comes out as a 151-frame GIF running at half speed.
    `color=c=${BG.replace('#', '0x')}:s=2x2:r=${FPS}[c]`,
    `[c][fg]scale2ref[bg][fg2]`,
    `[bg][fg2]overlay=shortest=1,format=rgb24,split[a][b]`,
    // 48 colours is generous for a four-colour ramp plus ink, bubble and
    // confetti; dithering a pixel sprite just adds noise it does not have.
    // stats_mode=diff weights the palette towards what actually moves.
    `[a]palettegen=max_colors=48:stats_mode=diff[p]`,
    `[b][p]paletteuse=dither=none:diff_mode=rectangle`
  ].join(';');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const run = spawnSync('ffmpeg', [
    '-y', '-framerate', String(FPS), '-i', pattern,
    '-filter_complex', filter,
    '-loop', '0', OUT
  ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });

  if (run.status !== 0) {
    throw new Error(`ffmpeg failed:\n${(run.stderr || '').slice(-1500)}`);
  }
}

async function main() {
  need('ffmpeg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-gif-'));
  const stem = 'f';
  try {
    seed(dir);
    await record(dir, path.join(dir, `${stem}.png`));
    const shot = fs.readdirSync(dir).filter(f => /^f-\d{4}\.png$/.test(f)).length;
    if (shot < FRAMES) console.warn(`only ${shot}/${FRAMES} frames captured`);
    encode(dir, stem);
    const kb = Math.round(fs.statSync(OUT).size / 1024);
    console.log(`wrote ${OUT} — ${shot} frames, ${kb}KB`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
