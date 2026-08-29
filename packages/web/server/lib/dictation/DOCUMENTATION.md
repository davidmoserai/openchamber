# Dictation module

Server-authoritative streaming speech-to-text for the chat composer, plus
local text-to-speech. The client streams 16 kHz mono PCM16 chunks (base64)
over a WebSocket; the server runs the transcription and streams live partial
transcripts back.

Local TTS runs three interchangeable engines behind one route,
`POST /api/dictation/tts/speak` (JSON `{text, speakerId?, speed?, model?,
refVoiceId?, language?, voiceSessionId?}` → WAV bytes; 503 with `reasonCode`
while the model is downloading):

- `kokoro-en-v0_19` — sherpa-onnx OfflineTts (native addon), runs in the same
  forked worker process as STT. English only, fixed voice bank
  (`speakerId`).
- `omnivoice-multilingual` and `qwen3-tts-multilingual` — zero-shot
  voice-cloning models (OmniVoice: 600+ languages; Qwen3-TTS: 10 languages,
  meaningfully faster). No Node/ONNX equivalent exists with cloning at this
  breadth, so both run as isolated **Python** (mlx-audio / MLX) child
  processes instead of a forked Node worker — see `local/mlx-audio-manager.js`.
  MLX only targets Apple Silicon, so these two are Mac-only. Node still owns
  the process lifecycle, HTTP routes, and all state; Python only performs
  inference. `refVoiceId` selects a saved reference clip (`local/voice-profiles.js`,
  `GET/POST/DELETE /api/dictation/tts/voices`); omitting it uses the model's
  default voice, in which case a shared `voiceSessionId` across a message's
  pipelined chunks keeps every chunk cloning whichever voice the first chunk
  happened to sample, instead of a new random speaker per chunk (see
  `MlxAudioManager.synthesize`'s auto-reference-session cache). `language` is
  an optional hint — omitting it lets the model infer the language from the
  text; OmniVoice takes ISO 639 codes, Qwen3-TTS takes language names
  ("German"), enforced by the two engines' respective option lists in
  `packages/ui/src/components/sections/openchamber/VoiceSettings.tsx`.

All three models live in the same catalog/downloader as STT models
(`local/model-catalog.js` `LOCAL_TTS_MODEL_CATALOG`) and are managed by the
same status/download/delete routes; `model-downloader.js` branches on
`type === 'mlx-audio'` to delegate install/readiness to
`getMlxAudioManager(spec.modelRepo)` instead of the generic tar.bz2 archive
path. The two mlx-audio models share one Python venv (`mlx-audio` is their
only dependency) but each gets its own long-lived sidecar process, since
each keeps a different model resident in memory.

## Ownership

- `runtime.js` — registers `GET /api/dictation/status`,
  `POST /api/dictation/models/:modelId/download`, and the
  `/api/dictation/ws` WebSocket endpoint (auth-gated the same way as the
  terminal WS: UI session token or `oc_url_token`, plus origin check).
  Created from the startup pipeline (`startup-pipeline-runtime.js`) before
  the generic OpenCode proxy so routes are not shadowed.
- `stream-manager.js` — `DictationStreamManager`, one per WS connection.
  Chunk reordering by `seq` + ack, resampling to the provider rate,
  auto-commit every ~15 s of audio, silence suppression by PCM peak,
  partial-transcript concatenation, adaptive finalization timeout.
- `service.js` — provider resolution and readiness. Providers:
  - `local` (default): sherpa-onnx Parakeet TDT in a forked worker process.
    Models auto-download in the background on first use; while missing, the
    stream fails with `reasonCode: 'model_download_in_progress'` and the
    status route reports per-model install/download state.
  - `openai-compatible`: buffered per-segment transcription against any
    OpenAI-compatible `/v1/audio/transcriptions` endpoint
    (`openai-compatible-session.js`, reuses `../tts/stt.js`).
- `local/` — worker process + client (IPC, idle shutdown TTL), sherpa
  recognizer engine and realtime session (throttled re-decode for partials),
  model catalog and downloader. The native `sherpa-onnx-node` addon is only
  ever loaded inside the worker process.
  - `mlx-audio-manager.js` — generic manager for any mlx-audio-backed model:
    bootstraps a `uv`-managed Python venv (shared across models — `mlx-audio`
    is the only dependency), spawns `mlx-audio/mlx_audio_server.py` per
    model repo (passed as argv[1]) and speaks newline-delimited JSON over its
    stdio, and idle-shuts-down each sidecar after 10 minutes. A per-call
    `ensureReady()` timeout only bounds how long *that caller* waits — a slow
    first-run download/pip-install is never killed for taking too long; it
    keeps progressing in the background and the next status poll or retry
    picks up the same in-flight process. `getMlxAudioManager(modelRepo)`
    caches one manager instance per distinct model.
  - `voice-profiles.js` — saved reference clips (WAV + exact transcript) for
    cloning, under `<modelsDir>/omnivoice-voices/<id>/`. Shared across both
    mlx-audio models, not scoped per engine.
- `audio.js` — PCM16 helpers: format parsing, peak, WAV wrapping, streaming
  linear resampler.

## WebSocket protocol (JSON text frames)

Client → server: `start {dictationId, format, options}`,
`chunk {dictationId, seq, audio}`, `finish {dictationId, finalSeq}`,
`cancel {dictationId}`, `ping`.

Server → client: `ready`, `ack {ackSeq}`, `partial {text}`,
`finish_accepted {timeoutMs}`, `final {text}`,
`error {error, retryable, reasonCode?}`, `pong`.

`options` in `start` carries the client-selected provider config:
`{ provider: 'local' | 'openai-compatible', language?, localModel?,
openaiCompatible?: { baseUrl, model, apiKey } }`.

## Invariants

- Never load `sherpa-onnx-node` in the main server process.
- The stream manager acks only the highest contiguous seq; the client is
  expected to retain unacked segments for retry/replay.
- Silence-only segments (peak < 300) are cleared, never committed, so
  Whisper-style providers do not hallucinate on silence.
- Model files live under `~/.config/openchamber/speech-models`.
