/**
 * Install-state tracking for the ANE dictation model.
 *
 * FluidAudio manages its own CoreML model cache internally (HuggingFace
 * download + compile, cached under `~/Library/Application Support/FluidAudio`)
 * — we don't reach into that cache directly since its layout is an internal
 * implementation detail of the FluidAudio package, not a documented contract.
 * Instead we run the helper's `download` mode (idempotent: a no-op if
 * FluidAudio's cache already has the model) and record success with our own
 * marker file, mirroring the installed/not-installed state the sherpa models
 * already expose to the UI.
 */

import { spawn } from 'child_process';
import { mkdir, stat, writeFile } from 'fs/promises';
import path from 'path';

import { resolveAneHelperPath } from './helper-path.js';

const MARKER_FILENAME = '.ane-parakeet-tdt-v3-installed';
const STDERR_TAIL_MAX_CHARS = 2000;

function markerPath(modelsDir) {
  return path.join(modelsDir, MARKER_FILENAME);
}

/**
 * @param {string} modelsDir
 * @returns {Promise<boolean>}
 */
export async function isAneSttModelInstalled(modelsDir) {
  try {
    const info = await stat(markerPath(modelsDir));
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Ensure the ANE model is downloaded (delegates to FluidAudio's own
 * downloader inside the helper process) and record install state.
 * @param {{ modelsDir: string }} options
 */
export async function ensureAneSttModel({ modelsDir }) {
  if (await isAneSttModelInstalled(modelsDir)) {
    return;
  }

  const helperPath = resolveAneHelperPath();
  if (!helperPath) {
    throw new Error('ANE dictation helper is not available on this system');
  }

  await new Promise((resolve, reject) => {
    const child = spawn(helperPath, ['download'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderrTail = '';
    child.stderr?.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX_CHARS);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `ANE model download failed (exit ${code ?? 'null'}).${stderrTail.trim() ? ` ${stderrTail.trim()}` : ''}`,
          ),
        );
      }
    });
  });

  await mkdir(modelsDir, { recursive: true });
  await writeFile(markerPath(modelsDir), new Date().toISOString());
}
