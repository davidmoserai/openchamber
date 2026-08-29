#!/usr/bin/env python3
"""
OmniVoice inference sidecar.

Runs as a long-lived child process of the OpenChamber Node server
(spawned/managed by ../omnivoice-manager.js). Speaks newline-delimited JSON
over stdin/stdout:

  stdin  (per line): {"id": str, "cmd": "generate", "text": str,
                      "refAudioPath"?: str, "refText"?: str,
                      "language"?: str, "speed"?: float}
  stdout (per line): {"id": str, "ok": true, "audioBase64": str,
                      "sampleRate": int}
                   | {"id": str, "ok": false, "error": str}

Before accepting requests, emits one status line to stdout:
  {"event": "loading"}
  {"event": "ready", "device": "cuda"|"mps"|"cpu"}
  {"event": "error", "error": str}   (fatal — process exits)

Never write anything except these JSON lines to stdout; diagnostics go to
stderr so they don't corrupt the protocol stream.
"""

import base64
import inspect
import io
import json
import sys
import wave

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

def pick_device():
    import torch
    if torch.cuda.is_available():
        return "cuda:0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"

def float_pcm_to_wav_base64(samples, sample_rate):
    import numpy as np
    clamped = np.clip(samples, -1.0, 1.0)
    pcm16 = (clamped * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm16.tobytes())
    return base64.b64encode(buffer.getvalue()).decode("ascii")

def main():
    try:
        import torch
        from omnivoice import OmniVoice
    except Exception as error:  # noqa: BLE001 - report any import failure to Node
        emit({"event": "error", "error": f"Failed to import OmniVoice: {error}"})
        sys.exit(1)

    emit({"event": "loading"})

    device = pick_device()
    dtype = torch.float16 if device != "cpu" else torch.float32

    try:
        model = OmniVoice.from_pretrained(
            "k2-fsa/OmniVoice",
            device_map=device,
            dtype=dtype,
        )
    except Exception as error:  # noqa: BLE001
        emit({"event": "error", "error": f"Failed to load OmniVoice model: {error}"})
        sys.exit(1)

    generate_params = set(inspect.signature(model.generate).parameters)
    emit({"event": "ready", "device": device})

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
            emit({"id": request_id, "ok": True, "ready": True, "device": device})
            continue

        if cmd != "generate":
            emit({"id": request_id, "ok": False, "error": f"Unknown command: {cmd}"})
            continue

        try:
            text = request["text"]
            kwargs = {"text": text}
            if request.get("refAudioPath") and request.get("refText"):
                kwargs["ref_audio"] = request["refAudioPath"]
                kwargs["ref_text"] = request["refText"]
            if request.get("language") and "language" in generate_params:
                kwargs["language"] = request["language"]
            if request.get("speed") and "speed" in generate_params:
                kwargs["speed"] = request["speed"]

            audio = model.generate(**kwargs)
            samples = audio[0] if isinstance(audio, list) else audio
            sample_rate = getattr(model, "sample_rate", 24000)

            emit({
                "id": request_id,
                "ok": True,
                "audioBase64": float_pcm_to_wav_base64(samples, sample_rate),
                "sampleRate": sample_rate,
            })
        except Exception as error:  # noqa: BLE001 - surface generation errors to Node
            emit({"id": request_id, "ok": False, "error": str(error)})

if __name__ == "__main__":
    main()
