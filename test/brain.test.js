'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Brain } = require('../src/brain/brain');

const T0 = 1_700_000_000_000;

function makeBrain(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-brain-'));
  let now = T0;
  const brain = new Brain({
    dir,
    settingsPath: path.join(dir, 'claude-settings.json'),
    now: () => now,
    rng: () => 0.99,
    ...extra
  });
  return { brain, dir, setNow: (t) => { now = t; } };
}

test('locked accessory cannot be equipped even via a forged IPC message', () => {
  const { brain } = makeBrain();
  assert.equal(brain.state.level, 0);
  const res = brain.command({ type: 'setAccessory', accessory: 'crown' }); // lv5 item
  assert.equal(res.ok, false);
  assert.match(res.reason, /locked/);
  assert.equal(brain.prefs.accessory, null);
});

test('unlocked accessory equips; unknown rejected', () => {
  const { brain } = makeBrain();
  brain.state.xp = 500; brain.state.level = 4;
  assert.equal(brain.command({ type: 'setAccessory', accessory: 'headphones' }).ok, true);
  assert.equal(brain.prefs.accessory, 'headphones');
  assert.equal(brain.command({ type: 'setAccessory', accessory: 'jetpack' }).ok, false);
  assert.equal(brain.command({ type: 'setAccessory', accessory: null }).ok, true);
  assert.equal(brain.prefs.accessory, null);
});

test('reset wipes progression but preserves cursor + customization', () => {
  const { brain } = makeBrain();
  brain.state.xp = 1000; brain.state.level = 6; brain.state.lifetimeCommits = 42;
  brain.prefs.name = 'Bubbles'; brain.prefs.palette = 'sakura'; brain.prefs.soundOn = true;
  brain.prefs.accessory = 'wings';
  brain.cursor.events = 12345;
  brain.cursor.transcripts['/x.jsonl'] = 999;

  brain.command({ type: 'resetProgress' });

  assert.equal(brain.state.xp, 0);
  assert.equal(brain.state.level, 0);
  assert.equal(brain.state.lifetimeCommits, 0);
  assert.equal(brain.prefs.accessory, null, 'accessory is progression — wiped');
  assert.equal(brain.prefs.name, 'Bubbles', 'name survives');
  assert.equal(brain.prefs.palette, 'sakura', 'palette survives');
  assert.equal(brain.prefs.soundOn, true, 'sound settings survive');
  assert.equal(brain.cursor.events, 12345, 'event cursor survives — no refeed');
  assert.equal(brain.cursor.transcripts['/x.jsonl'], 999, 'transcript offsets survive');
});

test('name is clamped to 12 chars; empty rejected', () => {
  const { brain } = makeBrain();
  brain.command({ type: 'setName', name: 'Supercalifragilistic' });
  assert.equal(brain.prefs.name.length, 12);
  assert.equal(brain.command({ type: 'setName', name: '   ' }).ok, false);
});

test('treat honors cooldown', () => {
  const { brain, setNow } = makeBrain();
  const food0 = brain.state.food;
  assert.equal(brain.command({ type: 'treat' }).ok, true);
  assert.equal(brain.state.food, food0 + 15);
  assert.equal(brain.command({ type: 'treat' }).ok, false, 'not hungry yet');
  setNow(T0 + 5 * 60_000 + 1);
  assert.equal(brain.command({ type: 'treat' }).ok, true);
});

test('petting xp is rate-limited (not farmable)', () => {
  const { brain, setNow } = makeBrain();
  brain.command({ type: 'pet' });
  const xp1 = brain.state.xp;
  assert.ok(xp1 > 0);
  for (let i = 0; i < 20; i++) brain.command({ type: 'pet' });
  assert.equal(brain.state.xp, xp1, 'no xp within cooldown');
  setNow(T0 + 3 * 60_000);
  brain.command({ type: 'pet' });
  assert.ok(brain.state.xp > xp1);
});

test('non-important bubbles respect mute; important ones bypass it', () => {
  const { brain } = makeBrain();
  brain.command({ type: 'setToggle', key: 'bubbles', value: false });
  brain.pushBubble({ text: 'just a quip' });
  assert.equal(brain.bubble, null, 'quip muted');
  brain.pushBubble({ text: 'Claude needs you!', important: true });
  assert.ok(brain.bubble, 'important bubble shown despite mute');
  assert.equal(brain.bubble.text, 'Claude needs you!');
});

