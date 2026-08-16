/**
 * Dictation service: resolves STT providers, tracks local model download
 * state, and exposes a readiness snapshot for the status route.
 *
 * Providers:
 * - 'local' (default): sherpa-onnx Parakeet running in a worker process.
 *   Models auto-download in the background on first use.
 * - 'openai-compatible': any OpenAI-compatible /v1/audio/transcriptions
 *   endpoint (faster-whisper, whisper.cpp, OpenAI).
 */

import { rm } from 'fs/promises';

import { DictationWorkerClient, WorkerBackedTranscriptionSession } from './local/worker-client.js';
import { AneHelperClient, AneBackedTranscriptionSession } from './local-ane/client.js';
import { isAneDictationSupported } from './local-ane/capability.js';
import { deleteAneSttModel, ensureAneSttModel, isAneSttModelInstalled } from './local-ane/model-downloader.js';
import { OpenAICompatibleTranscriptionSession } from './openai-compatible-session.js';
import {
  ANE_STT_MODEL_DESCRIPTION,
  ANE_STT_MODEL_ID,
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LOCAL_STT_MODEL_CATALOG,
  LOCAL_STT_MODEL_IDS,
  LOCAL_TTS_MODEL_CATALOG,
  LOCAL_TTS_MODEL_IDS,
  getLocalSttModelDir,
  isAneSttModelId,
  isLocalModelId,
  isLocalSttModelId,
  isLocalTtsModelId,
} from './local/model-catalog.js';
import { ensureLocalSttModel, isLocalSttModelInstalled } from './local/model-downloader.js';

