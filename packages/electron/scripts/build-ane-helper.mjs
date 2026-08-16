/**
 * Builds and bundles the `ane-dictation-helper` Swift binary (see
 * native/ane-dictation-helper/) for the desktop package.
 *
 * Apple Neural Engine dictation is Apple Silicon macOS only, so this is a
 * no-op (with a clean, empty resources dir) everywhere else — mirrors the
 * platform gating already done at read time in
 * packages/web/server/lib/dictation/local-ane/capability.js.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(electronRoot, '../..');
const nativeRoot = path.join(workspaceRoot, 'native', 'ane-dictation-helper');
const outputDir = path.join(electronRoot, 'resources', 'ane-dictation-helper');
const BINARY_NAME = 'ane-dictation-helper';

const resetOutputDir = () => {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, '.gitkeep'), '');
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
};

const main = () => {
  if (process.platform !== 'darwin') {
    console.log('[electron] skipping ANE dictation helper: not macOS');
    resetOutputDir();
    return;
  }

  const targetArchitecture = resolveTargetArchitecture();
  if (targetArchitecture.node !== 'arm64') {
    console.log(
      '[electron] skipping ANE dictation helper: Apple Neural Engine requires Apple Silicon (arm64), building for x64',
    );
    resetOutputDir();
    return;
  }

  if (!fs.existsSync(nativeRoot)) {
    throw new Error(`Missing ANE dictation helper source at ${nativeRoot}`);
  }

  console.log('[electron] building ANE dictation helper (swift build -c release)...');
  run('swift', ['build', '-c', 'release'], { cwd: nativeRoot });

  const builtBinary = path.join(nativeRoot, '.build', 'release', BINARY_NAME);
  if (!fs.existsSync(builtBinary)) {
    throw new Error(`Swift build did not produce ${builtBinary}`);
  }

  resetOutputDir();
  const outputBinary = path.join(outputDir, BINARY_NAME);
  fs.copyFileSync(builtBinary, outputBinary);
  fs.chmodSync(outputBinary, 0o755);

  console.log(`[electron] bundled ANE dictation helper: ${outputBinary}`);
};

main();