test('stats line: idle collapses, active shows real telemetry, hidden toggle', () => {
  const { brain } = makeBrain();
  brain.prefs.name = 'Pixel';
  let line = brain.statsLine(T0);
  assert.equal(line.mode, 'idle');
  assert.equal(line.text, 'Pixel lv.0');
  assert.deepEqual(line.lines, []);

  // fake a live session with ctx
  brain.sessions.noteEvent({ t: 'SessionStart', ts: T0, sid: 's1', project: 'alpha' });
  brain.sessions.session('s1').ctxTokens = 144_000;
  brain.state.greenStreak = 5;
  line = brain.statsLine(T0);
  assert.equal(line.mode, 'active');
  // The pill is what's true of the PET; per-session facts belong to the lines
  // and must not also be crammed in here.
  assert.match(line.text, /Pixel lv\.0 │ .*\/5h │ ✓×5/);
  assert.ok(!/session|ctx/.test(line.text), `session detail duplicated in the pill: ${line.text}`);
  assert.equal(line.lines.length, 1, 'every session gets a line, even the only one');
  assert.match(line.lines[0].text, /alpha · working · ~72%/);

  brain.sessions.noteEvent({ t: 'SessionStart', ts: T0, sid: 's2', project: 'beta' });
  brain.sessions.session('s2').ctxTokens = 20_000;
  line = brain.statsLine(T0);
  assert.equal(line.lines.length, 2);

  brain.command({ type: 'setToggle', key: 'statsLine', value: false });
  assert.equal(brain.statsLine(T0).mode, 'hidden');
  assert.deepEqual(brain.statsLine(T0).lines, []);
});

test('session lines: whoever is waiting on you comes first, and says so', () => {
  const { brain } = makeBrain();
  const start = (sid, project) => brain.sessions.noteEvent({ t: 'SessionStart', ts: T0, sid, project });
  for (const [sid, project] of [['s1', 'alpha'], ['s2', 'beta'], ['s3', 'gamma'], ['s4', 'delta']]) start(sid, project);
  brain.sessions.session('s1').ctxTokens = 144_000;   // busiest, but merely working

  // beta finished its turn 2 minutes ago; gamma is blocked on a permission
  // prompt; delta was told it has been waiting on the human.
  brain.sessions.noteEvent({ t: 'Stop', ts: T0 - 120_000, sid: 's2' });
  brain.sessions.noteEvent({ t: 'Notification', ts: T0 - 30_000, sid: 's3', msg: 'Claude needs your permission to use Bash' });
  brain.sessions.noteEvent({ t: 'Notification', ts: T0 - 5_000, sid: 's4', msg: 'Claude is waiting for your input' });

  const lines = brain.statsLine(T0).lines;
  assert.deepEqual(lines.map(l => l.kind), ['perm', 'idle', 'done', 'working'],
    'a blocked session must outrank a busy one — that is the whole point');
  assert.match(lines[0].text, /^! gamma · needs permission 30s$/);
  assert.match(lines[1].text, /^… delta · waiting for you 5s$/);
  assert.match(lines[2].text, /^✓ beta · done 2m$/);
  assert.match(lines[3].text, /^▸ alpha · working · ~72%/, 'a working session states no age — it is now');

  // and the pet wears the "!" only while something is truly BLOCKED
  assert.equal(brain.getRenderState().sessions.needsYou, true);
  brain.sessions.noteEvent({ t: 'PostToolUse', ts: T0, sid: 's3', tool: 'Bash' }); // permission granted
  assert.equal(brain.getRenderState().sessions.needsYou, false, 'the badge must clear itself');
});

test('a session whose context has not been read shows no context at all', () => {
  const { brain } = makeBrain();
  brain.prefs.name = 'Pixel';
  brain.sessions.noteEvent({ t: 'SessionStart', ts: T0, sid: 's1', project: 'alpha' });
  const line = brain.statsLine(T0);
  assert.equal(line.mode, 'active');
  assert.equal(line.lines.length, 1, 'the session itself is still real news');
  assert.ok(!line.lines[0].text.includes('%'), `printed a context it never read: ${line.lines[0].text}`);
  assert.match(line.lines[0].text, /alpha/, '…and it is still named');

  // …and it must not surface as a "fact" either
  brain.state.lifetimeCommits = 0;
  brain.state.greenStreak = 0;
  for (let i = 0; i < 40; i++) {
    const fact = brain.pickFact(T0, true);
    if (fact) assert.ok(!fact.includes('ctx'), `invented a context reading: ${fact}`);
  }
});

