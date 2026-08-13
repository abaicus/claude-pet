'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'src', 'capture', 'hook.js');

function runHook(payload, dir) {
  execFileSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: Object.assign({}, process.env, { CLAUDE_PET_DIR: dir }),
    timeout: 5000
  });
}
function readEvents(dir) {
  return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pet-hook-')); }

test('hook appends a compact event line and exits 0', () => {
  const dir = tmpDir();
  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 'abc-123',
    cwd: '/Users/me/projects/cool-app',
    transcript_path: '/Users/me/.claude/projects/x/abc.jsonl',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "hello"' },
    tool_response: { stdout: 'done', stderr: '' }
  }, dir);
  const [ev] = readEvents(dir);
  assert.equal(ev.t, 'PostToolUse');
  assert.equal(ev.sid, 'abc-123');
  assert.equal(ev.project, 'cool-app');
  assert.equal(ev.tool, 'Bash');
  assert.equal(ev.cmd, 'git commit -m "hello"');
  assert.ok(typeof ev.ts === 'number');
  assert.ok(JSON.stringify(ev).length < 1000, 'payload stays tiny');
});

test('hook survives garbage stdin (exit 0, still logs a line)', () => {
  const dir = tmpDir();
  runHook('this is not json{{{', dir); // throws if exit != 0
  const [ev] = readEvents(dir);
  assert.equal(ev.t, 'Unknown');
});

test('hook captures notification messages', () => {
  const dir = tmpDir();
  runHook({
    hook_event_name: 'Notification',
    session_id: 's',
    message: 'Claude needs your permission to use Bash'
  }, dir);
  const [ev] = readEvents(dir);
  assert.equal(ev.t, 'Notification');
  assert.match(ev.msg, /permission/);
});

test('hook keeps output TAIL where test summaries live, and truncates', () => {
  const dir = tmpDir();
  const noise = 'x'.repeat(5000);
  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 's',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: noise + '\nTests:       27 passed, 27 total', stderr: '' }
  }, dir);
  const [ev] = readEvents(dir);
  assert.ok(ev.out.length <= 700);
  assert.match(ev.out, /27 passed/);
});

test('hook flags failed tools', () => {
  const dir = tmpDir();
  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 's',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: '', stderr: 'boom', exit_code: 1 }
  }, dir);
  const [ev] = readEvents(dir);
  assert.equal(ev.ok, false);
});

test('multiple invocations append, never clobber', () => {
  const dir = tmpDir();
  runHook({ hook_event_name: 'SessionStart', session_id: 'a' }, dir);
  runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'a' }, dir);
  runHook({ hook_event_name: 'SessionEnd', session_id: 'a' }, dir);
  const evs = readEvents(dir);
  assert.deepEqual(evs.map(e => e.t), ['SessionStart', 'UserPromptSubmit', 'SessionEnd']);
});
