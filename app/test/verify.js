#!/usr/bin/env node
// Sandbox verification for claude-pet. Runs against a throwaway HOME so it can
// never touch your real ~/.claude/settings.json.
//
//   node test/verify.js
//
// Covers: the settings.json merge (idempotent / preserving / repairing /
// refusing), the generated hook script, and the renderer's test-run parser.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Module = require("module");

let pass = 0;
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push("  ok   " + name);
    pass++;
  } catch (e) {
    results.push("  FAIL " + name + "\n         " + (e.message || e).split("\n").join("\n         "));
  }
}

/* ---------- sandbox HOME + a fake electron module ---------- */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pet-test-"));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
delete process.env.CLAUDE_PET_NODE;

const noop = () => {};
const fakeElectron = {
  app: { whenReady: () => new Promise(noop), on: noop, quit: noop, dock: null },
  BrowserWindow: function () {},
  Menu: { buildFromTemplate: () => ({ popup: noop }) },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440 } }) },
  ipcMain: { on: noop },
  dialog: { showErrorBox: noop },
  globalShortcut: { register: noop, unregisterAll: noop },
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  return realLoad.call(this, request, ...rest);
};

const pet = require(path.join(__dirname, "..", "main.js"));
const SETTINGS = path.join(SANDBOX, ".claude", "settings.json");
const HOOK_FILE = path.join(SANDBOX, ".claude-pet", "pet-hook.js");
const EVENTS = path.join(SANDBOX, ".claude-pet", "events.jsonl");

const readSettings = () => JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
const writeSettings = (o) => {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, typeof o === "string" ? o : JSON.stringify(o, null, 2));
};
const resetSettings = () => { try { fs.rmSync(SETTINGS); } catch (e) {} };
const ourHooks = (s) =>
  Object.values(s.hooks || {})
    .flat()
    .flatMap((g) => g.hooks || [])
    .filter((h) => String(h.command).includes("pet-hook.js"));
const userHooks = (s) =>
  Object.values(s.hooks || {})
    .flat()
    .flatMap((g) => g.hooks || [])
    .filter((h) => !String(h.command).includes("pet-hook.js"));

/* ---------- installer ---------- */

console.log("\ninstaller");

test("installs into a home with no settings.json at all", () => {
  resetSettings();
  const r = pet.installHooks();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, true);
  const s = readSettings();
  assert.strictEqual(ourHooks(s).length, pet.HOOK_EVENTS.length, "one entry per event");
  for (const ev of pet.HOOK_EVENTS) assert.ok(s.hooks[ev], "missing " + ev);
});

test("registers PostToolUseFailure (the event the pet sulks on)", () => {
  assert.ok(pet.HOOK_EVENTS.includes("PostToolUseFailure"));
  assert.ok(readSettings().hooks.PostToolUseFailure);
});

test("tool events get a matcher, non-tool events do not", () => {
  const s = readSettings();
  assert.strictEqual(s.hooks.PostToolUse[0].matcher, "*");
  assert.strictEqual(s.hooks.PostToolUseFailure[0].matcher, "*");
  assert.strictEqual(s.hooks.SessionStart[0].matcher, undefined);
});

test("hooks are async so they can never block a tool call", () => {
  for (const h of ourHooks(readSettings())) {
    assert.strictEqual(h.async, true);
    assert.strictEqual(typeof h.timeout, "number");
  }
});

test("hook command uses an absolute, working node binary", () => {
  const cmd = ourHooks(readSettings())[0].command;
  const bin = cmd.match(/^"([^"]+)"/)[1];
  assert.ok(path.isAbsolute(bin), "not absolute: " + bin);
  execFileSync(bin, ["--version"], { stdio: "ignore" });
});

test("double install is idempotent", () => {
  const before = fs.readFileSync(SETTINGS, "utf8");
  const r = pet.installHooks();
  assert.strictEqual(r.changed, false, "second install reported a change");
  assert.strictEqual(fs.readFileSync(SETTINGS, "utf8"), before, "file was rewritten");
});

