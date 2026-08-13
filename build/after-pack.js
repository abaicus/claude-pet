'use strict';
// Ad-hoc signature for unsigned builds.
//
// An Apple Silicon Mac refuses to launch a binary carrying no signature at
// all — not a Gatekeeper warning, a hard kill. `codesign --sign -` is the
// free floor that makes the app runnable once the user clears quarantine.
// When a real Developer ID is configured, electron-builder has already signed
// properly and this must keep its hands off.

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK) return; // properly signed — nothing to do here

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // --deep is deprecated for distribution signing but is exactly right for an
  // ad-hoc pass over the helper apps and frameworks Electron nests inside.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath],
    { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  ${appName}  ${path.basename(context.appOutDir)}`);
};
