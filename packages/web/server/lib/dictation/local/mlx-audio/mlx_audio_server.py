#!/usr/bin/env python3
"""
Generic mlx-audio inference sidecar -- works for any mlx-audio TTS model
(Qwen3-TTS, OmniVoice-MLX, or future additions), selected by the Hugging
Face repo id passed as argv[1]. This is what lets ../mlx-audio-manager.js
be a single generic manager rather than one near-duplicate file per model.

Same newline-delimited JSON protocol as the (removed) OmniVoice/Qwen3-TTS
PyTorch-era sidecars:

  stdin  (per line): {"id": str, "cmd": "generate", "text": str,
                      "refAudioPath"?: str, "refText"?: str,
                      "language"?: str, "speed"?: float}
  stdout (per line): {"id": str, "ok": true, "audioBase64": str,
                      "sampleRate": int}
                   | {"id": str, "ok": false, "error": str}

Startup status lines: {"event": "loading"}, {"event": "ready", "device": "mlx"},
{"event": "error", "error": str}. MLX only targets Apple Silicon and has no
device_map to choose -- there is nothing to select here.
"""

import base64
import json
import sys
import tempfile
from pathlib import Path

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

def main():
    if len(sys.argv) < 2:
        emit({"event": "error", "error": "Missing required model repo argument"})
        sys.exit(1)
    model_id = sys.argv[1]

    try:
        from mlx_audio.tts.generate import generate_audio
        from mlx_audio.tts.utils import load_model
    except Exception as error:  # noqa: BLE001
        emit({"event": "error", "error": f"Failed to import mlx-audio: {error}"})
        sys.exit(1)

    emit({"event": "loading"})

    try:
        model = load_model(model_id)
    except Exception as error:  # noqa: BLE001
        emit({"event": "error", "error": f"Failed to load {model_id}: {error}"})
        sys.exit(1)

    emit({"event": "ready", "device": "mlx"})

    with tempfile.TemporaryDirectory(prefix="mlx-audio-sidecar-") as tmp_dir:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue

            request_id = request.get("id")
            cmd = request.get("cmd")

            if cmd == "ping":
                emit({"id": request_id, "ok": True, "ready": True, "device": "mlx"})
                continue

            if cmd != "generate":
                emit({"id": request_id, "ok": False, "error": f"Unknown command: {cmd}"})
                continue

            try:
                file_prefix = f"gen-{request_id}"
                generate_audio(
                    text=request["text"],
                    model=model,
                    ref_audio=request.get("refAudioPath"),
                    ref_text=request.get("refText"),
                    lang_code=request.get("language") or "en",
                    speed=request.get("speed") or 1.0,
                    output_path=tmp_dir,
                    file_prefix=file_prefix,
                    save=True,
                    verbose=False,
                    play=False,
                )

                output_path = Path(tmp_dir) / f"{file_prefix}_000.wav"
                audio_bytes = output_path.read_bytes()
                output_path.unlink(missing_ok=True)

                emit({
                    "id": request_id,
                    "ok": True,
                    "audioBase64": base64.b64encode(audio_bytes).decode("ascii"),
                    "sampleRate": 24000,
                })
            except Exception as error:  # noqa: BLE001
                emit({"id": request_id, "ok": False, "error": str(error)})

if __name__ == "__main__":
    main()
