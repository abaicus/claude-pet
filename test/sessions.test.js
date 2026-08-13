'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionRegistry } = require('../src/brain/sessions');
const { TUNING } = require('../src/shared/constants');

const T0 = 1_700_000_000_000;

function tmpTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-sess-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l) + '\n').join(''));
  return file;
}

function assistantEntry({ input = 0, cacheRead = 0, cacheCreate = 0, output = 0, sidechain = false, ts = T0, model }) {
  return {
    type: 'assistant',
    isSidechain: sidechain,
    timestamp: new Date(ts).toISOString(),
    message: {
      model,
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        output_tokens: output
      }
    }
  };
}

// What Claude Code itself writes when a session is compacted — its own counts.
function boundary({ trigger = 'manual', pre = 0, post = 0, ts = T0 }) {
  return {
    type: 'system', subtype: 'compact_boundary',
    timestamp: new Date(ts).toISOString(),
    compactMetadata: { trigger, preTokens: pre, postTokens: post }
  };
}

function startSession(reg, sid, tp, project = 'proj') {
  reg.noteEvent({ t: 'SessionStart', ts: T0, sid, tp, project });
}

test('ctx fullness from last main-chain assistant turn; sidechain excluded', () => {
  const tp = tmpTranscript([
    assistantEntry({ input: 1000, cacheRead: 50_000, output: 500 }),
    assistantEntry({ input: 900, cacheRead: 180_000, output: 700, sidechain: true }), // must NOT count
    assistantEntry({ input: 1200, cacheRead: 99_000, cacheCreate: 4000, output: 800 })
  ]);
  const reg = new SessionRegistry({});
  startSession(reg, 's1', tp, 'cool-app');
  reg.poll(T0 + 1000);
  const sum = reg.summary(T0 + 1000);
  assert.equal(sum.count, 1);
  const expected = (1200 + 99_000 + 4000) / TUNING.ctxWindow;
  assert.ok(Math.abs(sum.worstPct - expected) < 1e-9, `got ${sum.worstPct}`);
});

test('burn counts all output tokens in rolling 5h window', () => {
  const tp = tmpTranscript([
    assistantEntry({ input: 10, output: 30_000, ts: T0 - 6 * 3600_000 }),  // outside window
    assistantEntry({ input: 10, output: 11_000, ts: T0 - 3600_000 }),
    assistantEntry({ input: 10, output: 9_000, ts: T0 - 60_000, sidechain: true }) // burn is real spend: counts
  ]);
  const reg = new SessionRegistry({});
  startSession(reg, 's1', tp);
  const { outputTokensDelta } = reg.poll(T0);
  assert.equal(outputTokensDelta, 50_000, 'lifetime delta counts everything read');
  assert.equal(reg.burnTokens(T0), 20_000, 'window excludes 6h-old entry');
  assert.equal(reg.burnLabel(T0), '20k');
});

test('one-shot warnings at 75/90, re-armed below 60', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-warn-'));
  const tp = path.join(dir, 't.jsonl');
  const reg = new SessionRegistry({});

  const write = (frac) => fs.appendFileSync(tp,
    JSON.stringify(assistantEntry({ input: Math.round(TUNING.ctxWindow * frac), ts: T0 })) + '\n');

  startSession(reg, 's1', tp, 'app');
  write(0.5);
  assert.equal(reg.poll(T0).fx.filter(f => f.kind === 'ctx-warning').length, 0);

  write(0.78);
  let fx = reg.poll(T0 + 1).fx.filter(f => f.kind === 'ctx-warning');
  assert.equal(fx.length, 1, '75 warning fires once');
  assert.match(fx[0].text, /compact soon/);
  assert.ok(fx[0].important, 'warning bypasses mute');

  write(0.80);
  assert.equal(reg.poll(T0 + 2).fx.filter(f => f.kind === 'ctx-warning').length, 0, 'not re-fired');

  write(0.92);
  fx = reg.poll(T0 + 3).fx.filter(f => f.kind === 'ctx-warning');
  assert.equal(fx.length, 1, '90 warning fires once');
  assert.match(fx[0].text, /compact now/i);

  write(0.95);
  assert.equal(reg.poll(T0 + 4).fx.filter(f => f.kind === 'ctx-warning').length, 0);

  // simulate /compact: ctx drops below 60 → warnings re-arm
  write(0.30);
  reg.poll(T0 + 5);
  write(0.76);
  fx = reg.poll(T0 + 6).fx.filter(f => f.kind === 'ctx-warning');
  assert.equal(fx.length, 1, 're-armed after dropping below 60');
});

