import SwiftUI

struct ConversationView: View {
    @ObservedObject var model: ConversationModel
    @AppStorage("relayURL") private var relayURL = ""
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    Image(systemName: model.isActive ? "waveform.circle.fill" : "mic.circle")
                        .font(.system(size: 42))
                        .foregroundStyle(model.isActive ? .green : .cyan)
                        .accessibilityLabel(model.isActive ? "Conversación activa" : "Conversación detenida")
                    Text(model.status).font(.footnote).multilineTextAlignment(.center)
                    if let error = model.errorMessage {
                        Text(error).font(.caption2).foregroundStyle(.orange)
                    }
                    Button {
                        if model.isActive { model.stop() }
                        else { model.start(urlText: relayURL, token: KeychainStore.read()) }
                    } label: {
                        Label(model.isActive ? "Terminar" : "Hablar", systemImage: model.isActive ? "stop.fill" : "mic.fill")
                    }
                    .tint(model.isActive ? .red : .cyan)
                    if model.isActive {
                        Button(model.muted ? "Activar micro" : "Silenciar micro") { model.toggleMute() }
                        Button("Interrumpir respuesta") { model.interrupt() }
                    }
                    if !model.userTranscript.isEmpty {
                        transcript("Tú", model.userTranscript)
                    }
                    if !model.assistantTranscript.isEmpty {
                        transcript("Asistente", model.assistantTranscript)
                    }
                    if !model.isActive {
                        Text("Voz generada por IA · requiere Internet")
                            .font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                }
                .padding(.horizontal, 4)
            }
            .navigationTitle("Codex Voz")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .disabled(model.isActive)
                        .accessibilityLabel("Ajustes de conexión")
                }
            }
            .sheet(isPresented: $showSettings) { ConnectionSettings() }
        }
    }

    private func transcript(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(text).font(.footnote)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ConnectionSettings: View {
    @AppStorage("relayURL") private var relayURL = ""
    @State private var urlDraft = ""
    @State private var token = ""
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Servidor de voz") {
                    TextField("wss://…/realtime", text: $urlDraft)
                    SecureField("Token de acceso", text: $token)
                }
                Text("El token es el del servidor. Nunca introduzcas tu clave de OpenAI aquí.")
                    .font(.caption2)
                if let error { Text(error).foregroundStyle(.orange) }
                Button("Guardar") {
                    do {
                        try KeychainStore.save(token.trimmingCharacters(in: .whitespacesAndNewlines))
                        relayURL = urlDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                        dismiss()
                    } catch { self.error = error.localizedDescription }
                }
            }
            .navigationTitle("Conexión")
            .onAppear { urlDraft = relayURL; token = KeychainStore.read() }
        }
    }
}