test('brain end-to-end: events file → tailer → state, cursor persists', async () => {
  const { brain, dir } = makeBrain();
  const eventsFile = path.join(dir, 'events.jsonl');
  fs.writeFileSync(eventsFile,
    JSON.stringify({ t: 'UserPromptSubmit', ts: T0 - 1000, sid: 's1' }) + '\n' +
    JSON.stringify({ t: 'PostToolUse', ts: T0 - 900, sid: 's1', tool: 'Bash', cmd: 'git commit -m x' }) + '\n');

  brain.start({ installHooks: false });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(brain.state.lifetimeCommits, 1);
  assert.equal(brain.fxQueue.length, 0, 'replayed events fire no fx');

  fs.appendFileSync(eventsFile, JSON.stringify({ t: 'PostToolUse', ts: T0, sid: 's1', tool: 'Bash', cmd: 'git commit -m y' }) + '\n');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(brain.state.lifetimeCommits, 2);
  assert.ok(brain.fxQueue.some(f => f.name === 'party'), 'live event fires fx');

  brain.stop();
  const cursor = JSON.parse(fs.readFileSync(path.join(dir, 'cursor.json'), 'utf8'));
  assert.equal(cursor.events, fs.statSync(eventsFile).size, 'cursor saved at end of log');

  // relaunch: nothing re-fed
  const brain2 = new Brain({ dir, settingsPath: path.join(dir, 's.json'), now: () => T0 + 10_000, rng: () => 0.99 });
  assert.equal(brain2.state.lifetimeCommits, 2, 'state persisted');
  brain2.start({ installHooks: false });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(brain2.state.lifetimeCommits, 2, 'no double count after relaunch');
  brain2.stop();
});

test('debug: set level moves xp to ladder, fires evolve fx on the way up', () => {
  const { brain } = makeBrain();
  const res = brain.command({ type: 'debugSetLevel', level: 6 });
  assert.ok(res.ok);
  assert.equal(brain.state.level, 6);
  assert.equal(brain.state.xp, 1000); // XP_LADDER[6]
  assert.equal(brain.getRenderState().form, 'senior');
  assert.ok(brain.fxQueue.some(f => f.name === 'party' && f.big), 'evolution party fired');
  assert.equal(brain.command({ type: 'debugSetLevel', level: 11 }).ok, false);
  assert.equal(brain.command({ type: 'debugSetLevel', level: -1 }).ok, false);
});

test('debug: downleveling unequips an accessory that is no longer unlocked', () => {
  const { brain } = makeBrain();
  brain.command({ type: 'debugSetLevel', level: 7 });
  assert.ok(brain.command({ type: 'setAccessory', accessory: 'halo' }).ok); // lv7 item
  brain.command({ type: 'debugSetLevel', level: 3 });
  assert.equal(brain.prefs.accessory, null, 'halo unequipped — locks stay honest in debug');
  assert.equal(brain.state.level, 3);
});

test('debug: adjust clamps energy/mood, keeps food uncapped, xp rechecks level', () => {
  const { brain } = makeBrain();
  brain.command({ type: 'debugAdjust', key: 'energy', value: 999 });
  assert.equal(brain.state.energy, 100);
  brain.command({ type: 'debugAdjust', key: 'mood', value: -5 });
  assert.equal(brain.state.mood, 0);
  brain.command({ type: 'debugAdjust', key: 'food', value: 500 });
  assert.equal(brain.state.food, 500);
  brain.command({ type: 'debugAdjust', key: 'xp', value: 260 });
  assert.equal(brain.state.level, 3, 'xp adjust levels up');
  assert.equal(brain.command({ type: 'debugAdjust', key: 'nope', value: 1 }).ok, false);
  assert.equal(brain.command({ type: 'debugAdjust', key: 'mood', value: 'NaN' }).ok, false);
});

