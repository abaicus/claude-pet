#!/usr/bin/env node
'use strict';
// claude-pet hook script — standalone, zero deps, fire-and-forget.
//
// Claude Code invokes this for every hooked event with a JSON payload on
// stdin. We append one tiny JSON line to ~/.claude-pet/events.jsonl and get
// out of the way. Hard rules: never block, never fail the session — every
// path exits 0, no network, no waiting on the app.

const fs = require('fs');
const os = require('os');
const path = require('path');

// A Write of a large file arrives as one big payload. The old 256KB cap
// truncated it mid-JSON, so the parse failed and the event lost its tool name
// entirely — the pet went blind on exactly the biggest edits.
const MAX_STDIN = 2 * 1024 * 1024;
const STDIN_TIMEOUT_MS = 1500;     // never hang a session waiting on stdin

function petDir() {
  return process.env.CLAUDE_PET_DIR || path.join(os.homedir(), '.claude-pet');
}

function clip(s, n) {
  if (typeof s !== 'string') return undefined;
  s = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s.length > n ? s.slice(s.length - n) : s; // keep the TAIL (test summaries live there)
}
function clipHead(s, n) {
  if (typeof s !== 'string') return undefined;
  return s.length > n ? s.slice(0, n) : s;
}

function extractOutputTail(resp) {
  if (resp == null) return undefined;
  if (typeof resp === 'string') return clip(resp, 700);
  if (typeof resp === 'object') {
    const parts = [];
    if (typeof resp.stdout === 'string') parts.push(resp.stdout);
    if (typeof resp.stderr === 'string') parts.push(resp.stderr);
    if (parts.length === 0 && typeof resp.output === 'string') parts.push(resp.output);
    if (parts.length === 0) return undefined;
    return clip(parts.join('\n'), 700);
  }
  return undefined;
}

// Count newlines without split()'s allocation — these strings can be a whole
// file, and this runs inside somebody's coding session.
function lineCount(s) {
  if (typeof s !== 'string' || s === '') return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// Lines the edit itself carries — NOT a git diff. An Edit that rewrites a
// 10-line block counts 10 in and 10 out; the brain labels the total `~`
// because of exactly that.
function editSize(tool, input) {
  let add = 0, del = 0;
  if (tool === 'Write') add = lineCount(input.content);
  else if (tool === 'NotebookEdit') add = lineCount(input.new_source);
  else if (tool === 'Edit') { add = lineCount(input.new_string); del = lineCount(input.old_string); }
  else if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (!e) continue;
      add += lineCount(e.new_string);
      del += lineCount(e.old_string);
    }
  }
  return add || del ? { add, del } : null;
}

function todoCounts(input) {
  if (!Array.isArray(input.todos)) return undefined;
  let done = 0, doing = 0;
  for (const t of input.todos) {
    if (!t) continue;
    if (t.status === 'completed') done++;
    else if (t.status === 'in_progress') doing++;
  }
  return { n: input.todos.length, d: done, p: doing };
}

function hostOf(url) {
  if (typeof url !== 'string') return undefined;
  const m = /^https?:\/\/([^/?#\s]+)/i.exec(url);
  return m ? clipHead(m[1], 60) : undefined;
}

function looksFailed(resp) {
  if (resp == null) return false;
  if (typeof resp !== 'object') return false;
  if (resp.success === false) return true;
  if (resp.is_error === true || resp.isError === true) return true;
  if (typeof resp.exit_code === 'number' && resp.exit_code !== 0) return true;
  if (typeof resp.exitCode === 'number' && resp.exitCode !== 0) return true;
  if (resp.interrupted === true) return true;
  return false;
}

function buildRecord(payload) {
  const rec = {
    ts: Date.now(),
    t: payload.hook_event_name || 'Unknown',
    sid: clipHead(payload.session_id, 64)
  };
  if (payload.cwd) {
    rec.cwd = clipHead(payload.cwd, 300);
    rec.project = path.basename(payload.cwd);
  }
  if (payload.transcript_path) rec.tp = clipHead(payload.transcript_path, 400);

  // The permission mode the session is in ("plan", "acceptEdits",
  // "bypassPermissions"…). The pet reacts to CHANGES, never to the value.
  if (typeof payload.permission_mode === 'string') rec.pm = clipHead(payload.permission_mode, 24);

  const tool = payload.tool_name;
  if (tool) {
    rec.tool = clipHead(tool, 80);
    const input = payload.tool_input || {};
    if (tool === 'Bash' && typeof input.command === 'string') {
      rec.cmd = clipHead(input.command, 400);
      // Claude writes its own one-line summary of every command it runs.
      if (typeof input.description === 'string') rec.desc = clipHead(input.description, 60);
    }
    const filePath = typeof input.file_path === 'string' ? input.file_path
      : (typeof input.notebook_path === 'string' ? input.notebook_path : null);
    if (filePath) {
      rec.file = clipHead(path.basename(filePath), 120);
      const ext = /\.([A-Za-z0-9]{1,8})$/.exec(rec.file);
      if (ext) rec.ext = ext[1].toLowerCase();
    }
    const size = editSize(tool, input);
    if (size) { rec.add = size.add; rec.del = size.del; }
    if (tool === 'TodoWrite') {
      const todo = todoCounts(input);
      if (todo) rec.todo = todo;
    }
    if (tool === 'Task' && typeof input.subagent_type === 'string') {
      rec.agent = clipHead(input.subagent_type, 40);
    }
    if (tool === 'WebFetch') {
      const host = hostOf(input.url);
      if (host) rec.host = host;
    }
    if (tool.startsWith('mcp__')) {
      const srv = tool.split('__')[1];
      if (srv) rec.srv = clipHead(srv, 40);
    }
  }
  if (payload.hook_event_name === 'PostToolUse') {
    const out = extractOutputTail(payload.tool_response);
    if (out) rec.out = out;
    if (looksFailed(payload.tool_response)) rec.ok = false;
  }
  // The prompt's LENGTH, never the prompt. The pet has opinions about big
  // asks; it has no business keeping a copy of what you typed.
  if (typeof payload.prompt === 'string') rec.plen = payload.prompt.length;
  if (typeof payload.message === 'string') rec.msg = clipHead(payload.message, 400);
  if (typeof payload.trigger === 'string') rec.trigger = clipHead(payload.trigger, 40);
  if (typeof payload.reason === 'string') rec.reason = clipHead(payload.reason, 120);
  if (typeof payload.source === 'string') rec.source = clipHead(payload.source, 40);
  return rec;
}

function main() {
  let done = false;
  const finish = (payload) => {
    if (done) return;
    done = true;
    try {
      const dir = petDir();
      fs.mkdirSync(dir, { recursive: true });
      const rec = buildRecord(payload || {});
      fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(rec) + '\n');
    } catch (_) { /* never fail the session */ }
    process.exit(0);
  };

  const timer = setTimeout(() => finish({}), STDIN_TIMEOUT_MS);
  timer.unref && timer.unref();

  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (raw.length < MAX_STDIN) raw += chunk;
    });
    process.stdin.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw); } catch (_) { /* keep {} */ }
      clearTimeout(timer);
      finish(payload);
    });
    process.stdin.on('error', () => { clearTimeout(timer); finish({}); });
  } catch (_) {
    clearTimeout(timer);
    finish({});
  }
}

main();
