'use strict';
// The release path, tested where it can be tested cheaply.
//
// The build itself is exercised in CI (it packages the app and greps the asar
// for every window it can open). What is here is the part that silently rots:
// the cask, whose download URL is a string in one repo that has to keep
// matching a filename pattern produced by a config in another. Nothing fails
// loudly when those drift — `brew install` just 404s for everybody a week
// after the release went out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RENDER = path.join(ROOT, 'scripts', 'render-cask.js');
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function render(args) {
  return execFileSync(process.execPath, [RENDER, ...args], { encoding: 'utf8' });
}
function renderFails(args) {
  try {
    execFileSync(process.execPath, [RENDER, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return null;
  } catch (err) {
    return String(err.stderr || err.message);
  }
}

test('the cask names the files electron-builder actually produces', () => {
  const config = require(path.join(ROOT, 'electron-builder.config.js'));
  const cask = render(['1.2.3', SHA_A, SHA_B]);

  // electron-builder interpolates ${...}; the cask interpolates #{...}. Both
  // have to spell the same filename, or the release ships assets under names
  // the cask never asks for.
  const built = config.mac.artifactName
    .replace('${productName}', 'gogu')   // artifactName is literal here
    .replace('${version}', '1.2.3')
    .replace('${arch}', 'arm64')
    .replace('${ext}', 'dmg');
  assert.equal(built, 'gogu-1.2.3-arm64.dmg');

  const url = /url "([^"]+)"/.exec(cask);
  assert.ok(url, 'cask has a url');
  const resolved = url[1]
    .replace(/#\{version\}/g, '1.2.3')
    .replace(/#\{arch\}/g, 'arm64');
  assert.ok(resolved.endsWith(`/${built}`),
    `cask url ${resolved} does not end in the built artifact ${built}`);

  // …and the dmg target has to exist for both arches the cask offers.
  const dmg = config.mac.target.find(t => t.target === 'dmg');
  assert.ok(dmg, 'a dmg target is what the cask installs from');
  assert.deepEqual(dmg.arch.slice().sort(), ['arm64', 'x64']);
});

test('the dmg is compressed with a format the supported floor can mount', () => {
  const config = require(path.join(ROOT, 'electron-builder.config.js'));
  const cask = render(['1.2.3', SHA_A, SHA_B]);
  // ULMO is worth 19 MB per arch over ULFO, but hdiutil only learned to mount
  // it in 10.15. Shipping it to a Mac the cask still says yes to would be a
  // download that cannot be opened, so the two floors have to agree.
  assert.equal(config.mac.minimumSystemVersion, '10.15.0');
  assert.match(cask, /depends_on macos: :catalina/);

  // The config cannot ask for ULMO — electron-builder validates dmg.format
  // against a list that predates it — so it asks for the best format the
  // schema allows and a hook converts. Both halves have to stay present:
  // ULFO alone silently ships 19 MB more.
  assert.equal(config.dmg.format, 'ULFO');
  assert.equal(config.afterAllArtifactBuild, './build/after-all.js');
  const hook = fs.readFileSync(path.join(ROOT, 'build', 'after-all.js'), 'utf8');
  assert.match(hook, /'-format', 'ULMO'/);
});

test('the build drops the weight the app cannot reach', () => {
  const src = fs.readFileSync(path.join(ROOT, 'build', 'after-pack.js'), 'utf8');
  // electron-builder runs afterPack before it signs. If pruning ever moved
  // behind the CSC_LINK guard it would run on unsigned builds only, and the
  // notarized release would quietly go back to being 40 MB of Chromese.
  const guard = src.indexOf('if (process.env.CSC_LINK) return');
  const pruned = src.indexOf('prune(appPath)');
  assert.ok(pruned > 0 && guard > 0, 'both the prune and the guard are there');
  assert.ok(pruned < guard, 'signed builds must be pruned too');
});

test('the cask installs the app the build is named after', () => {
  const config = require(path.join(ROOT, 'electron-builder.config.js'));
  const cask = render(['1.2.3', SHA_A, SHA_B]);
  const app = /^  app "(.+)"$/m.exec(cask);
  assert.ok(app, 'cask installs an app');
  assert.equal(app[1], `${config.productName}.app`);
  assert.match(cask, new RegExp(`uninstall quit: "${config.appId}"`));
});

test('the rendered cask carries the version and both checksums', () => {
  const cask = render(['0.4.1', SHA_A, SHA_B]);
  assert.match(cask, /^  version "0\.4\.1"$/m);
  assert.match(cask, new RegExp(`arm:\\s+"${SHA_A}"`));
  assert.match(cask, new RegExp(`intel:\\s+"${SHA_B}"`));
});

test('a bad checksum or version is refused, not rendered', () => {
  assert.match(renderFails(['1.0.0', 'nope', SHA_B]) || '', /arm64 sha256/);
  assert.match(renderFails(['1.0.0', SHA_A, SHA_A.toUpperCase()]) || '', /x64 sha256/);
  assert.match(renderFails(['v1.0', SHA_A, SHA_B]) || '', /semver/);
  assert.ok(renderFails(['1.0.0', SHA_A]), 'a missing argument is an error');
});

test('the unsigned build ad-hoc signs itself, and the signed one does not', () => {
  const after = path.join(ROOT, 'build', 'after-pack.js');
  const src = fs.readFileSync(after, 'utf8');
  // The whole point of the file: without this guard a Developer ID signature
  // would be overwritten by an ad-hoc one on its way to being notarized.
  assert.match(src, /if \(process\.env\.CSC_LINK\) return/);
  assert.match(src, /--sign', '-'/);
});

test('the config switches to a real identity when a certificate is present', () => {
  const load = (env) => {
    const before = { ...process.env };
    Object.assign(process.env, env);
    delete require.cache[require.resolve(path.join(ROOT, 'electron-builder.config.js'))];
    const cfg = require(path.join(ROOT, 'electron-builder.config.js'));
    process.env = before;
    return cfg;
  };

  const unsigned = load({ CSC_LINK: '', APPLE_TEAM_ID: '' });
  assert.equal(unsigned.mac.identity, null, 'no cert → electron-builder must not look for one');
  assert.equal(unsigned.mac.hardenedRuntime, false, 'hardened runtime without a signature will not launch');
  assert.equal(unsigned.mac.notarize, false);

  const signed = load({ CSC_LINK: 'base64-p12', APPLE_TEAM_ID: 'ABCDE12345' });
  assert.equal(signed.mac.identity, undefined, 'cert → auto-discover the identity');
  assert.equal(signed.mac.hardenedRuntime, true, 'notarization requires it');
  assert.deepEqual(signed.mac.notarize, { teamId: 'ABCDE12345' });

  // A cert with no team id can be signed but not notarized — and asking
  // electron-builder to notarize without one fails late, after the build.
  const halfway = load({ CSC_LINK: 'base64-p12', APPLE_TEAM_ID: '' });
  assert.equal(halfway.mac.notarize, false);
});

test('the packaged app ships the whole renderer and nothing developer-only', () => {
  const config = require(path.join(ROOT, 'electron-builder.config.js'));
  assert.ok(config.files.includes('src/**/*'), 'every window lives under src/');
  assert.ok(config.files.includes('package.json'), 'electron reads main from it');
  for (const dev of ['test', 'scripts', 'mockups', 'docs']) {
    assert.ok(!config.files.some(f => f.startsWith(dev)),
      `${dev}/ is not shipped, so it must not be listed`);
  }
});

test('the icon the build points at is committed, and is a real icns', () => {
  const config = require(path.join(ROOT, 'electron-builder.config.js'));
  const icon = path.join(ROOT, config.mac.icon);
  assert.ok(fs.existsSync(icon), `${config.mac.icon} must be committed — CI does not draw it`);
  // icns magic: 'icns' then the file length, big-endian.
  const head = fs.readFileSync(icon).subarray(0, 8);
  assert.equal(head.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(head.readUInt32BE(4), fs.statSync(icon).size);
});

test('every image the README shows is committed', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const refs = [...readme.matchAll(/<img src="(docs\/media\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 3, 'the README is meant to have screenshots in it');
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(ROOT, ref)), `${ref} is referenced but missing`);
  }
});

test('the version being released is the version the app reports', () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  // The release workflow refuses a tag that disagrees with this file; keep the
  // two names it is packaged under in step as well.
  assert.equal(pkg.name, 'gogu');
  assert.equal(pkg.productName, 'Gogu');
});

test('render-cask writes to a file when asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cask-'));
  const out = path.join(dir, 'gogu.rb');
  render(['2.0.0', SHA_A, SHA_B, out]);
  assert.match(fs.readFileSync(out, 'utf8'), /^  version "2\.0\.0"$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});