test('two parallel sessions: strip data busiest-first, worst ctx wins', () => {
  const tp1 = tmpTranscript([assistantEntry({ input: 40_000, ts: T0 })]);
  const tp2 = tmpTranscript([assistantEntry({ input: 144_000, ts: T0 })]);
  const reg = new SessionRegistry({});
  startSession(reg, 's1', tp1, 'alpha');
  startSession(reg, 's2', tp2, 'beta');
  reg.poll(T0);
  const sum = reg.summary(T0);
  assert.equal(sum.count, 2);
  assert.equal(sum.sessions[0].project, 'beta', 'busiest first');
  assert.ok(Math.abs(sum.worstPct - 0.72) < 0.01);
});

test('SessionEnd removes from live set; silence kills a session too', () => {
  const tp = tmpTranscript([assistantEntry({ input: 1000, ts: T0 })]);
  const reg = new SessionRegistry({});
  startSession(reg, 's1', tp, 'app');
  reg.poll(T0);
  assert.equal(reg.summary(T0).count, 1);
  reg.noteEvent({ t: 'SessionEnd', ts: T0 + 1000, sid: 's1' });
  assert.equal(reg.summary(T0 + 1000).count, 0);

  startSession(reg, 's2', tp, 'app2');
  assert.equal(reg.summary(T0).count, 1);
  reg.poll(T0 + TUNING.sessionDeadAfterMs + 60_000);
  assert.equal(reg.summary(T0 + TUNING.sessionDeadAfterMs + 60_000).count, 0, 'stale session dropped');
});

test('periodic report only past 40% and at most every 10 min', () => {
  const tp = tmpTranscript([assistantEntry({ input: 100_000, ts: T0 })]);
  const reg = new SessionRegistry({});
  startSession(reg, 's1', tp, 'app');
  let fx = reg.poll(T0).fx.filter(f => f.kind === 'ctx-report');
  assert.equal(fx.length, 1, 'first report');
  // keep session alive with events
  reg.noteEvent({ t: 'Stop', ts: T0 + 5 * 60_000, sid: 's1' });
  fx = reg.poll(T0 + 5 * 60_000).fx.filter(f => f.kind === 'ctx-report');
  assert.equal(fx.length, 0, 'too soon');
  reg.noteEvent({ t: 'Stop', ts: T0 + 11 * 60_000, sid: 's1' });
  fx = reg.poll(T0 + 11 * 60_000).fx.filter(f => f.kind === 'ctx-report');
  assert.equal(fx.length, 1, 'after 10 min');
});

test('persisted transcript offsets prevent token refeed across restarts', () => {
  const tp = tmpTranscript([assistantEntry({ input: 10, output: 5000, ts: T0 })]);
  const offsets = {};
  const reg1 = new SessionRegistry({ transcriptOffsets: offsets });
  startSession(reg1, 's1', tp);
  assert.equal(reg1.poll(T0).outputTokensDelta, 5000);
  // "restart": new registry sharing the persisted offsets object
  const reg2 = new SessionRegistry({ transcriptOffsets: offsets });
  startSession(reg2, 's1', tp);
  assert.equal(reg2.poll(T0 + 1000).outputTokensDelta, 0, 'nothing re-fed');
});

