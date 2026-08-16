/**
 * Install-state tracking for the ANE dictation model.
 * See ../DOCUMENTATION.md for the marker-file/cache-path rationale.
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

/** @param {string} modelsDir */
export async function isAneSttModelInstalled(modelsDir) {
  try {
    const info = await stat(markerPath(modelsDir));
    return info.isFile();
  } catch {
    return false;
  }
}

/** @param {{ modelsDir: string }} options */
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

/** @param {string} modelsDir */
export async function deleteAneSttModel(modelsDir) {
  await Promise.all(
    fluidAudioModelCacheDirs().map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await rm(markerPath(modelsDir), { force: true });
}