test("preserves user hooks, user hook groups, and unrelated settings keys", () => {
  resetSettings();
  writeSettings({
    model: "opus",
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff", async: true }] }],
      PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "./lint.sh", timeout: 3 }] }],
      Notification: [{ hooks: [{ type: "command", command: "./notify.sh" }] }],
    },
  });
  pet.installHooks();
  const s = readSettings();
  assert.strictEqual(s.model, "opus");
  assert.deepStrictEqual(s.permissions, { allow: ["Bash(ls:*)"] });
  assert.strictEqual(userHooks(s).length, 3, "user hooks lost");
  assert.strictEqual(s.hooks.PostToolUse[0].matcher, "Edit|Write", "user matcher mangled");
  assert.strictEqual(s.hooks.PostToolUse[0].hooks[0].timeout, 3, "user timeout mangled");
  assert.strictEqual(s.hooks.Notification.length, 1, "untouched event modified");
  assert.strictEqual(ourHooks(s).length, pet.HOOK_EVENTS.length);
});

test("backs up settings.json before writing", () => {
  assert.ok(fs.existsSync(SETTINGS + ".pet-backup"));
  assert.ok(JSON.parse(fs.readFileSync(SETTINGS + ".pet-backup", "utf8")));
});

test("repairs its own stale entry when the node path moves", () => {
  const s = readSettings();
  const stale = s.hooks.SessionStart.find((g) => g.hooks.some((h) => String(h.command).includes("pet-hook.js")));
  stale.hooks[0].command = 'node "/old/nvm/path/.claude-pet/pet-hook.js"';
  delete stale.hooks[0].async;
  writeSettings(s);

  const r = pet.installHooks();
  assert.strictEqual(r.changed, true, "stale entry not repaired");
  const after = readSettings();
  assert.strictEqual(ourHooks(after).length, pet.HOOK_EVENTS.length, "duplicate entry added");
  for (const h of ourHooks(after)) {
    assert.ok(h.command.includes(SANDBOX), "still pointing at the old path");
    assert.strictEqual(h.async, true);
  }
});

test("refuses to write when settings.json is not valid JSON", () => {
  resetSettings();
  const broken = '{ "hooks": { oops not json';
  writeSettings(broken);
  const r = pet.installHooks();
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(SETTINGS, "utf8"), broken, "clobbered an unparseable file!");
});

test("uninstall removes only claude-pet entries", () => {
  resetSettings();
  writeSettings({
    model: "opus",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "afplay Glass.aiff" }] }],
      Notification: [{ hooks: [{ type: "command", command: "./notify.sh" }] }],
    },
  });
  pet.installHooks();
  const r = pet.uninstallHooks();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, true);
  const s = readSettings();
  assert.strictEqual(ourHooks(s).length, 0, "pet entries left behind");
  assert.strictEqual(userHooks(s).length, 2, "user hooks removed");
  assert.strictEqual(s.model, "opus");
  assert.ok(s.hooks.Stop && s.hooks.Notification, "user events deleted");
  assert.ok(!("PostToolUse" in s.hooks), "empty pet-only event left behind");
});

test("uninstall is safe to run twice and on a clean file", () => {
  const before = fs.readFileSync(SETTINGS, "utf8");
  const r = pet.uninstallHooks();
  assert.strictEqual(r.changed, false);
  assert.strictEqual(fs.readFileSync(SETTINGS, "utf8"), before);
});

test("uninstall refuses on invalid JSON", () => {
  writeSettings("{ nope");
  const r = pet.uninstallHooks();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.readFileSync(SETTINGS, "utf8"), "{ nope");
});

/* ---------- window chrome: tray icon, scale, menu ---------- */

test("tray mask is a well-formed 16x16 grid", () => {
  assert.strictEqual(pet.TRAY_MASK.length, 16);
  for (const row of pet.TRAY_MASK) {
    assert.strictEqual(row.length, 16, "bad row width: " + row);
    assert.ok(/^[.X]+$/.test(row), "unexpected char in: " + row);
  }
});

