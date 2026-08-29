/**
 * Manages the OmniVoice Python inference sidecar: one-time environment
 * bootstrap (uv venv + pip install), lazy spawn, newline-delimited JSON
 * request/response over stdio, and idle shutdown.
 *
 * OmniVoice (k2-fsa) needs PyTorch, which has no Node/ONNX equivalent with
 * zero-shot voice cloning across hundreds of languages, so — unlike the
 * sherpa-onnx models in this directory, which run as a native addon inside a
 * forked Node worker — this engine runs as an isolated Python child process.
 * Node still owns the process lifecycle, routes, and all state; Python only
 * performs inference.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = path.join(__dirname, 'omnivoice');
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'omnivoice_server.py');
const REQUIREMENTS_FILE = path.join(SIDECAR_DIR, 'requirements.txt');

const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
// Default per-call patience for an already-installed model: covers a cold
// respawn after idle shutdown plus loading the ~2.4 GB checkpoint back into
// memory, but does not hang an HTTP request indefinitely. The *background*
// first-install bootstrap (service.js's startModelDownload) passes
// Number.POSITIVE_INFINITY instead — see ensureReady().
const READY_TIMEOUT_MS = 90 * 1000;
const REQUEST_TIMEOUT_MS = 120 * 1000;
// How long an auto-derived reference voice (see synthesize()) stays usable
// after its first chunk. Long enough to cover one message's full chunk
// sequence, short enough not to accumulate temp files indefinitely.
const AUTO_REF_SESSION_TTL_MS = 3 * 60 * 1000;
const AUTO_REF_SESSION_DIR = path.join(os.tmpdir(), 'openchamber-omnivoice-sessions');

export function getVenvDir(modelsDir) {
  return path.join(modelsDir, 'omnivoice-venv');
}

function getVenvPython(modelsDir) {
  return path.join(getVenvDir(modelsDir), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

function getMarkerFile(modelsDir) {
  return path.join(getVenvDir(modelsDir), '.ready');
}

/**
 * @param {string} modelsDir
 * @returns {boolean} true once the sidecar has reported "ready" at least once.
 */
export function isOmniVoiceInstalled(modelsDir) {
  return existsSync(getMarkerFile(modelsDir)) && existsSync(getVenvPython(modelsDir));
}

