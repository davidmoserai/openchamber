/**
 * Install-state tracking for the ANE dictation model.
 *
 * Download delegates to FluidAudio's own downloader inside the helper
 * process (idempotent: a no-op if its cache already has the model); we
 * record success with our own marker file, mirroring the installed/not
 * -installed state the sherpa models already expose to the UI.
 *
 * Delete removes FluidAudio's on-disk cache directly. FluidAudio's own docs
 * (Manual Model Loading guide) document this cache path as
 * `~/Library/Application Support/FluidAudio/Models/<repo>` on macOS; the
 * actual observed directory name for this model is `parakeet-tdt-0.6b-v3`
 * (verified by inspection), so both that name and the full HuggingFace repo
 * name are tried. If neither exists there's nothing to reclaim — clearing
 * our own marker file is still enough to make the app treat it as
 * not-installed and re-download correctly next time it's selected.
 */

import { spawn } from 'child_process';
import { mkdir, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { resolveAneHelperPath } from './helper-path.js';

const MARKER_FILENAME = '.ane-parakeet-tdt-v3-installed';
const STDERR_TAIL_MAX_CHARS = 2000;

// Candidate directory names under FluidAudio's own cache root, newest/most
// likely first.
const FLUIDAUDIO_CACHE_MODEL_DIRNAMES = ['parakeet-tdt-0.6b-v3', 'parakeet-tdt-0.6b-v3-coreml'];

function markerPath(modelsDir) {
  return path.join(modelsDir, MARKER_FILENAME);
}

function fluidAudioModelCacheDirs() {
  const cacheRoot = path.join(os.homedir(), 'Library', 'Application Support', 'FluidAudio', 'Models');
  return FLUIDAUDIO_CACHE_MODEL_DIRNAMES.map((name) => path.join(cacheRoot, name));
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

/**
 * Delete the ANE model: FluidAudio's on-disk cache (best-effort, see module
 * docs above) plus our install marker.
 * @param {string} modelsDir
 */
export async function deleteAneSttModel(modelsDir) {
  await Promise.all(
    fluidAudioModelCacheDirs().map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await rm(markerPath(modelsDir), { force: true });
}
