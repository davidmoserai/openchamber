import Foundation

/// Serializes writes to stdout so concurrent session tasks never interleave
/// partial JSON lines. One JSON object per line (newline-delimited).
actor Outbox {
    static let shared = Outbox()

    private let handle = FileHandle.standardOutput

    func send(_ payload: [String: Any?]) {
        let cleaned = payload.compactMapValues { $0 }
        guard let data = try? JSONSerialization.data(withJSONObject: cleaned) else {
            return
        }
        var line = data
        line.append(0x0A) // "\n"
        handle.write(line)
    }
}
