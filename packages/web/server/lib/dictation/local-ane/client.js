/**
 * Client for the `ane-dictation-helper` Swift process (see
 * native/ane-dictation-helper/). Structurally mirrors
 * `../local/worker-client.js` (DictationWorkerClient /
 * WorkerBackedTranscriptionSession) so `service.js` can treat both engines
 * the same way, but the transport differs: the helper is not a Node process,
 * so there's no structured-clone IPC channel — requests/responses/events are
 * newline-delimited JSON over stdin/stdout, with PCM16 audio base64-encoded
 * in the JSON payload.
 *
 * Protocol (see native/ane-dictation-helper/Sources/ane-dictation-helper):
 *   parent -> helper: {type:'session.create'|'session.append'|'session.commit'
 *     |'session.clear'|'session.close', requestId, sessionId, audio?}
 *   helper -> parent: {type:'response', requestId, ok, result?, error?}
 *     plus {type:'session.committed'|'session.transcript'|'session.error', sessionId, ...}
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import readline from 'readline';

import { resolveAneHelperPath } from './helper-path.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SAMPLE_RATE = 16000;
const STDERR_TAIL_MAX_CHARS = 2000;

function spawnAneHelper() {
  const helperPath = resolveAneHelperPath();
  if (!helperPath) {
    throw new Error('ANE dictation helper is not available on this system');
  }
  return spawn(helperPath, ['serve'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export class AneHelperClient {
  /**
   * @param {{ requestTimeoutMs?: number, idleTtlMs?: number }} [options]
   */
  constructor(options = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.pendingRequests = new Map();
    this.sessionEmitters = new Map();
    this.proc = null;
    this.stderrTail = '';
    this.inFlightRequests = 0;
    this.idleTimer = null;
    this.intentionalCloses = new WeakSet();
  }

  /**
   * @param {EventEmitter} emitter receives 'committed' | 'transcript' | 'error'
   * @returns {Promise<{ sessionId: string, requiredSampleRate: number }>}
   */
  async createSession(emitter) {
    const sessionId = randomUUID();
    this.sessionEmitters.set(sessionId, emitter);
    try {
      const result = await this.sendRequest({ type: 'session.create', sessionId });
      return { sessionId, requiredSampleRate: result?.requiredSampleRate ?? DEFAULT_SAMPLE_RATE };
    } catch (err) {
      this.sessionEmitters.delete(sessionId);
      this.scheduleIdleShutdownIfReady();
      throw err;
    }
  }

  appendSessionAudio(sessionId, audio) {
    const base64 = Buffer.isBuffer(audio) ? audio.toString('base64') : Buffer.from(audio).toString('base64');
    void this.sendRequest({ type: 'session.append', sessionId, audio: base64 }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  commitSession(sessionId) {
    void this.sendRequest({ type: 'session.commit', sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  clearSession(sessionId) {
    void this.sendRequest({ type: 'session.clear', sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  closeSession(sessionId) {
    this.sessionEmitters.delete(sessionId);
    void this.sendRequest({ type: 'session.close', sessionId }).catch(() => {
      // Closing is best-effort; the parent already dropped the session.
    });
    this.scheduleIdleShutdownIfReady();
  }

  shutdown() {
    this.clearIdleTimer();
    this.rejectAllPending(new Error('ANE dictation helper shut down'));
    this.sessionEmitters.clear();
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      this.intentionalCloses.add(proc);
      try {
        proc.stdin.end();
      } catch {
        // ignore
      }
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }

  sendRequest(input) {
    const proc = this.ensureProcess();
    const requestId = randomUUID();
    const message = { ...input, requestId };
    this.inFlightRequests += 1;
    this.clearIdleTimer();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
        this.scheduleIdleShutdownIfReady();
        reject(new Error(`ANE dictation helper request timed out: ${input.type}`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      try {
        proc.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
        this.scheduleIdleShutdownIfReady();
        reject(error);
      }
    });
  }

  ensureProcess() {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      return this.proc;
    }
    const proc = spawnAneHelper();
    this.proc = proc;
    this.stderrTail = '';
    proc.stderr?.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_MAX_CHARS);
    });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.handleHelperLine(line));
    proc.on('exit', (code, signal) => this.handleProcessExit(proc, code, signal));
    return proc;
  }

  handleHelperLine(line) {
    if (!line) {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // JSON.parse only ever yields null for a non-object top-level value we'd
    // reject here; property access on any other JSON primitive (string,
    // number, boolean, array) below just reads as undefined, so there's
    // nothing further to narrow.
    if (message === null) {
      return;
    }

    if (message.type === 'ready') {
      return;
    }

    if (message.type === 'response') {
      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.requestId);
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
      this.scheduleIdleShutdownIfReady();
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error || 'ANE dictation helper request failed'));
      }
      return;
    }

    const emitter = this.sessionEmitters.get(message.sessionId);
    if (!emitter) {
      return;
    }
    switch (message.type) {
      case 'session.committed':
        emitter.emit('committed', message.payload);
        return;
      case 'session.transcript':
        emitter.emit('transcript', message.payload);
        return;
      case 'session.error':
        emitter.emit('error', new Error(message.error));
        return;
      default:
    }
  }

  handleProcessExit(proc, code, signal) {
    const wasCurrentProcess = this.proc === proc;
    const wasIntentional = this.intentionalCloses.has(proc);
    this.intentionalCloses.delete(proc);
    if (!wasCurrentProcess || wasIntentional) {
      if (wasCurrentProcess) {
        this.proc = null;
      }
      return;
    }

    const stderr = this.stderrTail.trim();
    const error = new Error(
      `ANE dictation helper exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}).` +
        (stderr ? ` Last stderr: ${stderr.slice(-500)}` : ''),
    );

    this.proc = null;
    this.clearIdleTimer();
    this.rejectAllPending(error);
    for (const emitter of this.sessionEmitters.values()) {
      if (emitter.listenerCount('error') > 0) {
        emitter.emit('error', error);
      }
    }
    this.sessionEmitters.clear();
    this.inFlightRequests = 0;
  }

  rejectAllPending(error) {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  emitSessionError(sessionId, error) {
    const emitter = this.sessionEmitters.get(sessionId);
    if (emitter && emitter.listenerCount('error') > 0) {
      emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  scheduleIdleShutdownIfReady() {
    if (!this.proc || this.inFlightRequests > 0 || this.sessionEmitters.size > 0) {
      return;
    }
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.inFlightRequests === 0 && this.sessionEmitters.size === 0) {
        this.shutdown();
      }
    }, this.idleTtlMs);
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * StreamingTranscriptionSession backed by the ANE helper process. Matches the
 * same session contract as WorkerBackedTranscriptionSession, consumed by
 * DictationStreamManager.
 */
export class AneBackedTranscriptionSession extends EventEmitter {
  /**
   * @param {AneHelperClient} client
   */
  constructor(client) {
    super();
    this.client = client;
    this.requiredSampleRate = DEFAULT_SAMPLE_RATE;
    this.connectedSessionId = null;
    this.connecting = null;
  }

  async connect() {
    if (this.connectedSessionId) {
      return;
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        try {
          const result = await this.client.createSession(this);
          this.connectedSessionId = result.sessionId;
          this.requiredSampleRate = result.requiredSampleRate;
        } finally {
          this.connecting = null;
        }
      })();
    }
    await this.connecting;
  }

  appendPcm16(pcm16le) {
    if (!this.connectedSessionId) {
      this.emit('error', new Error('ANE STT session not connected'));
      return;
    }
    this.client.appendSessionAudio(this.connectedSessionId, pcm16le);
  }

  commit() {
    if (!this.connectedSessionId) {
      this.emit('error', new Error('ANE STT session not connected'));
      return;
    }
    this.client.commitSession(this.connectedSessionId);
  }

  clear() {
    if (this.connectedSessionId) {
      this.client.clearSession(this.connectedSessionId);
    }
  }

  close() {
    const sessionId = this.connectedSessionId;
    this.connectedSessionId = null;
    if (sessionId) {
      this.client.closeSession(sessionId);
    }
  }
}
