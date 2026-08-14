'use strict';
// Two passes over the packed app, in this order: drop the weight nobody here
// uses, then ad-hoc sign what is left.
//
// Order matters and is not ours to choose — electron-builder runs afterPack
// before it signs, so anything deleted here is deleted before a signature
// (ad-hoc or Developer ID) is computed over the bundle. Pruning after signing
// would invalidate it and notarization would reject the app.
//
// The signing half only applies to unsigned builds. An Apple Silicon Mac
// refuses to launch a binary carrying no signature at all — not a Gatekeeper
// warning, a hard kill — and `codesign --sign -` is the free floor that makes
// the app runnable once the user clears quarantine. With a real Developer ID
// configured, electron-builder signs properly on its own and this keeps its
// hands off.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Electron ships Chromium's UI strings for 50-odd languages. Gogu's own UI is
// English-only, so the rest is ~40 MB of .lproj nobody can reach. Keeping en
// alone is what `mac.electronLanguages` claims to do and does not: on macOS it
// only prunes the empty .lproj stubs under Contents/Resources and never looks
// inside the framework, where the actual weight is.
const KEEP_LANGUAGES = new Set(['en']);

// SwiftShader is Chromium's software Vulkan driver: the fallback path for
// WebGL when there is no usable GPU. Gogu draws on 2D canvas only, and the 2D
// canvas falls back to Skia's software rasteriser in the main binary rather
// than to this. 16 MB for a code path this app has no way to enter.
const UNUSED_LIBRARIES = ['libvk_swiftshader.dylib', 'vk_swiftshader_icd.json'];

function bytesOf(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(target)
    .reduce((sum, entry) => sum + bytesOf(path.join(target, entry)), 0);
}

function drop(target, tally) {
  if (!fs.existsSync(target)) return;
  tally.bytes += bytesOf(target);
  tally.count += 1;
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneLanguages(dir, tally) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.lproj')) continue;
    if (KEEP_LANGUAGES.has(entry.slice(0, -'.lproj'.length))) continue;
    drop(path.join(dir, entry), tally);
  }
}

function prune(appPath) {
  const tally = { bytes: 0, count: 0 };
  const framework = path.join(appPath, 'Contents', 'Frameworks',
    'Electron Framework.framework', 'Versions', 'A');

  pruneLanguages(path.join(framework, 'Resources'), tally);
  pruneLanguages(path.join(appPath, 'Contents', 'Resources'), tally);
  for (const lib of UNUSED_LIBRARIES) {
    drop(path.join(framework, 'Libraries', lib), tally);
  }

  return tally;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const arch = path.basename(context.appOutDir);

  const { bytes, count } = prune(appPath);
  console.log(`  • pruned  ${count} items, ${(bytes / 1e6).toFixed(1)} MB  ${arch}`);

  if (process.env.CSC_LINK) return; // properly signed later — nothing more to do

  // --deep is deprecated for distribution signing but is exactly right for an
  // ad-hoc pass over the helper apps and frameworks Electron nests inside.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath],
    { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  ${appName}  ${arch}`);
};