test('unreadable transcript reports nothing (never lies)', () => {
  const reg = new SessionRegistry({});
  startSession(reg, 's1', '/nonexistent/path.jsonl', 'ghost');
  const { fx, outputTokensDelta } = reg.poll(T0);
  assert.equal(outputTokensDelta, 0);
  assert.equal(fx.filter(f => f.kind === 'ctx-warning').length, 0);
  // null, not 0: a context we could not read is unknown, and "unknown" and
  // "empty" are very different claims to put on screen.
  assert.equal(reg.summary(T0).worstPct, null);
  assert.equal(reg.summary(T0).sessions[0].pct, null);
});

test('the window comes from the model, not from one hardcoded number', () => {
  const tp = tmpTranscript([assistantEntry({ input: 300_000, model: 'claude-opus-5', ts: T0 })]);
  const reg = new SessionRegistry({});
  startSession(reg, 's1', tp, 'big');
  reg.poll(T0);
  // 300k against the old flat 200k assumption read as 150% — nonsense the pet
  // would happily have announced.
  assert.equal(Math.round(reg.summary(T0).worstPct * 100), 30);
});

test('a reading bigger than the assumed window raises the window, never passes 100%', () => {
  const tp = tmpTranscript([assistantEntry({ input: 480_000, model: 'some-future-model', ts: T0 })]);
  const reg = new SessionRegistry({});
  startSession(reg, 's1', tp, 'unknown-model');
  reg.poll(T0);
  assert.equal(reg.summary(T0).worstPct, 1, 'a full context is 100%, not 240%');
});

test('a compaction is read from Claude Code\'s own boundary entry', () => {
  const tp = tmpTranscript([
    assistantEntry({ input: 150_000, model: 'claude-opus-5', ts: T0 }),
    boundary({ trigger: 'manual', pre: 152_000, post: 14_000, ts: T0 + 1000 })
  ]);
  const reg = new SessionRegistry({});
  startSession(reg, 's1', tp, 'app');
  reg.poll(T0 + 2000);
  const s = reg.sessions.get('s1');
  assert.equal(s.ctxTokens, 14_000, 'postTokens is the context now — no waiting for the next turn');
});

test('an auto compaction measures the real ceiling and becomes the denominator', () => {
  const ceilings = {};
  const tp = tmpTranscript([
    assistantEntry({ input: 400_000, model: 'claude-opus-5', ts: T0 }),
    boundary({ trigger: 'auto', pre: 402_000, post: 12_000, ts: T0 + 1000 }),
    assistantEntry({ input: 201_000, model: 'claude-opus-5', ts: T0 + 2000 })
  ]);
  const reg = new SessionRegistry({ ctxCeilings: ceilings });
  startSession(reg, 's1', tp, 'app');
  reg.poll(T0 + 3000);
  assert.equal(ceilings['claude-opus-5'], 402_000, 'measured, and persisted for next time');
  // 201k of a measured 402k ceiling — half, not the 20% the table would guess
  assert.equal(Math.round(reg.summary(T0 + 3000).worstPct * 100), 50);
});

test('a restart reads the context back out of the transcript instead of claiming 0%', () => {
  const tp = tmpTranscript([
    assistantEntry({ input: 90_000, output: 400, model: 'claude-opus-5', ts: T0 }),
    assistantEntry({ input: 120_000, output: 700, model: 'claude-opus-5', ts: T0 + 1000 })
  ]);
  // "restart": the byte cursor survived at EOF, the reading did not
  const offsets = { [tp]: fs.statSync(tp).size };
  const reg = new SessionRegistry({ transcriptOffsets: offsets });
  startSession(reg, 's1', tp, 'app');
  const { outputTokensDelta } = reg.poll(T0 + 2000);
  assert.equal(reg.sessions.get('s1').ctxTokens, 120_000, 'the newest turn, read from the tail');
  assert.equal(outputTokensDelta, 0, 'seeding must never re-bank tokens already spent');
});

