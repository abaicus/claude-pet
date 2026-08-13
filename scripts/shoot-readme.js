'use strict';
// Renders the screenshots the README ships, from the REAL app.
//
//   node scripts/shoot-readme.js [outDir]     # default: docs/media
//
// Nothing here is mocked up: it writes a sandbox with the same
// `events.jsonl` the hooks would append and the same transcript files Claude
// Code would leave behind, then boots the app against it and lets the app
// take its own screenshots. If a number in a screenshot is wrong, the app is
// wrong — which is the only way a README screenshot stays honest.
//
// The sandbox is CLAUDE_PET_DIR + CLAUDE_PET_SETTINGS, so this never reads or
// writes your real pet or your real ~/.claude/settings.json.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'media'));
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));

const MINUTE = 60 * 1000;

// The board from the README's opening example, as data. Four sessions, one in
// each state, sorted by who is blocked on whom — which is the whole pitch.
const SESSIONS = [
  { sid: 'a1', project: 'claudy-pet', status: 'perm', ago: 12 * 1000, ctx: 0.34,
    msg: 'Claude needs your permission to use Bash' },
  { sid: 'b2', project: 'api-server', status: 'idle', ago: 4 * MINUTE, ctx: 0.71,
    msg: 'Claude is waiting for your input' },
  { sid: 'c3', project: 'web', status: 'done', ago: 2 * MINUTE, ctx: 0.18 },
  { sid: 'd4', project: 'docs-site', status: 'working', ago: 3 * 1000, ctx: 0.09 }
];

const STATUS_EVENT = { perm: 'Notification', idle: 'Notification', done: 'Stop', working: 'PreToolUse' };

function seed(dir) {
  const now = Date.now();
  fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });

  // Customization: the pet in the shots is a named, dressed, level-12 elder
  // rather than the level-0 egg a fresh install shows, because the README is
  // selling what the thing becomes.
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({
    name: 'Pixel', palette: 'mint', accessory: 'headphones',
    bubbles: true, statsLine: true, glow: true, scale: 1.5,
    soundOn: false, volume: 0.7, clickThrough: false, onboarded: true,
    position: { x: 120, y: 120 }
  }, null, 2));

  // XP_LADDER[12] is 7500 — level 12 is an elder wearing anything up to lv.12.
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 1, born: now - 40 * 24 * 3600 * 1000,
    xp: 8200, level: 12, food: 74, energy: 86, mood: 82,
    lifetimeCommits: 143, greenStreak: 5, lifetimeOutputTokens: 4_100_000,
    tokenMilestonesAwarded: 4, lastEventAt: now, lastMeaningfulAt: now,
    sleeping: false,
    todos: { n: 7, d: 3, p: 1, at: now - 90 * 1000 },
    pm: 'default', combo: { count: 3, lastAt: now }, petXpAt: 0, treatAt: 0
  }, null, 2));

  const events = [];
  for (const s of SESSIONS) {
    const tp = path.join(dir, 'transcripts', `${s.sid}.jsonl`);
    const base = { sid: s.sid, cwd: `/Users/dev/${s.project}`, project: s.project, tp };

    // A transcript whose last assistant turn reports this much context. The
    // app divides by the model's window (Opus 5: 1M) to get the ~% it shows.
    const ctxTokens = Math.round(s.ctx * 1_000_000);
    const lines = [
      { type: 'assistant', timestamp: new Date(now - s.ago - 30 * 1000).toISOString(),
        message: { model: 'claude-opus-5', usage: {
          input_tokens: 1200,
          cache_read_input_tokens: ctxTokens - 1200,
          output_tokens: Math.round(10_000 * (1 + SESSIONS.indexOf(s) * 0.1))
        } } }
    ];
    fs.writeFileSync(tp, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    // The turn that put the session where it is: a prompt, some work, and
    // then whatever event means "this is its state now".
    events.push({ ts: now - s.ago - 60 * 1000, t: 'UserPromptSubmit', ...base, plen: 180 });
    events.push({ ts: now - s.ago - 40 * 1000, t: 'PostToolUse', ...base,
      tool: 'Edit', file: 'server.js', ext: 'js', add: 34, del: 6 });
    const ev = { ts: now - s.ago, t: STATUS_EVENT[s.status], ...base };
    if (s.msg) ev.msg = s.msg;
    if (s.status === 'working') { ev.tool = 'Bash'; ev.cmd = 'npm test'; ev.desc = 'Run the test suite'; }
    events.push(ev);
  }
  events.sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    events.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
  return now;
}

// One app launch per screenshot: the shot env vars are read once at startup,
// and a second window state is a second run rather than a script that reaches
// into a running app.
//
// Retried once, because the capture is on a fixed delay and a cold Electron
// start is not: a boot that runs long produces no file at all, and a docs
// script that fails a third of the time gets stopped being run.
async function shoot(label, env, timeoutMs) {
  try {
    return await shootOnce(label, env, timeoutMs);
  } catch (err) {
    console.warn(`${label}: retrying — ${err.message.split('\n')[0]}`);
    return shootOnce(label, env, timeoutMs + 6000);
  }
}

function shootOnce(label, env, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-shot-'));
  seed(dir);
  return new Promise((resolve, reject) => {
    // Its own Electron profile per run. The app takes a single-instance lock
    // keyed on the profile, so back-to-back launches sharing one would have
    // the second quit on the spot — silently, and with no screenshot.
    const child = spawn(ELECTRON, [ROOT, `--user-data-dir=${path.join(dir, 'electron')}`], {
      env: {
        ...process.env,
        CLAUDE_PET_DIR: dir,
        CLAUDE_PET_SETTINGS: path.join(dir, 'settings.json'),
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const done = setTimeout(() => {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
      if (/shot written|settings shot written/.test(out)) resolve(label);
      else reject(new Error(`${label}: no shot was written\n${out.slice(-800)}`));
    }, timeoutMs);
    child.on('error', err => { clearTimeout(done); reject(err); });
  });
}

// Anything transparent goes on a plate before it reaches the README — see
// scripts/plate.js for why.
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON, args, { stdio: 'inherit' });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`)));
    child.on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-raw-'));

  // The pet with its status board up — the shot the README opens with.
  await shoot('pet', {
    CLAUDE_PET_SHOT: path.join(tmp, 'pet.png'),
    CLAUDE_PET_SHOT_HOVER: '1',
    CLAUDE_PET_SHOT_DELAY: '5000'
  }, 12000);
  await run([path.join(__dirname, 'plate.js'), path.join(tmp, 'pet.png'), path.join(OUT, 'pet.png'), '36']);

  // Settings, on the tab with the wardrobe on it.
  await shoot('appearance', {
    CLAUDE_PET_SHOT_SETTINGS: path.join(OUT, 'appearance.png'),
    CLAUDE_PET_SHOT_TAB: 'appearance',
    CLAUDE_PET_SHOT_DELAY: '4000'
  }, 12000);
  console.log('wrote', path.join(OUT, 'appearance.png'));

  await shoot('settings', {
    CLAUDE_PET_SHOT_SETTINGS: path.join(OUT, 'settings.png'),
    CLAUDE_PET_SHOT_DELAY: '4000'
  }, 12000);
  console.log('wrote', path.join(OUT, 'settings.png'));

  // The evolution strip needs no app at all — it is the art module drawing
  // seven silhouettes offscreen.
  await run([path.join(__dirname, 'shoot-forms.js'), path.join(tmp, 'forms.png')]);
  await run([path.join(__dirname, 'plate.js'), path.join(tmp, 'forms.png'), path.join(OUT, 'forms.png'), '20']);

  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
