/**
 * Manages mlx-audio Python inference sidecars: one-time environment
 * bootstrap (uv venv + pip install), lazy spawn, newline-delimited JSON
 * request/response over stdio, and idle shutdown.
 *
 * Generic across any mlx-audio-backed local TTS model -- they all need the
 * exact same single dependency (`mlx-audio`) and the exact same sidecar
 * protocol, differing only in which Hugging Face repo gets loaded. One
 * shared venv is bootstrapped once; each distinct model gets its own
 * long-lived Python process (via getMlxAudioManager(modelRepo)) since each
 * has its own model resident in memory. Currently only Qwen3-TTS uses this
 * (OmniVoice-MLX was evaluated and removed in favor of it), but the
 * generic shape means adding another mlx-audio model back is just a new
 * model-catalog.js entry.
 *
 * MLX only targets Apple Silicon and has no device_map to choose, unlike
 * PyTorch -- there is no cuda/mps/cpu selection to make here.
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
const SIDECAR_DIR = path.join(__dirname, 'mlx-audio');
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'mlx_audio_server.py');
const REQUIREMENTS_FILE = path.join(SIDECAR_DIR, 'requirements.txt');

const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
// This only bounds a single caller's patience, not the underlying
// bootstrap/download, which is intentionally never killed for taking too
// long -- see ensureReady() below.
const READY_TIMEOUT_MS = 90 * 1000;
const REQUEST_TIMEOUT_MS = 120 * 1000;
const AUTO_REF_SESSION_TTL_MS = 3 * 60 * 1000;
const AUTO_REF_SESSION_DIR = path.join(os.tmpdir(), 'openchamber-mlx-audio-sessions');

/** One shared venv: `mlx-audio` is the only dependency, regardless of model. */
function getVenvDir(modelsDir) {
  return path.join(modelsDir, 'mlx-audio-venv');
}

function getVenvPython(modelsDir) {
  return path.join(getVenvDir(modelsDir), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

function sanitizeForFilename(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Per-model marker, since bootstrap is shared but "has this specific model loaded successfully" is not. */
function getMarkerFile(modelsDir, modelRepo) {
  return path.join(getVenvDir(modelsDir), `.ready-${sanitizeForFilename(modelRepo)}`);
}

/**
 * @param {string} modelsDir
 * @param {string} modelRepo
 * @returns {boolean} true once this model's sidecar has reported "ready" at least once.
 */
export function isMlxAudioModelInstalled(modelsDir, modelRepo) {
  return existsSync(getMarkerFile(modelsDir, modelRepo)) && existsSync(getVenvPython(modelsDir));
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
        reject(new Error('uv is required to run local mlx-audio models. Install it from https://docs.astral.sh/uv/getting-started/installation/ and try again.'));
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

async function bootstrapVenv(modelsDir, onProgress) {
  const venvDir = getVenvDir(modelsDir);
  mkdirSync(modelsDir, { recursive: true });

  if (!existsSync(getVenvPython(modelsDir))) {
    onProgress?.('Creating Python environment');
    await runCommand('uv', ['venv', '--python', '3.12', venvDir]);
  }

  const venvPython = getVenvPython(modelsDir);
  onProgress?.('Installing mlx-audio');
  await runCommand('uv', ['pip', 'install', '--python', venvPython, '-r', REQUIREMENTS_FILE], { onLine: onProgress });
}

export class MlxAudioManager {
  /** @param {string} modelRepo Hugging Face repo id, e.g. "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit". */
  constructor(modelRepo) {
    this.modelRepo = modelRepo;
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
    const audioPath = path.join(AUTO_REF_SESSION_DIR, `${sanitizeForFilename(this.modelRepo)}-${voiceSessionId}.wav`);
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
      onProgress?.('Ready');
      return;
    }
    if (message.event === 'loading' || message.event === 'error') {
      if (message.event === 'error') {
        this._failAllPending(new Error(message.error));
      }
      if (message.event !== 'error') {
        onProgress?.(`Loading ${this.modelRepo}`);
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
      pending.reject(new Error(message.error || `${this.modelRepo} generation failed`));
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
      const child = spawn(venvPython, [SIDECAR_SCRIPT, this.modelRepo], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          // Xet chunked-transfer can fall into a low, unstable concurrency
          // state on constrained/proxied networks; plain resumable HTTP is
          // slower on a fast link but far more reliable everywhere else.
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
            onProgress?.(`Loading ${this.modelRepo} (first run downloads the model — this keeps running in the background even if a request times out)`);
          }
        };
        this.rl.on('line', onLine);

        child.stderr.on('data', (chunk) => onProgress?.(chunk.toString().trim()));
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`mlx-audio sidecar (${this.modelRepo}) exited during startup (code ${code})`));
          }
        });
      });

      this.rl.removeAllListeners('line');
      this.rl.on('line', (line) => this._handleLine(line, onProgress));
      child.on('exit', () => {
        this._failAllPending(new Error(`mlx-audio sidecar (${this.modelRepo}) exited unexpectedly`));
        this.process = null;
        this.rl = null;
        this.readyPromise = null;
      });

      writeFileSync(getMarkerFile(modelsDir, this.modelRepo), new Date().toISOString());
      this.device = readyResult.device;
      this._scheduleIdleShutdown();
      return readyResult;
    })().catch((error) => {
      this.readyPromise = null;
      this.shutdown();
      throw error;
    });
  }

  /** timeoutMs bounds only how long *this call* waits -- see the class doc comment. */
  async ensureReady({ modelsDir, onProgress, timeoutMs = READY_TIMEOUT_MS }) {
    if (!this.readyPromise) {
      this.readyPromise = this._bootstrapAndSpawn(modelsDir, onProgress);
    }

    if (!Number.isFinite(timeoutMs)) {
      return this.readyPromise;
    }

    let timer;
    const callerTimeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Still downloading/loading ${this.modelRepo} — it is progressing in the background, retry shortly`)),
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
        reject(new Error(`${this.modelRepo} generation timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify(request)}\n`);
    });

    const audio = Buffer.from(response.audioBase64, 'base64');

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
    this._failAllPending(new Error(`mlx-audio sidecar (${this.modelRepo}) shut down`));
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

/** One manager instance per distinct model repo, since each keeps its own
 * process with its own model resident in memory; the venv/dependencies
 * underneath are shared. */
const managers = new Map();

/** @param {string} modelRepo */
export function getMlxAudioManager(modelRepo) {
  let manager = managers.get(modelRepo);
  if (!manager) {
    manager = new MlxAudioManager(modelRepo);
    managers.set(modelRepo, manager);
  }
  return manager;
}

export function shutdownAllMlxAudioManagers() {
  for (const manager of managers.values()) {
    manager.shutdown();
  }
}

/**
 * Removing a model only clears its own "ready" marker (forcing a fresh
 * ensureReady() on next use) -- the shared venv is left alone since other
 * mlx-audio models may still depend on it, and the actual weights live in
 * the Hugging Face cache (~/.cache/huggingface), outside modelsDir entirely.
 * @param {string} modelsDir
 * @param {string} modelRepo
 */
export async function removeMlxAudioModel(modelsDir, modelRepo) {
  managers.get(modelRepo)?.shutdown();
  await rm(getMarkerFile(modelsDir, modelRepo), { force: true });
}