test('two sessions on one transcript both get the reading', () => {
  const tp = tmpTranscript([assistantEntry({ input: 88_000, model: 'claude-opus-5', ts: T0 })]);
  const reg = new SessionRegistry({});
  startSession(reg, 'a', tp, 'app');
  startSession(reg, 'b', tp, 'app');
  reg.poll(T0);
  assert.equal(reg.sessions.get('a').ctxTokens, 88_000);
  assert.equal(reg.sessions.get('b').ctxTokens, 88_000, 'a byte cursor is spent once — share the result');
});

// ---------------------------------------------------------------- status
// Which session is waiting on the human is the question the pet exists to
// answer, and it is read entirely from the hook stream — no guessing.
const ev = (t, sid, extra = {}, ts = T0) => Object.assign({ t, sid, ts }, extra);

test('status follows the hook stream: working → blocked → answered → done', () => {
  const reg = new SessionRegistry({});
  const ctx = { live: true, now: T0, rng: () => 0.5 };
  reg.noteEvent(ev('SessionStart', 's1', { project: 'app' }), ctx);
  assert.equal(reg.session('s1').status, 'working');

  reg.noteEvent(ev('Notification', 's1', { msg: 'Claude needs your permission to use Bash' }), ctx);
  assert.equal(reg.session('s1').status, 'perm', 'a permission ask is a block, not a nudge');
  assert.equal(reg.summary(T0).needsYou, true);

  // …answering it is any event at all from that session
  reg.noteEvent(ev('PostToolUse', 's1', { tool: 'Bash' }), ctx);
  assert.equal(reg.session('s1').status, 'working');
  assert.equal(reg.summary(T0).needsYou, false);

  reg.noteEvent(ev('Notification', 's1', { msg: 'Claude is waiting for your input' }), ctx);
  assert.equal(reg.session('s1').status, 'idle', 'an idle nudge is not a permission gate');
  assert.equal(reg.summary(T0).needsYou, false, 'only a real block wears the badge');

  reg.noteEvent(ev('Stop', 's1'), ctx);
  assert.equal(reg.session('s1').status, 'done');

  // a subagent finishing is NOT the turn finishing
  reg.noteEvent(ev('UserPromptSubmit', 's1'), ctx);
  reg.noteEvent(ev('SubagentStop', 's1'), ctx);
  assert.equal(reg.session('s1').status, 'working', 'a helper coming home is not your turn');
});

test('a finished turn announces itself by project, once, and never on a replay', () => {
  const reg = new SessionRegistry({});
  const ctx = (now, live = true) => ({ live, now, rng: () => 0.5 });
  reg.noteEvent(ev('SessionStart', 's1', { project: 'claudy-pet' }), ctx(T0));

  const fx = reg.noteEvent(ev('Stop', 's1', {}, T0 + 1000), ctx(T0 + 1000));
  const bubble = fx.find(f => f.type === 'bubble');
  assert.ok(bubble, 'the end of a turn is the news the pet exists for');
  assert.match(bubble.text, /^claudy-pet · /, 'which session finished is the whole point');
  assert.match(bubble.text, /✓$/);
  assert.ok(!bubble.important, 'every turn ending in amber would be a siren, not a signal');

  // Stop again inside the cooldown: silence (but the status still holds)
  const again = reg.noteEvent(ev('Stop', 's1', {}, T0 + 2000), ctx(T0 + 2000));
  assert.equal(again.length, 0, 'no repeat announcement inside the cooldown');
  assert.equal(reg.session('s1').status, 'done');

  // …and a backlog replayed at startup announces nothing at all
  const cold = new SessionRegistry({});
  cold.noteEvent(ev('SessionStart', 's2', { project: 'old' }), ctx(T0, false));
  assert.deepEqual(cold.noteEvent(ev('Stop', 's2'), ctx(T0, false)), [],
    'a day-old log must not shout about turns that ended yesterday');
});
