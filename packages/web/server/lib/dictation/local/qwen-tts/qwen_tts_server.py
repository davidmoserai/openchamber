#!/usr/bin/env python3
"""
Qwen3-TTS (MLX) inference sidecar.

Same newline-delimited JSON protocol as ../omnivoice/omnivoice_server.py, so
../qwen-tts-manager.js can reuse the same manager logic:

  stdin  (per line): {"id": str, "cmd": "generate", "text": str,
                      "refAudioPath"?: str, "refText"?: str,
                      "language"?: str, "speed"?: float}
  stdout (per line): {"id": str, "ok": true, "audioBase64": str,
                      "sampleRate": int}
                   | {"id": str, "ok": false, "error": str}

Startup status lines: {"event": "loading"}, {"event": "ready", "device": "mlx"},
{"event": "error", "error": str}.

Unlike OmniVoice (PyTorch, needs explicit cuda/mps/cpu selection), MLX only
targets Apple Silicon and picks its own device automatically -- there is no
device_map to choose here.
"""

import base64
import json
import sys
import tempfile
from pathlib import Path

MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit"

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

def main():
    try:
        from mlx_audio.tts.generate import generate_audio
        from mlx_audio.tts.utils import load_model
    except Exception as error:  # noqa: BLE001
        emit({"event": "error", "error": f"Failed to import mlx-audio: {error}"})
        sys.exit(1)

    emit({"event": "loading"})

    try:
        model = load_model(MODEL_ID)
    except Exception as error:  # noqa: BLE001
        emit({"event": "error", "error": f"Failed to load Qwen3-TTS model: {error}"})
        sys.exit(1)

    emit({"event": "ready", "device": "mlx"})

    with tempfile.TemporaryDirectory(prefix="qwen-tts-sidecar-") as tmp_dir:
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
