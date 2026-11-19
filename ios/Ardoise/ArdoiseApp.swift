import SwiftUI

/// Ardoise for iOS: sign in with the same passkey as the web app, pay from
/// the account's bitcoin credit on the lending venue you pick, read the
/// statement and the margin on each venue.
@main
struct ArdoiseApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            ScreenBackground()
            switch model.phase {
            case .signedOut:
                SignInView()
            case .loading:
                ProgressView("Signing in…")
                    .foregroundStyle(Theme.muted)
            case .needsActivation:
                ActivateView()
            case .ready:
                HomeView()
            }
        }
    }
}
