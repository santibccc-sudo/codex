import SwiftUI

@main
struct CodexVoiceApp: App {
    @StateObject private var conversation = ConversationModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ConversationView(model: conversation)
                .onChange(of: scenePhase) { _, phase in
                    if phase != .active { conversation.stop() }
                }
                .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in
                    conversation.stop()
                }
        }
    }
}

import AVFoundation