test("dragging does not rely on a CSS drag region", () => {
  // Every element in the window is absolutely positioned, so the body carrying
  // `-webkit-app-region: drag` is a zero-height box and the region has no area.
  // The pet was undraggable for exactly this reason; main moves the window now.
  const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  // Only real declarations count — the comments explaining this deliberately
  // name the property.
  const css = src.slice(src.indexOf("<style>"), src.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/-webkit-app-region:\s*drag\s*;/.test(css), "CSS drag region is back — it silently does nothing here");
  assert.ok(src.includes("pet-drag-start") && src.includes("pet-drag-end"), "drag IPC missing");
  assert.ok(/e\.button\s*!==\s*0/.test(src), "left-button check missing; right-click would start a drag");
});

test("scale clamps to the supported range and survives garbage", () => {
  assert.strictEqual(pet.clampScale(1.4), 1.4);
  assert.strictEqual(pet.clampScale(99), pet.SCALE_MAX);
  assert.strictEqual(pet.clampScale(0.01), pet.SCALE_MIN);
  for (const junk of [undefined, null, NaN, "", "abc", {}]) {
    assert.strictEqual(pet.clampScale(junk), 1, "bad fallback for " + JSON.stringify(junk));
  }
});

test("tray and right-click share one lean menu; sizing/sound live in settings", () => {
  const labels = pet.menuTemplate().map((i) => i.label || i.type);
  for (const want of ["Settings", "click-through", "Reinstall", "Uninstall", "Quit"]) {
    assert.ok(labels.some((l) => String(l).includes(want)), "menu is missing " + want + ": " + labels.join(" | "));
  }
  for (const gone of ["Size", "Reset size", "Level-up sounds"]) {
    assert.ok(!labels.some((l) => String(l).includes(gone)), gone + " belongs in the settings window now");
  }
});

/* ---------- generated hook script ---------- */

console.log("installer: " + pass + " passed\n\nhook script");

resetSettings();
pet.installHooks();

function runHook(payload) {
  try { fs.rmSync(EVENTS); } catch (e) {}
  const started = Date.now();
  const out = execFileSync(process.execPath, [HOOK_FILE], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10000,
  });
  const ms = Date.now() - started;
  const lines = fs.existsSync(EVENTS)
    ? fs.readFileSync(EVENTS, "utf8").split("\n").filter((l) => l.trim())
    : [];
  return { ms, stdout: out, records: lines.map((l) => JSON.parse(l)) };
}

test("emits a compact record for a PostToolUse Bash event", () => {
  const r = runHook({
    hook_event_name: "PostToolUse",
    session_id: "sess-1",
    cwd: "/tmp/proj",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { stdout: "Tests: 12 passed, 12 total", stderr: "", interrupted: false },
  });
  assert.strictEqual(r.records.length, 1);
  const rec = r.records[0];
  assert.strictEqual(rec.hook_event_name, "PostToolUse");
  assert.strictEqual(rec.tool_name, "Bash");
  assert.strictEqual(rec.command, "npm test");
  assert.match(rec.output, /12 passed/);
  assert.strictEqual(typeof rec.ts, "number");
});

test("carries the error text on PostToolUseFailure", () => {
  const r = runHook({
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "pytest" },
    error: "Command failed with exit code 1\n=== 2 failed, 10 passed in 0.42s ===",
  });
  assert.match(r.records[0].error, /2 failed, 10 passed/);
});

test("does NOT carry file contents from Write/Edit (log stays small)", () => {
  const huge = "x".repeat(200000);
  const r = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/big.txt", content: huge },
    tool_response: { filePath: "/tmp/big.txt", content: huge },
  });
  const size = fs.statSync(EVENTS).size;
  assert.ok(size < 1000, "record is " + size + " bytes; payload leaked into the log");
  assert.strictEqual(r.records[0].tool_name, "Write");
});

test("truncates giant Bash output but keeps the tail (summaries live there)", () => {
  const noise = "spam\n".repeat(50000);
  const r = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { stdout: noise + "Tests: 3 failed, 9 passed, 12 total" },
  });
  assert.ok(r.records[0].output.length <= 3000, "not truncated");
  assert.match(r.records[0].output, /3 failed, 9 passed/, "tail was cut off");
});

