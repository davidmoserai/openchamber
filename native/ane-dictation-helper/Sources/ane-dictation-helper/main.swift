import Foundation
import FluidAudio

/// Dictation local-speech helper: Parakeet TDT v3 on the Apple Neural Engine
/// via FluidAudio, spoken to over stdio.
///
/// Two modes, mirroring the Node-side sherpa-onnx worker's split between
/// model download and session serving (see
/// packages/web/server/lib/dictation/local/{model-downloader,worker-process}.js):
///
///   ane-dictation-helper download
///     Downloads/compiles the CoreML bundles via FluidAudio's own HuggingFace
///     cache (~/Library/Application Support/FluidAudio/Models) and exits.
///     Idempotent: a no-op if already cached.
///
///   ane-dictation-helper serve
///     Loads the (already-downloaded) models, then serves newline-delimited
///     JSON requests on stdin / responses+events on stdout. Protocol mirrors
///     worker-process.js: session.create/append/commit/clear/close in,
///     {type:"response", requestId, ok, result?, error?} plus
///     session.committed / session.transcript / session.error out.
enum HelperError: Error, CustomStringConvertible {
    case invalidMessage(String)
    case unknownType(String)
    case unknownSession(String)

    var description: String {
        switch self {
        case .invalidMessage(let type): return "Invalid \(type) message"
        case .unknownType(let type): return "Unknown request type: \(type)"
        case .unknownSession(let id): return "Unknown session: \(id)"
        }
    }
}

actor SessionStore {
    private let asrManager: AsrManager
    private var sessions: [String: DictationSession] = [:]

    init(asrManager: AsrManager) {
        self.asrManager = asrManager
    }

    func create(sessionId: String) {
        sessions[sessionId] = DictationSession(sessionId: sessionId, asrManager: asrManager)
    }

    func get(sessionId: String) -> DictationSession? {
        sessions[sessionId]
    }

    func remove(sessionId: String) {
        sessions.removeValue(forKey: sessionId)
    }
}

func pcm16leSamples(from data: Data) -> [Int16] {
    let count = data.count / 2
    guard count > 0 else { return [] }
    var samples = [Int16](repeating: 0, count: count)
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        for i in 0..<count {
            let low = UInt16(raw[i * 2])
            let high = UInt16(raw[i * 2 + 1])
            samples[i] = Int16(bitPattern: low | (high << 8))
        }
    }
    return samples
}

func respondOk(requestId: String?, result: [String: Any]?) async {
    guard let requestId else { return }
    await Outbox.shared.send(["type": "response", "requestId": requestId, "ok": true, "result": result])
}

func respondError(requestId: String?, message: String) async {
    guard let requestId else { return }
    await Outbox.shared.send(["type": "response", "requestId": requestId, "ok": false, "error": message])
}

func handle(message: [String: Any], store: SessionStore) async {
    let type = message["type"] as? String ?? ""
    let requestId = message["requestId"] as? String

    do {
        switch type {
        case "session.create":
            guard let sessionId = message["sessionId"] as? String else {
                throw HelperError.invalidMessage(type)
            }
            await store.create(sessionId: sessionId)
            await respondOk(requestId: requestId, result: ["requiredSampleRate": 16000])

        case "session.append":
            guard
                let sessionId = message["sessionId"] as? String,
                let audioBase64 = message["audio"] as? String,
                let audioData = Data(base64Encoded: audioBase64)
            else {
                throw HelperError.invalidMessage(type)
            }
            guard let session = await store.get(sessionId: sessionId) else {
                throw HelperError.unknownSession(sessionId)
            }
            await session.append(pcm16leSamples(from: audioData))
            await respondOk(requestId: requestId, result: nil)

        case "session.commit":
            guard let sessionId = message["sessionId"] as? String else {
                throw HelperError.invalidMessage(type)
            }
            guard let session = await store.get(sessionId: sessionId) else {
                throw HelperError.unknownSession(sessionId)
            }
            await session.commit()
            await respondOk(requestId: requestId, result: nil)

        case "session.clear":
            guard let sessionId = message["sessionId"] as? String else {
                throw HelperError.invalidMessage(type)
            }
            guard let session = await store.get(sessionId: sessionId) else {
                throw HelperError.unknownSession(sessionId)
            }
            await session.clear()
            await respondOk(requestId: requestId, result: nil)

        case "session.close":
            guard let sessionId = message["sessionId"] as? String else {
                throw HelperError.invalidMessage(type)
            }
            await store.remove(sessionId: sessionId)
            await respondOk(requestId: requestId, result: nil)

        default:
            throw HelperError.unknownType(type)
        }
    } catch {
        await respondError(requestId: requestId, message: "\(error)")
    }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
    exit(1)
}

func runDownload() async {
    do {
        _ = try await AsrModels.downloadAndLoad(version: .v3)
        exit(0)
    } catch {
        fail("Model download failed: \(error)")
    }
}

func runServe() async {
    let models: AsrModels
    do {
        // Idempotent: hits FluidAudio's local cache if `download` already ran.
        models = try await AsrModels.downloadAndLoad(version: .v3)
    } catch {
        fail("Model load failed: \(error)")
    }

    let asrManager = AsrManager()
    do {
        try await asrManager.loadModels(models)
    } catch {
        fail("ASR manager failed to load models: \(error)")
    }

    let store = SessionStore(asrManager: asrManager)
    await Outbox.shared.send(["type": "ready"])

    // Requests are handled strictly in stdin arrival order. This matters:
    // 'session.append' and 'session.commit' for the same session must apply
    // to the DictationSession actor in the order the client sent them, or a
    // commit can race ahead of still-pending appends and finalize on a
    // truncated buffer. Unpacking each line into its own concurrent Task lost
    // that ordering guarantee — audio chunks queue harmlessly in the stdin
    // pipe while a decode is in flight, so sequential handling costs nothing
    // observable given ANE decode latency.
    while let line = readLine(strippingNewline: true) {
        guard !line.isEmpty,
            let data = line.data(using: .utf8),
            let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            continue
        }
        await handle(message: parsed, store: store)
    }
}

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "serve"
switch mode {
case "download":
    await runDownload()
case "serve":
    await runServe()
default:
    fail("Unknown mode: \(mode) (expected 'download' or 'serve')")
}
