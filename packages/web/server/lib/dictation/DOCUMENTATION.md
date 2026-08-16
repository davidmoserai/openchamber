# Dictation module

Server-authoritative streaming speech-to-text for the chat composer, plus
local text-to-speech. The client streams 16 kHz mono PCM16 chunks (base64)
over a WebSocket; the server runs the transcription and streams live partial
transcripts back.

Local TTS (Kokoro via sherpa-onnx OfflineTts) runs in the same worker process
and is exposed as `POST /api/dictation/tts/speak` (JSON `{text, speakerId?,
speed?, model?}` → WAV bytes; 503 with `reasonCode` while the model is
downloading). TTS models live in the same catalog/downloader as STT models
(`local/model-catalog.js` `LOCAL_TTS_MODEL_CATALOG`) and are managed by the
same status/download/delete routes.

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
  - `local` (default): two engines behind one provider, selected by model id:
    - sherpa-onnx Parakeet/Whisper in a forked worker process (`local/`).
    - Apple Neural Engine Parakeet TDT v3 via a spawned Swift helper process
      (`local-ane/`), macOS Apple Silicon only — see below.
    Both engines share the same download-state machine
    (`downloadStates`/`downloadErrors`/`downloadProgress` in `service.js`)
    and the same `StreamingTranscriptionSession` contract
    (`connect`/`appendPcm16`/`commit`/`clear`/`close`, `EventEmitter` events
    `committed`/`transcript`/`error`), so `stream-manager.js` never needs to
    know which engine backs a session. Models auto-download in the
    background on first use; while missing, the stream fails with
    `reasonCode: 'model_download_in_progress'` and the status route reports
    per-model install/download state.
  - `openai-compatible`: buffered per-segment transcription against any
    OpenAI-compatible `/v1/audio/transcriptions` endpoint
    (`openai-compatible-session.js`, reuses `../tts/stt.js`).
- `local/` — worker process + client (IPC, idle shutdown TTL), sherpa
  recognizer engine and realtime session (throttled re-decode for partials),
  model catalog and downloader. The native `sherpa-onnx-node` addon is only
  ever loaded inside the worker process.
- `local-ane/` — client for the `ane-dictation-helper` Swift process
  (`native/ane-dictation-helper/`, FluidAudio/Parakeet TDT v3 on the Neural
  Engine). Same throttled-re-decode partial strategy as sherpa, but over a
  newline-delimited JSON stdio protocol instead of Node `fork()` IPC, since
  the helper isn't a Node process. `capability.js` is the single source of
  truth for whether this engine is offered at all — server-side chip model +
  macOS version + helper-binary-present check (never client-side: dictation
  audio is processed server-side, and the browser can be a different machine
  than the server). `model-downloader.js` tracks install state with our own
  marker file rather than sherpa's file-presence check, since FluidAudio
  downloads/compiles into its own cache
  (`~/Library/Application Support/FluidAudio/Models/`); delete removes that
  cache directory directly (path documented in FluidAudio's own Manual Model
  Loading guide, confirmed by inspection) plus the marker.
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
- ANE availability is decided by `local-ane/capability.js` reading the
  server's own hardware/OS, never by trusting a client-reported platform —
  the status route's `models` list is the only thing the client acts on.
- The stream manager acks only the highest contiguous seq; the client is
  expected to retain unacked segments for retry/replay.
- Silence-only segments (peak < 300) are cleared, never committed, so
  Whisper-style providers do not hallucinate on silence.
- Model files live under `~/.config/openchamber/speech-models`.
