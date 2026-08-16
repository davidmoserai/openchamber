/**
 * Resolves the path to the compiled `ane-dictation-helper` binary (see
 * native/ane-dictation-helper/). macOS Apple Silicon only.
 *
 * - Packaged Electron: bundled under resourcesPath/ane-dictation-helper/
 *   (see packages/electron/scripts/build-ane-helper.mjs, extraResources in
 *   packages/electron/package.json).
 * - Dev / non-packaged: the locally built `swift build -c release` output,
 *   so `bun run dev` and Electron dev both work without a package step.
 */

import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BINARY_NAME = 'ane-dictation-helper';
const RESOURCE_SUBDIR = 'ane-dictation-helper';

function devBinaryPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/web/server/lib/dictation/local-ane/ -> repo root is 6 levels up.
  return path.resolve(
    here,
    '..', '..', '..', '..', '..', '..',
    'native', 'ane-dictation-helper', '.build', 'release', BINARY_NAME,
  );
}

/**
 * @returns {string | null} absolute path to the helper binary, or null if it
 *   isn't available (wrong platform, or not built/bundled).
 */
export function resolveAneHelperPath() {
  if (process.platform !== 'darwin') {
    return null;
  }

  // process.resourcesPath only exists inside Electron (packaged or dev); it's
  // undefined under plain Node, never an empty string in practice.
  const packagedPath = process.resourcesPath
    ? path.join(process.resourcesPath, RESOURCE_SUBDIR, BINARY_NAME)
    : null;
  if (packagedPath && existsSync(packagedPath)) {
    return packagedPath;
  }

  const devPath = devBinaryPath();
  if (existsSync(devPath)) {
    return devPath;
  }

  return null;
}