export function createDictationService({ modelsDir }) {
  const workerClient = new DictationWorkerClient();
  const aneClient = new AneHelperClient();
  /** modelId -> 'downloading' | 'error' */
  const downloadStates = new Map();
  /** modelId -> last download error message */
  const downloadErrors = new Map();
  /** modelId -> in-flight ensure promise */
  const downloadPromises = new Map();
  /** modelId -> 0..100 download percent (null while size unknown) */
  const downloadProgress = new Map();

  const startModelDownload = (modelId) => {
    const existing = downloadPromises.get(modelId);
    if (existing) {
      return existing;
    }
    downloadStates.set(modelId, 'downloading');
    downloadErrors.delete(modelId);
    // The ANE helper delegates to FluidAudio's own downloader, which doesn't
    // report byte progress back to us — stays null (an already-supported UI
    // state) instead of a fake 0.
    downloadProgress.set(modelId, isAneSttModelId(modelId) ? null : 0);
    const ensure = isAneSttModelId(modelId)
      ? ensureAneSttModel({ modelsDir })
      : ensureLocalSttModel({
          modelsDir,
          modelId,
          onProgress: (downloadedBytes, totalBytes) => {
            downloadProgress.set(
              modelId,
              totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null,
            );
          },
        });
    const promise = ensure
      .then(() => {
        downloadStates.delete(modelId);
        downloadPromises.delete(modelId);
        downloadProgress.delete(modelId);
      })
      .catch((error) => {
        downloadStates.set(modelId, 'error');
        downloadErrors.set(modelId, error?.message || String(error));
        downloadPromises.delete(modelId);
        downloadProgress.delete(modelId);
      });
    downloadPromises.set(modelId, promise);
    return promise;
  };

  const resolveLocalModelId = (requested) => {
    if (isAneSttModelId(requested) && isAneDictationSupported()) {
      return requested;
    }
    return isLocalSttModelId(requested) ? requested : DEFAULT_LOCAL_STT_MODEL;
  };

  /**
   * Create a connected StreamingTranscriptionSession for one dictation.
   * Returns { session } on success or { error, retryable, reasonCode } when
   * the provider is not ready.
   *
   * @param {{ provider?: string, language?: string, localModel?: string,
   *           openaiCompatible?: { baseUrl?: string, model?: string, apiKey?: string } }} options
   */
  const createSttSession = async (options = {}) => {
    const provider = options.provider === 'openai-compatible' ? 'openai-compatible' : 'local';

    if (provider === 'openai-compatible') {
      const config = options.openaiCompatible || {};
      const session = new OpenAICompatibleTranscriptionSession({
        baseURL: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey || undefined,
        language: options.language || undefined,
      });
      try {
        await session.connect();
      } catch (error) {
        return {
          error: error?.message || String(error),
          retryable: false,
          reasonCode: 'stt_not_configured',
        };
      }
      return { session };
    }

    const modelId = resolveLocalModelId(options.localModel);
    const isAne = isAneSttModelId(modelId);
    const installed = isAne
      ? await isAneSttModelInstalled(modelsDir)
      : await isLocalSttModelInstalled(modelsDir, modelId);
    if (!installed) {
      const state = downloadStates.get(modelId);
      if (state === 'error') {
        const message = downloadErrors.get(modelId) || 'Model download failed';
        // Allow a retry on the next attempt.
        downloadStates.delete(modelId);
        return {
          error: `Failed to download dictation model: ${message}`,
          retryable: true,
          reasonCode: 'model_download_failed',
        };
      }
      void startModelDownload(modelId);
      return {
        error: 'Dictation model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      };
    }

    if (isAne) {
      const session = new AneBackedTranscriptionSession(aneClient);
      try {
        await session.connect();
      } catch (error) {
        return {
          error: error?.message || String(error),
          retryable: true,
          reasonCode: 'stt_unavailable',
        };
      }
      return { session };
    }

    const session = new WorkerBackedTranscriptionSession(workerClient, { modelsDir, modelId });
    try {
      await session.connect();
    } catch (error) {
      const message = error?.message || String(error);
      // A model that passes the file-presence check but fails to load is
      // corrupt on disk (e.g. truncated by an interrupted extraction). Remove
      // it so the next attempt re-downloads instead of crashing forever.
      if (/Load model|Protobuf parsing failed/i.test(message)) {
        await rm(getLocalSttModelDir(modelsDir, modelId), { recursive: true, force: true })
          .catch(() => undefined);
        return {
          error: 'Dictation model files were corrupt and have been removed; retry to re-download',
          retryable: true,
          reasonCode: 'model_corrupt',
        };
      }
      return {
        error: message,
        retryable: true,
        reasonCode: 'stt_unavailable',
      };
    }
    return { session };
  };

  /**
   * Readiness snapshot for the status route and UI gating.
   * @param {{ provider?: string, localModel?: string }} [options]
   */
  const getStatus = async (options = {}) => {
    const provider = options.provider === 'openai-compatible' ? 'openai-compatible' : 'local';
    const modelId = resolveLocalModelId(options.localModel);

    const describeModel = async (id, catalog) => ({
      id,
      description: catalog[id].description,
      installed: await isLocalSttModelInstalled(modelsDir, id),
      downloading: downloadStates.get(id) === 'downloading',
      downloadProgress: downloadProgress.get(id) ?? null,
      downloadError: downloadErrors.get(id) || null,
      deletable: true,
    });

    const models = await Promise.all(
      LOCAL_STT_MODEL_IDS.map((id) => describeModel(id, LOCAL_STT_MODEL_CATALOG)),
    );
    // Only ever surfaced on macOS Apple Silicon with the helper binary
    // present — everyone else sees exactly the sherpa-onnx CPU model list
    // above, unchanged.
    if (isAneDictationSupported()) {
      models.push({
        id: ANE_STT_MODEL_ID,
        description: ANE_STT_MODEL_DESCRIPTION,
        installed: await isAneSttModelInstalled(modelsDir),
        downloading: downloadStates.get(ANE_STT_MODEL_ID) === 'downloading',
        downloadProgress: downloadProgress.get(ANE_STT_MODEL_ID) ?? null,
        downloadError: downloadErrors.get(ANE_STT_MODEL_ID) || null,
        deletable: true,
      });
    }
    const ttsModels = await Promise.all(
      LOCAL_TTS_MODEL_IDS.map((id) => describeModel(id, LOCAL_TTS_MODEL_CATALOG)),
    );

    if (provider === 'openai-compatible') {
      return { provider, available: true, models, ttsModels };
    }

    const model = models.find((entry) => entry.id === modelId) || null;
    if (model?.installed) {
      return { provider, available: true, activeModel: modelId, models, ttsModels };
    }
    if (model?.downloading) {
      return {
        provider,
        available: false,
        reasonCode: 'model_download_in_progress',
        activeModel: modelId,
        models,
        ttsModels,
      };
    }
    if (model?.downloadError) {
      return {
        provider,
        available: false,
        reasonCode: 'model_download_failed',
        error: model.downloadError,
        activeModel: modelId,
        models,
        ttsModels,
      };
    }
    return {
      provider,
      available: false,
      reasonCode: 'models_missing',
      activeModel: modelId,
      models,
      ttsModels,
    };
  };

  /**
   * Synthesize speech with the local TTS model. Returns WAV bytes, or a
   * readiness error while the model is missing/downloading.
   * @param {{ text: string, model?: string, speakerId?: number, speed?: number }} options
   */
  const synthesizeSpeech = async ({ text, model, speakerId, speed }) => {
    const modelId = isLocalTtsModelId(model) ? model : DEFAULT_LOCAL_TTS_MODEL;
    const installed = await isLocalSttModelInstalled(modelsDir, modelId);
    if (!installed) {
      const state = downloadStates.get(modelId);
      if (state === 'error') {
        const message = downloadErrors.get(modelId) || 'Model download failed';
        downloadStates.delete(modelId);
        return {
          error: `Failed to download TTS model: ${message}`,
          retryable: true,
          reasonCode: 'model_download_failed',
        };
      }
      void startModelDownload(modelId);
      return {
        error: 'TTS model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      };
    }

    const result = await workerClient.synthesizeSpeech({
      modelsDir,
      modelId,
      text,
      speakerId,
      speed,
    });
    return { audio: result.audio, format: result.format };
  };

  /**
   * Kick off a background download for a model (used by the status route's
   * download action so Settings can pre-download models).
   */
  const requestModelDownload = async (modelId) => {
    const isAne = isAneSttModelId(modelId);
    if (!isAne && !isLocalModelId(modelId)) {
      return { ok: false, error: 'Unknown model id' };
    }
    if (isAne && !isAneDictationSupported()) {
      return { ok: false, error: 'Apple Neural Engine dictation is not supported on this device' };
    }
    const installed = isAne
      ? await isAneSttModelInstalled(modelsDir)
      : await isLocalSttModelInstalled(modelsDir, modelId);
    if (installed) {
      return { ok: true, installed: true };
    }
    void startModelDownload(modelId);
    return { ok: true, installed: false };
  };

  /**
   * Delete an installed model from disk. A model that is mid-download cannot
   * be deleted. An engine already loaded in the worker keeps its in-memory
   * copy until the worker's idle shutdown; the files are simply re-downloaded
   * on the next use if the model is selected again.
   */
  const deleteModel = async (modelId) => {
    const isAne = isAneSttModelId(modelId);
    if (!isAne && !isLocalModelId(modelId)) {
      return { ok: false, error: 'Unknown model id' };
    }
    if (downloadStates.get(modelId) === 'downloading') {
      return { ok: false, error: 'Model is downloading' };
    }
    if (isAne) {
      await deleteAneSttModel(modelsDir);
    } else {
      await rm(getLocalSttModelDir(modelsDir, modelId), { recursive: true, force: true });
    }
    downloadErrors.delete(modelId);
    return { ok: true };
  };

  const shutdown = () => {
    workerClient.shutdown();
    aneClient.shutdown();
  };

  return {
    createSttSession,
    synthesizeSpeech,
    getStatus,
    requestModelDownload,
    deleteModel,
    shutdown,
  };
}