test("exits 0 and stays quiet on malformed stdin", () => {
  const r = runHook("this is not json at all");
  assert.strictEqual(r.stdout, "", "wrote to stdout");
  assert.strictEqual(r.records.length, 0);
});

test("exits 0 on empty stdin", () => {
  const r = runHook("");
  assert.strictEqual(r.stdout, "");
});

test("carries transcript_path so the app can read usage (the hook never does)", () => {
  const r = runHook({ hook_event_name: "Stop", session_id: "s", transcript_path: "/tmp/x/tr.jsonl" });
  assert.strictEqual(r.records[0].transcript_path, "/tmp/x/tr.jsonl");
});

test("is fast enough to sit in front of every tool call", () => {
  const r = runHook({ hook_event_name: "Stop" });
  assert.ok(r.ms < 1000, "took " + r.ms + "ms");
});

test("appends rather than overwriting, one line per event", () => {
  try { fs.rmSync(EVENTS); } catch (e) {}
  for (let i = 0; i < 5; i++) {
    execFileSync(process.execPath, [HOOK_FILE], {
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "s" + i }),
      timeout: 10000,
    });
  }
  const lines = fs.readFileSync(EVENTS, "utf8").split("\n").filter((l) => l.trim());
  assert.strictEqual(lines.length, 5);
  assert.deepStrictEqual(lines.map((l) => JSON.parse(l).session_id), ["s0", "s1", "s2", "s3", "s4"]);
});

/* ---------- renderer: test-run awareness ---------- */

console.log("hook script: " + pass + " passed\n\ntest-run detection");

// Lift the test-awareness block straight out of index.html so we exercise the
// exact source that ships, not a copy.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const START = "/* ---------- test-run awareness ---------- */";
const END = "/* ---------- event ingestion ---------- */";
const block = html.slice(html.indexOf(START), html.indexOf(END));
assert.ok(block.includes("parseTests"), "could not lift the test-awareness block from index.html");
const { isTestCmd, parseTests } = new Function(block + "\nreturn { isTestCmd, parseTests };")();

test("recognizes test commands across ecosystems", () => {
  const yes = [
    "npm test", "npm run test", "npm run test:unit", "pnpm test", "yarn test", "bun test",
    "npx jest src/", "npx vitest run", "npx playwright test", "jest --coverage",
    "pytest -q", "python -m pytest tests/", "python3 -m unittest discover", "tox",
    "go test ./...", "cargo test", "cargo nextest run", "bundle exec rspec",
    "phpunit --colors", "mvn -q verify test", "./gradlew test", "dotnet test",
    "swift test", "mix test", "ctest --output-on-failure",
    "cd /some/dir && npm test",
  ];
  const no = [
    "git commit -m 'wip'", "ls -la", "npm install", "npm run build", "cargo build",
    "go build ./...", "cat README.md", "grep -r TODO .", "npm run lint",
  ];
  for (const c of yes) assert.ok(isTestCmd(c), "missed: " + c);
  for (const c of no) assert.ok(!isTestCmd(c), "false positive: " + c);
});

test("parses a green jest/vitest run", () => {
  const r = parseTests("Test Suites: 4 passed, 4 total\nTests:       27 passed, 27 total\nTime: 2.1 s");
  assert.strictEqual(r.passed, 27);
  assert.strictEqual(r.failed, 0);
  assert.strictEqual(r.ok, true);
});

test("parses a red jest/vitest run", () => {
  const r = parseTests("Tests:       3 failed, 24 passed, 27 total\nTime: 2.4 s");
  assert.strictEqual(r.failed, 3);
  assert.strictEqual(r.passed, 24);
  assert.strictEqual(r.ok, false);
});

test("parses vitest (no colon after the label)", () => {
  const g = parseTests(" Test Files  4 passed (4)\n      Tests  27 passed (27)\n   Duration  1.20s");
  assert.strictEqual(g.passed, 27, "picked up the Test Files count instead");
  assert.strictEqual(g.ok, true);
  const r = parseTests(" Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 25 passed (27)");
  assert.strictEqual(r.failed, 2);
  assert.strictEqual(r.ok, false);
});

