'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installHooks, uninstallHooks, hooksInstalled, HOOK_EVENTS } = require('../src/capture/installer');

function tmpSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-inst-'));
  return {
    dir,
    settingsPath: path.join(dir, 'settings.json'),
    petDirPath: path.join(dir, 'pet')
  };
}

test('install into missing settings file creates it, uninstall empties our entries', () => {
  const { settingsPath, petDirPath } = tmpSetup();
  const res = installHooks({ settingsPath, petDirPath });
  assert.ok(res.ok && res.changed);
  assert.ok(fs.existsSync(path.join(petDirPath, 'gogu-hook.js')), 'hook script deployed');
  assert.ok(hooksInstalled({ settingsPath }));

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const ev of HOOK_EVENTS) assert.ok(Array.isArray(settings.hooks[ev]), `${ev} present`);

  const un = uninstallHooks({ settingsPath });
  assert.ok(un.ok && un.changed);
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(after.hooks, undefined);
});

test('install is idempotent', () => {
  const { settingsPath, petDirPath } = tmpSetup();
  installHooks({ settingsPath, petDirPath });
  const once = fs.readFileSync(settingsPath, 'utf8');
  const res2 = installHooks({ settingsPath, petDirPath });
  assert.ok(res2.ok);
  assert.equal(res2.changed, false);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), once, 'byte-identical after re-install');
});

test('preserves existing user settings and hooks; uninstall is byte-identical', () => {
  const { settingsPath, petDirPath } = tmpSetup();
  const userSettings = {
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter --fix' }] }
      ],
      SessionStart: [
        { hooks: [{ type: 'command', command: 'echo hi' }] }
      ]
    }
  };
  const original = JSON.stringify(userSettings, null, 2) + '\n';
  fs.writeFileSync(settingsPath, original);

  const res = installHooks({ settingsPath, petDirPath });
  assert.ok(res.ok && res.changed);

  const mid = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(mid.model, 'opus');
  assert.deepEqual(mid.permissions, userSettings.permissions);
  // user's entries still first / intact
  assert.equal(mid.hooks.PostToolUse[0].hooks[0].command, 'my-linter --fix');
  assert.equal(mid.hooks.SessionStart[0].hooks[0].command, 'echo hi');
  assert.equal(mid.hooks.PostToolUse.length, 2);

  const un = uninstallHooks({ settingsPath });
  assert.ok(un.ok && un.changed);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original, 'uninstall leaves the file byte-identical');
});

test('refuses to touch an unparseable config', () => {
  const { settingsPath, petDirPath } = tmpSetup();
  fs.writeFileSync(settingsPath, '{ "hooks": broken json');
  const res = installHooks({ settingsPath, petDirPath });
  assert.equal(res.ok, false);
  assert.match(res.reason, /refusing/i);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{ "hooks": broken json', 'file untouched');
  const un = uninstallHooks({ settingsPath });
  assert.equal(un.ok, false);
});

test('uninstall with no settings file is a no-op success', () => {
  const { settingsPath } = tmpSetup();
  const res = uninstallHooks({ settingsPath });
  assert.ok(res.ok);
  assert.equal(res.changed, false);
  assert.ok(!fs.existsSync(settingsPath), 'did not create a file');
});

test('respects tab indentation of an existing file', () => {
  const { settingsPath, petDirPath } = tmpSetup();
  const original = '{\n\t"model": "sonnet"\n}\n';
  fs.writeFileSync(settingsPath, original);
  installHooks({ settingsPath, petDirPath });
  const text = fs.readFileSync(settingsPath, 'utf8');
  assert.match(text, /\n\t"model"/, 'kept tabs');
  uninstallHooks({ settingsPath });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
});

test('install repoints command if pet dir moved', () => {
  const t = tmpSetup();
  installHooks({ settingsPath: t.settingsPath, petDirPath: t.petDirPath });
  const other = path.join(t.dir, 'pet2');
  const res = installHooks({ settingsPath: t.settingsPath, petDirPath: other });
  assert.ok(res.ok && res.changed);
  const settings = JSON.parse(fs.readFileSync(t.settingsPath, 'utf8'));
  const cmd = settings.hooks.SessionStart.find(e => JSON.stringify(e).includes('.gogu')
    || JSON.stringify(e).includes('pet2')).hooks[0].command;
  assert.ok(cmd.includes('pet2'), cmd);
  // still exactly one pet entry per event
  assert.equal(settings.hooks.SessionStart.length, 1);
});
