import AVFoundation
import Foundation

// Capture and render PCM16 mono at 24 kHz, as required by Realtime.
// The input converter runs only on the tap callback; playback runs on the main actor.
@MainActor
final class WatchAudio {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                      sampleRate: 24_000, channels: 1, interleaved: false)!
    private var hasTap = false
    private var attached = false
    private var receivedFrames: Int64 = 0

    func activate() async throws {
        let session = AVAudioSession.sharedInstance()
        let allowed = await withCheckedContinuation { continuation in
            session.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard allowed else { throw AudioError.permission }
        try Task.checkCancellation()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [])
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            session.activate(options: []) { success, error in
                if let error { continuation.resume(throwing: error) }
                else if success { continuation.resume() }
                else { continuation.resume(throwing: AudioError.route) }
            }
        }
    }

    func start(onChunk: @escaping (Data) -> Void) throws {
        let input = engine.inputNode
        let hardware = input.outputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0,
              let converter = AVAudioConverter(from: hardware, to: format) else { throw AudioError.route }
        if !attached {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            attached = true
        }
        let wireFormat = format
        input.installTap(onBus: 0, bufferSize: 2048, format: hardware) { buffer, _ in
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 24_000 / hardware.sampleRate)) + 64
            guard let converted = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
            var supplied = false
            var conversionError: NSError?
            let status = converter.convert(to: converted, error: &conversionError) { _, state in
                if supplied { state.pointee = .noDataNow; return nil }
                supplied = true
                state.pointee = .haveData
                return buffer
            }
            guard status != .error, conversionError == nil,
                  let samples = converted.floatChannelData?[0], converted.frameLength > 0 else { return }
            var bytes = Data(capacity: Int(converted.frameLength) * 2)
            for index in 0..<Int(converted.frameLength) {
                let sample = samples[index].isFinite ? max(-1, min(1, samples[index])) : 0
                var pcm = Int16(sample * 32767).littleEndian
                withUnsafeBytes(of: &pcm) { bytes.append(contentsOf: $0) }
            }
            onChunk(bytes)
        }
        hasTap = true
        engine.prepare()
        try engine.start()
        player.play()
    }

    func play(_ data: Data) throws {
        guard !data.isEmpty, data.count % 2 == 0 else { throw AudioError.invalidAudio }
        let count = data.count / 2
        // Bound queued audio to 30 seconds if the device cannot keep up.
        guard receivedFrames - playedFrames < 24_000 * 30 else { throw AudioError.backlog }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let samples = buffer.floatChannelData?[0] else { throw AudioError.invalidAudio }
        buffer.frameLength = AVAudioFrameCount(count)
        data.withUnsafeBytes { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            for index in 0..<count {
                let value = UInt16(bytes[index * 2]) | UInt16(bytes[index * 2 + 1]) << 8
                samples[index] = Float(Int16(bitPattern: value)) / 32768
            }
        }
        receivedFrames += Int64(count)
        player.scheduleBuffer(buffer)
        if !player.isPlaying { player.play() }
    }

    private var playedFrames: Int64 {
        guard let renderTime = player.lastRenderTime,
              let time = player.playerTime(forNodeTime: renderTime) else { return 0 }
        return max(0, min(receivedFrames, time.sampleTime))
    }

    // Return the amount actually rendered, so interrupted speech is also removed from model context.
    @discardableResult
    func interrupt() -> Int {
        let milliseconds = Int(playedFrames * 1000 / 24_000)
        player.stop()
        receivedFrames = 0
        if engine.isRunning { player.play() }
        return milliseconds
    }

    func stop() {
        player.stop()
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        engine.stop()
        receivedFrames = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    enum AudioError: LocalizedError {
        case permission, route, invalidAudio, backlog
        var errorDescription: String? {
            switch self {
            case .permission: return "Permite el acceso al micrófono en los ajustes del reloj."
            case .route: return "No hay una ruta de audio disponible. Comprueba el micrófono y los auriculares."
            case .invalidAudio: return "El servicio ha enviado audio no válido."
            case .backlog: return "La reproducción se ha retrasado. Vuelve a conectar."
            }
        }
    }
}