test("parses pytest", () => {
  assert.deepStrictEqual(parseTests("==== 10 passed in 0.42s ===="), { passed: 10, failed: null, ok: true });
  const red = parseTests("==== 2 failed, 10 passed in 0.42s ====");
  assert.strictEqual(red.failed, 2);
  assert.strictEqual(red.ok, false);
});

test("parses cargo", () => {
  const g = parseTests("test result: ok. 12 passed; 0 failed; 0 ignored");
  assert.strictEqual(g.passed, 12);
  assert.strictEqual(g.ok, true);
  const r = parseTests("test result: FAILED. 9 passed; 3 failed; 0 ignored");
  assert.strictEqual(r.failed, 3);
  assert.strictEqual(r.ok, false);
});

test("parses go test", () => {
  assert.strictEqual(parseTests("ok  \tgithub.com/x/y\t0.31s").ok, true);
  assert.strictEqual(parseTests("--- FAIL: TestThing (0.00s)\nFAIL\nexit status 1").ok, false);
});

test("returns ok=null when it genuinely cannot tell", () => {
  assert.strictEqual(parseTests("").ok, null);
  assert.strictEqual(parseTests("some unrelated chatter").ok, null);
});

/* ---------- renderer: session awareness ---------- */

console.log("test-run detection: " + pass + " passed\n\nsession awareness & customization");

// Same lift-the-shipped-source trick: the pure half of the session-awareness
// block runs in plain Node (path is its only outside dependency).
const SA_START = "/* ---------- session awareness (pure) ---------- */";
const SA_END = "/* ---------- session awareness (io) ---------- */";
const saBlock = html.slice(html.indexOf(SA_START), html.indexOf(SA_END));
assert.ok(saBlock.includes("usageFromLine"), "could not lift the session-awareness block from index.html");
const sa = new Function(
  "path",
  saBlock + "\nreturn { SESSIONS, trackSession, activeSessions, usageFromLine, fmtTokens, shortModel, proj };"
)(path);

test("parses token usage out of a real transcript line", () => {
  const line = JSON.stringify({
    parentUuid: "x",
    message: {
      model: "claude-fable-5", id: "msg_01", type: "message", role: "assistant", content: [],
      usage: { input_tokens: 2, cache_creation_input_tokens: 17997, cache_read_input_tokens: 48495, output_tokens: 381 },
    },
    type: "assistant", uuid: "u1", timestamp: "2026-08-13T09:36:25.232Z",
  });
  const u = sa.usageFromLine(line);
  assert.ok(u, "line not recognized");
  assert.strictEqual(u.id, "msg_01");
  assert.strictEqual(u.ctx, 2 + 17997 + 48495, "context = input + both cache buckets");
  assert.strictEqual(u.out, 381);
  assert.strictEqual(u.model, "claude-fable-5");
  assert.strictEqual(u.t, Date.parse("2026-08-13T09:36:25.232Z"));
});

test("ignores non-assistant lines, junk, and a line torn mid-append", () => {
  assert.strictEqual(sa.usageFromLine(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })), null);
  assert.strictEqual(sa.usageFromLine('{"type":"assistant","message":{"usage"'), null);
  assert.strictEqual(sa.usageFromLine("total garbage"), null);
  assert.strictEqual(sa.usageFromLine(""), null);
});

test("tracks sessions across start / end / resume", () => {
  sa.trackSession({ session_id: "s1", cwd: "/tmp/projA", hook_event_name: "SessionStart", transcript_path: "/tmp/t.jsonl" });
  sa.trackSession({ session_id: "s2", cwd: "/tmp/projB", hook_event_name: "PostToolUse" });
  assert.strictEqual(sa.activeSessions().length, 2);
  sa.trackSession({ session_id: "s2", hook_event_name: "SessionEnd" });
  assert.strictEqual(sa.activeSessions().length, 1, "ended session still counted");
  sa.trackSession({ session_id: "s2", hook_event_name: "SessionStart" }); // resumed
  assert.strictEqual(sa.activeSessions().length, 2, "resumed session not revived");
  assert.strictEqual(sa.proj(sa.SESSIONS.get("s1")), "projA");
  assert.strictEqual(sa.SESSIONS.get("s1").transcript, "/tmp/t.jsonl");
});

