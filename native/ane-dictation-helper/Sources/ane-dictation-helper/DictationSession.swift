import Foundation
import FluidAudio

/// One dictation segment. Mirrors the Node-side `SherpaRealtimeTranscriptionSession`
/// contract: accumulate PCM16 for the current segment, re-decode the whole
/// segment on a throttle to emit partials, and finalize on `commit()`.
///
/// There is no true incremental/cache-aware decode in the batch Parakeet API,
/// so partials come from re-running `AsrManager.transcribe` on the growing
/// buffer — the same strategy the sherpa-onnx engine uses, just backed by the
/// Neural Engine instead of CPU ONNX. This keeps both engines' latency/CPU
/// behavior directly comparable.
actor DictationSession {
    private let sessionId: String
    private let asrManager: AsrManager

    private var pcm: [Int16] = []
    private var currentSegmentId = UUID().uuidString
    private var previousSegmentId: String?
    private var lastPartialText = ""
    private var minDecodeIntervalMs: Double = 350
    private var lastDecodeAt = Date.distantPast
    private var decoding = false
    private var pendingDecode = false

    init(sessionId: String, asrManager: AsrManager) {
        self.sessionId = sessionId
        self.asrManager = asrManager
    }

    func append(_ chunk: [Int16]) async {
        pcm.append(contentsOf: chunk)
        await maybeDecode(force: false)
    }

    func commit() async {
        await maybeDecode(force: true)

        let finalText = lastPartialText
        let segmentId = currentSegmentId
        let previous = previousSegmentId

        await Outbox.shared.send([
            "type": "session.committed",
            "sessionId": sessionId,
            "payload": ["segmentId": segmentId, "previousSegmentId": previous],
        ])
        await Outbox.shared.send([
            "type": "session.transcript",
            "sessionId": sessionId,
            "payload": ["segmentId": segmentId, "transcript": finalText, "isFinal": true],
        ])

        previousSegmentId = segmentId
        currentSegmentId = UUID().uuidString
        lastPartialText = ""
        pcm.removeAll()
    }

    func clear() {
        pcm.removeAll()
        currentSegmentId = UUID().uuidString
        lastPartialText = ""
    }

    private func maybeDecode(force: Bool) async {
        if !force, Date().timeIntervalSince(lastDecodeAt) * 1000 < minDecodeIntervalMs {
            return
        }
        if decoding {
            pendingDecode = true
            return
        }
        // FluidAudio's transcribe(_:decoderState:) throws .invalidAudioData
        // below its own minimum (0.3s). Early in a segment the throttled
        // partial-decode can fire on just one ~100ms chunk; treat "too short
        // to decode yet" the same as "nothing to decode yet" rather than
        // surfacing it as a session error.
        let minimumSamples = ASRConstants.minimumRequiredSamples(forSampleRate: 16000)
        if pcm.count < minimumSamples {
            return
        }

        decoding = true
        let decodeStartedAt = Date()
        let samples = Self.floatSamplesWithAutoGain(pcm)

        do {
            // A fresh decoder state per call is correct here: we always feed the
            // complete accumulated segment from the start, not an incremental
            // continuation, so there is no hypothesis state to carry over.
            var decoderState = try TdtDecoderState()
            let result = try await asrManager.transcribe(samples, decoderState: &decoderState)
            lastDecodeAt = Date()
            // Adaptive throttle, same reasoning as the sherpa engine: re-decoding
            // a growing segment on every chunk would monopolize the helper on
            // long dictation. Space partial decodes to ~1.5x observed decode time.
            minDecodeIntervalMs = max(350, lastDecodeAt.timeIntervalSince(decodeStartedAt) * 1000 * 1.5)

            let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text != lastPartialText {
                lastPartialText = text
                await Outbox.shared.send([
                    "type": "session.transcript",
                    "sessionId": sessionId,
                    "payload": ["segmentId": currentSegmentId, "transcript": text, "isFinal": false],
                ])
            }
        } catch {
            await Outbox.shared.send([
                "type": "session.error",
                "sessionId": sessionId,
                "error": "\(error)",
            ])
        }

        decoding = false
        if pendingDecode {
            pendingDecode = false
            await maybeDecode(force: true)
        }
    }

    /// Same auto-gain strategy as the sherpa engine so quiet microphones decode
    /// consistently across both local STT backends.
    private static func floatSamplesWithAutoGain(_ pcm: [Int16]) -> [Float] {
        var peak: Int16 = 0
        for sample in pcm {
            let magnitude = sample == Int16.min ? Int16.max : abs(sample)
            if magnitude > peak {
                peak = magnitude
            }
        }
        let peakFloat = Float(peak) / 32768.0
        let targetPeak: Float = 0.6
        let maxGain: Float = 50
        let gain: Float = (peakFloat > 0 && peakFloat < targetPeak)
            ? min(maxGain, targetPeak / peakFloat)
            : 1

        return pcm.map { sample in
            max(-1, min(1, (Float(sample) / 32768.0) * gain))
        }
    }
}
