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

const MAX_STDIN = 256 * 1024;      // safety cap; payloads are normally small
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

  const tool = payload.tool_name;
  if (tool) {
    rec.tool = clipHead(tool, 80);
    const input = payload.tool_input || {};
    if (tool === 'Bash' && typeof input.command === 'string') {
      rec.cmd = clipHead(input.command, 400);
    }
    if (typeof input.file_path === 'string') rec.file = clipHead(path.basename(input.file_path), 120);
  }
  if (payload.hook_event_name === 'PostToolUse') {
    const out = extractOutputTail(payload.tool_response);
    if (out) rec.out = out;
    if (looksFailed(payload.tool_response)) rec.ok = false;
  }
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
