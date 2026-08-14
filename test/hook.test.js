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
    env: Object.assign({}, process.env, { GOGU_DIR: dir }),
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

// ---------------------------------------------------------------- detail
test('hook measures the edit, not the file', () => {
  const dir = tmpDir();
  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 's',
    tool_name: 'Edit',
    tool_input: {
      file_path: '/x/src/Thing.tsx',
      old_string: 'a\nb\nc',
      new_string: 'a\nb\nc\nd\ne'
    }
  }, dir);
  const [ev] = readEvents(dir);
  assert.equal(ev.file, 'Thing.tsx');
  assert.equal(ev.ext, 'tsx');
  assert.equal(ev.add, 5);
  assert.equal(ev.del, 3);
});

test('hook sums a MultiEdit across its edits', () => {
  const dir = tmpDir();
  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 's',
    tool_name: 'MultiEdit',
    tool_input: {
      file_path: '/x/a.py',
      edits: [
        { old_string: '1', new_string: '1\n2' },
        { old_string: 'x\ny', new_string: 'x' }
      ]
    }
  }, dir);
  const [ev] = readEvents(dir);
  assert.equal(ev.add, 3);
  assert.equal(ev.del, 3);
  assert.equal(ev.ext, 'py');
});

test('hook records todo counts, subagent type, fetch host and MCP server', () => {
  const dir = tmpDir();
  const post = (tool_name, tool_input) =>
    runHook({ hook_event_name: 'PostToolUse', session_id: 's', tool_name, tool_input }, dir);
  post('TodoWrite', { todos: [
    { status: 'completed' }, { status: 'completed' },
    { status: 'in_progress' }, { status: 'pending' }
  ] });
  post('Task', { subagent_type: 'Explore', description: 'look around' });
  post('WebFetch', { url: 'https://docs.claude.com/en/docs/hooks?x=1#y' });
  post('mcp__sanity__query_documents', { query: '*' });
  const [todo, task, web, mcp] = readEvents(dir);
  assert.deepEqual(todo.todo, { n: 4, d: 2, p: 1 });
  assert.equal(task.agent, 'Explore');
  assert.equal(web.host, 'docs.claude.com');
  assert.equal(mcp.srv, 'sanity');
});

test('hook keeps the prompt\'s length and not one character of the prompt', () => {
  const dir = tmpDir();
  const secret = 'my database password is hunter2 and here is a very long question about it';
  runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: secret }, dir);
  const line = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  const [ev] = readEvents(dir);
  assert.equal(ev.plen, secret.length);
  assert.ok(!line.includes('hunter2'), 'the prompt text must never reach disk');
  assert.ok(!line.includes('password'));
});

test('hook records the permission mode and Claude\'s own command description', () => {
  const dir = tmpDir();
  runHook({
    hook_event_name: 'PreToolUse',
    session_id: 's',
    permission_mode: 'plan',
    tool_name: 'Bash',
    tool_input: { command: 'ls -la', description: 'List files in the repo' }
  }, dir);
  const [ev] = readEvents(dir);
  assert.equal(ev.pm, 'plan');
  assert.equal(ev.desc, 'List files in the repo');
});

test('a large Write still parses — the payload cap must not blind the pet', () => {
  const dir = tmpDir();
  const big = ('const x = 1;\n').repeat(30_000);   // ~360KB, over the old 256KB cap
  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 's',
    tool_name: 'Write',
    tool_input: { file_path: '/x/big.js', content: big }
  }, dir);
  const [ev] = readEvents(dir);
  assert.equal(ev.tool, 'Write');
  assert.equal(ev.add, 30_001);
  assert.ok(JSON.stringify(ev).length < 1000, 'the event stays tiny regardless');
});
