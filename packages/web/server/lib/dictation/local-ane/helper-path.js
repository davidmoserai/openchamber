/**
 * Resolves the path to the compiled `ane-dictation-helper` binary (see
 * native/ane-dictation-helper/): packaged Electron resourcesPath, falling
 * back to the local `swift build -c release` output for dev.
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
 * @param {{ platform?: string, resourcesPath?: string | null,
 *           fileExists?: (path: string) => boolean }} [overrides] injectable
 *   for tests; defaults read the real host/process.
 * @returns {string | null}
 */
export function resolveAneHelperPath({
  platform = process.platform,
  resourcesPath = process.resourcesPath ?? null,
  fileExists = existsSync,
} = {}) {
  if (platform !== 'darwin') {
    return null;
  }

  const packagedPath = resourcesPath ? path.join(resourcesPath, RESOURCE_SUBDIR, BINARY_NAME) : null;
  if (packagedPath && fileExists(packagedPath)) {
    return packagedPath;
  }

  const devPath = devBinaryPath();
  if (fileExists(devPath)) {
    return devPath;
  }

  return null;
}
