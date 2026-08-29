/**
 * Manages the Qwen3-TTS (MLX) Python inference sidecar: one-time environment
 * bootstrap (uv venv + pip install), lazy spawn, newline-delimited JSON
 * request/response over stdio, and idle shutdown.
 *
 * Structurally identical to omnivoice-manager.js (same protocol, same
 * auto-reference-voice-session mechanism for pipelined-chunk consistency),
 * but the bootstrap is simpler: MLX has no separate device_map to pick and
 * no PyTorch/CUDA wheel selection -- it only targets Apple Silicon and
 * handles that automatically. `mlx-audio` is the only dependency.
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
const SIDECAR_DIR = path.join(__dirname, 'qwen-tts');
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'qwen_tts_server.py');
const REQUIREMENTS_FILE = path.join(SIDECAR_DIR, 'requirements.txt');

const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
// See omnivoice-manager.js's READY_TIMEOUT_MS for why this only bounds a
// single caller's patience, not the underlying bootstrap/download.
const READY_TIMEOUT_MS = 90 * 1000;
const REQUEST_TIMEOUT_MS = 120 * 1000;
const AUTO_REF_SESSION_TTL_MS = 3 * 60 * 1000;
const AUTO_REF_SESSION_DIR = path.join(os.tmpdir(), 'openchamber-qwen-tts-sessions');

export function getVenvDir(modelsDir) {
  return path.join(modelsDir, 'qwen-tts-venv');
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
export function isQwenTtsInstalled(modelsDir) {
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
        reject(new Error('uv is required to run Qwen3-TTS locally. Install it from https://docs.astral.sh/uv/getting-started/installation/ and try again.'));
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

export class QwenTtsManager {
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

  /** See OmniVoiceManager._cacheAutoRefSession -- identical purpose. */
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
      onProgress?.('Ready');
      return;
    }
    if (message.event === 'loading' || message.event === 'error') {
      if (message.event === 'error') {
        this._failAllPending(new Error(message.error));
      }
      if (message.event !== 'error') {
        onProgress?.('Loading Qwen3-TTS model');
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
      pending.reject(new Error(message.error || 'Qwen3-TTS generation failed'));
    }
  }

  _failAllPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** See OmniVoiceManager._bootstrapAndSpawn -- identical structure. */
  _bootstrapAndSpawn(modelsDir, onProgress) {
    return (async () => {
      await bootstrapVenv(modelsDir, onProgress);

      const venvPython = getVenvPython(modelsDir);
      const child = spawn(venvPython, [SIDECAR_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          // Same Xet instability seen with OmniVoice's downloads applies
          // here too -- huggingface_hub is the download path either way.
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
            onProgress?.('Loading Qwen3-TTS model (first run downloads ~1.7 GB — this keeps running in the background even if a request times out)');
          }
        };
        this.rl.on('line', onLine);

        child.stderr.on('data', (chunk) => onProgress?.(chunk.toString().trim()));
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`Qwen3-TTS sidecar exited during startup (code ${code})`));
          }
        });
      });

      this.rl.removeAllListeners('line');
      this.rl.on('line', (line) => this._handleLine(line, onProgress));
      child.on('exit', () => {
        this._failAllPending(new Error('Qwen3-TTS sidecar exited unexpectedly'));
        this.process = null;
        this.rl = null;
        this.readyPromise = null;
      });

      writeFileSync(getMarkerFile(modelsDir), new Date().toISOString());
      this.device = readyResult.device;
      this._scheduleIdleShutdown();
      return readyResult;
    })().catch((error) => {
      this.readyPromise = null;
      this.shutdown();
      throw error;
    });
  }

  /** See OmniVoiceManager.ensureReady -- identical semantics. */
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
        () => reject(new Error('Still downloading/loading Qwen3-TTS — it is progressing in the background, retry shortly')),
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
        reject(new Error('Qwen3-TTS generation timed out'));
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
    this._failAllPending(new Error('Qwen3-TTS sidecar shut down'));
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
export const qwenTtsManager = new QwenTtsManager();

/**
 * @param {string} modelsDir
 */
export async function removeQwenTtsInstall(modelsDir) {
  qwenTtsManager.shutdown();
  await rm(getVenvDir(modelsDir), { recursive: true, force: true });
}