function runCommand(command, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', (chunk) => onLine?.(chunk.toString()));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      onLine?.(chunk.toString());
    });
    child.on('error', (error) => {
      if (command === 'uv' && error.code === 'ENOENT') {
        reject(new Error('uv is required to run OmniVoice locally. Install it from https://docs.astral.sh/uv/getting-started/installation/ and try again.'));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

/**
 * Torch wheel selection: plain PyPI wheels work for both CPU and Apple
 * Silicon (MPS is bundled into the standard macOS wheel). Non-macOS
 * platforms get an extra CUDA wheel index; `uv pip install` still succeeds
 * on machines without a matching NVIDIA driver, and the sidecar falls back
 * to CPU at runtime via `pick_device()`.
 */
function torchInstallArgs() {
  if (process.platform === 'darwin') {
    return ['torch==2.8.0', 'torchaudio==2.8.0'];
  }
  return ['torch==2.8.0', 'torchaudio==2.8.0', '--extra-index-url', 'https://download.pytorch.org/whl/cu128'];
}

async function bootstrapVenv(modelsDir, onProgress) {
  const venvDir = getVenvDir(modelsDir);
  mkdirSync(modelsDir, { recursive: true });

  if (!existsSync(getVenvPython(modelsDir))) {
    onProgress?.('Creating Python environment');
    await runCommand('uv', ['venv', '--python', '3.12', venvDir]);
  }

  const venvPython = getVenvPython(modelsDir);
  onProgress?.('Installing PyTorch (this can take a while)');
  await runCommand('uv', ['pip', 'install', '--python', venvPython, ...torchInstallArgs()], { onLine: onProgress });

  onProgress?.('Installing OmniVoice');
  await runCommand('uv', ['pip', 'install', '--python', venvPython, '-r', REQUIREMENTS_FILE], { onLine: onProgress });
}

export class OmniVoiceManager {
  constructor() {
    /** @type {import('child_process').ChildProcess | null} */
    this.process = null;
    this.rl = null;
    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    /** @type {Promise<{ device: string }> | null} */
    this.readyPromise = null;
    this.idleTimer = null;
    this.device = null;
    /** @type {Map<string, { audioPath: string, text: string, timer: NodeJS.Timeout }>} */
    this.autoRefSessions = new Map();
  }

  /**
   * After a chunk generates with no fixed voice (no explicit clone selected),
   * cache its own output as a reference so later chunks in the same message
   * clone *that* voice instead of each independently sampling a new random
   * one. The text passed in is already an exact transcript of this audio.
   */
  async _cacheAutoRefSession(voiceSessionId, audioBuffer, text) {
    await mkdir(AUTO_REF_SESSION_DIR, { recursive: true });
    const audioPath = path.join(AUTO_REF_SESSION_DIR, `${voiceSessionId}.wav`);
    await writeFile(audioPath, audioBuffer);

    const timer = setTimeout(() => {
      this.autoRefSessions.delete(voiceSessionId);
      rm(audioPath, { force: true }).catch(() => undefined);
    }, AUTO_REF_SESSION_TTL_MS);
    timer.unref?.();

    this.autoRefSessions.set(voiceSessionId, { audioPath, text, timer });
  }

  _scheduleIdleShutdown() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => this.shutdown(), IDLE_SHUTDOWN_MS);
    this.idleTimer.unref?.();
  }

  _handleLine(line, onProgress) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.event === 'ready') {
      this.device = message.device;
      onProgress?.(`Ready (device: ${message.device})`);
      return;
    }
    if (message.event === 'loading' || message.event === 'error') {
      if (message.event === 'error') {
        this._failAllPending(new Error(message.error));
      }
      if (message.event !== 'error') {
        onProgress?.('Loading OmniVoice model');
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message);
    } else {
      pending.reject(new Error(message.error || 'OmniVoice generation failed'));
    }
  }

  _failAllPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Spawns the sidecar and waits for it to report readiness. Has no internal
   * timeout: a slow download is not a failure, so this only settles on a
   * genuine "ready" event or a real process error/exit. Runs at most once —
   * concurrent/later calls share `this.readyPromise`.
   */
  _bootstrapAndSpawn(modelsDir, onProgress) {
    return (async () => {
      await bootstrapVenv(modelsDir, onProgress);

      const venvPython = getVenvPython(modelsDir);
      const child = spawn(venvPython, [SIDECAR_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          // The Xet chunked-transfer backend can fall into a low, unstable
          // concurrency state on constrained/proxied networks; plain
          // resumable HTTP is slower on a fast link but far more reliable
          // everywhere else.
          HF_HUB_DISABLE_XET: '1',
        },
      });
      this.process = child;
      this.rl = readline.createInterface({ input: child.stdout });

      const readyResult = await new Promise((resolve, reject) => {
        const onLine = (line) => {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          if (message.event === 'ready') {
            this.rl.off('line', onLine);
            resolve({ device: message.device });
          } else if (message.event === 'error') {
            this.rl.off('line', onLine);
            reject(new Error(message.error));
          } else {
            onProgress?.('Loading OmniVoice model (first run downloads ~2.4 GB — this keeps running in the background even if a request times out)');
          }
        };
        this.rl.on('line', onLine);

        child.stderr.on('data', (chunk) => onProgress?.(chunk.toString().trim()));
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`OmniVoice sidecar exited during startup (code ${code})`));
          }
        });
      });

      // Switch to steady-state line handling now that startup is resolved.
      this.rl.removeAllListeners('line');
      this.rl.on('line', (line) => this._handleLine(line, onProgress));
      child.on('exit', () => {
        this._failAllPending(new Error('OmniVoice sidecar exited unexpectedly'));
        this.process = null;
        this.rl = null;
        this.readyPromise = null;
      });

      writeFileSync(getMarkerFile(modelsDir), new Date().toISOString());
      this.device = readyResult.device;
      this._scheduleIdleShutdown();
      return readyResult;
    })().catch((error) => {
      // A genuine failure (bad install, sidecar crashed before ready) means
      // this process is actually dead — reset so the next call respawns.
      this.readyPromise = null;
      this.shutdown();
      throw error;
    });
  }

  /**
   * Ensure the venv is bootstrapped and the sidecar process is running and
   * has reported readiness. Safe to call repeatedly; concurrent callers
   * share the same in-flight bootstrap/spawn.
   *
   * `timeoutMs` bounds only how long *this call* waits — if it elapses while
   * a first-run download is still in flight, that download is left running
   * in the background rather than killed, so the next call (e.g. the UI
   * polling status, or the user retrying) can pick up right where it left
   * off instead of restarting a multi-gigabyte download from scratch.
   * @param {{ modelsDir: string, onProgress?: (msg: string) => void, timeoutMs?: number }} params
   */
  async ensureReady({ modelsDir, onProgress, timeoutMs = READY_TIMEOUT_MS }) {
    if (!this.readyPromise) {
      this.readyPromise = this._bootstrapAndSpawn(modelsDir, onProgress);
    }

    if (!Number.isFinite(timeoutMs)) {
      // No caller-side patience limit (used for the background install
      // trigger) — just wait however long the real bootstrap takes.
      return this.readyPromise;
    }

    let timer;
    const callerTimeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Still downloading/loading OmniVoice — it is progressing in the background, retry shortly')),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([this.readyPromise, callerTimeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {{ modelsDir: string, text: string, refAudioPath?: string,
   *           refText?: string, language?: string, speed?: number,
   *           voiceSessionId?: string, onProgress?: (msg: string) => void }} params
   * @returns {Promise<{ audio: Buffer, format: string }>}
   */
  async synthesize({ modelsDir, text, refAudioPath, refText, language, speed, voiceSessionId, onProgress }) {
    await this.ensureReady({ modelsDir, onProgress });
    this._scheduleIdleShutdown();

    // No explicit cloned voice was requested, but this chunk belongs to a
    // multi-chunk message (voiceSessionId): if an earlier chunk in the same
    // message already established a voice, reuse it instead of sampling a
    // new random speaker for this chunk.
    let effectiveRefAudioPath = refAudioPath;
    let effectiveRefText = refText;
    if (!effectiveRefAudioPath && voiceSessionId) {
      const cached = this.autoRefSessions.get(voiceSessionId);
      if (cached) {
        effectiveRefAudioPath = cached.audioPath;
        effectiveRefText = cached.text;
      }
    }

    const id = randomUUID();
    const request = { id, cmd: 'generate', text, refAudioPath: effectiveRefAudioPath, refText: effectiveRefText, language, speed };

    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('OmniVoice generation timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify(request)}\n`);
    });

    const audio = Buffer.from(response.audioBase64, 'base64');

    // This was the first chunk of the message (no ref used, none cached yet)
    // -- capture its own output as the reference for the chunks after it.
    if (!refAudioPath && voiceSessionId && !this.autoRefSessions.has(voiceSessionId)) {
      await this._cacheAutoRefSession(voiceSessionId, audio, text);
    }

    return { audio, format: 'audio/wav' };
  }

  shutdown() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this._failAllPending(new Error('OmniVoice sidecar shut down'));
    this.rl?.removeAllListeners();
    this.rl?.close();
    this.rl = null;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.readyPromise = null;
  }
}

/** Single shared manager: both the status/download routes and the speak
 * route must talk to the same running sidecar process. */
export const omniVoiceManager = new OmniVoiceManager();

/**
 * Deletes the venv (and, with it, the Hugging Face model cache that lives
 * under it is untouched — HF caches to `~/.cache/huggingface` by default, so
 * this only reclaims the venv/site-packages). Stops the running sidecar
 * first so Windows/locked-file deletes don't fail.
 * @param {string} modelsDir
 */
export async function removeOmniVoiceInstall(modelsDir) {
  omniVoiceManager.shutdown();
  await rm(getVenvDir(modelsDir), { recursive: true, force: true });
}