test('debug: synthetic events run through the real reducer with live fx', () => {
  const { brain } = makeBrain();
  const commits = brain.state.lifetimeCommits;
  assert.ok(brain.command({ type: 'debugEvent', name: 'commit' }).ok);
  assert.equal(brain.state.lifetimeCommits, commits + 1);
  assert.ok(brain.fxQueue.some(f => f.name === 'party'));

  brain.command({ type: 'debugEvent', name: 'testsRed' });
  assert.equal(brain.state.greenStreak, 0);
  assert.ok(brain.fxQueue.some(f => f.name === 'sulk'));

  brain.command({ type: 'debugEvent', name: 'notification' });
  assert.ok(brain.bubble && brain.bubble.important, 'notification preset relays important bubble');

  assert.equal(brain.command({ type: 'debugEvent', name: 'nope' }).ok, false);
  assert.equal(brain.sessions.sessions.has('debug'), false, 'debug sid stays out of the registry');
});

test('debug: sleep toggle', () => {
  const { brain } = makeBrain();
  brain.command({ type: 'debugSleep', value: true });
  assert.equal(brain.state.sleeping, true);
  brain.command({ type: 'debugSleep', value: false });
  assert.equal(brain.state.sleeping, false);
});

test('render state exposes the dumb-renderer contract', () => {
  const { brain } = makeBrain();
  const rs = brain.getRenderState();
  for (const key of ['form', 'palette', 'accessory', 'moodBand', 'bubble', 'fx', 'statsLine', 'scale', 'toggles', 'sounds']) {
    assert.ok(key in rs, `render state has ${key}`);
  }
  assert.equal(rs.form, 'egg');
  assert.equal(rs.xpNext, 50);
});

test('the stats line shows Claude\'s todo progress, then stops when it\'s stale', () => {
  const { brain, setNow } = makeBrain();
  const { TUNING } = require('../src/shared/constants');
  brain.state.todos = { n: 7, d: 3, p: 1, at: T0 };
  assert.match(brain.statsLine(T0).text, /☑ 3\/7/);

  // A list nobody has touched in a quarter of an hour is not live telemetry.
  const stale = T0 + TUNING.todoFreshMs + 1;
  setNow(stale);
  assert.ok(!brain.statsLine(stale).text.includes('☑'));

  // A finished list is not progress either — the party already said so.
  brain.state.todos = { n: 7, d: 7, p: 0, at: T0 };
  assert.ok(!brain.statsLine(T0).text.includes('☑'));
});

test('the volume slider samples the level it is setting', () => {
  const { brain, setNow } = makeBrain();
  const sounds = () => brain.getRenderState().sounds.map(s => s.name);

  // Muted: moving the slider is silent. Muted means muted.
  brain.command({ type: 'setSound', volume: 0.5 });
  assert.deepEqual(sounds(), [], 'a muted pet must not blurt out a sample');

  // Switching sound on chimes once, wherever it was switched on from.
  brain.command({ type: 'setSound', on: true });
  assert.deepEqual(sounds(), ['ding']);

  brain.command({ type: 'setSound', volume: 0.8 });
  assert.equal(sounds().pop(), 'pet', 'a new level should be audible at once');

  // `input` fires on every notch of a drag — one sample, not a burst.
  let t = T0;
  const before = sounds().length;
  for (const v of [0.75, 0.7, 0.65, 0.6]) {
    t += 20; setNow(t);
    brain.command({ type: 'setSound', volume: v });
  }
  assert.equal(sounds().length, before, 'a drag machine-gunned the sample');
  setNow(t + 200);
  brain.command({ type: 'setSound', volume: 0.55 });
  assert.equal(sounds().length, before + 1, 'the sample never came back after the throttle');

  // Silence at the bottom of the slider is the correct sample of silence.
  setNow(t + 1000);
  brain.command({ type: 'setSound', volume: 0 });
  assert.equal(sounds().length, before + 1);
});

test('debug event presets all resolve through the real reducer', () => {
  const { brain } = makeBrain();
  // Every button the settings window offers must hit a preset that exists;
  // a typo here is a dead button nothing reports.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings', 'settings.js'), 'utf8');
  const list = src.match(/const DEBUG_EVENTS = \[([\s\S]*?)\n\];/)[1];
  const names = [...list.matchAll(/\['([a-zA-Z]+)',/g)].map(m => m[1]);
  assert.ok(names.length >= 20, `expected a real grid, found ${names.length}`);
  for (const name of names) {
    const res = brain.command({ type: 'debugEvent', name });
    assert.equal(res.ok, true, `preset '${name}' is offered but does not exist`);
  }
});
