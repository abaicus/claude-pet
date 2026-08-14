'use strict';
// Re-compresses each finished disk image with lzfse.
//
// hdiutil has taken `-format ULMO` since 10.15 and it is worth 18 MB per arch
// over the ULFO the build asks for, but electron-builder's config schema only
// knows the formats it knew in 2021 and rejects the string outright. So the
// build asks for the best format the schema allows and this converts it.
//
// Safe to do after the fact because electron-builder does not sign the image —
// `dmg.sign` is off by default and left off. The signature and the notarization
// staple live on the .app inside, which a conversion copies byte for byte.
//
// A failure here is not a failed release: the ULFO image electron-builder
// already produced is a perfectly good one, so this logs and leaves it.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const mb = (bytes) => (bytes / 1e6).toFixed(1);

function recompress(dmg) {
  const before = fs.statSync(dmg).size;
  // hdiutil appends .dmg to an output path that does not already end in it,
  // so the temp name has to carry the extension rather than have one bolted on.
  const temp = dmg.replace(/\.dmg$/, '.lzfse.dmg');

  try {
    execFileSync('hdiutil', ['convert', dmg, '-format', 'ULMO', '-o', temp, '-quiet'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    fs.rmSync(temp, { force: true });
    console.log(`  • kept ULFO  ${path.basename(dmg)}  (${String(err.message).trim()})`);
    return;
  }

  const after = fs.statSync(temp).size;
  if (after >= before) { // nothing gained; not worth the churn
    fs.rmSync(temp, { force: true });
    return;
  }
  fs.renameSync(temp, dmg);
  console.log(`  • lzfse  ${path.basename(dmg)}  ${mb(before)} MB → ${mb(after)} MB`);

  // The blockmap describes the image electron-builder built, not this one.
  // Nothing consumes it here — there is no auto-updater — and a stale one is
  // worse than none.
  fs.rmSync(`${dmg}.blockmap`, { force: true });
}

exports.default = async function afterAllArtifactBuild(buildResult) {
  if (process.platform !== 'darwin') return [];
  for (const artifact of buildResult.artifactPaths) {
    if (artifact.endsWith('.dmg')) recompress(artifact);
  }
  return []; // nothing new to publish, only smaller versions of what is there
};