test("formats tokens and model names the way a pixel bubble wants them", () => {
  assert.strictEqual(sa.fmtTokens(512), "512");
  assert.strictEqual(sa.fmtTokens(51200), "51k");
  assert.strictEqual(sa.fmtTokens(1000000), "1M");
  assert.strictEqual(sa.fmtTokens(2340000), "2.3M");
  assert.strictEqual(sa.shortModel("claude-fable-5"), "fable-5");
  assert.strictEqual(sa.shortModel("claude-opus-4-1-20250805"), "opus-4-1");
});

/* ---------- renderer: customization ---------- */

// The customization block only leans on S (merged state); hand it an empty one.
const C_START = "/* ---------- customization ---------- */";
const custBlock = html.slice(html.indexOf(C_START), html.indexOf("const IDLE_MS"));
assert.ok(custBlock.includes("PALETTES"), "could not lift the customization block from index.html");
const cust = new Function("S", custBlock + "\nreturn { PALETTES, ACCESSORIES, CUSTOM_DEFAULTS };")({});

test("every palette is a 4-step ramp of hex colors (stages 1-4)", () => {
  for (const [id, ramp] of Object.entries(cust.PALETTES)) {
    assert.strictEqual(ramp.length, 4, id + " is not a 4-ramp");
    for (const c of ramp) assert.match(c, /^#[0-9a-f]{6}$/i, id + " has a bad color: " + c);
  }
  assert.ok(cust.PALETTES[cust.CUSTOM_DEFAULTS.palette], "default palette does not exist");
});

test("accessories: unique ids, 'none' is free, every lock is reachable", () => {
  const ids = cust.ACCESSORIES.map((a) => a.id);
  assert.strictEqual(new Set(ids).size, ids.length, "duplicate accessory ids");
  assert.strictEqual(cust.ACCESSORIES.find((a) => a.id === "none").lv, 0);
  for (const a of cust.ACCESSORIES) assert.ok(a.lv >= 0 && a.lv <= 4, a.id + " is locked past wizard");
});

test("interaction & settings wiring is present in all three sources", () => {
  for (const needle of ["dblclick", "pet-wander", "pet-cursor", "pet-walk", "pet-custom-set", "PET_COOLDOWN", "TREAT_COOLDOWN"])
    assert.ok(html.includes(needle), "index.html missing " + needle);
  const settingsSrc = fs.readFileSync(path.join(__dirname, "..", "settings.html"), "utf8");
  for (const needle of ["pet-state-get", "custom-set", "settings-close", "showGlow", "pet-scale", "pet-reset-window"])
    assert.ok(settingsSrc.includes(needle), "settings.html missing " + needle);
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  for (const needle of ["pet-custom-set", "pet-wander", "pet-cursor", "settings.html", "transcript_path", "pet-reset-window", "pet-scale-set"])
    assert.ok(mainSrc.includes(needle), "main.js missing " + needle);
});

test("the bubble is bottom-anchored above the head (grows upward), glow exists", () => {
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
  const bubble = css.slice(css.indexOf("#bubble"), css.indexOf("}", css.indexOf("#bubble")));
  assert.ok(/bottom:\s*\d+px/.test(bubble), "bubble is not bottom-anchored");
  assert.ok(!/[^-]top:\s*\d/.test(bubble), "bubble is parked at the top of the window again");
  // The glow is a rim hugging the sprite, NOT a radial cloud behind the body —
  // that smeared gray over dark wallpapers.
  assert.ok(/drop-shadow/.test(css), "rim glow missing");
  assert.ok(html.includes('id="ground"'), "ground shadow missing from the DOM");
  assert.ok(!html.includes('id="glow"'), "the radial glow cloud is back");
});

/* ---------- report ---------- */

console.log("session awareness & customization: " + pass + " passed\n");
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("  FAIL")).length;
console.log("\n" + pass + " passed, " + failed + " failed   (sandbox: " + SANDBOX + ")");
if (!failed) fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
