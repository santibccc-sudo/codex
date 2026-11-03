import Foundation
import SwiftUI

@MainActor
final class ConversationModel: ObservableObject {
    @Published private(set) var isActive = false
    @Published private(set) var status = "Listo para hablar"
    @Published private(set) var userTranscript = ""
    @Published private(set) var assistantTranscript = ""
    @Published private(set) var errorMessage: String?
    @Published private(set) var muted = false

    private let audio = WatchAudio()
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var conversationTask: Task<Void, Never>?
    private var senderTask: Task<Void, Never>?
    private var deadlineTask: Task<Void, Never>?
    private var outgoing: AsyncStream<Data>.Continuation?
    private var generation = UUID()
    private var responseID: String?
    private var audioItemID: String?
    private var generating = false
    private var ready = false

    func start(urlText: String, token: String) {
        guard !isActive else { return }
        guard let url = URL(string: urlText.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "wss", url.host != nil, url.path == "/realtime",
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            errorMessage = "Usa una dirección wss://tu-servidor/realtime sin parámetros."
            return
        }
        guard token.count >= 32 else { errorMessage = "Configura el token del servidor (mínimo 32 caracteres)."; return }
        errorMessage = nil
        userTranscript = ""
        assistantTranscript = ""
        status = "Preparando micrófono…"
        isActive = true
        let current = UUID()
        generation = current
        conversationTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.audio.activate()
                guard self.generation == current, !Task.isCancelled else {
                    if !self.isActive { self.audio.stop() }
                    return
                }
                var request = URLRequest(url: url)
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                let configuration = URLSessionConfiguration.ephemeral
                configuration.timeoutIntervalForRequest = 20
                configuration.timeoutIntervalForResource = 3600
                let session = URLSession(configuration: configuration)
                self.session = session
                let socket = session.webSocketTask(with: request)
                self.socket = socket
                self.status = "Conectando…"
                socket.resume()
                self.deadlineTask = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(20))
                    guard !Task.isCancelled, let self, self.generation == current, !self.ready else { return }
                    self.fail("No se pudo preparar la conversación. Comprueba el servidor, el token y la conexión.")
                }
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    guard self.generation == current else { return }
                    let data: Data
                    switch message {
                    case .string(let text): data = Data(text.utf8)
                    case .data(let bytes): data = bytes
                    @unknown default: continue
                    }
                    guard let event = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                    try self.handle(event, current: current)
                }
            } catch {
                guard self.generation == current, !Task.isCancelled else { return }
                self.fail(error.localizedDescription)
            }
        }
    }

    private func handle(_ event: [String: Any], current: UUID) throws {
        switch event["type"] as? String {
        case "relay.ready":
            guard !ready else { return }
            ready = true
            deadlineTask?.cancel()
            let stream = AsyncStream<Data>(bufferingPolicy: .bufferingNewest(12)) { outgoing = $0 }
            senderTask = Task { [weak self] in
                for await bytes in stream {
                    guard let self, self.generation == current, !Task.isCancelled else { return }
                    do {
                        try await self.send(["type": "input_audio_buffer.append", "audio": bytes.base64EncodedString()])
                    } catch {
                        if self.generation == current { self.fail("No se pudo enviar el audio. Vuelve a conectar.") }
                        return
                    }
                }
            }
            try audio.start { [weak self] bytes in
                Task { @MainActor in
                    guard let self, self.generation == current, self.isActive, !self.muted else { return }
                    if let result = self.outgoing?.yield(bytes), case .dropped = result {
                        self.fail("La conexión no puede enviar el audio en tiempo real. Vuelve a conectar.")
                    }
                }
            }
            status = "Escuchando"
        case "input_audio_buffer.speech_started":
            interrupt(cancelResponse: false)
            userTranscript = ""
            status = "Te escucho…"
        case "input_audio_buffer.speech_stopped":
            status = "Pensando…"
        case "conversation.item.input_audio_transcription.completed":
            userTranscript = String((event["transcript"] as? String ?? "").suffix(4000))
        case "response.created":
            responseID = (event["response"] as? [String: Any])?["id"] as? String
            generating = true
            audioItemID = nil
            audio.interrupt()
            assistantTranscript = ""
            status = "Respondiendo"
        case "response.output_audio.delta":
            guard let active = responseID, event["response_id"] as? String == active,
                  let encoded = event["delta"] as? String, let bytes = Data(base64Encoded: encoded) else { return }
            audioItemID = event["item_id"] as? String
            try audio.play(bytes)
        case "response.output_audio_transcript.delta":
            guard let active = responseID, event["response_id"] as? String == active else { return }
            assistantTranscript = String((assistantTranscript + (event["delta"] as? String ?? "")).suffix(4000))
        case "response.done":
            let response = event["response"] as? [String: Any]
            guard response?["id"] as? String == responseID else { return }
            generating = false
            if response?["status"] as? String == "failed" { fail("No se pudo generar la respuesta de voz."); return }
            status = muted ? "Micrófono silenciado" : "Escuchando · puedes interrumpir"
        case "relay.error":
            fail(event["message"] as? String ?? "Error de conexión.")
        default: break
        }
    }

    func toggleMute() {
        guard ready else { return }
        muted.toggle()
        status = muted ? "Micrófono silenciado" : "Escuchando"
    }

    func interrupt(cancelResponse: Bool = true) {
        let milliseconds = audio.interrupt()
        let item = audioItemID
        let shouldCancel = cancelResponse && generating
        let current = generation
        responseID = nil
        audioItemID = nil
        generating = false
        guard ready else { return }
        status = muted ? "Micrófono silenciado" : "Escuchando"
        Task { [weak self] in
            guard let self else { return }
            do {
                if shouldCancel { try await self.send(["type": "response.cancel"]) }
                guard self.generation == current else { return }
                if let item {
                    try await self.send(["type": "conversation.item.truncate", "item_id": item,
                                         "content_index": 0, "audio_end_ms": milliseconds])
                }
            } catch {
                if self.generation == current { self.fail("Se perdió la conexión al interrumpir.") }
            }
        }
    }

    private func send(_ event: [String: Any]) async throws {
        guard let socket else { throw URLError(.notConnectedToInternet) }
        let data = try JSONSerialization.data(withJSONObject: event)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }

    private func fail(_ message: String) {
        stop()
        errorMessage = message
    }

    func stop() {
        generation = UUID()
        conversationTask?.cancel(); conversationTask = nil
        senderTask?.cancel(); senderTask = nil
        deadlineTask?.cancel(); deadlineTask = nil
        outgoing?.finish(); outgoing = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        session?.invalidateAndCancel(); session = nil
        audio.stop()
        ready = false
        isActive = false
        muted = false
        generating = false
        responseID = nil
        audioItemID = nil
        status = "Listo para hablar"
    }
}
