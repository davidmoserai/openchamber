/**
 * Verifies the ANE dictation helper is bundled (and actually runnable) for
 * arm64 macOS builds, and correctly absent everywhere else. Mirrors
 * verify-opencode-cli.mjs's --staged/--packaged shape.
 *
 * This exists because the three macOS build workflows manually reimplement
 * the packaging step sequence instead of calling packages/electron's
 * `package` script — a change to that script's chain doesn't reach CI on its
 * own. This check is the regression guard: it fails loudly instead of
 * silently shipping a release with the ANE dictation option missing.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const BINARY_NAME = 'ane-dictation-helper';

const isAneTarget = () => process.platform === 'darwin' && resolveTargetArchitecture().node === 'arm64';

const assertAlive = (binaryPath) => {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`ANE dictation helper not found: ${binaryPath}`);
  }
  const stat = fs.statSync(binaryPath);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`ANE dictation helper is not an executable file: ${binaryPath}`);
  }
  // No --version flag on this binary; its own argument-validation path
  // doubles as a proof-of-life check (built for this machine's arch, and
  // actually runs rather than failing to load/exec).
  const result = spawnSync(binaryPath, ['__verify__'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    windowsHide: true,
  });
  if (result.status !== 1 || !/Unknown mode/.test(result.stderr || '')) {
    throw new Error(
      `ANE dictation helper did not respond as expected: ${binaryPath}\n` +
        `status=${result.status}\nstderr=${result.stderr}\nstdout=${result.stdout}`,
    );
  }
  console.log(`[electron] verified ANE dictation helper is alive: ${binaryPath}`);
};

const assertAbsent = (dir, label) => {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name !== '.gitkeep') : [];
  if (entries.length > 0) {
    throw new Error(
      `ANE dictation helper should not be bundled for this target (Apple Neural Engine is arm64-only), ` +
        `found in ${label}: ${entries.join(', ')}`,
    );
  }
  console.log(`[electron] verified ANE dictation helper is correctly absent (${label})`);
};

const findPackagedBinaries = () => {
  const distDir = path.join(electronRoot, 'dist');
  if (!fs.existsSync(distDir)) return [];

  const candidates = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name === BINARY_NAME &&
        path.basename(path.dirname(fullPath)) === BINARY_NAME
      ) {
        candidates.push(fullPath);
      }
    }
  };
  visit(distDir);
  return candidates;
};

const usage = () => {
  console.error('Usage: node scripts/verify-ane-helper.mjs --staged|--packaged');
  process.exit(2);
};

const main = () => {
  const mode = process.argv[2];
  if (mode !== '--staged' && mode !== '--packaged') usage();

  const expectPresent = isAneTarget();

  if (mode === '--staged') {
    const stagedDir = path.join(electronRoot, 'resources', 'ane-dictation-helper');
    if (expectPresent) {
      assertAlive(path.join(stagedDir, BINARY_NAME));
    } else {
      assertAbsent(stagedDir, 'staged resources');
    }
    return;
  }

  const packagedBinaries = findPackagedBinaries();
  if (expectPresent) {
    if (packagedBinaries.length === 0) {
      throw new Error(
        'No packaged ANE dictation helper found under packages/electron/dist for an arm64 macOS build',
      );
    }
    for (const binary of packagedBinaries) {
      assertAlive(binary);
    }
    return;
  }
  if (packagedBinaries.length > 0) {
    throw new Error(
      `ANE dictation helper should not be packaged for this target, found: ${packagedBinaries.join(', ')}`,
    );
  }
  console.log('[electron] verified ANE dictation helper is correctly absent from the packaged build');
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
